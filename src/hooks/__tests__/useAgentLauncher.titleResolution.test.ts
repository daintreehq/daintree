// @vitest-environment node
/**
 * Tests the title / titleMode resolution from useAgentLauncher.ts
 * (issues #10439, #10738).
 *
 * The full hook has deep React/Electron dependencies that make direct rendering
 * costly here, so we mirror the pure branching logic that builds the
 * `AddPanelOptions.title` / `titleMode` pair — see `presetTitle` /
 * `hasPresetTitle` / `trimmedName` / `customTitle` in useAgentLauncher.ts. Any
 * change to those lines should require a corresponding update here.
 */
import { describe, it, expect } from "vitest";
// The real sanitizer, extracted in #11547 — previously hand-mirrored here,
// which could drift from the hook silently.
import { sanitizeTerminalName } from "@/utils/agentLaunchValidation";

// ── mirror of the hook's title-resolution block ──────────────────────────────
// Mirrors the presetTitle/trimmedName/customTitle resolution in
// useAgentLauncher.ts. Any change to that logic should update this mirror.

function resolvePanelTitle(
  computedTitle: string,
  preset: { name?: string; displayTitle?: string } | undefined,
  name: string | undefined
): { title: string; titleMode?: "custom" } {
  // Preset title: explicit displayTitle wins verbatim; otherwise compose the
  // agent name with the preset in brackets. Pinned as "custom" so the
  // agent-detected title sync can't overwrite it with the bare agent name.
  let presetTitle = computedTitle;
  let hasPresetTitle = false;
  if (preset) {
    const presetName = preset.name?.trim();
    if (presetName) {
      hasPresetTitle = true;
      presetTitle = preset.displayTitle?.trim()
        ? preset.displayTitle
        : `${computedTitle} [${presetName}]`;
    }
  }
  const trimmedName = name ? sanitizeTerminalName(name) : undefined;
  // Pin when either a caller name or a preset title is in effect.
  const customTitle = trimmedName || hasPresetTitle ? { titleMode: "custom" as const } : {};
  return { title: trimmedName || presetTitle, ...customTitle };
}

const AGENT_TITLE = "Claude";

describe("assistant-supplied name → title / titleMode", () => {
  it("uses the name as the title and pins it with titleMode 'custom'", () => {
    expect(resolvePanelTitle(AGENT_TITLE, undefined, "Claude: auth refactor")).toEqual({
      title: "Claude: auth refactor",
      titleMode: "custom",
    });
  });

  it("trims surrounding whitespace from a non-empty name", () => {
    expect(resolvePanelTitle(AGENT_TITLE, undefined, "  research work  ")).toEqual({
      title: "research work",
      titleMode: "custom",
    });
  });

  it("strips control characters and collapses whitespace from the name", () => {
    expect(resolvePanelTitle(AGENT_TITLE, undefined, "Claude:\tauth\n\nrefactor")).toEqual({
      title: "Claude: auth refactor",
      titleMode: "custom",
    });
  });

  it("falls back to the computed title when the name is only control characters", () => {
    const result = resolvePanelTitle(AGENT_TITLE, undefined, "\t\n\r");
    expect(result.title).toBe(AGENT_TITLE);
    expect(result.titleMode).toBeUndefined();
  });

  it("falls back to the computed title and sets no titleMode when name is undefined", () => {
    const result = resolvePanelTitle(AGENT_TITLE, undefined, undefined);
    expect(result.title).toBe(AGENT_TITLE);
    expect(result.titleMode).toBeUndefined();
  });

  it("falls back to the computed title and sets no titleMode when name is empty", () => {
    const result = resolvePanelTitle(AGENT_TITLE, undefined, "");
    expect(result.title).toBe(AGENT_TITLE);
    expect(result.titleMode).toBeUndefined();
  });

  it("falls back to the computed title and sets no titleMode when name is whitespace only", () => {
    const result = resolvePanelTitle(AGENT_TITLE, undefined, "   ");
    expect(result.title).toBe(AGENT_TITLE);
    expect(result.titleMode).toBeUndefined();
  });
});

describe("preset → panel title and titleMode pin", () => {
  it("composes '<Agent> [<Preset>]' and pins it when displayTitle is absent", () => {
    // The bracketed preset name must be pinned so agent detection can't
    // overwrite it with the bare agent name (the #10738 regression).
    expect(resolvePanelTitle(AGENT_TITLE, { name: "Z.ai" }, undefined)).toEqual({
      title: "Claude [Z.ai]",
      titleMode: "custom",
    });
  });

  it("uses displayTitle verbatim and pins it when set", () => {
    // Distinct from the composed "Claude [Z.ai]" so this proves displayTitle
    // wins verbatim rather than the bracket fallback happening to match.
    expect(
      resolvePanelTitle(AGENT_TITLE, { name: "Z.ai", displayTitle: "Pinned Route" }, undefined)
    ).toEqual({
      title: "Pinned Route",
      titleMode: "custom",
    });
  });

  it("treats a whitespace-only displayTitle as absent and composes the bracket form", () => {
    expect(
      resolvePanelTitle(AGENT_TITLE, { name: "Z.ai", displayTitle: "   " }, undefined)
    ).toEqual({
      title: "Claude [Z.ai]",
      titleMode: "custom",
    });
  });

  it("ignores a preset whose name is empty/whitespace (no compose, no pin)", () => {
    expect(resolvePanelTitle(AGENT_TITLE, { name: "   " }, undefined)).toEqual({
      title: AGENT_TITLE,
    });
  });

  it("lets an explicit caller-supplied name override the preset title", () => {
    expect(
      resolvePanelTitle(
        AGENT_TITLE,
        { name: "Z.ai", displayTitle: "Claude [Z.ai]" },
        "auth refactor"
      )
    ).toEqual({
      title: "auth refactor",
      titleMode: "custom",
    });
  });

  it("does not pin when there is no preset and no caller name", () => {
    // A default-titled launch stays free for agent detection to relabel.
    expect(resolvePanelTitle(AGENT_TITLE, undefined, undefined)).toEqual({
      title: AGENT_TITLE,
    });
  });
});
