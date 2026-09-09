/**
 * The bounds on the one `extensionState` key an external MCP client owns.
 *
 * Both helpers here exist to stop a caller-supplied value damaging something
 * downstream of it: the depth check keeps a pathological record from costing
 * every subsequent listing its structured half, and the reader keeps the rest
 * of the bag — `presetEnv` most of all — off a surface every api-key client
 * can call.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_CLIENT_METADATA_DEPTH,
  MCP_CLIENT_METADATA_KEY,
  exceedsClientMetadataDepth,
  readClientMetadata,
} from "../mcpClientMetadata.js";

function nest(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let i = 0; i < depth - 1; i++) value = { next: value };
  return value;
}

describe("exceedsClientMetadataDepth", () => {
  it("accepts a record at the limit and rejects one past it", () => {
    expect(exceedsClientMetadataDepth(nest(MAX_CLIENT_METADATA_DEPTH))).toBe(false);
    expect(exceedsClientMetadataDepth(nest(MAX_CLIENT_METADATA_DEPTH + 1))).toBe(true);
  });

  it("counts arrays as levels, since the transport's own depth check does", () => {
    let arrayNested: unknown = "leaf";
    for (let i = 0; i < MAX_CLIENT_METADATA_DEPTH + 4; i++) arrayNested = [arrayNested];

    expect(exceedsClientMetadataDepth({ deep: arrayNested })).toBe(true);
  });

  it("survives a value deep enough to overflow a recursive check", () => {
    // 2KB of `[[[[…]]]]` nests about a thousand deep, which is the shape this
    // guard exists for — a recursive implementation would blow the stack on the
    // way to rejecting it.
    let bomb: unknown = 0;
    for (let i = 0; i < 20_000; i++) bomb = [bomb];

    expect(exceedsClientMetadataDepth(bomb)).toBe(true);
  });

  it("does not count sibling keys as depth", () => {
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));

    expect(exceedsClientMetadataDepth(wide)).toBe(false);
  });
});

describe("readClientMetadata", () => {
  it("returns only the reserved key, never the bag around it", () => {
    const bag = {
      [MCP_CLIENT_METADATA_KEY]: { session: "gc-1" },
      presetEnv: { ANTHROPIC_API_KEY: "sk-secret" },
    };

    // The whole point: this listing is reachable by every api-key client, and
    // `presetEnv` is a real subprocess environment.
    expect(readClientMetadata(bag)).toEqual({ session: "gc-1" });
  });

  it("reports null for a panel carrying no record", () => {
    expect(readClientMetadata(undefined)).toBeNull();
    expect(readClientMetadata({})).toBeNull();
    expect(readClientMetadata({ presetEnv: { TOKEN: "x" } })).toBeNull();
  });

  it("reports null for a stored value that is not a plain object", () => {
    // Reachable from a hand-edited `state.json` as much as from a build that
    // once wrote a different shape.
    for (const raw of ["str", 7, true, null, ["a"]]) {
      expect(readClientMetadata({ [MCP_CLIENT_METADATA_KEY]: raw })).toBeNull();
    }
  });
});
