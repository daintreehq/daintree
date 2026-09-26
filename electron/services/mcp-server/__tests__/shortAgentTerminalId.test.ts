import { describe, expect, it } from "vitest";
import { shortAgentTerminalId } from "../sessionServer.js";

describe("shortAgentTerminalId", () => {
  it("names the terminal after its agent with a short suffix", () => {
    expect(shortAgentTerminalId("claude", () => false)).toMatch(/^claude-[0-9a-f]{4}$/);
    expect(shortAgentTerminalId("My Agent!", () => false)).toMatch(/^my-agent-[0-9a-f]{4}$/);
    expect(shortAgentTerminalId(undefined, () => false)).toMatch(/^agent-[0-9a-f]{4}$/);
  });

  it("never returns an id a live terminal holds", () => {
    const taken = new Set<string>();
    const isInUse = (id: string) => {
      if (taken.size < 3) {
        taken.add(id);
        return true;
      }
      return taken.has(id);
    };
    const id = shortAgentTerminalId("codex", isInUse);
    expect(taken.has(id)).toBe(false);
  });

  it("falls back to a longer suffix when every short one is taken", () => {
    expect(shortAgentTerminalId("codex", (id) => /^codex-[0-9a-f]{4}$/.test(id))).toMatch(
      /^codex-[0-9a-f]{8}$/
    );
  });

  it("still returns a free id when every generated suffix collides", () => {
    const id = shortAgentTerminalId("codex", (candidate) => !candidate.includes("-", 6));
    expect(id).toMatch(/^codex-[0-9a-f-]{36}$/);
  });
});
