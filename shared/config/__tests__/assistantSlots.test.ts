import { describe, expect, it } from "vitest";
import {
  ASSISTANT_LANE_CONFIG_DIR,
  MAX_ASSISTANT_SLOTS,
  assistantLaneMcpConfigName,
  assistantSessionDirName,
  assistantSlotKey,
  isAssistantSessionDirName,
  isValidAssistantSlot,
  projectIdFromSlotKey,
  sessionIdFromLaneMcpConfigName,
} from "../assistantSlots.js";

const HASH = "0123456789abcdef";

describe("assistantSlots", () => {
  it("gives every lane of a project the same session directory", () => {
    // One folder per project is what makes the agent's per-folder trust and
    // `.mcp.json` approval prompts fire once per project rather than per lane.
    expect(assistantSessionDirName(HASH)).toBe(HASH);
  });

  it("recognises only the bare project hash as a live session directory", () => {
    // Load-bearing for GC, which deletes whatever this rejects. The two legacy
    // shapes — per-launch UUIDs and the `-sN` per-lane directories — must be
    // rejected so they are collected, and nothing else may be accepted.
    expect(isAssistantSessionDirName(HASH, HASH.length)).toBe(true);
    expect(isAssistantSessionDirName(`${HASH}-s1`, HASH.length)).toBe(false);
    expect(isAssistantSessionDirName(`${HASH}-s0`, HASH.length)).toBe(false);
    expect(isAssistantSessionDirName("3f2504e0-4f89-11d3-9a0c-0305e82c3301", HASH.length)).toBe(
      false
    );
    expect(isAssistantSessionDirName(HASH.slice(1), HASH.length)).toBe(false);
    expect(isAssistantSessionDirName(HASH.toUpperCase(), HASH.length)).toBe(false);
  });

  it("names lane files per provision and recovers the session id from the name", () => {
    // Per provision, not per slot: a same-slot re-provision must not share a file
    // name with the session it replaced, whose late revoke may still delete its own.
    const a = assistantLaneMcpConfigName(1, "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    const b = assistantLaneMcpConfigName(1, "9b2c7a10-0000-4000-8000-000000000001");
    expect(a).not.toBe(b);
    expect(sessionIdFromLaneMcpConfigName(a)).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(sessionIdFromLaneMcpConfigName("slot-0.mcp.json")).toBeNull();
    expect(sessionIdFromLaneMcpConfigName("notes.txt")).toBeNull();
    expect(ASSISTANT_LANE_CONFIG_DIR.startsWith(".")).toBe(true);
  });

  it("round-trips a project id through the slot key, NUL delimiter included", () => {
    // A project id can be a filesystem path, and every printable separator is
    // a legal path character — so the key uses NUL and splits on the LAST one.
    const id = "/Users/me/proj with spaces/and-dashes";
    const key = assistantSlotKey(id, 2);
    expect(key).toBe(`${id}\u0000${2}`);
    expect(projectIdFromSlotKey(key)).toBe(id);
    expect(projectIdFromSlotKey(`weird\u0000inside\u00001`)).toBe("weird\u0000inside");
    expect(projectIdFromSlotKey("no-delimiter")).toBe("no-delimiter");
  });

  it("accepts exactly the slots below the ceiling", () => {
    for (let slot = 0; slot < MAX_ASSISTANT_SLOTS; slot += 1) {
      expect(isValidAssistantSlot(slot)).toBe(true);
    }
    expect(isValidAssistantSlot(MAX_ASSISTANT_SLOTS)).toBe(false);
    expect(isValidAssistantSlot(-1)).toBe(false);
    expect(isValidAssistantSlot(1.5)).toBe(false);
    expect(isValidAssistantSlot("1")).toBe(false);
  });
});
