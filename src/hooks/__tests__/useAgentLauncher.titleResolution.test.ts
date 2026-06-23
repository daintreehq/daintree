// @vitest-environment node
/**
 * Tests the assistant-supplied `name` → title / titleMode resolution from
 * useAgentLauncher.ts (issue #10439).
 *
 * The full hook has deep React/Electron dependencies that make direct rendering
 * costly here, so we mirror the pure branching logic that builds the
 * `AddPanelOptions.title` / `titleMode` pair — see `trimmedName` / `customTitle`
 * in useAgentLauncher.ts. Any change to those lines should require a
 * corresponding update here.
 */
import { describe, it, expect } from "vitest";

// ── mirror of the hook's title-resolution block ──────────────────────────────
// Mirrors `sanitizeTerminalName` + the trimmedName/customTitle branch in
// useAgentLauncher.ts. Any change to that logic should update this mirror.
function sanitizeTerminalName(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code <= 0x1f || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

function resolveTitle(
  computedTitle: string,
  name: string | undefined
): { title: string; titleMode?: "custom" } {
  const trimmedName = name ? sanitizeTerminalName(name) : undefined;
  const customTitle = trimmedName ? { titleMode: "custom" as const } : {};
  return { title: trimmedName || computedTitle, ...customTitle };
}

const DEFAULT_TITLE = "Claude";

describe("assistant-supplied name → title / titleMode", () => {
  it("uses the name as the title and pins it with titleMode 'custom'", () => {
    expect(resolveTitle(DEFAULT_TITLE, "Claude: auth refactor")).toEqual({
      title: "Claude: auth refactor",
      titleMode: "custom",
    });
  });

  it("trims surrounding whitespace from a non-empty name", () => {
    expect(resolveTitle(DEFAULT_TITLE, "  research work  ")).toEqual({
      title: "research work",
      titleMode: "custom",
    });
  });

  it("strips control characters and collapses whitespace from the name", () => {
    expect(resolveTitle(DEFAULT_TITLE, "Claude:\tauth\n\nrefactor")).toEqual({
      title: "Claude: auth refactor",
      titleMode: "custom",
    });
  });

  it("falls back to the default when the name is only control characters", () => {
    const result = resolveTitle(DEFAULT_TITLE, "\t\n\r");
    expect(result.title).toBe(DEFAULT_TITLE);
    expect(result.titleMode).toBeUndefined();
  });

  it("falls back to the computed title and sets no titleMode when name is undefined", () => {
    const result = resolveTitle(DEFAULT_TITLE, undefined);
    expect(result.title).toBe(DEFAULT_TITLE);
    expect(result.titleMode).toBeUndefined();
  });

  it("falls back to the computed title and sets no titleMode when name is empty", () => {
    const result = resolveTitle(DEFAULT_TITLE, "");
    expect(result.title).toBe(DEFAULT_TITLE);
    expect(result.titleMode).toBeUndefined();
  });

  it("falls back to the computed title and sets no titleMode when name is whitespace only", () => {
    const result = resolveTitle(DEFAULT_TITLE, "   ");
    expect(result.title).toBe(DEFAULT_TITLE);
    expect(result.titleMode).toBeUndefined();
  });

  it("does not pin (titleMode) merely because a computed title exists", () => {
    // The pin is owned by the caller's name, never by the default title — so a
    // default-titled launch stays free for agent detection to relabel.
    const result = resolveTitle(DEFAULT_TITLE, undefined);
    expect(result.titleMode).toBeUndefined();
  });
});

// ── mirror of the hook's preset-title resolution (issue #10738) ──────────────
// Mirrors `presetTitle` + the `trimmedName || presetTitle` selection in
// useAgentLauncher.ts. A preset's optional displayTitle overrides its name,
// but an explicit caller-supplied name still wins over both.
function resolveLaunchTitle(
  computedTitle: string,
  preset: { name: string; displayTitle?: string } | undefined,
  name: string | undefined
): string {
  const presetTitle = preset ? (preset.displayTitle ?? preset.name) : computedTitle;
  const trimmedName = name ? sanitizeTerminalName(name) : undefined;
  return trimmedName || presetTitle;
}

describe("preset displayTitle → panel title", () => {
  it("prefers displayTitle over the preset name", () => {
    expect(
      resolveLaunchTitle(
        DEFAULT_TITLE,
        { name: "Claude", displayTitle: "Claude [Z.ai]" },
        undefined
      )
    ).toBe("Claude [Z.ai]");
  });

  it("falls back to the preset name when displayTitle is absent", () => {
    expect(resolveLaunchTitle(DEFAULT_TITLE, { name: "Claude" }, undefined)).toBe("Claude");
  });

  it("lets an explicit caller-supplied name override displayTitle", () => {
    expect(
      resolveLaunchTitle(
        DEFAULT_TITLE,
        { name: "Claude", displayTitle: "Claude [Z.ai]" },
        "auth refactor"
      )
    ).toBe("auth refactor");
  });
});
