import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
const loadCompiler = createRequire(import.meta.url);
let previousSession: object | undefined;
const compilerConfigs = new Set<string>();

/** Only direct imports registered in a literal component options object are provable. */
function registeredComponents(source: string): Set<string> {
  const file = ts.createSourceFile("component.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Set<string>();
  const factories = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const clause = statement.importClause;
    if (clause?.name) imports.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        if (binding.isTypeOnly) continue;
        imports.add(binding.name.text);
        if (ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "vue" && (binding.propertyName ?? binding.name).text === "defineComponent") factories.add(binding.name.text);
      }
    }
  }
  const names = new Set<string>();
  const exp = file.statements.find(ts.isExportAssignment);
  if (!exp || exp.isExportEquals) return names;
  let value = exp.expression;
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && factories.has(value.expression.text) && value.arguments.length === 1) value = value.arguments[0];
  if (!ts.isObjectLiteralExpression(value) || value.properties.some(p => ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name)))) return names;
  const registrations = value.properties.filter(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "components");
  if (registrations.length !== 1 || !ts.isPropertyAssignment(registrations[0]) || !ts.isObjectLiteralExpression(registrations[0].initializer)) return names;
  for (const property of registrations[0].initializer.properties) {
    if (ts.isShorthandPropertyAssignment(property) && imports.has(property.name.text)) names.add(property.name.text);
    else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && ts.isIdentifier(property.initializer) && imports.has(property.initializer.text)) names.add(property.name.text);
    else return new Set();
  }
  return new Set([...names].flatMap(name => [name, name.replace(/\B([A-Z])/g, "-$1").toLowerCase()]));
}
import { contribution, type RepositoryAdapter } from "./types.js";

/** Explicit Vue SFC imports. Runtime component registries and preprocessors require full CI. */
export const vueAdapter: RepositoryAdapter = {
  id: "vue", version: "7", kind: "framework",
  detect: ({ files }) => files.some((file) => file.endsWith(".vue")),
  analyze(context) {
    const phasesMs: Record<string, number> = {};
    const counts: Record<string, number> = { components: 0, typeReads: 0, registrationScans: 0 };
    const measure = <T>(name: string, work: () => T): T => {
      const start = performance.now();
      try { return work(); } finally { phasesMs[name] = (phasesMs[name] ?? 0) + performance.now() - start; }
    };
    // Go and scoped TS-only packages do not need to initialize Vue's compiler/Babel
    // dependency tree. Keep the same synchronous adapter contract, loading it on use.
    const { compileScript, compileTemplate, invalidateTypeCache, parse, registerTS } = measure("compilerLoad", () => loadCompiler("@vue/compiler-sfc")) as typeof import("@vue/compiler-sfc");
    registerTS(() => ts);
    const session = context.vueAnalysisSession ?? {};
    if (session !== previousSession) {
      for (const file of compilerConfigs) invalidateTypeCache(file);
      compilerConfigs.clear();
      previousSession = session;
    }
    const recordRead = (file: string) => {
      if (file.endsWith(".json")) compilerConfigs.add(file);
      context.recordVueRead?.(file);
    };
    const result = contribution(this);
    result.performance = { phasesMs, counts };
    const dependencies = [...context.profile.packageJson.dependencies, ...context.profile.packageJson.devDependencies];
    if (dependencies.includes("nuxt") || context.files.some((file) => /(?:^|\/)nuxt\.config\./.test(file))) {
      result.blockers.push("Nuxt implicit routes and auto-imports require a dedicated framework adapter");
    }
    for (const path of context.vueComponentPaths ?? context.files.filter((file) => file.endsWith(".vue"))) {
      counts.components++;
      result.sourcePaths.push(path);
      const block = (reason: string) => {
        const message = `Vue ${path}: ${reason}`;
        result.blockers.push(message);
        (result.fileBlockers ??= []).push({ path, reason: message });
      };
      const typeDependencies = new Set<string>();
      const recordTypeDependency = (file: string) => {
        recordRead(file);
        const dependency = relative(context.repoPath, resolve(file)).replace(/\\/g, "/");
        if (dependency === ".." || dependency.startsWith("../") || isAbsolute(dependency)) throw new Error("Vue type dependency escapes repository");
        typeDependencies.add(dependency);
      };
      try {
        const raw = measure("sourceRead", () => readFileSync(join(context.repoPath, path), "utf8"));
        // compiler-sfc discards an empty script block then reports a missing block.
        // Recognize only this exact dependency-free SFC shape, not arbitrary parse errors.
        if (/^\s*<script(?:\s+setup)?(?:\s+lang=["'](?:ts|js)["'])?\s*>\s*<\/script>\s*$/.test(raw)) {
          result.virtualSources.push({ path, source: "export default {};" });
          continue;
        }
        // Dependency extraction uses code, bindings and errors, never source maps.
        const { descriptor, errors } = measure("sfcParse", () => parse(raw, { filename: join(context.repoPath, path), sourceMap: false }));
        if (errors.length) block("component parse failed");
        if (descriptor.customBlocks.length) block("custom blocks require a framework plugin");
        const blocks = [descriptor.script, descriptor.scriptSetup, descriptor.template, ...descriptor.styles].filter((b) => b !== null);
        for (const b of blocks) {
          if (b.src) block("external SFC blocks are not yet modeled");
          if (b.lang && !["js", "ts", "jsx", "tsx", "html", "css"].includes(b.lang)) block(`unsupported preprocessor ${b.lang}`);
        }
        const script = descriptor.script || descriptor.scriptSetup
          ? measure("scriptCompile", () => compileScript(descriptor, { id: path, sourceMap: false, fs: {
            fileExists(file) { recordRead(file); return ts.sys.fileExists(file); },
            readFile(file) {
              recordRead(file);
              recordTypeDependency(file);
              counts.typeReads++;
              return readFileSync(file, "utf8");
            },
          } })) : undefined;
        for (const dependency of script?.deps ?? []) recordTypeDependency(dependency);
        // Imported macro types affect generated runtime props. Retain the files read
        // by the compiler even when the generated script erases their imports.
        for (const dependency of typeDependencies) {
          if (/\.[cm]?[jt]sx?$/.test(dependency)) result.sourcePaths.push(dependency);
          else result.assetPaths.push(dependency);
          result.edges.push({ from: path, to: dependency, kind: "asset" });
        }
        let source = script?.content ?? "";
        if (/\bimport\.meta\.glob(?:Eager)?\s*\(/.test(source)) block("glob imports require bundler dependency expansion");
        if (descriptor.template && !descriptor.template.src && !descriptor.template.lang) {
          const templateBlock = descriptor.template;
          const template = measure("templateCompile", () => compileTemplate({
            source: templateBlock.content, filename: path, id: path,
            compilerOptions: { bindingMetadata: script?.bindings, sourceMap: false },
          }));
          if (template.errors.length) block("template compilation failed");
          // These calls represent dependencies supplied at runtime, outside the import graph.
          const componentCalls = [...template.code.matchAll(/\b_resolveComponent\s*\(\s*(["'])(.*?)\1/g)];
          // Script-setup bindings and native-only templates have no runtime
          // component calls, so an Options API registration scan cannot help.
          const registrations = componentCalls.length ? measure("registrationScan", () => { counts.registrationScans++; return registeredComponents(source); }) : new Set<string>();
          const unresolved = componentCalls.some(match => !registrations.has(match[2]));
          if (unresolved || /\b_resolve(?:DynamicComponent|Directive)\s*\(/.test(template.code)) block("runtime component/directive resolution requires full validation");
          source += `\n${template.code}`;
        } else if (descriptor.template) block("external or preprocessed template requires full validation");
        for (const style of descriptor.styles) {
          // CSS imports/URLs may be rewritten by arbitrary bundler plugins. Do not guess.
          if (/@import\b|url\s*\(/i.test(style.content)) block("style imports or URLs require full validation");
        }
        result.virtualSources.push({ path, source });
      } catch (error) {
        const detail = String(error instanceof Error ? error.message : error).replaceAll(context.repoPath, "<repo>").split("\n")[0].slice(0, 240);
        block(`component could not be analyzed: ${detail}`);
      } finally {
        // compiler-sfc caches parsed imported types globally. Do not let a later
        // component or a second analysis reuse stale types or bypass filesystem reads.
        measure("typeCacheInvalidation", () => { for (const dependency of typeDependencies) invalidateTypeCache(join(context.repoPath, dependency)); });
      }
    }
    return result;
  },
};
