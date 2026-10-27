import { describe, expect, it } from "vitest";
import { readIndexCss } from "@/__tests__/support/hostCss";

// The toolbar dictation waveform (#14911) is four background-painted bars, so
// its forced-colours, reduced-motion and contrast treatments live in CSS that
// jsdom never evaluates. These guard each rule's presence in its own block.

function blocksAfter(content: string, marker: string): string {
  const blocks: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = content.indexOf(marker, searchFrom);
    if (start === -1) break;
    const open = content.indexOf("{", start);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (let i = open; i < content.length; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks.push(content.slice(open, end + 1));
    searchFrom = end + 1;
  }
  return blocks.join("\n");
}

// Comments name the same markers and selectors as the rules, so a rule that
// was commented out or swapped for another block would still match.
function hostCss(): string {
  return readIndexCss().replace(/\/\*[\s\S]*?\*\//g, "");
}

const BAR_RULE = /\[data-voice-wave\]\s*>\s*span\s*\{([^}]*)\}/;

describe("toolbar dictation waveform accessibility contract (#14911)", () => {
  it("forced colours paints the bars ButtonText at full strength, inside the button they sit in", () => {
    const rule = blocksAfter(hostCss(), "@media (forced-colors: active)").match(BAR_RULE);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/background-color:\s*ButtonText\s*!important/);
    // !important beats the level loop's inline opacity and the waiting fade.
    expect(rule?.[1]).toMatch(/opacity:\s*1\s*!important/);
    expect(rule?.[1]).not.toMatch(/forced-color-adjust/);
  });

  it("reduced motion stops the waiting fade under both the OS and the app preference", () => {
    // The variant emits both the media query and the body attribute selector,
    // and the unlayered rule there outranks a layered motion-reduce utility.
    const block = blocksAfter(hostCss(), "@variant reduce-motion");
    const stopped = [...block.matchAll(/([^{}]*)\{\s*animation:\s*none;/g)].map((m) => m[1]);
    expect(stopped.some((list) => list?.includes(".animate-voice-wave-wait"))).toBe(true);
  });

  it("increased contrast raises the floor the waiting fade dims to", () => {
    const css = hostCss();
    const keyframes = blocksAfter(css, "@keyframes voice-wave-wait");
    expect(keyframes).toMatch(/opacity:\s*var\(--voice-wave-wait-floor,\s*[\d.]+\)/);
    const rule = blocksAfter(css, "@media (prefers-contrast: more)").match(BAR_RULE);
    const floor = Number(rule?.[1]?.match(/--voice-wave-wait-floor:\s*([\d.]+)/)?.[1]);
    const fallback = Number(
      keyframes.match(/var\(--voice-wave-wait-floor,\s*([\d.]+)\)/)?.[1] ?? Number.NaN
    );
    expect(floor).toBeGreaterThan(fallback);
  });
});
