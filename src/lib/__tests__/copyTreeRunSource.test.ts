import { describe, expect, it } from "vitest";
import { resolveCopyTreeRunSource } from "../copyTreeRunSource";
import type { ActionSource } from "@shared/types/actions";

describe("resolveCopyTreeRunSource", () => {
  it("lets a caller that knows its surface override the dispatch source", () => {
    // The case that motivates the parameter: both of these dispatch as
    // "context-menu", so only the explicit value tells them apart.
    expect(resolveCopyTreeRunSource("context-menu", "worktree-card")).toBe("worktree-card");
    expect(resolveCopyTreeRunSource("context-menu", "file-browser")).toBe("file-browser");
  });

  it("honours an explicit surface even when the dispatch source is inferable", () => {
    expect(resolveCopyTreeRunSource("keybinding", "toolbar")).toBe("toolbar");
    expect(resolveCopyTreeRunSource("agent", "toolbar")).toBe("toolbar");
  });

  it("infers a keyboard shortcut", () => {
    expect(resolveCopyTreeRunSource("keybinding")).toBe("shortcut");
  });

  it("infers an agent dispatch as MCP", () => {
    expect(resolveCopyTreeRunSource("agent")).toBe("mcp");
  });

  it("refuses to guess for sources that do not identify a surface", () => {
    const ambiguous: ActionSource[] = ["user", "menu", "context-menu", "plugin"];
    for (const source of ambiguous) {
      expect(resolveCopyTreeRunSource(source)).toBe("unknown");
    }
  });

  it("falls back to unknown when there is no dispatch source at all", () => {
    expect(resolveCopyTreeRunSource(undefined)).toBe("unknown");
  });
});
