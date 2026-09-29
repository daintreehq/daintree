// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The composer's control row — `❯`, attach, stash and mic — is one family, so
 * each rule here is stated over all four rather than per control. They drifted
 * apart one control at a time: the `❯` had no hover wash, stash ignored the
 * composer's `disabled`, attach and mic each dimmed themselves on top of the
 * shell's own dim (to 30% and 24% beside a picker at 60%), and three tooltips
 * opened toward the pane edge while one opened away from it.
 *
 * Source enforcement, like the sibling `layout` contract: the classes are where
 * every one of these defects lived.
 */

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function declarations(file: string): string {
  return fs
    .readFileSync(path.join(DIR, file), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The `<Tooltip>…</Tooltip>` block whose button carries `label`, or the file's only one. */
function tooltipBlock(src: string, label?: string): string {
  const blocks = src.match(/<Tooltip>[\s\S]*?<\/Tooltip>/g) ?? [];
  const found = label ? blocks.filter((b) => b.includes(`aria-label="${label}"`)) : blocks;
  expect(found, `one tooltip block for ${label ?? "the mic"}`).toHaveLength(1);
  return found[0]!;
}

/**
 * The button's own props, from `<button` to its `aria-label` — the glyph inside
 * is out of the window, so the mic's paused bars (`opacity-70` marks, not a
 * dim) are not read as the button's.
 */
function button(block: string): string {
  const match = block.match(/<button[\s\S]*?aria-label=/);
  expect(match).not.toBeNull();
  return match![0];
}

function side(block: string): string | undefined {
  return block.match(/<TooltipContent[^>]*\bside="([a-z]+)"/)?.[1];
}

const bar = declarations("HybridInputBar.tsx");
const voice = declarations("VoiceInputButton.tsx");

const CONTROLS = [
  ["picker", tooltipBlock(bar, "Open command picker")],
  ["attach", tooltipBlock(bar, "Attach files")],
  ["stash", tooltipBlock(bar, "Restore stashed input")],
  ["mic", tooltipBlock(voice)],
] as const;

describe("composer control row", () => {
  it.each(CONTROLS)("%s takes the shared text, hover and focus recipe", (_name, block) => {
    const b = button(block);
    for (const recipe of [
      "COMPOSER_CONTROL_TEXT_CLASS",
      "COMPOSER_CONTROL_HOVER_BG_CLASS",
      "COMPOSER_CONTROL_FOCUS_CLASS",
    ]) {
      expect(b).toContain(recipe);
    }
  });

  it.each(CONTROLS)("%s follows the composer's disabled state", (_name, block) => {
    // Bound to the prop, not merely present: `disabled={false}` would pass a
    // presence check and leave the control live in an unavailable composer.
    expect(button(block)).toMatch(/\bdisabled=\{[^}]*\bdisabled\b/);
  });

  it("gives every control one shape, so the hover wash and focus outline match", () => {
    const radii = CONTROLS.map(([name, block]) => {
      const found = button(block).match(/\brounded-[\w[\]()-]+/g) ?? [];
      expect(found, `${name} declares exactly one radius`).toHaveLength(1);
      return found[0];
    });
    expect(new Set(radii).size).toBe(1);
  });

  it.each(CONTROLS)("%s adds no dim of its own, so the shell's is the only one", (_name, block) => {
    expect(button(block)).not.toMatch(/opacity-/);
  });

  it("dims an unavailable composer once, at the shared 50%", () => {
    const dims = bar.match(/disabled && "[^"]*opacity-[^"]*"/g) ?? [];
    expect(dims).toEqual(['disabled && "opacity-50"']);
  });

  it("opens every tooltip on one side, away from the pane edge", () => {
    const sides = new Set(CONTROLS.map(([, block]) => side(block)));
    expect(sides.size).toBe(1);
    expect([...sides][0]).toBe("top");
  });
});
