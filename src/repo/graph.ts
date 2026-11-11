import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createTestFileMatcher, DEFAULT_TEST_FILE_MATCHER, testFileMatcherForProfile, type TestFileMatcher } from "./test-discovery.js";
import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { adapterFiles, REPOSITORY_ADAPTERS } from "./adapters/index.js";
import { pythonAdapter } from "./adapters/python.js";
import { analyzeRepository, type AnalyzeRepositoryOptions } from "./analyzer.js";
import { applyVueScope, inVuePackage } from "./vue-scope.js";
import { declaredWorkspaceRoots } from "./workspaces.js";
import { WorkspaceSources } from "./workspace-sources.js";
import type {
  DependencyEdge,
  ModuleBindings,
  DependencyEdgeKind,
  DependencyGraph,
  DependencyGraphNode,
  DependencyGraphResult,
  GraphConfidence,
  GraphIntegrityFinding,
  GraphIntegrityReport,
  GraphPerformanceMetrics,
  RepositoryProfile,
  ResolutionReference,
  ScopedAdapterBlocker,
  SourceRoot,
  UnresolvedDependency,
} from "./types.js";

interface ImportRef {
  specifier: string;
  kind: DependencyEdgeKind;
  dynamic: boolean;
  computed?: boolean;
  /** For a computed load whose target set is still bounded by literal text: `` import(`./x/${a}.json`) ``
   * or `import.meta.glob("./x/*.json")`. `base` is the literal directory prefix (a specifier ending in
   * "/"); `regex` matches paths relative to it. Unresolvable patterns keep the load computed. */
  patterns?: { base: string; regex: string; negated: boolean; viteRoot?: boolean }[];
  /** `import { type A, type B }` or `export { type A } from`: every specifier is inline `type`, so the
   * statement is erased unless the importer's tsconfig preserves imports (see `keepsTypeOnlyImports`). */
  inlineTypeOnly?: boolean;
  /** A `vi.mock("./x")` / `jest.mock("./x")` target. Vitest counts these as dependencies of the test;
   * an unresolvable one (a virtual or aliased module) is dropped rather than made unsafe. */
  mock?: boolean;
  /** Runtime names an `import` statement binds (`default` for a default import); absent means the whole
   * module (namespace and side-effect imports, dynamic imports, require, mocks). */
  names?: string[];
  /** For `export ... from`: the names it forwards as [exported, imported] pairs, `star` for `export *`,
   * or `namespace` for `export * as ns`. */
  reexport?: { pairs?: [string, string][]; star?: boolean; namespace?: string };
  /** A computed load outside any function body (or in an immediately invoked one): it runs when the
   * module loads, so a test that merely loads the module may run it. */
  atLoad?: boolean;
}

/** Test-runner calls whose literal first argument names a module the test depends on. */
const MOCK_MODULE_CALLS = new Set([
  "vi.mock", "vi.doMock", "vi.unmock", "vi.doUnmock", "vi.importActual", "vi.importMock",
  "jest.mock", "jest.doMock", "jest.unmock", "jest.dontMock", "jest.requireActual", "jest.requireMock", "jest.createMockFromModule",
]);

/** Whether this importer's emit keeps statements whose specifiers are all inline `type`. Without these
 * options TypeScript, esbuild and oxc drop the whole statement, so it never loads the target. */
function keepsTypeOnlyImports(options: ts.CompilerOptions): boolean {
  return Boolean(options.verbatimModuleSyntax || options.preserveValueImports || options.importsNotUsedAsValues === ts.ImportsNotUsedAsValues.Preserve);
}

function allInlineType(elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[]): boolean {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A specifier may omit the extension or name a directory's index module.
const OPTIONAL_MODULE_SUFFIX = "(?:\\.[A-Za-z0-9]+|/index\\.[A-Za-z0-9]+)?";

/** A specifier expression folded into literal text and unknown holes (`undefined`), adjacent text joined. */
type SpecifierParts = (string | undefined)[];

/** `const` bindings with an initializer, by name, for names the file binds exactly once. A name bound
 * twice anywhere (a parameter, a `let`, a second `const` in another scope) could mean either binding at
 * a given use, so it is left out and its uses stay unknown. */
function singleConstBindings(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const counts = new Map<string, number>();
  const consts = new Map<string, ts.Expression>();
  const count = (name: ts.BindingName | undefined) => {
    if (!name) return;
    if (ts.isIdentifier(name)) { counts.set(name.text, (counts.get(name.text) ?? 0) + 1); return; }
    for (const element of name.elements) if (!ts.isOmittedExpression(element)) count(element.name);
  };
  // Source files parsed by the Program have no parent pointers, so `const` is read from the list.
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclarationList(node)) {
      const isConst = (node.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of node.declarations) {
        if (isConst && ts.isIdentifier(declaration.name) && declaration.initializer) consts.set(declaration.name.text, declaration.initializer);
      }
    } else if (ts.isVariableDeclaration(node)) count(node.name);
    else if (ts.isParameter(node) || ts.isBindingElement(node)) count(node.name);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node)) && node.name) count(node.name);
    else if (ts.isImportClause(node) && node.name) count(node.name);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) count(node.name);
    else if (ts.isImportEqualsDeclaration(node)) count(node.name);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const name of [...consts.keys()]) if (counts.get(name) !== 1) consts.delete(name);
  return consts;
}

/** Folds string concatenation, templates and single `const` bindings (2026-11-06: LobeHub's
 * `import('./genServerAiProviderConfig?v=' + Date.now())` and `const modulePath = '../x' + '.mts'`
 * made both tests COMPUTED_IMPORT selections on every commit). Anything else is an unknown hole. */
function specifierParts(expression: ts.Expression, consts: ReadonlyMap<string, ts.Expression>, depth = 0): SpecifierParts {
  const join = (parts: SpecifierParts): SpecifierParts => {
    const joined: SpecifierParts = [];
    for (const part of parts) {
      const last = joined.length - 1;
      if (typeof part === "string" && typeof joined[last] === "string") joined[last] += part;
      else if (part !== undefined || joined[last] !== undefined || last < 0) joined.push(part);
    }
    return joined;
  };
  if (depth > 8) return [undefined];
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isParenthesizedExpression(expression)) return specifierParts(expression.expression, consts, depth + 1);
  if (ts.isTemplateExpression(expression)) {
    return join([expression.head.text, ...expression.templateSpans.flatMap((span) => [...specifierParts(span.expression, consts, depth + 1), span.literal.text])]);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = specifierParts(expression.left, consts, depth + 1);
    // `+` concatenates only when one side is a string; two unknowns could be a numeric sum.
    if (!left.some((part) => typeof part === "string")) {
      const right = specifierParts(expression.right, consts, depth + 1);
      return right.some((part) => typeof part === "string") ? join([...left, ...right]) : [undefined];
    }
    return join([...left, ...specifierParts(expression.right, consts, depth + 1)]);
  }
  if (ts.isIdentifier(expression)) {
    const initializer = consts.get(expression.text);
    if (initializer) return specifierParts(initializer, consts, depth + 1);
  }
  return [undefined];
}

/** A folded specifier: its literal text, or the patterns bounding it. A query (`?v=...`) selects no file
 * of its own: Vite and Node strip it before resolving, so text after the first `?` is dropped. */
function foldedSpecifier(parts: SpecifierParts): { literal: string } | { patterns: ImportRef["patterns"] } {
  const cut: SpecifierParts = [];
  for (const part of parts) {
    if (typeof part === "string" && part.includes("?")) { cut.push(part.slice(0, part.indexOf("?"))); break; }
    cut.push(part);
  }
  if (cut.every((part) => typeof part === "string")) return { literal: cut.join("") };
  const head = typeof cut[0] === "string" ? cut[0] : "";
  const slash = head.lastIndexOf("/");
  if (slash < 0) return { patterns: undefined };
  // A hole can hold "/" so it matches across directories, which can only over-select.
  const regex = escapeRegex(head.slice(slash + 1)) + cut.slice(1).map((part) => part === undefined ? ".*" : escapeRegex(part)).join("");
  return { patterns: [{ base: head.slice(0, slash + 1), regex: `${regex}${OPTIONAL_MODULE_SUFFIX}`, negated: false }] };
}

const VITE_CONFIG_NAMES = ["vite", "vitest"].flatMap((tool) => ["ts", "mts", "cts", "js", "mjs", "cjs"].map((ext) => `${tool}.config.${ext}`));

/** One Vite `import.meta.glob` pattern; `[...]` classes are not translated and keep the load computed. */
function globPattern(glob: string): NonNullable<ImportRef["patterns"]>[number] | undefined {
  const negated = glob.startsWith("!");
  const body = negated ? glob.slice(1) : glob;
  const firstWild = body.search(/[*?{[]/);
  const cut = body.lastIndexOf("/", firstWild < 0 ? body.length : firstWild);
  if (cut < 0 || body.includes("[")) return undefined;
  let regex = "";
  const rest = body.slice(cut + 1);
  for (let i = 0; i < rest.length; i++) {
    const char = rest[i]!;
    if (rest.startsWith("**/", i)) { regex += "(?:.*/)?"; i += 2; }
    else if (rest.startsWith("**", i)) { regex += ".*"; i += 1; }
    else if (char === "*") regex += "[^/]*";
    else if (char === "?") regex += "[^/]";
    else if (char === "{") {
      const close = rest.indexOf("}", i);
      if (close < 0) return undefined;
      regex += `(?:${rest.slice(i + 1, close).split(",").map(escapeRegex).join("|")})`;
      i = close;
    } else regex += escapeRegex(char);
  }
  // Vite resolves a glob starting with "/" from its project root, not the filesystem root.
  return { base: body.slice(0, cut + 1), regex, negated, ...(body.startsWith("/") ? { viteRoot: true } : {}) };
}

function isImportMetaGlob(expression: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expression) && /^glob(?:Eager)?$/.test(expression.name.text)
    && ts.isMetaProperty(expression.expression) && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
]);

const ASSET_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".json",
  ".jsonc",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".wasm",
  ".md",
  ".txt",
]);

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function isSourceFileName(fileName: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function isAssetFileName(fileName: string): boolean {
  return ASSET_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function isNodeBuiltin(specifier: string): boolean {
  return isBuiltin(specifier);
}


function toRelativeInternal(
  repoPath: string,
  absolutePath: string,
): string | undefined {
  const rel = toPosix(normalize(relative(repoPath, absolutePath)));
  if (rel.startsWith("..")) return undefined;
  if (rel === "node_modules" || rel.startsWith("node_modules/")) return undefined;
  return rel;
}

function isExcludedPath(rel: string, excludeDirs: string[]): boolean {
  return excludeDirs.some(
    (dir) => rel === dir || rel.startsWith(`${dir}/`),
  );
}

/**
 * Whether `require` at this call names a local binding rather than the module loader, as in an
 * assertion helper `const require = (condition, code) => ...`. Such calls load nothing, so treating
 * their arguments as computed specifiers made every delta in one dogfood repository UNSAFE. A local
 * `require` initialised from `createRequire(...)` is the loader and is not a shadow. Scopes are
 * tracked during the walk: source files parsed by the Program have no parent pointers.
 */
function scopeShadowsRequire(scope: ts.Node): boolean {
  const declares = (name: ts.BindingName | ts.Identifier | undefined) => !!name && ts.isIdentifier(name) && name.text === "require";
  const loaderInitializer = (init: ts.Expression | undefined) =>
    !!init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "createRequire";
  const statementShadows = (statement: ts.Statement) =>
    (ts.isFunctionDeclaration(statement) && declares(statement.name)) ||
    (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((d) => declares(d.name) && !loaderInitializer(d.initializer)));
  if ((ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) && scope.statements.some(statementShadows)) return true;
  return ts.isFunctionLike(scope) && scope.parameters.some((p) => declares(p.name));
}

function extractImportRefs(sourceFile: ts.SourceFile): ImportRef[] {
  const refs: ImportRef[] = [];
  let shadowDepth = 0;
  let consts: Map<string, ts.Expression> | undefined;

  // A function body runs when called, not when the module loads; an immediately invoked one runs at load.
  // Program source files have no parent pointers, so a call marks the function it invokes on the way down.
  let functionDepth = 0;
  const invokedAtOnce = new Set<ts.Node>();
  function visit(node: ts.Node) {
    const shadows = scopeShadowsRequire(node);
    if (shadows) shadowDepth++;
    if (ts.isCallExpression(node)) {
      let callee: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
      if (ts.isFunctionLike(callee)) invokedAtOnce.add(callee);
    }
    const body = ts.isFunctionLike(node) && !invokedAtOnce.has(node);
    if (body) functionDepth++;
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier)) {
        const clause = node.importClause;
        const isTypeOnly = clause?.isTypeOnly ?? false;
        const kind: DependencyEdgeKind = isTypeOnly ? "type-import" : "import";
        const inlineTypeOnly = !isTypeOnly && !!clause && !clause.name && !!clause.namedBindings
          && ts.isNamedImports(clause.namedBindings) && allInlineType(clause.namedBindings.elements);
        const bindings = clause && !(clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
          ? [...(clause.name ? ["default"] : []), ...(clause.namedBindings && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings.elements.filter((el) => !el.isTypeOnly).map((el) => (el.propertyName ?? el.name).text) : [])]
          : undefined;
        refs.push({ specifier: specifier.text, kind, dynamic: false, ...(inlineTypeOnly ? { inlineTypeOnly } : {}), ...(bindings ? { names: bindings } : {}) });
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = node.moduleReference.expression;
      if (specifier && ts.isStringLiteral(specifier)) {
        refs.push({ specifier: specifier.text, kind: node.isTypeOnly ? "type-import" : "require", dynamic: false });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier)) {
        const kind: DependencyEdgeKind = node.isTypeOnly ? "type-import" : "re-export";
        const inlineTypeOnly = !node.isTypeOnly && !!node.exportClause && ts.isNamedExports(node.exportClause) && allInlineType(node.exportClause.elements);
        const clause = node.exportClause;
        const reexport = !clause ? { star: true }
          : ts.isNamespaceExport(clause) ? { namespace: clause.name.text }
          : { pairs: clause.elements.filter((el) => !el.isTypeOnly).map((el): [string, string] => [el.name.text, (el.propertyName ?? el.name).text]) };
        refs.push({ specifier: specifier.text, kind, dynamic: false, ...(inlineTypeOnly ? { inlineTypeOnly } : {}), reexport });
      }
    } else if (ts.isCallExpression(node)) {
      const firstArg = node.arguments[0];
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require" && shadowDepth === 0;
      if ((isImport || isRequire) && firstArg) {
        const syntaxLiteral = ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg);
        const folded = foldedSpecifier(specifierParts(firstArg, consts ??= singleConstBindings(sourceFile)));
        const literal = "literal" in folded;
        const patterns = "patterns" in folded ? folded.patterns : undefined;
        refs.push({
          specifier: syntaxLiteral ? firstArg.text : literal ? folded.literal : firstArg.getText(sourceFile).slice(0, 200),
          kind: isImport ? "dynamic-import" : "require",
          dynamic: isImport || !syntaxLiteral,
          computed: !literal,
          ...(patterns ? { patterns } : {}),
          ...(!literal && functionDepth === 0 ? { atLoad: true } : {}),
        });
      } else if (firstArg && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && MOCK_MODULE_CALLS.has(`${node.expression.expression.text}.${node.expression.name.text}`)
        && (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))) {
        refs.push({ specifier: firstArg.text, kind: "import", dynamic: false, mock: true });
      } else if (isImportMetaGlob(node.expression) && firstArg) {
        // Vite expands these at build time; without them a file loaded only through a glob had no edge.
        const items = ts.isArrayLiteralExpression(firstArg) ? [...firstArg.elements] : [firstArg];
        const globs = items.map((item) => ts.isStringLiteral(item) || ts.isNoSubstitutionTemplateLiteral(item) ? item.text : undefined);
        const patterns = globs.every((glob) => glob !== undefined) ? globs.map((glob) => globPattern(glob!)) : [];
        refs.push({
          specifier: firstArg.getText(sourceFile).slice(0, 200),
          kind: "dynamic-import",
          dynamic: true,
          computed: true,
          ...(patterns.length && patterns.every(Boolean) ? { patterns: patterns as NonNullable<ImportRef["patterns"]> } : {}),
          ...(functionDepth === 0 ? { atLoad: true } : {}),
        });
      }
    }

    ts.forEachChild(node, visit);
    if (body) functionDepth--;
    if (shadows) shadowDepth--;
  }

  visit(sourceFile);
  return refs;
}

/**
 * Whether the nearest package.json at or above `path` (inside the repository) declares its JavaScript free of
 * side effects: `"sideEffects": false`, or a list naming only stylesheets. This is the contract bundlers
 * rely on to drop unused re-exports; without it a module's evaluation may matter, so imports stay whole.
 */
function sideEffectFreePackage(repoPath: string, path: string, cache: Map<string, boolean | undefined>): boolean {
  let dir = dirname(path);
  while (true) {
    let declared = cache.get(dir);
    if (!cache.has(dir)) {
      declared = undefined;
      try {
        const pkg = JSON.parse(readFileSync(join(repoPath, dir, "package.json"), "utf8")) as { sideEffects?: unknown };
        const se = pkg.sideEffects;
        declared = se === false || (Array.isArray(se) && se.length > 0 && se.every((glob) => typeof glob === "string" && /\.(s?css|sass|less|styl)$/.test(glob)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") declared = false;
      }
      cache.set(dir, declared);
    }
    if (declared !== undefined) return declared;
    if (dir === "." || dir === "" || dirname(dir) === dir) return false;
    dir = dirname(dir);
  }
}

/**
 * Runtime names a module defines itself, for export-level selection. `opaque` when they cannot be listed
 * (CommonJS `module.exports`/`exports.x`, `export =`, destructured `export const { a } = ...`): an import of
 * such a module always counts as the whole module.
 */
function exportedLocals(sourceFile: ts.SourceFile): { locals: string[]; opaque: boolean } {
  const locals = new Set<string>();
  let opaque = false;
  const has = (node: ts.Node, kind: ts.SyntaxKind) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
  for (const st of sourceFile.statements) {
    if (ts.isExportDeclaration(st)) {
      if (!st.moduleSpecifier && !st.isTypeOnly && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) if (!el.isTypeOnly) locals.add(el.name.text);
      }
    } else if (ts.isExportAssignment(st)) {
      locals.add("default");
      if (st.isExportEquals) opaque = true;
    } else if (has(st, ts.SyntaxKind.ExportKeyword)) {
      if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) continue;
      if (has(st, ts.SyntaxKind.DefaultKeyword)) locals.add("default");
      else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) locals.add(d.name.text);
          else opaque = true;
        }
      } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) && st.name && ts.isIdentifier(st.name)) {
        locals.add(st.name.text);
      } else opaque = true;
    }
  }
  const visit = (node: ts.Node): void => {
    if (opaque) return;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && (node.expression.text === "exports" || (node.expression.text === "module" && node.name.text === "exports"))) opaque = true;
    else ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { locals: [...locals].sort(), opaque };
}

class DependencyGraphImpl implements DependencyGraph {
  readonly nodes: DependencyGraphNode[];
  readonly edges: DependencyEdge[];
  readonly forward: Record<string, string[]> = {};
  readonly reverse: Record<string, string[]> = {};
  /** `reverse` without `import type` edges, which TypeScript erases before anything runs. */
  private readonly reverseRuntime: Record<string, string[]> = {};

  constructor(
    sourcePaths: ReadonlySet<string>,
    assetPaths: ReadonlySet<string>,
    edges: DependencyEdge[],
    private repoPath: string,
    isTestFile: TestFileMatcher = DEFAULT_TEST_FILE_MATCHER,
  ) {
    this.edges = [...edges].sort(DependencyGraphImpl.compareEdges);
    this.nodes = [
      ...Array.from(sourcePaths).map((p) => ({
        path: p,
        isSource: true,
        isAsset: false,
        isTest: isTestFile(p),
        isEntryPoint: false,
      })),
      ...Array.from(assetPaths).map((p) => ({
        path: p,
        isSource: false,
        isAsset: true,
        assetType: extname(p).toLowerCase(),
        isTest: false,
        isEntryPoint: false,
      })),
    ].sort((a, b) => a.path.localeCompare(b.path));

    for (const node of this.nodes) {
      this.forward[node.path] = [];
      this.reverse[node.path] = [];
      this.reverseRuntime[node.path] = [];
    }

    for (const edge of this.edges) {
      if (this.forward[edge.from] !== undefined) {
        this.forward[edge.from]!.push(edge.to);
      }
      if (this.reverse[edge.to] !== undefined) {
        this.reverse[edge.to]!.push(edge.from);
        if (edge.kind !== "type-import") this.reverseRuntime[edge.to]!.push(edge.from);
      }
    }

    for (const adjacency of [this.forward, this.reverse, this.reverseRuntime]) {
      for (const key of Object.keys(adjacency)) {
        adjacency[key] = [...new Set(adjacency[key]!)].sort();
      }
    }
  }

  private static compareEdges(a: DependencyEdge, b: DependencyEdge): number {
    return (
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.kind.localeCompare(b.kind)
    );
  }

  dependenciesOf(filePath: string): string[] {
    const rel = this.normalizeQuery(filePath);
    return this.forward[rel] ?? [];
  }

  dependentsOf(filePath: string): string[] {
    const rel = this.normalizeQuery(filePath);
    return this.reverse[rel] ?? [];
  }

  transitiveDependenciesOf(filePath: string): string[] {
    return this.transitiveTraversal(filePath, this.forward);
  }

  transitiveDependentsOf(filePath: string): string[] {
    return this.transitiveTraversal(filePath, this.reverse);
  }

  transitiveRuntimeDependentsOf(filePath: string): string[] {
    return this.transitiveTraversal(filePath, this.reverseRuntime);
  }

  private transitiveTraversal(filePath: string, adjacency: Record<string, string[]>): string[] {
    const rel = this.normalizeQuery(filePath);
    const visited = new Set<string>([rel]);
    // An index, not shift(): shift() is O(n) and made dependents of hub modules quadratic (2026-11-03,
    // 379 s of impact analysis on one LobeHub commit whose changed files had ~14k dependents).
    const queue: string[] = [rel];
    for (let head = 0; head < queue.length; head++) {
      for (const next of adjacency[queue[head]!] ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    return queue.slice(1).sort();
  }

  private normalizeQuery(filePath: string): string {
    const rel = toPosix(normalize(relative(this.repoPath, resolve(this.repoPath, filePath))));
    return rel;
  }
}

/** Restores a cached graph. `testPatterns` (from the cached profile) keeps isTest flags consistent with
 * the test universe the graph was built under; without it the pre-2026-08-23 defaults apply. */
export function hydrateDependencyGraph(graph: DependencyGraph, repoPath: string, testPatterns?: readonly string[]): DependencyGraph {
  const sourcePaths = new Set(graph.nodes.filter((n) => n.isSource).map((n) => n.path));
  const assetPaths = new Set(graph.nodes.filter((n) => n.isAsset).map((n) => n.path));
  return new DependencyGraphImpl(sourcePaths, assetPaths, graph.edges, repoPath, testPatterns ? createTestFileMatcher(testPatterns) : DEFAULT_TEST_FILE_MATCHER);
}

/**
 * TypeScript "solution style" tsconfigs (`"files": [], "references": [...]`) parse to zero
 * root file names via ts.parseJsonConfigFileContent — it does not expand `references` into
 * `fileNames` (that requires solution-build APIs this module doesn't otherwise use). Left
 * unhandled, that produces an empty ts.Program and therefore an empty dependency graph,
 * which computeConfidence() would otherwise happily report as "COMPLETE" (nothing to
 * flag as unresolved when there's nothing to resolve). Recursively resolve each
 * referenced project's own file list and compiler options so the program actually
 * contains the real source files.
 */
function resolveProjectReferenceInputs(
  configPath: string,
  visited: Set<string>,
): { fileNames: string[]; optionsList: ts.CompilerOptions[] } {
  const collected: { fileNames: string[]; optionsList: ts.CompilerOptions[] } = { fileNames: [], optionsList: [] };
  const normalized = ts.sys.resolvePath ? ts.sys.resolvePath(configPath) : configPath;
  if (visited.has(normalized)) return collected; // guard against reference cycles
  visited.add(normalized);

  const { config, error } = ts.readConfigFile(toPosix(configPath), ts.sys.readFile);
  if (error || !config) return collected;

  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath), undefined, configPath);
  collected.fileNames.push(...parsed.fileNames);
  if (parsed.fileNames.length > 0) collected.optionsList.push(parsed.options);

  for (const ref of parsed.projectReferences ?? []) {
    const refConfigPath = ts.resolveProjectReferencePath(ref);
    if (!ts.sys.fileExists(refConfigPath)) continue;
    const nested = resolveProjectReferenceInputs(refConfigPath, visited);
    collected.fileNames.push(...nested.fileNames);
    collected.optionsList.push(...nested.optionsList);
  }

  return collected;
}

const FALLBACK_SCAN_IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "tmp", "temp"]);
/** Bound on how many files this walk will ever collect, purely as a defensive cap against pathological
 * repos - real source roots are never anywhere close to this in practice. */
const FALLBACK_SCAN_MAX_FILES = 20_000;

/** Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md): recursively collects real
 * TS/JS source file paths under the given source-root directories. Used only as a fallback when the
 * repository's own tsconfig scopes the compiler Program to something that excludes real source
 * entirely (see the doc comment on the caller below) - independent of, and not a replacement for, the
 * repo's own tsconfig-driven file discovery. */
function discoverFallbackSourceFiles(repoPath: string, sourceRoots: SourceRoot[]): string[] {
  const found: string[] = [];
  function walk(dirAbs: string): void {
    if (found.length >= FALLBACK_SCAN_MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // root doesn't exist / unreadable - not this function's concern to report, just skip it
    }
    for (const entry of entries) {
      if (found.length >= FALLBACK_SCAN_MAX_FILES) return;
      if (FALLBACK_SCAN_IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && isSourceFileName(entry.name) && !entry.name.endsWith(".d.ts")) {
        found.push(full);
      }
    }
  }
  for (const root of sourceRoots) walk(join(repoPath, root.path));
  return found;
}

/** Monorepo layouts without a root `tsconfig.json` (a `tsconfig.json` per package under per-package
 * subdirectories such as `packages/`, `apps/`, or `crates/` - e.g. biomejs/biome, calcom/cal.diy) are
 * never seen by `ts.findConfigFile()`, which starts at the repository root and walks UP, never DOWN
 * into subdirectories. This recursively discovers those per-package `tsconfig.json` files so the graph
 * can still be built from the repository's real TypeScript surface instead of crashing. Mirrors the
 * ignore set used by the source-file fallback scan so `node_modules` / build output / VCS internals are
 * never descended into. */
const NESTED_TSCONFIG_IGNORED_DIRS = FALLBACK_SCAN_IGNORED_DIRS;
/** Defensive cap on how many tsconfig files the nested walk will ever collect, mirroring the
 * source-file fallback's own bound - real monorepos have one per package, nowhere near this. */
const NESTED_TSCONFIG_MAX_FILES = 1_000;

export function discoverNestedTsconfigPaths(repoPath: string): string[] {
  const found: string[] = [];
  function walk(dirAbs: string): void {
    if (found.length >= NESTED_TSCONFIG_MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable directory - skip it, not this function's concern to report
    }
    for (const entry of entries) {
      if (found.length >= NESTED_TSCONFIG_MAX_FILES) return;
      if (NESTED_TSCONFIG_IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === "tsconfig.json") {
        found.push(full);
      }
    }
  }
  walk(repoPath);
  // Deterministic order: the option-merge below is "last wins", so a stable source order makes the
  // merged compiler options reproducible across filesystems (readdir order is OS-dependent).
  return found.sort();
}

function createProgram(
  repoPath: string,
  fallbackSourceRoots: SourceRoot[] = [],
  additionalSources: string[] = [],
  syntaxOnly = false,
): {
  program: ts.Program;
  options: ts.CompilerOptions;
  fileNames: readonly string[];
  resolvedViaProjectReferences: boolean;
} {
  // Phase 01 F5 (2026-08-26). This was `ts.findConfigFile(repoPath, ...)`, which starts at repoPath
  // and walks UP - so a repository cloned beneath any directory containing a tsconfig.json was
  // silently analysed against that ANCESTOR's project instead of its own. Flagged as a known latent
  // bug in src/research/repository/collector.ts and left unfixed since. It never bit the container
  // pipeline (clones land at /repos/<name>, with nothing above them) but it corrupts every local run,
  // which is precisely how this phase's own verification is done. Clamped to the repository root:
  // identical behaviour when a root tsconfig exists, and no escape when it does not.
  const rootConfigCandidate = join(repoPath, "tsconfig.json");
  const configPath = ts.sys.fileExists(rootConfigCandidate) ? rootConfigCandidate : undefined;

  let fileNames: readonly string[] = [];
  let options: ts.CompilerOptions = {};
  let resolvedViaProjectReferences = false;
  let configFileParsingDiagnostics: readonly ts.Diagnostic[] = [];

  if (configPath) {
    const { config, error } = ts.readConfigFile(toPosix(configPath), ts.sys.readFile);
    if (error) {
      throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
    }

    const parsed = ts.parseJsonConfigFileContent(
      config,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
    );

    fileNames = parsed.fileNames;
    options = parsed.options;
    configFileParsingDiagnostics = parsed.errors;

    // Expand project references whenever the root DECLARES them - not only when the root itself
    // yielded no files.
    //
    // The condition was `fileNames.length === 0`, which assumed a solution-style root contributes
    // nothing of its own. Real ones do. Measured 2026-08-30:
    //
    //   typescript-eslint  root has "files": [] yet parses to 3 file names and 19 references. The gate
    //                      was false, references were never expanded, and the graph came back with 310
    //                      nodes of which 308 were tests and TWO were non-test files - the repository's
    //                      entire source absent, while ast-spec/tsconfig.build.json alone holds 253
    //                      files two levels down.
    //   babel              the same gate, masked: its root `include` pulls in ~500 files directly, so
    //                      the graph looked plausible at 511 nodes while holding 421 of 697
    //                      packages/*/src files - 60% coverage, silently.
    //
    // THE INVARIANT IS A UNION, not a replacement: the program contains the root project's own inputs
    // AND the recursively resolved reference inputs. Replacing would delete Babel's 421 root-included
    // files the moment expansion began working for it.
    if (parsed.projectReferences && parsed.projectReferences.length > 0) {
      const visited = new Set<string>([ts.sys.resolvePath ? ts.sys.resolvePath(configPath) : configPath]);
      const collected: { fileNames: string[]; optionsList: ts.CompilerOptions[] } = { fileNames: [], optionsList: [] };
      for (const ref of parsed.projectReferences) {
        const refConfigPath = ts.resolveProjectReferencePath(ref);
        if (!ts.sys.fileExists(refConfigPath)) continue;
        const nested = resolveProjectReferenceInputs(refConfigPath, visited);
        collected.fileNames.push(...nested.fileNames);
        collected.optionsList.push(...nested.optionsList);
      }
      if (collected.fileNames.length > 0) {
        fileNames = Array.from(new Set([...fileNames, ...collected.fileNames]));
        // Best-effort merge, as before: later-referenced projects' options win over earlier ones. The
        // root's own options are applied LAST so the config the caller actually pointed at still wins -
        // which is also what keeps a mixed root's existing behaviour unchanged. This is an
        // approximation (referenced projects can legitimately differ) but it is used only for import
        // resolution and AST parsing here, not for type checking.
        const mergedReferences = collected.optionsList.reduce((merged, opts) => ({ ...merged, ...opts }), {} as ts.CompilerOptions);
        options = { ...mergedReferences, ...options };
        resolvedViaProjectReferences = true;
      }
    }
  } else {
    // No root tsconfig.json. Instead of throwing (which previously crashed the whole analysis for
    // every monorepo with only per-package tsconfigs - biomejs/biome, calcom/cal.diy, and the 2026-08-24
    // blind baseline's "tsconfig crash" finding), discover the repository's nested per-package tsconfigs
    // and merge their inputs exactly like project references. The same "multiple sub-projects' compiler
    // options merged into one best-effort approximation" caveat applies, so resolvedViaProjectReferences
    // is set to cap confidence at PARTIAL. If there is genuinely no tsconfig anywhere (pure-Rust repo,
    // plain-JS repo), fileNames stays empty and computeConfidence() reports UNSAFE - a conservative
    // FALLBACK rather than an unhandled exception.
    const nestedConfigPaths = discoverNestedTsconfigPaths(repoPath);
    if (nestedConfigPaths.length > 0) {
      const visited = new Set<string>();
      const collected: { fileNames: string[]; optionsList: ts.CompilerOptions[] } = { fileNames: [], optionsList: [] };
      for (const nestedPath of nestedConfigPaths) {
        const nested = resolveProjectReferenceInputs(nestedPath, visited);
        collected.fileNames.push(...nested.fileNames);
        collected.optionsList.push(...nested.optionsList);
      }
      if (collected.fileNames.length > 0) {
        fileNames = Array.from(new Set(collected.fileNames));
        options = collected.optionsList.reduce((merged, opts) => ({ ...merged, ...opts }), {} as ts.CompilerOptions);
        resolvedViaProjectReferences = true;
      }
    }
  }

  // Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md), root-caused in Stage 1A
  // (sindresorhus/execa): a real repository's tsconfig can exist and be entirely valid (so the repo is
  // correctly not excluded by the "no tsconfig" rule) yet be scoped ONLY to declaration-file validation
  // via an explicit "files" list with no "include" glob (a genuine, non-niche pattern for ESM-first
  // packages that hand-author both .js source and a separate .d.ts for `tsc`-only type-checking) - the
  // resulting Program never loads any real .js/.ts implementation source at all, producing a graph with
  // (effectively) zero source nodes despite real, testable code existing. Trigger is narrow and
  // specific: the tsconfig's own file list resolved to at least one file, but EVERY one of them is a
  // declaration file - not "the file list is merely small" (a genuinely small, correctly-scoped
  // tsconfig should not be second-guessed). When triggered, independently-discovered source files
  // (analyzer.ts's own glob-based source-root scan, entirely separate from and unaffected by the
  // tsconfig's own file-list scoping) are ADDED to the Program's root files - never replacing what the
  // tsconfig specified, only supplementing it.
  if (fileNames.length > 0 && fileNames.every((f) => f.endsWith(".d.ts")) && fallbackSourceRoots.length > 0) {
    const discovered = discoverFallbackSourceFiles(repoPath, fallbackSourceRoots);
    if (discovered.length > 0) {
      fileNames = Array.from(new Set([...fileNames, ...discovered]));
      // Real-world validation finding (2026-08-21, docs/research/2026-08-21-stage1b-*.md): merely
      // adding discovered .js files to rootNames is not sufficient - a tsconfig scoped to declaration-
      // only validation (this fallback's whole trigger condition) was never designed to compile .js at
      // all, so it correctly never sets allowJs. Without it, TypeScript does not treat the
      // fallback-added .js files as valid program members for AST/import extraction purposes. Only
      // forced on when the fallback itself already fired - never changes behavior for a repo whose
      // tsconfig was never mis-scoped in the first place.
      options = { ...options, allowJs: true };
    }
  }

  if (additionalSources.length) {
    fileNames = [...new Set([...fileNames, ...additionalSources])];
    options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, ...options, allowJs: true };
  }
  // The graph extracts syntax and import edges; it never asks TypeScript for a type checker or
  // semantic diagnostics. Letting the Program resolve imports made it load every lib and node_modules
  // declaration file: 5.6s of a median 8.2s analysis across a dogfood repository's paired runs (2026-10-21
  // telemetry). Imports are resolved explicitly below with the original options, and an implementation
  // file the root list missed is parsed when an import reaches it, within a budget that fails closed.
  // `syntaxOnly` (scoped analysis) used to be the only caller given these options.
  void syntaxOnly;
  const program = ts.createProgram({
    rootNames: fileNames,
    options: { ...options, noResolve: true, noLib: true, types: [] },
    configFileParsingDiagnostics,
  });

  return { program, options, fileNames, resolvedViaProjectReferences };
}

/**
 * Module resolution asks whether the same `node_modules` directories and candidate files exist for
 * every importer; the moduleResolutionCache does not cover those probes. They were the largest single
 * cost of graph construction (2026-10-21 profile). The tree does not change during one analysis, so
 * each answer is read from the disk once.
 */
function memoizedResolutionHost(system: ts.System): ts.ModuleResolutionHost {
  const memo = <T>(fn: (path: string) => T) => {
    const answers = new Map<string, T>();
    return (path: string) => {
      if (!answers.has(path)) answers.set(path, fn(path));
      return answers.get(path)!;
    };
  };
  return {
    fileExists: memo((path) => system.fileExists(path)),
    directoryExists: memo((path) => system.directoryExists(path)),
    readFile: memo((path) => system.readFile(path)),
    realpath: system.realpath ? memo((path) => system.realpath!(path)) : undefined,
    getCurrentDirectory: () => system.getCurrentDirectory(),
    getDirectories: memo((path) => system.getDirectories(path)),
    useCaseSensitiveFileNames: system.useCaseSensitiveFileNames,
  };
}

function classifySpecifier(specifier: string): "relative" | "absolute" | "alias" | "package" {
  if (specifier.startsWith("`./") || specifier.startsWith("`../")) return "relative";
  if (specifier.startsWith("./") || specifier.startsWith("../")) return "relative";
  if (specifier.startsWith("`/")) return "absolute";
  if (specifier.startsWith("/")) return "absolute";
  if (specifier.startsWith("`@/")) return "alias";
  if (specifier.startsWith("@/")) return "alias";
  if (specifier.startsWith("`~/")) return "alias";
  if (specifier.startsWith("~/")) return "alias";
  if (specifier.startsWith("`#")) return "alias";
  if (specifier.startsWith("#")) return "alias";
  return "package";
}

function expandAliasCandidates(
  specifier: string,
  aliases: { pattern: string; substitutions: string[] }[],
  repoPath: string,
): string[] {
  for (const { pattern, substitutions } of aliases) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (specifier.startsWith(prefix)) {
        const rest = specifier.slice(prefix.length);
        return substitutions.map((sub) => {
          const base = sub.endsWith("/*") ? sub.slice(0, -1) : sub;
          return resolve(repoPath, base, rest);
        });
      }
    } else if (specifier === pattern || specifier.startsWith(`${pattern}/`)) {
      return substitutions.map((sub) => resolve(repoPath, sub));
    }
  }
  return [];
}

/**
 * Bundler import-query suffixes (2026-08-23, deepseek-harness Phase 5): Vite/webpack allow
 * `import css from "../styles/base.css?inline"` / `?raw` / `?url` / `?worker` (no `#` handling). The
 * query changes HOW the bundler loads the file, never WHICH file - so for resolution purposes the
 * specifier is the path before the first `?`/`#`. Without this every such import was "unresolved
 * internal module", which made the whole ui-theme package UNSAFE and blocked 5 of 30 deepseek merges
 * on nothing else. Applied only to relative/absolute/alias specifiers (bare package names cannot carry
 * a query); the original specifier is still what gets recorded in references.
 */
function stripImportQuery(specifier: string): string {
  // Only `?` - a leading `#` is a Node subpath import (`#internal/x`), and `#fragment` is not a bundler convention.
  const cut = specifier.indexOf("?");
  return cut <= 0 ? specifier : specifier.slice(0, cut);
}

function findAssetCandidate(
  importerAbs: string,
  specifier: string,
  aliases: { pattern: string; substitutions: string[] }[],
  repoPath: string,
): string | undefined {
  const candidates: string[] = [];
  if (specifier.startsWith(".")) {
    candidates.push(resolve(dirname(importerAbs), specifier));
  } else if (specifier.startsWith("/")) {
    candidates.push(resolve(repoPath, specifier.slice(1)));
  } else {
    candidates.push(...expandAliasCandidates(specifier, aliases, repoPath));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface BuildDependencyGraphOptions extends AnalyzeRepositoryOptions {
  vueAnalysisCache?: { directory: string; version: string };
}

export async function buildDependencyGraph(
  options: BuildDependencyGraphOptions = {},
): Promise<DependencyGraphResult> {
  const start = process.hrtime.bigint();
  const phasesMs: Record<string, number> = {};
  let phaseStart = start;
  const markPhase = (name: string) => {
    const now = process.hrtime.bigint();
    phasesMs[name] = Number(now - phaseStart) / 1_000_000;
    phaseStart = now;
  };
  const repoPath = options.repoPath ? resolve(options.repoPath) : process.cwd();

  const profile = analyzeRepository(options);
  markPhase("repositoryDiscovery");
  const scopeBlockers = applyVueScope(repoPath, profile);
  markPhase("scopeDiscovery");
  const scope = profile.vueScope;
  const physicalRepoRoot = scope ? realpathSync.native(repoPath) : "";
  const physicalPackageRoot = scope ? realpathSync.native(join(repoPath, scope.packageRoot)) : "";
  const scopePathChecks = new Map<string, boolean>();
  const outsideScope = (path: string): boolean => {
    if (!scope) return false;
    const cached = scopePathChecks.get(path);
    if (cached !== undefined) return cached;
    const lexicalOutside = !inVuePackage(path, scope.packageRoot) && !path.split("/").includes("node_modules");
    let outside = lexicalOutside;
    if (!outside && existsSync(join(repoPath, path))) {
      const physical = realpathSync.native(join(repoPath, path));
      const packageRelative = relative(physicalPackageRoot, physical).replace(/\\/g, "/");
      const repositoryRelative = relative(physicalRepoRoot, physical).replace(/\\/g, "/");
      outside = (packageRelative === ".." || packageRelative.startsWith("../") || /^[A-Za-z]:|^\//.test(packageRelative)) &&
        !(!repositoryRelative.startsWith("../") && !/^[A-Za-z]:|^\//.test(repositoryRelative) && (repositoryRelative.startsWith("node_modules/") || repositoryRelative.includes("/node_modules/")));
    }
    scopePathChecks.set(path, outside);
    return outside;
  };
  const files = adapterFiles(repoPath, options.excludeDirs).filter(path => !scope || inVuePackage(path, scope.packageRoot));
  markPhase("adapterInventory");
  const context = { repoPath, files, profile, vueAnalysisSession: {} };
  const cachedVue = options.vueAnalysisCache ? (await import("../cache/vue-analysis-cache.js")).analyzeVueCached : undefined;
  const contributions = REPOSITORY_ADAPTERS.filter((adapter) => adapter.detect(context)).map((adapter) => adapter.id === "vue" && cachedVue && options.vueAnalysisCache
    ? cachedVue(context, options.vueAnalysisCache.directory, options.vueAnalysisCache.version) : adapter.analyze(context));
  markPhase("adapters");
  const adapterBlockers = [...scopeBlockers, ...contributions.flatMap((item) => item.blockers)];
  // The directories each narrowable blocker is confined to ("" when one of its files is not confined).
  // Outside a declared Vue suite, a blocker confined to directories only is scoped to them below.
  const blockerScopes = new Map<string, Set<string>>();
  const addScope = (reason: string, directory: string) => {
    if (scope) return;
    let scopes = blockerScopes.get(reason);
    if (!scopes) blockerScopes.set(reason, scopes = new Set());
    scopes.add(directory);
  };
  const packageDirectories = new Map<string, string>();
  const packageScope = (path: string) => nearestPackageDirectory(repoPath, path, packageDirectories);
  const workspaceRoots = new Set(declaredWorkspaceRoots(repoPath));
  const workspaceSources = new WorkspaceSources(repoPath, workspaceRoots);
  // The package manager links workspace packages only into workspace members (and the root project).
  const inWorkspace = (rel: string) => { const directory = packageScope(rel); return directory === "" || workspaceRoots.has(directory); };
  let realRepoRoot: string | undefined;
  const physicalRelative = (file: string): string | undefined => {
    try {
      realRepoRoot ??= realpathSync.native(repoPath);
      const rel = relative(realRepoRoot, realpathSync.native(file)).replace(/\\/g, "/");
      return rel && !rel.startsWith("../") && rel !== ".." && !isAbsolute(rel) ? rel : undefined;
    } catch { return undefined; }
  };
  for (const item of contributions) for (const { path, reason } of [...(item.fileBlockers ?? []), ...(item.subjectBlockers ?? [])]) addScope(reason, packageScope(path));
  if (profile.diffciConfig?.configurationError && !adapterBlockers.includes(profile.diffciConfig.configurationError)) adapterBlockers.push(profile.diffciConfig.configurationError);
  if (contributions.some((item) => item.id === "go") && files.some((file) => /\.(?:[cm]?[jt]sx?|vue)$/.test(file))) {
    adapterBlockers.push("Mixed Go/JavaScript repositories require explicit cross-language dependencies; full validation required");
  }
  const pythonModeled = contributions.some((item) => item.id === "python");
  const unmodeledLanguageFiles = contributions.length ? files.filter((file) => (!pythonModeled && /\.py$/.test(file)) || /\.(?:rs|cs|svelte|astro)$/.test(file) || !contributions.some((item) => item.id === "maven") && /\.(?:java|kt)$/.test(file)) : [];
  if (unmodeledLanguageFiles.length) {
    const reason = "Unmodeled languages alongside an adapter require full validation";
    adapterBlockers.push(reason);
    // Files in a top-level dot-directory outside every package (agent skills, editor tooling) are confined
    // to that directory: no package's sources or tests can load them.
    for (const file of unmodeledLanguageFiles) addScope(reason, packageScope(file) || (/^\.[^/]+\//.test(file) && !file.startsWith(".github/") ? file.slice(0, file.indexOf("/")) : ""));
  }
  profile.adapters = contributions.map(({ id, version, blockers }) => ({ id, version, blockers }));
  profile.goTestPackages = Object.assign({}, ...contributions.map((item) => item.testPackages));
  profile.goTestEnvironment = contributions.find((item) => item.id === "go")?.executionEnv;
  const goContribution = contributions.find((item) => item.id === "go");
  profile.goDependencyPaths = goContribution ? {
    sources: [...new Set(goContribution.sourcePaths)].sort(),
    embeds: [...new Set(goContribution.assetPaths)].sort(),
  } : undefined;
  profile.mavenTestModules = Object.assign({}, ...contributions.filter((item) => item.id === "maven").map((item) => item.testPackages));
  const pythonContribution = contributions.find((item) => item.id === "python");
  if (pythonContribution) {
    profile.pythonSources = [...new Set(pythonContribution.sourcePaths)].sort();
    profile.pythonTests = [...new Set(pythonContribution.testFiles)].sort();
    if (pythonContribution.interpreter) profile.pythonInterpreter = pythonContribution.interpreter;
  }
  const adapterTests = contributions.flatMap((item) => item.testFiles);
  profile.testFilePaths = [...new Set([...profile.testFilePaths, ...adapterTests])].sort();
  if (profile.testUniverse) {
    profile.testUniverse.discoveredTestFiles = profile.testFilePaths.length;
    profile.testUniverse.blindSpot = (profile.testUniverse.declaredFrameworks.length > 0 || contributions.some((item) => item.id === "go" || item.id === "maven" || item.id === "python")) && profile.testFilePaths.length === 0;
  }
  const entryPointPaths = new Set(profile.entryPoints.map((e) => e.path));

  const vueSources = scope || contributions.some((item) => item.id === "vue")
    ? files.filter((file) => /\.[cm]?[jt]sx?$/.test(file)).map((file) => join(repoPath, file)) : [];
  // Runner tests excluded by tsconfig still need their import edges in the graph.
  const testSources = profile.testFilePaths
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .map((file) => join(repoPath, file));
  let { program, options: compilerOptions, resolvedViaProjectReferences } = createProgram(scope ? join(repoPath, scope.packageRoot) : repoPath, scope ? [] : profile.sourceRoots, [...vueSources, ...testSources], Boolean(scope));
  markPhase("typescriptProgram");
  let moduleResolutionCache = ts.createModuleResolutionCache(
    repoPath,
    (x) => x,
    compilerOptions,
  );

  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => sf.fileName && !sf.fileName.endsWith(".d.ts") && (!scope || inVuePackage(toRelativeInternal(repoPath, sf.fileName) ?? "", scope.packageRoot)));
  for (const item of contributions) {
    for (const virtual of item.virtualSources) {
      sourceFiles.push(ts.createSourceFile(join(repoPath, virtual.path), virtual.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
    }
  }

  const internalSourcePaths = new Set<string>();

  for (const sf of sourceFiles) {
    const rel = toRelativeInternal(repoPath, sf.fileName);
    if (rel && isSourceFileName(sf.fileName) && !isExcludedPath(rel, options.excludeDirs ?? [])) {
      internalSourcePaths.add(rel);
    }
  }

  const edges: DependencyEdge[] = contributions.flatMap((item) => item.edges);
  const unresolved: UnresolvedDependency[] = [];
  const references: ResolutionReference[] = [];
  const assetPaths = new Set<string>(contributions.flatMap((item) => item.assetPaths));
  for (const item of contributions) for (const path of item.sourcePaths) internalSourcePaths.add(path);
  const edgeKeys = new Set<string>(edges.map((edge) => `${edge.from}|${edge.to}|${edge.kind}`));
  const bindings: Record<string, ModuleBindings> = {};
  const bindingsOf = (path: string): ModuleBindings => (bindings[path] ??= { locals: [], imports: {}, reexports: {} });

  /** Records what a runtime edge binds; an edge without a parsed statement binds the whole module. */
  function recordBinding(from: string, to: string, kind: DependencyEdgeKind, ref?: ImportRef): void {
    if (kind === "asset") return;
    const b = bindingsOf(from);
    if (kind === "type-import") {
      if (!(b.typeImports ??= []).includes(to)) b.typeImports.push(to);
      return;
    }
    if (ref?.reexport) {
      const r = (b.reexports[to] ??= { pairs: [], star: false, namespaces: [] });
      if (ref.reexport.star) r.star = true;
      if (ref.reexport.namespace) r.namespaces.push(ref.reexport.namespace);
      for (const pair of ref.reexport.pairs ?? []) r.pairs.push(pair);
      return;
    }
    const current = b.imports[to];
    if (!ref?.names || current === "*") b.imports[to] = "*";
    else b.imports[to] = [...new Set([...(current ?? []), ...ref.names])];
  }

  function addEdge(from: string, to: string, kind: DependencyEdgeKind, ref?: ImportRef): void {
    recordBinding(from, to, kind, ref);
    const key = `${from}|${to}|${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind });
  }

  function recordUnresolved(
    importerRel: string,
    ref: ImportRef,
    reason: string,
  ): void {
    if (ref.mock) return;
    unresolved.push({
      importer: importerRel,
      specifier: ref.specifier,
      reason,
      dynamic: ref.dynamic,
      ...(ref.computed ? { computed: true } : {}),
      typeOnly: ref.kind === "type-import",
    });
  }

  function recordReference(
    resolution: ResolutionReference["resolution"],
    importer: string,
    ref: ImportRef,
  ): void {
    if (ref.mock && resolution === "unresolved") return;
    references.push({
      resolution,
      specifier: ref.specifier,
      importer,
      kind: ref.kind,
      dynamic: ref.dynamic,
    });
  }

  function recordAssetEdge(importerRel: string, assetRel: string): void {
    assetPaths.add(assetRel);
    addEdge(importerRel, assetRel, "asset");
  }

  let fileSet: Set<string> | undefined;
  /** Where Vite may resolve a root-absolute glob for this importer: each enclosing directory holding a
   * Vite or Vitest configuration, and the repository root (Vite's default root when run from there).
   * Matches in every candidate are unioned, which can only over-select (2026-11-06: LobeHub's
   * `import.meta.glob('/locales/*\/ui.json')` kept two desktop tests selected on every commit). */
  function viteRoots(importerAbs: string): string[] {
    const roots = new Set<string>([repoPath]);
    for (let directory = dirname(importerAbs); toRelativeInternal(repoPath, directory) !== undefined; directory = dirname(directory)) {
      const rel = toRelativeInternal(repoPath, directory)!;
      const prefix = rel === "." ? "" : `${rel}/`;
      if (VITE_CONFIG_NAMES.some((name) => (fileSet ??= new Set(files)).has(prefix + name))) roots.add(directory);
      if (rel === "." || dirname(directory) === directory) break;
    }
    return [...roots];
  }

  /** Every repository file a bounded computed load can name, or undefined to keep it computed: the
   * base directory does not resolve, nothing matches, or a match is neither analyzed source nor an
   * asset. Alias directories resolve as in findAssetCandidate, and all candidates are unioned. */
  function resolvePatternTargets(importerAbs: string, patterns: NonNullable<ImportRef["patterns"]>, importerOptions: ts.CompilerOptions): string[] | undefined {
    const compilerAliases = Object.entries(importerOptions.paths ?? {}).map(([pattern, substitutions]) => ({ pattern, substitutions }));
    const aliasRoot = importerOptions.baseUrl ?? (importerOptions as { pathsBasePath?: string }).pathsBasePath ?? repoPath;
    const included = new Set<string>();
    const excluded = new Set<string>();
    for (const pattern of patterns) {
      const base = pattern.base.replace(/\/+$/, "") || ".";
      if (base.startsWith("/") && !pattern.viteRoot) return undefined;
      const directories = pattern.viteRoot ? viteRoots(importerAbs).map((root) => join(root, base))
        : base.startsWith(".") ? [resolve(dirname(importerAbs), base)]
        : [...expandAliasCandidates(base, compilerAliases, aliasRoot), ...expandAliasCandidates(base, profile.pathAliases, repoPath)];
      const matcher = new RegExp(`^${pattern.regex}$`);
      for (const directory of directories) {
        const rel = toRelativeInternal(repoPath, directory);
        if (rel === undefined) continue;
        const prefix = rel === "." ? "" : `${rel}/`;
        for (const file of files) {
          if (file.startsWith(prefix) && matcher.test(file.slice(prefix.length))) (pattern.negated ? excluded : included).add(file);
        }
      }
    }
    const importerRel = toRelativeInternal(repoPath, importerAbs);
    const targets = [...included].filter((file) => !excluded.has(file) && file !== importerRel).sort();
    if (!targets.length || targets.some((file) => !internalSourcePaths.has(file) && !isAssetFileName(file))) return undefined;
    return targets;
  }

  let filesParsed = sourceFiles.length;
  let followedImplementationFiles = 0;
  // Implementation files outside the tsconfig inventory that an import may still pull in before the graph
  // fails closed. A fixed 500 was too small for monorepos whose tests and their helpers sit outside every
  // tsconfig: 2026-11-06, payloadcms/payload's solution tsconfig covers packages/*/src only, while test/,
  // templates/ and tools/ hold about 2,700 imported source files, so every commit was UNSAFE with about
  // 220 blockers. Scale with the repository instead, keeping a floor for small inventories.
  const followBudget = Math.max(5000, sourceFiles.length);

  // Resolve each importer with its own nearest project, never another package's
  // aliases. Invalid project configuration remains a hard safety blocker.
  const projectOptions = new Map<string, ts.CompilerOptions>();
  const resolutionHost = memoizedResolutionHost(ts.sys);
  function hasUnavailableExternalBase(config: unknown, errors: readonly ts.Diagnostic[]): boolean {
    if (!config || typeof config !== "object") return false;
    const rawExtends = (config as { extends?: unknown }).extends;
    const entries = Array.isArray(rawExtends) ? rawExtends : [rawExtends];
    const hasPackageBase = entries.some(value =>
      typeof value === "string" && !value.startsWith(".") && !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value),
    );
    if (!hasPackageBase) return false;
    // A read-only source clone deliberately has no node_modules. TypeScript reports a package-based
    // `extends` that would normally be supplied by devDependencies as 5083/6053. The importing
    // project's own compilerOptions are still parsed and are safer than borrowing another package's
    // aliases. Any other diagnostic remains a hard blocker.
    return errors.every(error => error.code === 18003 || error.code === 5083 || error.code === 6053);
  }
  // The bundled TypeScript (5.9) rejects `target`/`lib` values that newer compilers accept, such as
  // TypeScript 6's "es2025" (jshttp/cookie, first GitLab run 2026-11-05: every plan FULL). Neither
  // option names a file or alias, so the rejection does not change what an import resolves to - with
  // one exception: an unset `module` defaults from `target`, and `moduleResolution` from `module`.
  // The diagnostic is therefore ignored only when the project states `module` or `moduleResolution`
  // itself. Every other 6046 (an unknown `module` or `moduleResolution` value) stays fatal.
  function isNewerTargetOrLibValue(error: ts.Diagnostic, parsedOptions: ts.CompilerOptions): boolean {
    if (error.code !== 6046) return false;
    if (parsedOptions.module === undefined && parsedOptions.moduleResolution === undefined) return false;
    const text = ts.flattenDiagnosticMessageText(error.messageText, "\n");
    return /'--(?:target|lib)'/.test(text);
  }
  // Nearest tsconfig.json per importer directory. Probing the disk for every importer walked to the
  // repository root once per file: about a third of graph build time on a 2,000-file repository (2026-10-21).
  const nearestConfig = new Map<string, ts.CompilerOptions>();
  function optionsFor(file: string): ts.CompilerOptions {
    const key = dirname(file);
    let options = nearestConfig.get(key);
    if (!options) { options = findOptionsFor(file); nearestConfig.set(key, options); }
    return options;
  }
  function findOptionsFor(file: string): ts.CompilerOptions {
    let directory = dirname(file);
    while (toRelativeInternal(repoPath, directory) !== undefined) {
      const config = join(directory, "tsconfig.json");
      if (existsSync(config)) {
        if (!projectOptions.has(config)) {
          const read = ts.readConfigFile(toPosix(config), ts.sys.readFile);
          const parsed = read.error ? undefined : ts.parseJsonConfigFileContent(read.config, ts.sys, directory, undefined, config);
          const errors = parsed ? parsed.errors.filter(error => !isNewerTargetOrLibValue(error, parsed.options)) : [];
          // No-input diagnostics do not invalidate module-resolution options.
          const invalid = !parsed || errors.some(error => error.code !== 18003)
            && !hasUnavailableExternalBase(read.config, errors);
          if (invalid) {
            const configRel = toRelativeInternal(repoPath, config);
            const reason = `Invalid importer TypeScript configuration: ${configRel}`;
            adapterBlockers.push(reason);
            // Only the files this configuration governs resolve with the wrong options. That is confined
            // to a nested package only when no workspace package links to it by name and nothing the
            // configuration states points outside the package (an alias there would hide its edges).
            if (configRel) addScope(reason, read.error ? "" : confinedConfigScope(repoPath, configRel, read.config, packageScope(configRel), workspaceRoots));
            projectOptions.set(config, compilerOptions);
          } else {
            // A target newer than the bundled compiler knows is at least its newest one.
            const droppedTarget = parsed.errors.some(error => !errors.includes(error) && /'--target'/.test(ts.flattenDiagnosticMessageText(error.messageText, "\n")));
            projectOptions.set(config, droppedTarget && parsed.options.target === undefined ? { ...parsed.options, target: ts.ScriptTarget.ESNext } : parsed.options);
          }
        }
        return projectOptions.get(config)!;
      }
      if (directory === repoPath || dirname(directory) === directory) break;
      directory = dirname(directory);
    }
    return compilerOptions;
  }

  /** Parses an implementation file an import reaches outside the initial walk, rather than silently dropping
   * the edge or loading every TypeScript declaration library again; false, with a blocker, past the budget. */
  function followImplementation(absolute: string, rel: string): boolean {
    if (internalSourcePaths.has(rel)) return true;
    try {
      if (isExcludedPath(rel, options.excludeDirs ?? []) || followedImplementationFiles >= followBudget || statSync(absolute).size > 5 * 1024 * 1024) throw new Error("excluded or exceeds parse budget");
      const followed = ts.createSourceFile(absolute, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
      if ((followed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) throw new Error("invalid implementation syntax");
      sourceFiles.push(followed);
      followedImplementationFiles++;
    } catch {
      adapterBlockers.push(`Resolved implementation cannot be included in the scoped source inventory: ${rel}`);
      return false;
    }
    internalSourcePaths.add(rel);
    return true;
  }

  for (const sf of sourceFiles) {
    const importerRel = toRelativeInternal(repoPath, sf.fileName);
    if (!importerRel || !isSourceFileName(sf.fileName)) continue;
    if (isExcludedPath(importerRel, options.excludeDirs ?? [])) continue;

    const importerOptions = optionsFor(sf.fileName);

    const keepsTypeImports = keepsTypeOnlyImports(importerOptions);
    const refs = extractImportRefs(sf).map((ref) => ref.inlineTypeOnly && !keepsTypeImports ? { ...ref, kind: "type-import" as const } : ref);
    const { locals, opaque } = exportedLocals(sf);
    const own = bindingsOf(importerRel);
    own.locals = locals;
    if (opaque) own.opaque = true;
    if (scope && sf.referencedFiles.length) adapterBlockers.push(`Triple-slash file references in the scoped suite require full validation: ${importerRel}`);
    for (const ref of refs) {
      // Expression text is not a module name. In particular, import(name) must
      // not be classified as an external package called "name".
      if (ref.computed && ref.atLoad) bindingsOf(importerRel).computedAtLoad = true;
      if (ref.computed && ref.patterns) {
        const targets = resolvePatternTargets(sf.fileName, ref.patterns, importerOptions);
        if (targets) {
          for (const target of targets) {
            if (internalSourcePaths.has(target)) addEdge(importerRel, target, ref.kind, ref);
            else recordAssetEdge(importerRel, target);
          }
          recordReference(targets.some((target) => internalSourcePaths.has(target)) ? "internal-source" : "internal-asset", importerRel, ref);
          continue;
        }
      }
      if (ref.computed) {
        recordUnresolved(importerRel, ref, "computed module specifier requires full validation");
        recordReference("unresolved", importerRel, ref);
        continue;
      }
      if (!ref.specifier) {
        recordUnresolved(importerRel, ref, "empty specifier");
        recordReference("unresolved", importerRel, ref);
        continue;
      }

      if (isNodeBuiltin(ref.specifier)) {
        recordReference("platform-builtin", importerRel, ref);
        continue;
      }

      const specifierCategory = classifySpecifier(ref.specifier);
      const resolvableSpecifier = specifierCategory === "relative" || specifierCategory === "absolute" || specifierCategory === "alias" ? stripImportQuery(ref.specifier) : ref.specifier;
      // TypeScript may resolve a Vue import to a declaration shim. Preserve the actual SFC edge.
      if (resolvableSpecifier.endsWith(".vue")) {
        const compilerAliases = Object.entries(importerOptions.paths ?? {}).map(([pattern, substitutions]) => ({ pattern, substitutions }));
        const candidate = findAssetCandidate(sf.fileName, resolvableSpecifier, compilerAliases.length ? compilerAliases : profile.pathAliases, importerOptions.baseUrl ?? dirname(sf.fileName));
        const target = candidate && toRelativeInternal(repoPath, candidate);
        if (target && internalSourcePaths.has(target)) {
          addEdge(importerRel, target, ref.kind, ref);
          recordReference("internal-source", importerRel, ref);
          continue;
        }
        recordUnresolved(importerRel, ref, "Vue component not found in analyzed source inventory");
        recordReference("unresolved", importerRel, ref);
        continue;
      }
      const resolution = ts.resolveModuleName(
        resolvableSpecifier,
        sf.fileName,
        importerOptions,
        resolutionHost,
        moduleResolutionCache,
      );

      // A workspace package's build output is not its source (2026-11-09, Sentry: `@sentry/server-utils`
      // resolves to nothing before a build and to build/types/index.d.ts after one). Map the import to the
      // package's source file, or leave it external so the workspace guard falls back.
      const workspaceImport = !scope && specifierCategory === "package" && workspaceSources.size && inWorkspace(importerRel)
        ? workspaceSources.packageFor(resolvableSpecifier)
        : undefined;
      if (workspaceImport) {
        const { pkg, subpath } = workspaceImport;
        const resolvedFile = resolution.resolvedModule?.resolvedFileName;
        // Through real paths: a workspace link, or a repository path spelled differently (a Windows 8.3
        // short name), must still land inside the package.
        const resolvedRel = resolvedFile ? physicalRelative(resolvedFile) : undefined;
        const insidePackage = resolvedRel !== undefined && resolvedRel.startsWith(`${pkg.root}/`);
        if (!resolvedFile || (insidePackage && (/\.d\.[mc]?ts$/.test(resolvedRel!) || !internalSourcePaths.has(resolvedRel!)))) {
          const source = (insidePackage ? workspaceSources.sourceForFile(pkg, resolvedRel!) : undefined) ?? workspaceSources.sourceForSubpath(pkg, subpath);
          const asset = source ? undefined : workspaceSources.assetForSubpath(pkg, subpath);
          if (asset) {
            recordAssetEdge(importerRel, asset);
            recordReference("internal-asset", importerRel, ref);
            continue;
          }
          // The package's source may sit outside the tsconfig inventory (payloadcms/payload's solution tsconfig
          // references only some packages): parse it like any other followed implementation.
          if (source && (internalSourcePaths.has(source) || (!/\.d\.[mc]?ts$/.test(source) && followImplementation(join(repoPath, source), source)))) {
            addEdge(importerRel, source, ref.kind, ref);
            recordReference("internal-source", importerRel, ref);
          } else {
            recordReference("external-package", importerRel, ref);
          }
          continue;
        }
      }

      if (!resolution.resolvedModule || !resolution.resolvedModule.resolvedFileName) {
        const category = classifySpecifier(ref.specifier);
        if (category === "relative" || category === "absolute" || category === "alias") {
          const assetAbs = findAssetCandidate(
            sf.fileName,
            resolvableSpecifier,
            profile.pathAliases,
            repoPath,
          );
          if (assetAbs) {
            const assetRel = toRelativeInternal(repoPath, assetAbs);
            if (assetRel) {
              recordAssetEdge(importerRel, assetRel);
              recordReference("internal-asset", importerRel, ref);
              continue;
            }
          }
          recordUnresolved(importerRel, ref, "unresolved internal module");
          recordReference("unresolved", importerRel, ref);
        } else {
          recordReference("external-package", importerRel, ref);
        }
        continue;
      }

      const resolved = resolution.resolvedModule.resolvedFileName;
      const targetRel = toRelativeInternal(repoPath, resolved);
      // The generic internal-path helper intentionally hides root node_modules.
      // Scope validation must still follow those paths to catch workspace symlinks.
      const scopeTarget = scope ? relative(physicalRepoRoot, realpathSync.native(resolved)).replace(/\\/g, "/") : targetRel;
      if (scopeTarget && outsideScope(scopeTarget)) {
        adapterBlockers.push(`Vue dependency crosses the declared package boundary: ${importerRel} -> ${scopeTarget}`);
        continue;
      }
      if (scope && resolution.resolvedModule.isExternalLibraryImport && (!targetRel || targetRel.split("/").includes("node_modules"))) {
        recordReference("external-package", importerRel, ref);
        continue;
      }

      if (targetRel && isSourceFileName(resolved)) {
        if (!resolved.endsWith(".d.ts") && !followImplementation(resolved, targetRel)) continue;
        internalSourcePaths.add(targetRel);
        addEdge(importerRel, targetRel, ref.kind, ref);
        recordReference("internal-source", importerRel, ref);
        continue;
      }

      if (targetRel && isAssetFileName(resolved)) {
        recordAssetEdge(importerRel, targetRel);
        recordReference("internal-asset", importerRel, ref);
        continue;
      }

      const category = classifySpecifier(ref.specifier);
      if (category === "relative" || category === "absolute" || category === "alias") {
        const reason = targetRel
          ? "resolved to non-source internal file"
          : "resolved outside repository";
        recordUnresolved(importerRel, ref, reason);
        recordReference("unresolved", importerRel, ref);
      } else {
        recordReference("external-package", importerRel, ref);
      }
    }
  }

  // Only a verified scoped suite can establish that a component is not executed.
  // Every test and setup/config root must actually have been parsed, not merely
  // added as a leaf test node. Unknown reachable components still block the suite.
  if (scope && scopeBlockers.length === 0 && profile.testFilePaths.length) {
    const roots = [...profile.testFilePaths, ...(profile.vueSetupPaths ?? [])];
    const parsedPaths = new Set(sourceFiles.map(file => toRelativeInternal(repoPath, file.fileName)).filter(Boolean));
    if (roots.every(path => parsedPaths.has(path))) {
      const outgoing = new Map<string, string[]>();
      for (const edge of edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
      const reachable = new Set(roots); const pending = [...roots];
      while (pending.length) for (const target of outgoing.get(pending.pop()!) ?? []) if (!reachable.has(target)) { reachable.add(target); pending.push(target); }
      const vue = contributions.find(item => item.id === "vue");
      const irrelevant = new Set((vue?.fileBlockers ?? []).filter(item => !reachable.has(item.path)).map(item => item.reason));
      const outOfSuiteBlockers = irrelevant.size;
      if (profile.vueRuntimeIsolationVerified) {
        const closure = (starts: string[]) => {
          const visited = new Set(starts); const queue = [...starts];
          while (queue.length) for (const target of outgoing.get(queue.pop()!) ?? []) if (!visited.has(target)) { visited.add(target); queue.push(target); }
          return visited;
        };
        const shared = closure(profile.vueSetupPaths ?? []);
        const runtime = (vue?.fileBlockers ?? []).filter(item => item.reason === `Vue ${item.path}: runtime component/directive resolution requires full validation` && reachable.has(item.path));
        // Unknown outgoing runtime edges affect every test reaching this component.
        // Run all such isolated test files for EVERY delta, regardless of static impact.
        // Shared setup/configuration uncertainty cannot be confined to those files.
        if (runtime.length && runtime.every(item => !shared.has(item.path))) {
          const targets = new Set(runtime.map(item => item.path));
          profile.vueRuntimeAlwaysRunPaths = profile.testFilePaths.filter(path => [...closure([path])].some(dependency => targets.has(dependency)));
          for (const item of runtime) irrelevant.add(item.reason);
        }
      }
      for (let i = adapterBlockers.length - 1; i >= 0; i--) if (irrelevant.has(adapterBlockers[i])) adapterBlockers.splice(i, 1);
      if (vue?.performance) Object.assign(vue.performance.counts, { verifiedSuiteRoots: roots.length, reachablePaths: reachable.size, outOfSuiteBlockers, runtimeAlwaysRunTests: profile.vueRuntimeAlwaysRunPaths?.length ?? 0 });
    }
  }
  const unresolvedVue = unresolved.filter((ref) => ref.importer.endsWith(".vue") || stripImportQuery(ref.specifier).endsWith(".vue"));
  if (unresolvedVue.length) {
    const reason = "Unresolved Vue dependencies require full validation";
    adapterBlockers.push(reason);
    for (const ref of unresolvedVue) addScope(reason, packageScope(ref.importer));
  }
  filesParsed = sourceFiles.length;
  if (scope && unresolved.length) adapterBlockers.push("Unresolved dependencies in the declared Vue suite require full validation");
  if (scope && edges.some(edge => outsideScope(edge.from) || outsideScope(edge.to))) adapterBlockers.push("Vue asset or macro dependency crosses the declared package boundary");
  const scopedAdapterBlockers = scopeAdapterBlockers(adapterBlockers, blockerScopes);
  // A type-only import of a subpath the package neither exports nor contains resolves nowhere, installed or not
  // (payloadcms/payload's stale `import type { ... } from 'payload/types'`): it hides no edge a change can reach.
  const namesNothing = (ref: ResolutionReference) => {
    if (ref.kind !== "type-import") return false;
    const target = workspaceSources.packageFor(stripImportQuery(ref.specifier));
    return target !== undefined && !workspaceSources.names(target.pkg, target.subpath);
  };
  scopedAdapterBlockers.push(...uninstalledWorkspaceBlockers(repoPath, references.filter((ref) => inWorkspace(ref.importer) && !namesNothing(ref)), workspaceRoots));
  profile.adapterBlockers = [...adapterBlockers];
  markPhase("importExtractionAndResolution");

  // Nested-package test visibility (2026-08-24, biomejs/biome finding): `internalSourcePaths` above is
  // strictly the TS PROGRAM's own file list (createProgram()'s `include`/nested-tsconfig-merged
  // fileNames) - so a package whose own tsconfig deliberately excludes its test directory (a real,
  // common pattern; confirmed verbatim on biome: `packages/@biomejs/js-api/tsconfig.json` has
  // `"exclude": ["./tests", "./dist"], "include": ["./src"]`) NEVER contributes those files to the
  // program, so they never became graph nodes and `totalTestsInGraph` stayed 0 even though
  // `profile.testFilePaths` (the separate, tsconfig-agnostic glob walk in analyzer.ts's discoverTests())
  // already found them correctly. Source-ROOT discovery itself was already correct (the 2026-08-21
  // zod/trpc fallback already lists `packages`/`crates` as roots for exactly this monorepo shape) - the
  // gap was narrower: the graph never incorporated what that walk found. Fix: union in any test file
  // discoverTests() found that the TS program's own file list missed, as an ADDITIONAL leaf node
  // (isTest true; no import edges - we have no real resolution info for a file the type-checker was
  // never asked to see, so dependency-graph traversal through it is honestly absent, not guessed at).
  // This does NOT add Rust visibility of any kind - testFilePaths only ever contains files already
  // matched by the JS/TS test-file patterns; a `.rs` test is never in it and stays "unknown" as before.
  for (const testPath of profile.testFilePaths) {
    if (!internalSourcePaths.has(testPath) && !assetPaths.has(testPath)) internalSourcePaths.add(testPath);
  }

  const graph = new DependencyGraphImpl(internalSourcePaths, assetPaths, edges, repoPath, testFileMatcherForProfile(profile));

  for (const node of graph.nodes) {
    node.isEntryPoint = entryPointPaths.has(node.path);
  }

  const heapDuringBuildMb = process.memoryUsage
    ? Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100
    : undefined;

  // Release the heavy TypeScript AST / program after graph extraction.
  program = undefined as unknown as ts.Program;
  moduleResolutionCache = undefined as unknown as ts.ModuleResolutionCache;
  if (typeof globalThis.gc === "function") {
    try { globalThis.gc(); } catch { /* ignore */ }
  }

  const heapAfterExtractionMb = process.memoryUsage
    ? Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100
    : undefined;

  profile.stats.sourceFiles = graph.nodes.filter((n) => n.isSource).length;
  profile.stats.testFiles = graph.nodes.filter((n) => n.isTest).length;

  const integrity = validateDependencyGraph(graph);
  const dynamicUnresolvedCount = unresolved.filter((u) => u.dynamic).length;
  const confidenceWithoutScopedBlockers = adapterBlockers.length ? "UNSAFE" : computeConfidence(
    unresolved.length,
    dynamicUnresolvedCount,
    integrity.criticalCount,
    profile.stats.sourceFiles,
    resolvedViaProjectReferences,
  );
  // The graph's own confidence still counts scoped blockers; only a delta can rule them out.
  const confidence = scopedAdapterBlockers.length ? "UNSAFE" : confidenceWithoutScopedBlockers;

  const internalAssetEdges = edges.filter((e) => e.kind === "asset").length;
  const externalReferences = references.filter((r) => r.resolution === "external-package").length;
  const platformBuiltinReferences = references.filter(
    (r) => r.resolution === "platform-builtin",
  ).length;
  const counts = {
    internalSource: references.filter((r) => r.resolution === "internal-source").length,
    internalAsset: internalAssetEdges,
    externalPackage: externalReferences,
    platformBuiltin: platformBuiltinReferences,
    unresolved: unresolved.length,
  };

  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  markPhase("graphFinalization");

  const performance: GraphPerformanceMetrics = {
    durationMs,
    phasesMs,
    adapterMetrics: Object.fromEntries(contributions.filter(item => item.performance).map(item => [item.id, item.performance!])),
    heapUsedMb: heapDuringBuildMb,
    heapAfterExtractionMb,
    filesDiscovered: filesParsed,
    filesParsed: filesParsed,
  };

  const sideEffectsByDir = new Map<string, boolean | undefined>();
  for (const [path, b] of Object.entries(bindings)) if (sideEffectFreePackage(repoPath, path, sideEffectsByDir)) b.sideEffectFree = true;

  return {
    graph,
    bindings,
    adapterBlockers,
    ...(scopedAdapterBlockers.length ? { scopedAdapterBlockers, confidenceWithoutScopedBlockers } : {}),
    profile,
    unresolved,
    references,
    counts,
    externalReferences,
    platformBuiltinReferences,
    internalAssetEdges,
    performance,
    confidence,
    integrity,
    resolvedViaProjectReferences,
    runtimeTestSelection: runtimeTestSelectionEligible(repoPath, files, profile),
    typeTestGlobs: typeTestGlobs(repoPath, files),
  };
}

export type TypeScriptProjectKind = "root" | "nested" | "none";

/** Product eligibility includes native adapters; legacy TS corpus classification stays separate. */
export function classifyRepositoryProject(repoPath: string): { capable: boolean; reason: string } {
  const typescript = classifyTypeScriptProject(repoPath);
  if (typescript.capable) return typescript;
  const files = adapterFiles(repoPath);
  if (files.includes("go.mod")) return { capable: true, reason: "Go module (package-level analysis)" };
  if (files.some((file) => file.endsWith(".vue"))) return { capable: true, reason: "Vue single-file components" };
  if (files.includes("pom.xml") && files.some((file) => file.endsWith(".java") || file.endsWith(".kt"))) return { capable: true, reason: "Maven reactor (module-level Java analysis)" };
  if (pythonAdapter.detect({ repoPath, files, profile: {} as RepositoryProfile })) return { capable: true, reason: "Python project tested with pytest (file-level import analysis)" };
  return { capable: false, reason: "No TypeScript project, Vue components, root Go module, Maven reactor, or Python project found" };
}

export interface TypeScriptProjectCapability {
  /** Whether createProgram() has any tsconfig at all to build a Program from. */
  capable: boolean;
  kind: TypeScriptProjectKind;
  /** Number of per-package tsconfigs found when `kind` is "nested". */
  nestedCount: number;
  reason: string;
}

/**
 * Can DiffCI build a dependency graph for this repository? (Phase 01 F3, 2026-08-26.)
 *
 * This exists so the eligibility gate cannot drift from what the graph builder can actually do -
 * which is exactly what happened. `src/repo/graph.ts` gained nested per-package tsconfig support on
 * 2026-08-24 (for biome and cal.diy); `collectMetadata()` kept refusing anything without a ROOT
 * tsconfig, with the message "DiffCI cannot analyze this repository". On the Phase 01 baseline both
 * `vitest-dev/vitest` and `facebook/docusaurus` were refused by that gate and then built real graphs
 * of 2118 and 1131 nodes. The message was not a limitation, it was out of date - and it cost roughly
 * 144 container launches a day before the ramp caught it.
 *
 * A nested-only layout is capable but not equivalent: createProgram() merges several sub-projects'
 * compiler options into one approximation, which caps graph confidence at PARTIAL. Callers should
 * report the kind rather than flatten it to a boolean.
 */
export function classifyTypeScriptProject(repoPath: string): TypeScriptProjectCapability {
  if (existsSync(join(repoPath, "tsconfig.json"))) {
    return { capable: true, kind: "root", nestedCount: 0, reason: "tsconfig.json at the repository root" };
  }
  const nested = discoverNestedTsconfigPaths(repoPath);
  if (nested.length > 0) {
    return {
      capable: true,
      kind: "nested",
      nestedCount: nested.length,
      reason: `no root tsconfig.json, but ${nested.length} per-package tsconfig.json file(s) the graph builder merges`,
    };
  }
  return {
    capable: false,
    kind: "none",
    nestedCount: 0,
    reason: "no tsconfig.json anywhere in the repository - there is no TypeScript project to build a graph from",
  };
}

export function validateDependencyGraph(graph: DependencyGraph): GraphIntegrityReport {
  const findings: GraphIntegrityFinding[] = [];
  const nodePaths = new Set(graph.nodes.map((n) => n.path));

  for (const edge of graph.edges) {
    if (!nodePaths.has(edge.from)) {
      findings.push({
        level: "critical",
        message: `Edge from nonexistent node: ${edge.from} -> ${edge.to}`,
      });
    }
    if (!nodePaths.has(edge.to)) {
      findings.push({
        level: "critical",
        message: `Edge to nonexistent node: ${edge.from} -> ${edge.to}`,
      });
    }
    if (edge.from.startsWith("../") || edge.from.includes("/../")) {
      findings.push({
        level: "critical",
        message: `Edge path escapes repository: ${edge.from} -> ${edge.to}`,
      });
    }
    if (edge.to.startsWith("../") || edge.to.includes("/../")) {
      findings.push({
        level: "critical",
        message: `Edge path escapes repository: ${edge.from} -> ${edge.to}`,
      });
    }
    if (edge.from.includes("\\") || edge.to.includes("\\")) {
      findings.push({
        level: "critical",
        message: `Edge path contains backslash: ${edge.from} -> ${edge.to}`,
      });
    }
  }

  const expectedForward: Record<string, string[]> = {};
  const expectedReverse: Record<string, string[]> = {};
  for (const path of nodePaths) {
    expectedForward[path] = [];
    expectedReverse[path] = [];
  }
  for (const edge of graph.edges) {
    if (expectedForward[edge.from] !== undefined) {
      expectedForward[edge.from].push(edge.to);
    }
    if (expectedReverse[edge.to] !== undefined) {
      expectedReverse[edge.to].push(edge.from);
    }
  }

  for (const path of nodePaths) {
    const expectedF = [...new Set(expectedForward[path])].sort();
    const actualF = graph.forward[path]?.slice().sort() ?? [];
    if (JSON.stringify(expectedF) !== JSON.stringify(actualF)) {
      findings.push({
        level: "critical",
        message: `Forward adjacency mismatch for ${path}`,
      });
    }
    const expectedR = [...new Set(expectedReverse[path])].sort();
    const actualR = graph.reverse[path]?.slice().sort() ?? [];
    if (JSON.stringify(expectedR) !== JSON.stringify(actualR)) {
      findings.push({
        level: "critical",
        message: `Reverse adjacency mismatch for ${path}`,
      });
    }
  }

  const connected = new Set<string>();
  for (const edge of graph.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  for (const node of graph.nodes) {
    if (!connected.has(node.path) && !node.isEntryPoint) {
      findings.push({
        level: "warning",
        message: `Isolated node: ${node.path}`,
      });
    }
    if (!node.path) {
      findings.push({ level: "critical", message: "Node with empty path" });
    } else if (node.path.includes("\\")) {
      findings.push({
        level: "critical",
        message: `Malformed node path with backslash: ${node.path}`,
      });
    }
  }

  return {
    findings,
    criticalCount: findings.filter((f) => f.level === "critical").length,
    warningCount: findings.filter((f) => f.level === "warning").length,
    stats: {
      nodeCount: graph.nodes.length,
      sourceNodeCount: graph.nodes.filter((n) => n.isSource).length,
      assetNodeCount: graph.nodes.filter((n) => n.isAsset).length,
      edgeCount: graph.edges.length,
      assetEdgeCount: graph.edges.filter((e) => e.kind === "asset").length,
    },
  };
}

/**
 * Whether an `import type` edge can be ignored when selecting tests (2026-11-03). Vitest transpiles
 * without type checking, so a type-only change cannot alter a runtime test's outcome; ts-jest and Vitest's
 * typecheck mode check every test's types. Any sign of them anywhere in the repository, including
 * workspace packages, keeps type-only edges selecting tests. tsd and tstyche check only their own files
 * (typeTestGlobs), and those type tests are selected through every edge either way (impact.ts).
 */
function runtimeTestSelectionEligible(repoPath: string, files: readonly string[], profile: RepositoryProfile): boolean {
  const configs = profile.testRunnerConfigs ?? [];
  if (!configs.length || configs.some((config) => config.runner !== "vitest")) return false;
  const read = (path: string) => { try { return readFileSync(join(repoPath, path), "utf8"); } catch { return undefined; } };
  for (const file of files) {
    if (file.split("/").includes("node_modules")) continue;
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (/^jest\.config\./.test(name)) return false;
    if (/^vit(?:e|est)[\w.-]*\.(?:config|workspace|projects)\.[cm]?[jt]s$/.test(name)) {
      const text = read(file);
      if (text === undefined || /\btypecheck\b/.test(text)) return false;
    } else if (name === "package.json") {
      let manifest: { scripts?: Record<string, unknown>; dependencies?: object; devDependencies?: object; peerDependencies?: object; optionalDependencies?: object };
      try { manifest = JSON.parse(read(file) ?? ""); } catch { return false; }
      const packages = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies].flatMap((group) => Object.keys(group ?? {}));
      // tsd and tstyche check types only in their own test files (typeTestGlobs), which keep type edges;
      // Jest (ts-jest) and `--typecheck` type-check every test they run (2026-11-10: tstyche alone turned
      // off runtime selection for all of payloadcms/payload's Vitest tests).
      if (packages.some((name) => ["jest", "ts-jest"].includes(name))) return false;
      if (Object.values(manifest.scripts ?? {}).some((script) => typeof script !== "string" || /(?:^|[\s&;|(])jest(?:\s|$)|--typecheck/.test(script))) return false;
    }
  }
  return true;
}

/** The files tstyche or tsd check, when either is installed: tstyche.json's `testFileMatch` or tstyche's
 * defaults, and tsd's `*.test-d.ts`. */
function typeTestGlobs(repoPath: string, files: readonly string[]): string[] {
  const read = (path: string) => { try { return readFileSync(join(repoPath, path), "utf8"); } catch { return undefined; } };
  let tstyche = false, tsd = false;
  for (const file of files) {
    if (file.split("/").includes("node_modules") || !file.endsWith("package.json")) continue;
    let manifest: { scripts?: Record<string, unknown>; dependencies?: object; devDependencies?: object; peerDependencies?: object; optionalDependencies?: object };
    try { manifest = JSON.parse(read(file) ?? ""); } catch { continue; }
    const packages = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies].flatMap((group) => Object.keys(group ?? {}));
    const scripts = Object.values(manifest.scripts ?? {}).filter((script): script is string => typeof script === "string");
    if (packages.includes("tstyche") || scripts.some((script) => /(?:^|[\s&;|(])tstyche(?:\s|$)/.test(script))) tstyche = true;
    if (packages.includes("tsd") || scripts.some((script) => /(?:^|[\s&;|(])tsd(?:\s|$)/.test(script))) tsd = true;
  }
  const globs: string[] = [];
  if (tstyche) {
    let match: unknown;
    for (const name of ["tstyche.config.json", "tstyche.json"]) {
      const text = read(name);
      if (text === undefined) continue;
      const parsed = ts.parseConfigFileTextToJson(name, text);
      match = (parsed.config as { testFileMatch?: unknown } | undefined)?.testFileMatch;
      break;
    }
    globs.push(...(Array.isArray(match) && match.every((glob) => typeof glob === "string") ? match as string[]
      : ["**/*.tst.*", "**/__typetests__/*.test.*", "**/typetests/*.test.*"]));
  }
  if (tsd) globs.push("**/*.test-d.ts", "**/*.test-d.tsx");
  return globs;
}

function computeConfidence(
  unresolvedCount: number,
  dynamicUnresolvedCount: number,
  integrityCriticalCount: number,
  sourceFileCount: number,
  resolvedViaProjectReferences: boolean,
): GraphConfidence {
  // An empty graph has nothing to flag as unresolved and nothing to violate integrity
  // checks, so without this it would fall through to "COMPLETE" — the worst possible
  // failure mode (confidently wrong rather than honestly unsure). Zero source files means
  // we could not build a trustworthy view of the repository at all.
  if (sourceFileCount === 0) return "UNSAFE";
  if (integrityCriticalCount > 0) return "UNSAFE";
  if (dynamicUnresolvedCount > 0) return "UNSAFE";
  if (unresolvedCount > 0) return "UNSAFE";
  // Project-reference resolution merges multiple sub-projects' compiler options into one
  // best-effort approximation (see resolveProjectReferenceInputs) rather than the exact
  // settings TypeScript itself would use per sub-project, so cap confidence at PARTIAL
  // even when nothing else flagged a problem.
  if (resolvedViaProjectReferences) return "PARTIAL";
  return "COMPLETE";
}

/** Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md): per-delta refinement of a graph's
 * raw, delta-independent confidence(). Stage 1A's forensic investigation of all 7 fully-UNSAFE
 * repositories found that in 5 of 7, the unresolved-import count was under 0.1% of total graph edges
 * and confined to files structurally unrelated to the actual library/test surface (a build-tooling
 * script, a non-committed generated fixture, an optional peer-dependency shim) - yet computeConfidence()
 * unconditionally treats ANY unresolved import anywhere in the repository as disqualifying the ENTIRE
 * graph for EVERY delta, for as long as that one file's import stays unresolved, regardless of whether
 * the delta being analyzed has anything to do with it.
 *
 * For static unresolved references, this narrows that: an unresolved import makes THIS delta's
 * confidence untrustworthy if its importer is actually reachable from the changed files (in either
 * direction - the changed file might depend on the incomplete file, or something reachable from the
 * changed file might). If none of the graph's unresolved imports are anywhere near this delta, the
 * graph's real incompleteness elsewhere cannot plausibly affect what can safely be determined about
 * THIS specific change.
 *
 * Deliberately NOT narrowed - these remain hard, global blockers regardless of the delta:
 * - Unresolved runtime imports/requires: a computed target has no known graph edge, so lack of
 *   reachability cannot establish that it does not load one of the changed files.
 * - `sourceFileCount === 0` (an empty graph gives no reachability information to reason about at all).
 * - `integrity.criticalCount > 0` (the graph's own internal structure is broken - a construction bug,
 *   not a property of any one file, so no delta-specific narrowing is meaningful).
 * These match computeConfidence()'s own priority order - both are checked before the unresolved-import
 * conditions this function narrows, and are returned as-is, unchanged, before reachability is examined.
 *
 * This function accepts the SAME confidence-relevant fields as computeConfidence() (rather than the
 * bare enum) precisely so a `confidence === "UNSAFE"` return value can be disambiguated: reachability
 * narrowing only applies when unresolved/dynamic-unresolved imports are the actual reason, never when
 * sourceFileCount or integrity triggered it. */
export function refineConfidenceForDelta(result: DependencyGraphResult, changedFiles: string[]): GraphConfidence {
  if (result.adapterBlockers?.length) return "UNSAFE";
  if (result.scopedAdapterBlockers?.length) {
    if (relevantScopedAdapterBlockers(result, changedFiles).length) return "UNSAFE";
    // An older result without the unscoped confidence fails closed.
    return refineUnscopedConfidence({ ...result, confidence: result.confidenceWithoutScopedBlockers ?? "UNSAFE" }, changedFiles);
  }
  return refineUnscopedConfidence(result, changedFiles);
}

/** The scoped blockers a delta reaches: a changed file, or a file the changed files depend on or that
 * depends on them, lies inside one of the blocker's package directories. A missing edge starts at a file
 * inside that directory, so this is stricter than the per-importer narrowing of unresolved imports. */
export function relevantScopedAdapterBlockers(result: DependencyGraphResult, changedFiles: string[]): ScopedAdapterBlocker[] {
  const blockers = result.scopedAdapterBlockers ?? [];
  if (!blockers.length) return [];
  const touched = new Set<string>(changedFiles);
  for (const file of changedFiles) {
    for (const dep of result.graph.transitiveDependenciesOf(file)) touched.add(dep);
    for (const dep of result.graph.transitiveDependentsOf(file)) touched.add(dep);
  }
  const directories = new Set<string>();
  for (const path of touched) {
    let index = path.lastIndexOf("/");
    while (index > 0) { directories.add(path.slice(0, index)); index = path.lastIndexOf("/", index - 1); }
  }
  return blockers.filter((blocker) => blocker.directories.some((directory) => directories.has(directory)));
}

function refineUnscopedConfidence(result: DependencyGraphResult, changedFiles: string[]): GraphConfidence {
  // A computed runtime target can be any file, so its missing edge proves nothing about which changed
  // file it loads. It cannot, however, change the behaviour of a test that never runs the importer:
  // ImpactAnalyzer selects every test that does (COMPUTED_IMPORT) and falls back when the importer is
  // outside the graph. Computed references are therefore excluded from reachability below rather
  // than blocking every delta. A literal dynamic import names its only possible target and is
  // narrowed like any other unresolved import.
  // Anything that was never UNSAFE in the first place passes through untouched - there is nothing to
  // narrow, and re-deriving sourceFileCount/integrity from raw fields here (rather than trusting the
  // already-computed confidence) would be both redundant and a real correctness risk: a caller's
  // profile object could be stale/unrelated to the graph actually being evaluated for reasons that have
  // nothing to do with this delta, and computeConfidence() already made the authoritative call once.
  if (result.confidence !== "UNSAFE") return result.confidence;
  // sourceFileCount===0 can never co-occur with unresolved.length>0 in a real graph (buildDependencyGraph
  // only ever records an unresolved entry for a file that isSourceFileName(), and any such file is
  // unconditionally added to internalSourcePaths before unresolved-detection ever runs - so
  // unresolved.length>0 guarantees sourceFileCount>=1 by construction). No need to re-check it
  // independently; result.confidence already reflects it correctly.
  //
  // integrity.criticalCount>0 is different - it's a genuinely independent condition (graph edge/adjacency
  // consistency, orthogonal to import resolution) that COULD co-occur with real unresolved imports, and
  // is never narrowable by reachability (an internally-broken graph gives no trustworthy reachability
  // information to reason about at all) - checked explicitly here, only within this already-UNSAFE
  // branch, not as an unconditional gate that could override a confidence that was never UNSAFE.
  if (result.integrity.criticalCount > 0) return "UNSAFE";
  if (result.unresolved.length === 0) return result.confidence;

  const reachableFromChanged = new Set<string>();
  const dependents = new Set<string>();
  const runtimeDependents = new Set<string>();
  const runtimeOnly = result.runtimeTestSelection === true && typeof result.graph.transitiveRuntimeDependentsOf === "function";
  for (const file of changedFiles) {
    for (const dep of result.graph.transitiveDependenciesOf(file)) reachableFromChanged.add(dep);
    for (const dep of result.graph.transitiveDependentsOf(file)) { reachableFromChanged.add(dep); dependents.add(dep); }
    if (runtimeOnly) for (const dep of result.graph.transitiveRuntimeDependentsOf!(file)) runtimeDependents.add(dep);
  }
  const changedSet = new Set(changedFiles);

  // An importer that already depends on a changed file is affected, and so is everything depending on
  // it: whatever its missing edge points at, following that edge cannot reach a test that is not already
  // selected (2026-11-03: one broken `import type` in a LobeHub test file made 35 of 40 commits UNSAFE).
  // "Already depends" means through the edges that select tests: runtime edges when type-only ones do
  // not select (runtimeTestSelection), unless the missing edge is itself type-only.
  const alreadyAffected = (u: UnresolvedDependency) => (runtimeOnly && !u.typeOnly ? runtimeDependents : dependents).has(u.importer);
  const relevantUnresolved = result.unresolved.some((u) => !u.computed && !alreadyAffected(u) && (changedSet.has(u.importer) || reachableFromChanged.has(u.importer)));
  if (relevantUnresolved) return "UNSAFE";

  // None of the unresolved imports are reachable from this delta's changed files - narrow to what
  // confidence would have been without the unresolved-import trigger (still respecting the
  // project-references cap, exactly as computeConfidence()'s own final two branches do).
  return result.resolvedViaProjectReferences ? "PARTIAL" : "COMPLETE";
}

/** Nearest directory holding a package.json, relative to the repository; "" is the repository root. */
function nearestPackageDirectory(repoPath: string, path: string, cache: Map<string, string>): string {
  const visited: string[] = [];
  let directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  let found = "";
  while (directory) {
    const cached = cache.get(directory);
    if (cached !== undefined) { found = cached; break; }
    visited.push(directory);
    if (existsSync(join(repoPath, directory, "package.json"))) { found = directory; break; }
    directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
  }
  for (const item of visited) cache.set(item, found);
  return found;
}

/** The package directory an invalid importer tsconfig is confined to, or "" when it is not: the package
 * is the repository root or a declared workspace member, or a path the configuration states leaves it. */
function confinedConfigScope(repoPath: string, configRel: string, config: unknown, directory: string, workspaceRoots: ReadonlySet<string>): string {
  if (!directory || workspaceRoots.has(directory) || [...workspaceRoots].some((root) => root.startsWith(`${directory}/`))) return "";
  const configDirectory = resolve(repoPath, dirname(configRel));
  const packageRoot = resolve(repoPath, directory);
  const strings: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { strings.push(key); collect(item); }
  };
  collect(config);
  for (const value of strings) {
    if (!value.includes("..") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value)) continue;
    const target = relative(packageRoot, resolve(configDirectory, value.replace(/\*.*$/, "")));
    if (target === ".." || target.startsWith(`..${sep}`) || target.startsWith("../") || /^[A-Za-z]:|^[\\/]/.test(target)) return "";
  }
  return directory;
}

/** Moves blockers confined to directories out of `adapterBlockers` and returns them scoped to those
 * directories (2026-11-08: Sentry's JavaScript SDK keeps 19 Nuxt, SvelteKit and Vue E2E applications whose
 * tsconfig extends generated `.nuxt/`/`.svelte-kit/` files; they made every change in its SDK packages fall
 * back to full validation, although no package imports them). A blocker with any unconfined file, or with
 * no recorded files, stays global. */
function scopeAdapterBlockers(adapterBlockers: string[], scopes: Map<string, Set<string>>): ScopedAdapterBlocker[] {
  const scoped = new Map<string, Set<string>>();
  for (const reason of new Set(adapterBlockers)) {
    const directories = scopes.get(reason);
    if (!directories?.size || directories.has("")) continue;
    scoped.set(reason, directories);
  }
  for (let i = adapterBlockers.length - 1; i >= 0; i--) if (scoped.has(adapterBlockers[i]!)) adapterBlockers.splice(i, 1);
  return [...scoped].map(([reason, directories]) => ({ reason, directories: [...directories].sort() }));
}

/** A declared workspace package imported by name from a workspace member whose import could not be mapped
 * to the package's source files hides every edge into that package (2026-11-08: in an uninstalled Sentry
 * checkout, 18 packages import `@sentry/server-utils`, and none of those edges existed). A change reaching
 * the package then falls back instead of skipping its dependents. Imports from outside the workspace get
 * the package from elsewhere (a registry or a tarball) and are left out by the caller. */
function uninstalledWorkspaceBlockers(repoPath: string, references: ResolutionReference[], workspaceRoots: ReadonlySet<string>): ScopedAdapterBlocker[] {
  const external = references.filter((ref) => ref.resolution === "external-package");
  if (!external.length) return [];
  const packages = new Map<string, string>();
  for (const root of workspaceRoots) {
    try {
      const name = JSON.parse(readFileSync(join(repoPath, root, "package.json"), "utf8"))?.name;
      if (typeof name === "string" && name) packages.set(name, root);
    } catch { /* an unreadable manifest names no package */ }
  }
  if (!packages.size) return [];
  const importers = new Map<string, Set<string>>();
  for (const ref of external) {
    const parts = ref.specifier.split("/");
    const name = ref.specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    if (!packages.has(name)) continue;
    let set = importers.get(name);
    if (!set) importers.set(name, set = new Set());
    set.add(ref.importer);
  }
  return [...importers].sort(([a], [b]) => a.localeCompare(b)).map(([name, files]) => ({
    reason: `Workspace package ${name} is imported by ${files.size} file${files.size === 1 ? "" : "s"} but DiffCI cannot map the import to the package's source files; point the package's types entry at a tsconfig outDir or declarationDir with a rootDir, or at source`,
    directories: [packages.get(name)!],
  }));
}

/** Why the graph's own confidence is below COMPLETE, in counts only (no paths), so a report can say why a
 * repository-wide UNSAFE did not decide this change's verdict. 2026-11-06: every LobeHub receipt read
 * "UNSAFE" beside "safe to propose" with nothing connecting the two. Empty when the graph is COMPLETE. */
export function explainGraphConfidence(result: DependencyGraphResult): string[] {
  const reasons: string[] = [];
  const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  if (result.graph.nodes.every((node) => !node.isSource)) reasons.push("no source files were analysed");
  if (result.integrity.criticalCount > 0) reasons.push(`${plural(result.integrity.criticalCount, "graph integrity problem")}; every change falls back to full validation`);
  if (result.adapterBlockers?.length) reasons.push(`${plural(result.adapterBlockers.length, "unsupported framework or language relationship")}; every change falls back to full validation`);
  if (result.scopedAdapterBlockers?.length) reasons.push(`${plural(result.scopedAdapterBlockers.length, "unsupported relationship")} confined to package directories; a change that reaches one falls back to full validation`);
  const computed = result.unresolved.filter((ref) => ref.computed);
  const staticRefs = result.unresolved.filter((ref) => !ref.computed);
  if (computed.length) {
    const importers = new Set(computed.map((ref) => ref.importer)).size;
    reasons.push(`${plural(computed.length, "computed module load")} in ${plural(importers, "file")}; the tests that run them are selected for every code change`);
  }
  if (staticRefs.length) reasons.push(`${plural(staticRefs.length, "unresolved import")}; a change that reaches one falls back to full validation`);
  if (result.resolvedViaProjectReferences) reasons.push("compiler options are merged across TypeScript project references, which caps confidence at PARTIAL");
  return reasons;
}

export function graphToJson(result: DependencyGraphResult): string {
  const { graph, profile, unresolved, references, counts, externalReferences, platformBuiltinReferences, internalAssetEdges, performance, confidence, integrity } = result;
  return JSON.stringify(
    {
      profile,
      graph: {
        nodes: graph.nodes,
        edges: graph.edges,
      },
      unresolved,
      references,
      counts,
      externalReferences,
      platformBuiltinReferences,
      internalAssetEdges,
      performance,
      confidence,
      integrity,
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}
