import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import rule from "./structured-test-skip-annotations.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022 },
});

ruleTester.run("structured-test-skip-annotations", rule, {
  valid: [
    {
      name: "single annotation immediately before skip",
      code: `
        test("a", async () => {
          test.info().annotations.push({ type: "platform-skip", description: "linux only" });
          test.skip();
        });
      `,
    },
    {
      name: "two consecutive annotation+skip pairs each carry their own annotation",
      code: `
        test("a", async () => {
          test.info().annotations.push({ type: "platform-skip", description: "linux only" });
          test.skip();
          test.info().annotations.push({ type: "conditional-skip", description: "needs api key" });
          test.skip();
        });
      `,
    },
    {
      name: "static skip declaration with details.annotation is untouched",
      code: `
        test.skip("static one", { annotation: { type: "platform-skip", description: "win only" } }, async () => {});
      `,
    },
    {
      name: "quarantine annotation with a dated description",
      code: `
        test("a", async () => {
          test.info().annotations.push({ type: "quarantine", description: "2026-01-15 flaky on CI" });
          test.skip();
        });
      `,
    },
    {
      name: "comments and blank lines between annotation and skip are allowed",
      code: `
        test("a", async () => {
          test.info().annotations.push({ type: "platform-skip", description: "linux only" });

          // skip on non-linux
          test.skip();
        });
      `,
    },
  ],
  invalid: [
    {
      name: "skip with no preceding annotation",
      code: `
        test("a", async () => {
          test.skip();
        });
      `,
      errors: [{ messageId: "missingAnnotation" }],
    },
    {
      name: "second skip borrows the first skip's annotation (the bug)",
      code: `
        test("a", async () => {
          test.info().annotations.push({ type: "platform-skip", description: "linux only" });
          test.skip();
          test.skip();
        });
      `,
      errors: [{ messageId: "missingAnnotation" }],
    },
    {
      name: "intervening helper statement between annotation and skip",
      code: `
        test("a", async () => {
          test.info().annotations.push({ type: "platform-skip", description: "linux only" });
          doSomething();
          test.skip();
        });
      `,
      errors: [{ messageId: "missingAnnotation" }],
    },
    {
      name: "annotation type not in the allowed set",
      code: `
        test("a", async () => {
          test.info().annotations.push({ type: "flakey", description: "sometimes fails" });
          test.skip();
        });
      `,
      errors: [{ messageId: "invalidType" }],
    },
    {
      name: "quarantine annotation missing the YYYY-MM-DD prefix",
      code: `
        test("a", async () => {
          test.info().annotations.push({ type: "quarantine", description: "flaky on CI" });
          test.skip();
        });
      `,
      errors: [{ messageId: "quarantineMissingDate" }],
    },
    {
      name: "static skip declaration with no annotation in details",
      code: `
        test.skip("static one", async () => {});
      `,
      errors: [{ messageId: "missingAnnotation" }],
    },
    {
      name: "static skip quarantine annotation missing the YYYY-MM-DD prefix",
      code: `
        test.skip("static one", { annotation: { type: "quarantine", description: "flaky on CI" } }, async () => {});
      `,
      errors: [{ messageId: "quarantineMissingDate" }],
    },
  ],
});
