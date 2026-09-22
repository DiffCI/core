import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { analyzeRepository } from "./analyzer.js";
import type { RepositoryProfile } from "./types.js";
import { adapterFiles } from "./adapters/index.js";

export function inVuePackage(path: string, root: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

/** Scope is an explicit CI declaration, never inferred from a convenient source directory. */
export function applyVueScope(repoPath: string, profile: RepositoryProfile): string[] {
  const scope = profile.diffciConfig?.vue;
  if (!scope) return profile.diffciConfig?.configurationError ? [profile.diffciConfig.configurationError] : [];
  const packagePath = join(repoPath, scope.packageRoot);
  const prefix = (path: string) => scope.packageRoot === "." ? path.replace(/^\.\//, "") : `${scope.packageRoot}/${path.replace(/^\.\//, "")}`;
  if (!existsSync(join(packagePath, "package.json")) || !existsSync(join(packagePath, scope.testConfig))) return ["Vue scope requires an existing package.json and default Vitest config"];
  const actual = relative(realpathSync(repoPath), realpathSync(packagePath));
  if (actual === ".." || actual.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(actual)) return ["Vue package scope escapes the repository"];
  const physicallyLocal = (path: string) => {
    const physical = relative(realpathSync(packagePath), realpathSync(join(packagePath, path))).replace(/\\/g, "/");
    return physical !== ".." && !physical.startsWith("../") && !isAbsolute(physical);
  };
  if (!["package.json", scope.testConfig].every(physicallyLocal)) return ["Vue package manifest or config crosses the physical package boundary"];
  const scoped = analyzeRepository({ repoPath: packagePath });
  const configs = scoped.testRunnerConfigs ?? [];
  if (configs.length !== 1 || configs[0].file !== scope.testConfig || configs[0].runner !== "vitest") return ["Vue scope requires exactly one verified default Vitest suite"];
  if (configs[0].declaresTests && !configs[0].authoritative) return ["Vue scoped test patterns could not be fully verified"];
  if ([...configs[0].includes, ...configs[0].roots].some(path => /^(?:\/|\\|[A-Za-z]:)/.test(path) || path.split(/[\\/]/).includes(".."))) return ["Vue test discovery crosses the package boundary"];
  const config = ts.createSourceFile(scope.testConfig, readFileSync(join(packagePath, scope.testConfig), "utf8"), ts.ScriptTarget.Latest, true);
  const blockers: string[] = [];
  const setup: string[] = [prefix(scope.testConfig)];
  let typecheckEnabled = false;
  let runtimeIsolation = true;
  const allowedImports = new Set(["vitest/config", "@vitejs/plugin-vue", "node:path", "node:url", "path", "url"]);
  const factories = new Set<string>();
  const vuePlugins = new Set<string>();
  for (const statement of config.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text === "@vitejs/plugin-vue" && statement.importClause?.name) vuePlugins.add(statement.importClause.name.text);
    if (statement.moduleSpecifier.text === "vitest/config" && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const element of statement.importClause.namedBindings.elements) if ((element.propertyName ?? element.name).text === "defineConfig") factories.add(element.name.text);
    }
  }
  const exported = config.statements.find(ts.isExportAssignment);
  let definition = exported?.expression;
  if (definition && ts.isCallExpression(definition) && ts.isIdentifier(definition.expression) && factories.has(definition.expression.text) && definition.arguments.length === 1) definition = definition.arguments[0];
  if (!definition || !ts.isObjectLiteralExpression(definition)) blockers.push("Vue scope requires a literal default Vitest configuration");
  function visit(node: ts.Node): void {
    if (ts.isSpreadAssignment(node) || ts.isComputedPropertyName(node)) blockers.push("Vue scoped config contains unmodeled configuration composition");
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !allowedImports.has(node.moduleSpecifier.text)) blockers.push("Vue scoped Vitest config has an unsupported plugin or config helper");
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const name = node.name.text;
      if (name === "isolate" && node.initializer.kind !== ts.SyntaxKind.TrueKeyword) runtimeIsolation = false;
      if (["runner", "browser", "poolOptions", "poolMatchGlobs", "environmentMatchGlobs"].includes(name)) runtimeIsolation = false;
      if (name === "pool" && (!ts.isStringLiteral(node.initializer) || !["threads", "forks"].includes(node.initializer.text))) runtimeIsolation = false;
      if (name === "environment" && (!ts.isStringLiteral(node.initializer) || !["node", "jsdom", "happy-dom"].includes(node.initializer.text))) runtimeIsolation = false;
      if (name === "typecheck") {
        if (!ts.isObjectLiteralExpression(node.initializer)) blockers.push("Vue typecheck configuration must be literal");
        else for (const property of node.initializer.properties) {
          if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) { blockers.push("Vue typecheck configuration is not fully modeled"); continue; }
          if (property.name.text === "enabled") {
            if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) typecheckEnabled = true;
            else if (property.initializer.kind !== ts.SyntaxKind.FalseKeyword) blockers.push("Vue typecheck enabled flag must be literal");
          }
          if (["include", "exclude", "only"].includes(property.name.text)) blockers.push("Custom Vue type-test discovery requires full validation");
        }
      }
      if (name === "plugins" && (!ts.isArrayLiteralExpression(node.initializer) || node.initializer.elements.some(element => !ts.isCallExpression(element) || !ts.isIdentifier(element.expression) || !vuePlugins.has(element.expression.text) || element.arguments.length !== 0))) blockers.push("Vue scope supports only the default Vue compiler plugin");
      if (["root", "projects", "workspace", "extends"].includes(name)) blockers.push("Vue scoped Vitest config overrides its package boundary");
      if (["setupFiles", "globalSetup"].includes(name)) {
        const values = ts.isArrayLiteralExpression(node.initializer) ? [...node.initializer.elements] : [node.initializer];
        for (const value of values) {
          if (!ts.isStringLiteral(value)) { blockers.push("Vue scoped setup paths must be literal package-local files"); continue; }
          const path = relative(packagePath, resolve(packagePath, value.text)).replace(/\\/g, "/");
          if (path.startsWith("../") || isAbsolute(path) || !existsSync(join(packagePath, path)) || !physicallyLocal(path)) blockers.push("Vue scoped setup path escapes or is missing from the package");
          else setup.push(prefix(path));
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(config);
  // Only a literal test object can establish the default isolated Vitest contract.
  const testDefinitions = definition && ts.isObjectLiteralExpression(definition) ? definition.properties.filter(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "test") : [];
  const testDefinition = testDefinitions.length === 1 ? testDefinitions[0] : undefined;
  const literalProperties = (node: ts.Node): boolean => {
    if (ts.isObjectLiteralExpression(node) && node.properties.some(p => !ts.isPropertyAssignment(p) || ts.isComputedPropertyName(p.name))) return false;
    let valid = true;
    ts.forEachChild(node, child => { if (!literalProperties(child)) valid = false; });
    return valid;
  };
  profile.vueRuntimeIsolationVerified = runtimeIsolation && blockers.length === 0 && !!testDefinition && ts.isPropertyAssignment(testDefinition) && ts.isObjectLiteralExpression(testDefinition.initializer) && literalProperties(testDefinition.initializer);
  // Package discovery supplies the runner universe. Do not let repository-wide docs,
  // playground configs or other frameworks expand or replace this declared suite.
  profile.vueScope = scope;
  profile.vueSetupPaths = setup;
  profile.packageJson = scoped.packageJson;
  profile.sourceRoots = scoped.sourceRoots.map(root => ({ ...root, path: prefix(root.path) }));
  profile.testFilePaths = scoped.testFilePaths.map(prefix);
  profile.testPatterns = scoped.testPatterns?.map(prefix);
  profile.testExcludePatterns = scoped.testExcludePatterns?.map(prefix);
  profile.testAuthoritativePatterns = scoped.testAuthoritativePatterns?.map(prefix);
  if (typecheckEnabled) {
    // Vitest's typecheck.include default is independent from its runtime test include.
    // Keep every type suite, rather than applying runtime reachability to type checking.
    profile.vueTypeTestPaths = adapterFiles(packagePath).filter(path => /\.(?:test|spec)-d\.[cm]?[jt]sx?$/.test(path)).map(prefix);
    profile.testFilePaths = [...new Set([...profile.testFilePaths, ...profile.vueTypeTestPaths])].sort();
    profile.testPatterns = [...(profile.testPatterns ?? []), ...profile.vueTypeTestPaths];
    profile.testAuthoritativePatterns = [...(profile.testAuthoritativePatterns ?? []), ...profile.vueTypeTestPaths];
    if (!profile.vueTypeTestPaths.length) blockers.push("Enabled Vue type checking has no discovered type suites");
  }
  profile.testIgnoreRegexSources = scoped.testIgnoreRegexSources;
  profile.testRoots = scope.packageRoot === "." ? undefined : [scope.packageRoot];
  profile.tests = scoped.tests.map(test => ({ ...test, glob: prefix(test.glob) }));
  profile.testRunnerConfigs = configs.map(config => ({ ...config, file: prefix(config.file), includes: config.includes.map(prefix), excludeGlobs: config.excludeGlobs.map(prefix), roots: config.roots.map(prefix) }));
  profile.testUniverse = scoped.testUniverse;
  profile.entryPoints = scoped.entryPoints.map(entry => ({ ...entry, path: prefix(entry.path) }));
  profile.pathAliases = scoped.pathAliases.map(alias => ({ ...alias, substitutions: alias.substitutions.map(prefix) }));
  return [...blockers, ...(profile.testFilePaths.length ? [] : ["Declared Vue suite has no discovered tests"])];
}
