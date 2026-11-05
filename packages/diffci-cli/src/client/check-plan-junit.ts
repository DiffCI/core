// SPDX-License-Identifier: MIT
import { posix, win32 } from "node:path";
import { SaxesParser } from "saxes";

export interface JunitFailure {
  name: string;
  classname?: string;
  suite?: string;
  file?: string;
  suiteFiles: string[];
  suiteNames: string[];
  suiteLevel?: boolean;
}

export interface JunitFailures {
  testCases: number;
  failures: JunitFailure[];
}

interface Suite {
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
    // Bound inherited metadata for both consumers, including passing cases in enforce-misses.
    for (const value of [failure.name, failure.classname, failure.file, failure.suite,
      ...failure.suiteFiles, ...failure.suiteNames]) {
      metadataBytes += value === undefined ? 0 : Buffer.byteLength(value, "utf8");
      if (metadataBytes > MAX_BYTES) invalid("Failure metadata exceeds the 16 MiB limit.");
    }
    if (failed) result.failures.push(failure);
    onCase?.(failure, failed, skipped);
  }
  function inherited(): Pick<JunitFailure, "suite" | "suiteFiles" | "suiteNames"> {
    return {
      suite: [...suites].reverse().find((suite) => suite.element === "testsuite")?.name,
      suiteFiles: suites.flatMap((suite) => suite.file === undefined ? [] : [suite.file]),
      suiteNames: suites.flatMap((suite) => suite.element !== "testsuite" || suite.name === undefined ? [] : [suite.name]),
    };
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
    if (name === "testsuite" || name === "testsuites") {
      if (parent && parent.name !== "testsuite" && parent.name !== "testsuites") {
        invalid("A test suite must be inside a suite container.");
      }
      const suite: Suite = {
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
      if (parent?.name !== "testsuite" && parent?.name !== "testsuites") invalid("A testcase must be inside a testsuite.");
      frame.testCase = {
        skipped: false,
        failed: attributes.failure !== undefined,
        errored: false,
        failure: {
          name: attributes.name ?? "(unnamed testcase)",
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

export function parseJunitFailures(xml: string): JunitFailures {
  return readJunit(xml);
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

export function junitFile(test: JunitFailure, repoRoot: string, root = "."): string {
  if (test.suiteLevel) return "";
  const explicit = test.file !== undefined ? [test.file] : test.suiteFiles;
  const values = explicit.length ? explicit : [test.classname, ...test.suiteNames]
    .filter((value): value is string => value !== undefined && /\.[cm]?[jt]sx?$/.test(value));
  const candidates = values.map(value => normalizeTestPath(value, repoRoot, root));
  return candidates.length && candidates.every(value => value !== "" && value === candidates[0]) ? candidates[0]! : "";
}
