import { describe, expect, it } from "vitest";
import { stableArgsSha256 } from "../../../utils/pluginMcpHash.js";
import { PLUGIN_AUDIT_ARGS_HASH_MAX_BYTES, safeArgsHash } from "../pluginAuditArgsHash.js";

describe("safeArgsHash", () => {
  it("hashes args within the budget exactly as the canonical hash does", () => {
    const args = [{ b: 1, a: ["x", { d: true, c: null }] }];
    expect(safeArgsHash(args)).toBe(stableArgsSha256(args));
    expect(safeArgsHash([{ a: 1, b: 2 }])).toBe(safeArgsHash([{ b: 2, a: 1 }]));
  });

  it("leaves args over the budget unhashed", () => {
    expect(safeArgsHash(["x".repeat(PLUGIN_AUDIT_ARGS_HASH_MAX_BYTES + 1)])).toBe("");
    // Many small values add up the same as one large one.
    const wide = Array.from({ length: PLUGIN_AUDIT_ARGS_HASH_MAX_BYTES / 8 + 1 }, (_, i) => i);
    expect(safeArgsHash([wide])).toBe("");
  });

  it("degrades to an empty hash rather than throwing", () => {
    const hostile = {
      get boom(): never {
        throw new Error("getter threw");
      },
    };
    expect(safeArgsHash([hostile])).toBe("");
  });
});
