import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import * as ids from "../ids.js";
import * as protocol from "../protocol.js";

// `ids.ts` exists so the eager renderer entry can reach the contract without
// zod; `protocol.ts` re-exports it rather than restating it, so there is no
// second copy of a channel name or an id to drift.
describe("shared/ids", () => {
  it("is re-exported by protocol, value-identical", () => {
    for (const [key, value] of Object.entries(ids)) {
      expect(protocol, `protocol re-exports ${key}`).toHaveProperty(key);
      expect((protocol as Record<string, unknown>)[key], key).toBe(value);
    }
  });

  it("stays zod-free", () => {
    const source = readFileSync(new URL("../ids.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bfrom\s+["']zod["']/);
  });
});
