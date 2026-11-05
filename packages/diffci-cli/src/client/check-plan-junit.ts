// SPDX-License-Identifier: MIT
import { SaxesParser } from "saxes";

export interface JunitFailure {
  name: string;
  classname?: string;
  suite?: string;
  file?: string;
  suiteFiles: string[];
  suiteNames: string[];
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
  failure: JunitFailure;
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
export function parseJunitFailures(xml: string): JunitFailures {
  if (Buffer.byteLength(xml, "utf8") > MAX_BYTES) {
    invalid("XML exceeds the 16 MiB limit.");
  }

  const result: JunitFailures = { testCases: 0, failures: [] };
  const frames: Frame[] = [];
  const suites: Suite[] = [];
  let tags = 0;
  let metadataBytes = 0;
  const parser = new SaxesParser({ xmlns: true });

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
    if (Object.values(tag.attributes).some((attribute) => attribute.uri !== "")) {
      invalid("Namespaced JUnit attributes and namespace declarations are not supported.");
    }
    const attributes = Object.fromEntries(
      Object.entries(tag.attributes).map(([key, attribute]) => [key, attribute.value]),
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
      if (parent?.name !== "testsuite") invalid("A testcase must be inside a testsuite.");
      const testSuites = suites.filter((suite) => suite.element === "testsuite");
      frame.testCase = {
        failed: false,
        errored: false,
        failure: {
          name: attributes.name ?? "(unnamed testcase)",
          classname: attributes.classname,
          file: attributes.file,
          suite: testSuites[testSuites.length - 1]?.name,
          suiteFiles: suites.flatMap((suite) => suite.file === undefined ? [] : [suite.file]),
          suiteNames: suites.flatMap((suite) => suite.name === undefined ? [] : [suite.name]),
        },
      };
      result.testCases += 1;
    } else if (name === "failure" || name === "error") {
      if (!parent?.testCase) invalid("Failure evidence must be a direct testcase child.");
      if (name === "failure") parent.testCase.failed = true;
      else parent.testCase.errored = true;
    }
    frames.push(frame);
  });
  parser.on("closetag", () => {
    const frame = frames.pop()!;
    if (frame.testCase) {
      const testCase = frame.testCase;
      if (testCase.failed || testCase.errored) {
        const failure = testCase.failure;
        // Inherited names/files repeat across cases; bound that expansion before mapping/output.
        for (const value of [failure.name, failure.classname, failure.file, failure.suite,
          ...failure.suiteFiles, ...failure.suiteNames]) {
          metadataBytes += value === undefined ? 0 : Buffer.byteLength(value, "utf8");
          if (metadataBytes > MAX_BYTES) invalid("Failure metadata exceeds the 16 MiB limit.");
        }
        result.failures.push(failure);
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
  if (result.testCases === 0) invalid("The report contains no testcases.");
  return result;
}
