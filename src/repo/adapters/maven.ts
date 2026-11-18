import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { contribution, type AdapterContext, type AdapterContribution, type RepositoryAdapter } from "./types.js";

interface Coordinates { groupId: string; artifactId: string; }
interface Pom {
  path: string;
  dir: string;
  groupId?: string;
  artifactId?: string;
  parent?: Coordinates;
  dependencies: Coordinates[];
  customSourceRoots: boolean;
  /** The module's Java test root relative to the repository, or undefined when it can't be resolved for certain. */
  testRoot?: string;
  /** Every `<testSourceDirectory>` the POM declares, including those inside profiles. */
  declaredTestRoots: string[];
  /** Whether a `<testSourceDirectory>` sits inside a profile, which may or may not be active. */
  profileTestRoot: boolean;
  /** Whether the POM configures build-helper-maven-plugin, which can add any folder, resources included, as a source root. */
  buildHelper: boolean;
}

const DEFAULT_TEST_ROOT = "src/test/java";

/**
 * Resolves a `<testSourceDirectory>` to a repository path. Only a plain relative path inside the module
 * resolves; a `${property}`, an absolute path, a path leaving the module, or several declarations (a
 * profile can override the root) don't, so the caller falls back. Never guess (#163).
 */
function resolveTestRoot(dir: string, declared: string[]): string | undefined {
  const roots = [...new Set(declared)];
  if (roots.length > 1) return undefined;
  const root = roots[0] ?? DEFAULT_TEST_ROOT;
  if (!root || root.includes("${") || root.startsWith("/") || /^[A-Za-z]:/.test(root) || root.includes("\\")) return undefined;
  const local = posix.normalize(root).replace(/\/+$/, "");
  if (local === "." || local === ".." || local.startsWith("../")) return undefined;
  return dir ? `${dir}/${local}` : local;
}

function tags(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "g");
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) out.push((match[1] ?? "").trim());
  return out;
}

function first(xml: string, name: string): string | undefined { return tags(xml, name)[0]; }

/** Drops `<!-- ... -->` comments in one left-to-right pass. An unterminated comment is kept, as before. */
function stripXmlComments(source: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const start = source.indexOf("<!--", i);
    if (start === -1) return out + source.slice(i);
    const end = source.indexOf("-->", start + 4);
    if (end === -1) return out + source.slice(start);
    out += source.slice(i, start);
    i = end + 3;
  }
}

function parsePom(path: string, source: string): Pom {
  // Commented-out elements are not part of the model: an old <artifactId> in a comment must not
  // become the module's identity.
  const xml = stripXmlComments(source);
  const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
  const parent = first(xml, "parent");
  const own = xml.replace(/<parent\b[^>]*>[\s\S]*?<\/parent>/, "");
  // Nested plugin/dependency coordinates are not the project's own identity. In
  // particular, a dependency's ${project.groupId} must not shadow an inherited ID.
  const identity = own.replace(/<(dependencies|dependencyManagement|build|profiles|reporting|properties)\b[^>]*>[\s\S]*?<\/\1>/g, "");
  // A profile's <testSourceDirectory> applies only when that profile is active, which this static
  // adapter can't tell, so such a POM falls back.
  const declaredTestRoots = tags(xml, "testSourceDirectory");
  const profileTestRoot = declaredTestRoots.length !== tags(xml.replace(/<profiles\b[^>]*>[\s\S]*?<\/profiles>/g, ""), "testSourceDirectory").length;
  const dependencies = tags(xml, "dependency")
    .map(value => ({ groupId: first(value, "groupId") ?? "", artifactId: first(value, "artifactId") ?? "" }))
    .filter(value => value.artifactId);
  return {
    path, dir,
    groupId: first(identity, "groupId") ?? first(parent ?? "", "groupId"),
    artifactId: first(identity, "artifactId"),
    parent: parent === undefined ? undefined : { groupId: first(parent, "groupId") ?? "", artifactId: first(parent, "artifactId") ?? "" },
    dependencies,
    customSourceRoots: tags(xml, "sourceDirectory").some(root => root !== "src/main/java"),
    testRoot: profileTestRoot ? undefined : resolveTestRoot(dir, declaredTestRoots),
    declaredTestRoots, profileTestRoot,
    buildHelper: xml.includes("build-helper-maven-plugin"),
  };
}

function under(dir: string, path: string): boolean { return !dir || path === dir || path.startsWith(dir + "/"); }
function owningPom(poms: Pom[], file: string): Pom | undefined {
  return poms.filter(pom => under(pom.dir, file)).sort((a, b) => b.dir.length - a.dir.length)[0];
}
/**
 * Surefire's default includes (Test*, *Test, *Tests, *TestCase) and Failsafe's (IT*, *IT, *ITCase), under the
 * module's Java test root or src/test/kotlin.
 */
function isTest(pom: Pom, path: string): boolean {
  const roots = [pom.testRoot!, pom.dir ? `${pom.dir}/src/test/kotlin` : "src/test/kotlin"];
  return roots.some(root => path.startsWith(root + "/")) &&
    /^(?:Test.*|IT.*|.*(?:Test|Tests|TestCase|IT|ITCase))\.(?:java|kt)$/.test(posix.basename(path));
}

export function analyzeMaven(context: AdapterContext): AdapterContribution {
  const result = contribution(mavenAdapter);
  const poms = context.files.filter(file => file === "pom.xml" || file.endsWith("/pom.xml"))
    .map(path => parsePom(path, readFileSync(context.repoPath + "/" + path, "utf8")));
  if (!poms.length) { result.blockers.push("Maven analysis found no pom.xml"); return result; }
  const byGA = new Map(poms.filter(pom => pom.artifactId).map(pom => [`${pom.groupId ?? ""}:${pom.artifactId}`, pom]));
  const byArtifact = new Map(poms.filter(pom => pom.artifactId).map(pom => [pom.artifactId!, pom]));
  const findPom = (coordinates: Coordinates) => byGA.get(`${coordinates.groupId}:${coordinates.artifactId}`) ?? byArtifact.get(coordinates.artifactId);
  const members = new Map<Pom, string[]>();
  const resources = new Map<Pom, string[]>();
  const anchors = new Map<Pom, string>();

  // A module that declares no <testSourceDirectory> inherits the nearest local parent's. Unless that is
  // the default root, fall back rather than assume src/test/java.
  for (const pom of poms) {
    if (pom.declaredTestRoots.length) continue;
    const visited = new Set<Pom>([pom]);
    let ancestor = pom.parent && findPom(pom.parent);
    while (ancestor && !visited.has(ancestor) && !ancestor.declaredTestRoots.length) {
      visited.add(ancestor);
      ancestor = ancestor.parent && findPom(ancestor.parent);
    }
    if (ancestor && !visited.has(ancestor) &&
      (ancestor.profileTestRoot || resolveTestRoot("", ancestor.declaredTestRoots) !== DEFAULT_TEST_ROOT)) pom.testRoot = undefined;
  }

  for (const pom of poms) {
    if (pom.customSourceRoots || pom.testRoot === undefined) result.blockers.push(`Maven ${pom.path}: custom source roots require full validation`);
    // This static adapter does not construct Maven's effective model. A local parent's
    // dependency declarations cannot safely be treated as belonging only to that POM.
    const visited = new Set<Pom>([pom]);
    let parent = pom.parent && findPom(pom.parent);
    while (parent && !visited.has(parent)) {
      if (parent.dependencies.length) {
        result.blockers.push(`Maven ${pom.path}: parent dependency inheritance requires full validation`);
        break;
      }
      visited.add(parent);
      parent = parent.parent && findPom(parent.parent);
    }

    const owned = context.files.filter(file => owningPom(poms, file) === pom);
    const sources = owned.filter(file => /\.(?:java|kt)$/.test(file) &&
      (/\/src\/(?:main|test)\/(?:java|kotlin)\//.test("/" + file) || (pom.testRoot !== undefined && file.startsWith(pom.testRoot + "/"))));
    const assets = owned.filter(file => /\/src\/(?:main|test)\/resources\//.test("/" + file));
    // Java or Kotlin outside every root DiffCI recognises may still be compiled and run by Maven: a test root
    // added by build-helper-maven-plugin, or one set by a parent POM outside the repository. Fail closed (#327).
    // Resources (archetype templates, compiler-test inputs) and the Maven wrapper's downloader are not sources,
    // unless build-helper-maven-plugin is configured: it can add a folder under resources as a source root.
    const known = new Set(sources);
    if (owned.some(file => /\.(?:java|kt)$/.test(file) && !known.has(file) &&
      (pom.buildHelper || !/\/src\/(?:main|test)\/resources\//.test("/" + file)) && !/(?:^|\/)\.mvn\//.test(file))) {
      result.blockers.push(`Maven ${pom.path}: Java sources outside the standard roots require full validation`);
    }
    members.set(pom, sources);
    resources.set(pom, assets);
    const anchor = sources[0] ?? assets[0];
    if (anchor) anchors.set(pom, anchor);
    result.sourcePaths.push(...sources);
    result.assetPaths.push(...assets);
    for (const file of sources) {
      if (pom.testRoot !== undefined && isTest(pom, file)) { result.testFiles.push(file); result.testPackages[file] = pom.dir || "."; }
    }
  }

  for (const pom of poms) {
    const anchor = anchors.get(pom);
    if (anchor) {
      for (const file of members.get(pom) ?? []) {
        if (file !== anchor) result.edges.push({ from: anchor, to: file, kind: "import" }, { from: file, to: anchor, kind: "import" });
      }
      // Resources are inputs to the entire module. Resource-only JARs also need an
      // anchor so changes can reach tests in modules that depend on them.
      for (const file of resources.get(pom) ?? []) {
        if (file !== anchor) result.edges.push({ from: anchor, to: file, kind: "asset" });
      }
    }
    for (const dependency of pom.dependencies) {
      const groupId = dependency.groupId.replace(/\$\{project\.groupId\}/g, pom.groupId ?? "").replace(/\$\{pom\.groupId\}/g, pom.groupId ?? "");
      if (/\$\{/.test(groupId) || /\$\{/.test(dependency.artifactId)) {
        result.blockers.push(`Maven ${pom.path}: unresolved dependency coordinates require full validation`);
        continue;
      }
      const target = findPom({ groupId, artifactId: dependency.artifactId });
      const targetAnchor = target && anchors.get(target);
      if (anchor && targetAnchor && targetAnchor !== anchor) result.edges.push({ from: anchor, to: targetAnchor, kind: "import" });
    }
  }
  if (!result.sourcePaths.length) result.blockers.push("Maven reactor contains no Java sources");
  return result;
}

export const mavenAdapter: RepositoryAdapter = {
  id: "maven", version: "2", kind: "language",
  detect: ({ files }) => files.includes("pom.xml") && files.some(file => file.endsWith(".java") || file.endsWith(".kt")),
  analyze: analyzeMaven,
};
