// SPDX-License-Identifier: MIT
import { posix, win32 } from "node:path";
import { SaxesParser } from "saxes";

export interface JunitFailure {
  name: string;
  classname?: string;
  suite?: string;
  file?: string;
  suiteFiles: readonly string[];
  suiteNames: readonly string[];
  suiteLevel?: boolean;
}

export interface JunitFailures {
  testCases: number;
  failures: JunitFailure[];
}

interface Suite {
  metadata: Pick<JunitFailure, "suite" | "suiteFiles" | "suiteNames">;
  element: string;
  name?: string;
  file?: string;
  declaredTests?: number;
  declaredFailures?: number;
  declaredErrors?: number;
  testCases: number;
  failures: number;
  errors: number;
}

interface TestCase {
  failure: Omit<JunitFailure, "suiteFiles" | "suiteNames">;
  skipped: boolean;
  failed: boolean;
  errored: boolean;
}

interface Frame {
  name: string;
  suite?: Suite;
  testCase?: TestCase;
  /** Node's `<undefined name="root">` wrapper: transparent, carries no suite identity. */
  nodeRoot?: boolean;
}

/** A frame that may directly contain testsuite and testcase elements. */
function isSuiteContainer(frame: Frame | undefined): boolean {
  return frame?.name === "testsuite" || frame?.name === "testsuites" || frame?.nodeRoot === true;
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_TAGS = 100_000;
const IGNORED_ATTRIBUTE_URIS = new Set([
  "http://www.w3.org/2000/xmlns/",
  "http://www.w3.org/2001/XMLSchema-instance",
  "http://www.w3.org/XML/1998/namespace",
]);

function invalid(message: string): never {
  throw new Error(`Invalid JUnit report: ${message}`);
}

function declaredCount(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const count = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(count)) {
    invalid(`${name} must be a nonnegative integer.`);
  }
  return count;
}

/** Read only structural failure evidence; logs, comments and CDATA are never tags. */
export function readJunit(xml: string, onCase?: (test: JunitFailure, failed: boolean, skipped: boolean) => void): JunitFailures {
  if (Buffer.byteLength(xml, "utf8") > MAX_BYTES) {
    invalid("XML exceeds the 16 MiB limit.");
  }

  const result: JunitFailures = { testCases: 0, failures: [] };
  const frames: Frame[] = [];
  const suites: Suite[] = [];
  let tags = 0;
  let metadataBytes = 0;
  const parser = new SaxesParser({ xmlns: true });

  function emit(failure: JunitFailure, failed: boolean, skipped: boolean): void {
    // Passing cases are transient callback data, not retained failure output.
    if (failed) {
      for (const value of [failure.name, failure.classname, failure.file, failure.suite,
        ...failure.suiteFiles, ...failure.suiteNames]) {
        metadataBytes += value === undefined ? 0 : Buffer.byteLength(value, "utf8");
        if (metadataBytes > MAX_BYTES) invalid("Failure metadata exceeds the 16 MiB limit.");
      }
      result.failures.push(failure);
    }
    onCase?.(failure, failed, skipped);
  }
  function inherited(): Pick<JunitFailure, "suite" | "suiteFiles" | "suiteNames"> {
    return suites[suites.length - 1]?.metadata ?? { suiteFiles: [], suiteNames: [] };
  }

  // Keep the parser's default throwing error handler: partial XML is not evidence.
  parser.on("doctype", () => invalid("DOCTYPE declarations are not supported."));
  parser.on("xmldecl", (declaration) => {
    if (declaration.version !== "1.0") invalid("Only XML 1.0 is supported.");
    if (declaration.encoding && declaration.encoding.toUpperCase() !== "UTF-8") {
      invalid("Only UTF-8 XML is supported.");
    }
  });
  parser.on("opentagstart", () => {
    if (++tags > MAX_TAGS) invalid("XML exceeds the 100000 tag limit.");
    if (frames.length >= MAX_DEPTH) invalid("XML exceeds the 128 level depth limit.");
  });
  parser.on("opentag", (tag) => {
    const name = tag.name;
    const parent = frames[frames.length - 1];
    if (tag.uri !== "") invalid("Namespaced JUnit elements are not supported.");
    // Namespace declarations and schema hints carry no testcase identity. Unknown qualified
    // metadata is still refused so x:file/x:failures cannot silently disappear.
    if (Object.values(tag.attributes).some((attribute) => attribute.uri !== "" && !IGNORED_ATTRIBUTE_URIS.has(attribute.uri))) {
      invalid("Unsupported namespaced JUnit attribute.");
    }
    const attributes = Object.fromEntries(
      Object.entries(tag.attributes).filter(([, attribute]) => attribute.uri === "").map(([key, attribute]) => [key, attribute.value]),
    );
    const frame: Frame = { name };

    if (!parent && name !== "testsuite" && name !== "testsuites") {
      invalid("The root must be testsuite or testsuites.");
    }
    if (name === "undefined" && attributes.name === "root" && parent?.name === "testsuites" && frames.length === 1) {
      // Node's built-in junit reporter (verified on 24.16.0) writes the root test as this tag when a
      // root-level hook fails, and nests the rest of the report inside it. It names no suite or file.
      frame.nodeRoot = true;
    } else if (name === "testsuite" || name === "testsuites") {
      if (parent && !isSuiteContainer(parent)) {
        invalid("A test suite must be inside a suite container.");
      }
      const outer = inherited();
      const suite: Suite = {
        metadata: {
          suite: name === "testsuite" ? attributes.name : outer.suite,
          suiteFiles: attributes.file === undefined ? outer.suiteFiles : [...outer.suiteFiles, attributes.file],
          suiteNames: name !== "testsuite" || attributes.name === undefined ? outer.suiteNames : [...outer.suiteNames, attributes.name],
        },
        element: name,
        name: attributes.name,
        file: attributes.file,
        declaredTests: declaredCount(attributes.tests, "tests"),
        declaredFailures: declaredCount(attributes.failures, "failures"),
        declaredErrors: declaredCount(attributes.errors, "errors"),
        testCases: 0,
        failures: 0,
        errors: 0,
      };
      frame.suite = suite;
      suites.push(suite);
    } else if (name === "testcase") {
      if (!isSuiteContainer(parent)) invalid("A testcase must be inside a testsuite.");
      frame.testCase = {
        skipped: false,
        failed: attributes.failure !== undefined,
        errored: false,
        failure: {
          name: attributes.name ?? "",
          classname: attributes.classname,
          file: attributes.file,
        },
      };
      result.testCases += 1;
    } else if (name === "failure" || name === "error") {
      if (parent?.testCase) {
        if (name === "failure") parent.testCase.failed = true;
        else parent.testCase.errored = true;
      } else if (parent?.suite) {
        emit({ name: attributes.message ?? `(suite ${name})`, suiteLevel: true, ...inherited() }, true, false);
        for (const suite of suites) {
          if (name === "failure") suite.failures += 1;
          else suite.errors += 1;
        }
      } else invalid("Failure evidence must be a direct testcase or suite child.");
    } else if (name === "skipped" && parent?.testCase) {
      parent.testCase.skipped = true;
    }
    frames.push(frame);
  });
  parser.on("closetag", () => {
    const frame = frames.pop()!;
    if (frame.testCase) {
      const testCase = frame.testCase;
      if (testCase.failed || testCase.errored || onCase) {
        emit({ ...testCase.failure, ...inherited() }, testCase.failed || testCase.errored, testCase.skipped);
      }
      for (const suite of suites) {
        suite.testCases += 1;
        if (testCase.failed) suite.failures += 1;
        if (testCase.errored) suite.errors += 1;
      }
    }
    if (frame.suite) {
      const suite = frame.suite;
      // jest-junit can emit extra load-error cases without increasing its headers.
      // A higher header, however, means testcase evidence is missing from the report.
      if ((suite.declaredTests ?? 0) > suite.testCases ||
          (suite.declaredFailures ?? 0) > suite.failures ||
          (suite.declaredErrors ?? 0) > suite.errors) {
        invalid("Declared tests, failures or errors exceed the observed testcase evidence.");
      }
      suites.pop();
    }
  });
  parser.write(xml).close();
  if (result.testCases === 0 && result.failures.length === 0) invalid("The report contains no testcases.");
  return result;
}

/** Lexical mapping only: never guess the checkout root from a suffix or access the filesystem. */
export function normalizeTestPath(value: string, repoRoot: string, root = "."): string {
  const slashed = value.replace(/\\/g, "/");
  if (!slashed || /[\x00-\x1f\x7f]/.test(slashed) || slashed.endsWith("/") || slashed.endsWith("/.")
    || slashed.split("/").includes("..")) return "";
  const windows = /^[a-z]:\//i.test(slashed) || slashed.startsWith("//");
  const path = windows ? win32 : posix;
  if (path.isAbsolute(slashed)) {
    const checkout = repoRoot.replace(/\\/g, "/");
    if (!path.isAbsolute(checkout) || (windows && !win32.isAbsolute(repoRoot))) return slashed;
    const inside = path.relative(checkout, slashed).replace(/\\/g, "/");
    return inside && inside !== ".." && !inside.startsWith("../") && !path.isAbsolute(inside) ? inside : slashed;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(slashed)) return "";
  return posix.normalize(posix.join(root, slashed));
}

export type JunitAttribution = { file: string } | { reason: string; candidates?: string[] };

export function attributeJunitFile(test: JunitFailure, repoRoot: string, root = "."): JunitAttribution {
  if (test.suiteLevel) return { reason: "Suite-level failure has no testcase file identity" };
  const explicit = test.file !== undefined ? [test.file] : test.suiteFiles;
  const values = explicit.length ? explicit : [test.classname, ...test.suiteNames]
    .filter((value): value is string => value !== undefined && /\.[cm]?[jt]sx?$/.test(value));
  if (!values.length) return { reason: "No file attribute or recognizable JavaScript file metadata" };
  const paths = values.map(value => normalizeTestPath(value, repoRoot, root));
  const candidates = [...new Set(paths.filter(Boolean))].sort();
  if (paths.some(path => !path || posix.isAbsolute(path) || win32.isAbsolute(path))) {
    return { reason: "File path is invalid or outside the checkout; check --repo/--base-repo", candidates };
  }
  if (candidates.length !== 1) return { reason: "File metadata identifies multiple files", candidates };
  return { file: candidates[0]! };
}

export function junitFile(test: JunitFailure, repoRoot: string, root = "."): string {
  const attribution = attributeJunitFile(test, repoRoot, root);
  return "file" in attribution ? attribution.file : "";
}
