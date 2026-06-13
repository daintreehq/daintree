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
// Mirrors:
//   const trimmedName = launchOptions?.name?.trim();
//   const customTitle = trimmedName ? { titleMode: "custom" as const } : {};
//   title: trimmedName || computedTitle,
//   ...customTitle
function resolveTitle(
  computedTitle: string,
  name: string | undefined
): { title: string; titleMode?: "custom" } {
  const trimmedName = name?.trim();
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
