import { beforeEach, describe, expect, it, vi } from "vitest";

const { serializeSpy } = vi.hoisted(() => ({ serializeSpy: vi.fn() }));
vi.mock("../../../utils/safeSerializeToolResult.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/safeSerializeToolResult.js")>();
  serializeSpy.mockImplementation(actual.safeSerializeToolResult);
  return { ...actual, safeSerializeToolResult: serializeSpy };
});

import { stableArgsSha256 } from "../../../utils/pluginMcpHash.js";
import { PLUGIN_AUDIT_ARGS_HASH_MAX_BYTES, safeArgsHash } from "../pluginAuditArgsHash.js";

function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = { n: value };
  return value;
}

describe("safeArgsHash", () => {
  beforeEach(() => {
    serializeSpy.mockClear();
  });

  it("hashes args within the budget exactly as the canonical hash does", () => {
    const args = [{ b: 1, a: ["x", { d: true, c: null }] }, new Uint8Array([1, 2, 3]), nested(20)];
    expect(safeArgsHash(args)).toBe(stableArgsSha256(args));
    expect(safeArgsHash([{ a: 1, b: 2 }])).toBe(safeArgsHash([{ b: 2, a: 1 }]));
  });

  it.each([
    ["one large string", () => ["x".repeat(PLUGIN_AUDIT_ARGS_HASH_MAX_BYTES + 1)]],
    [
      "many small values",
      () => [Array.from({ length: PLUGIN_AUDIT_ARGS_HASH_MAX_BYTES / 8 + 1 }, (_, i) => i)],
    ],
    // Small to clone, since structured clone copies the shared buffer once,
    // but every view's indices are listed, sorted and printed when hashed.
    [
      "views sharing one buffer",
      () => {
        const buffer = new ArrayBuffer(60_000);
        return Array.from({ length: 20 }, () => new Uint8Array(buffer));
      },
    ],
    // A few KiB to clone, but each level indents every line below it.
    ["deep nesting", () => [nested(1200)]],
    // Holes clone as nothing much, but each prints an indented `null`.
    [
      "a sparse array deep in the args",
      () => {
        let value: unknown = new Array(50_000);
        for (let i = 0; i < 100; i++) value = { n: value };
        return [value];
      },
    ],
  ])("leaves %s unhashed without serializing it", (_name, make) => {
    expect(safeArgsHash(make())).toBe("");
    expect(serializeSpy).not.toHaveBeenCalled();
  });

  it("refuses views over a shared buffer before listing any view's indices", () => {
    const buffer = new ArrayBuffer(60_000);
    const views = Array.from({ length: 20 }, () => new Uint8Array(buffer));
    const entries = vi.spyOn(Object, "entries");
    try {
      expect(safeArgsHash(views)).toBe("");
      expect(entries.mock.calls.some(([value]) => ArrayBuffer.isView(value))).toBe(false);
    } finally {
      entries.mockRestore();
    }
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
