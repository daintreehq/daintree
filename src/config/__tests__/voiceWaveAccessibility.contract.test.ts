import { describe, expect, it } from "vitest";
import { readIndexCss } from "@/__tests__/support/hostCss";

// The toolbar dictation waveform (#14911) is four background-painted bars, so
// its forced-colours treatment lives in CSS that jsdom never evaluates.

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
  it("forced colours paints the bars ButtonText, the pair for marks inside a button", () => {
    const rule = blocksAfter(hostCss(), "@media (forced-colors: active)").match(BAR_RULE);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/background-color:\s*ButtonText\s*!important/);
    expect(rule?.[1]).not.toMatch(/forced-color-adjust/);
  });
});
