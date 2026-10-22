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
}

function tags(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "g");
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) out.push((match[1] ?? "").trim());
  return out;
}

function first(xml: string, name: string): string | undefined { return tags(xml, name)[0]; }

function parsePom(path: string, xml: string): Pom {
  const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
  const parent = first(xml, "parent");
  const own = xml.replace(/<parent\b[^>]*>[\s\S]*?<\/parent>/, "");
  // Nested plugin/dependency coordinates are not the project's own identity. In
  // particular, a dependency's ${project.groupId} must not shadow an inherited ID.
  const identity = own.replace(/<(dependencies|dependencyManagement|build|profiles|reporting|properties)\b[^>]*>[\s\S]*?<\/\1>/g, "");
  const dependencies = tags(xml, "dependency")
    .map(value => ({ groupId: first(value, "groupId") ?? "", artifactId: first(value, "artifactId") ?? "" }))
    .filter(value => value.artifactId);
  return {
    path, dir,
    groupId: first(identity, "groupId") ?? first(parent ?? "", "groupId"),
    artifactId: first(identity, "artifactId"),
    parent: parent === undefined ? undefined : { groupId: first(parent, "groupId") ?? "", artifactId: first(parent, "artifactId") ?? "" },
    dependencies,
    customSourceRoots: tags(xml, "sourceDirectory").some(root => root !== "src/main/java") ||
      tags(xml, "testSourceDirectory").some(root => root !== "src/test/java"),
  };
}

function under(dir: string, path: string): boolean { return !dir || path === dir || path.startsWith(dir + "/"); }
function owningPom(poms: Pom[], file: string): Pom | undefined {
  return poms.filter(pom => under(pom.dir, file)).sort((a, b) => b.dir.length - a.dir.length)[0];
}
function isTest(path: string): boolean {
  return /\/src\/test\/(?:java|kotlin)\//.test("/" + path) &&
    /^(?:Test.*|.*(?:Test|Tests|TestCase|IT))\.(?:java|kt)$/.test(posix.basename(path));
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

  for (const pom of poms) {
    if (pom.customSourceRoots) result.blockers.push(`Maven ${pom.path}: custom source roots require full validation`);
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
    const sources = owned.filter(file => /\/src\/(?:main|test)\/(?:java|kotlin)\/.*\.(?:java|kt)$/.test("/" + file));
    const assets = owned.filter(file => /\/src\/(?:main|test)\/resources\//.test("/" + file));
    members.set(pom, sources);
    resources.set(pom, assets);
    const anchor = sources[0] ?? assets[0];
    if (anchor) anchors.set(pom, anchor);
    result.sourcePaths.push(...sources);
    result.assetPaths.push(...assets);
    for (const file of sources) {
      if (isTest(file)) { result.testFiles.push(file); result.testPackages[file] = pom.dir || "."; }
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
