import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { describe, it } from "vitest";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

export function createRuleTester() {
  return new RuleTester({
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  });
}

/**
 * The parser the rules actually run under. Espree cannot represent `as` casts or
 * the other TypeScript wrappers the walker has to see through, so those cases
 * would silently pass on a parser that never produces the node.
 */
export function createTsRuleTester() {
  return new RuleTester({
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  });
}
