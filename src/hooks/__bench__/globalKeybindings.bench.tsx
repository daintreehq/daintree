// @vitest-environment jsdom
/**
 * Per-keydown cost of the global keybinding capture handler with the real
 * KeybindingService and full default binding set. Dispatches N keydowns per
 * scenario (plain typing into xterm and a textarea, unbound Cmd/Ctrl chords)
 * into a ~3k-node document and reports µs per keydown as the median of five
 * passes. jsdom's selector engine is far slower than Chromium's, so absolute
 * numbers only compare against each other.
 *
 *   npx vitest run -c src/hooks/__bench__/vitest.config.ts
 *   KB_N=1000 npx vitest run -c src/hooks/__bench__/vitest.config.ts
 */
import { renderHook } from "@testing-library/react";
import { describe, it, vi } from "vitest";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(async () => ({ ok: true })), get: vi.fn(() => null) },
}));

import { useGlobalKeybindings } from "../useGlobalKeybindings";

const N = Number(process.env.KB_N ?? 10_000);

function buildDom(): { xterm: HTMLElement; textarea: HTMLElement; body: HTMLElement } {
  // ~3k nodes, roughly the size of a populated window.
  const root = document.createElement("div");
  for (let p = 0; p < 12; p++) {
    const panel = document.createElement("div");
    panel.setAttribute("data-panel-location", "grid");
    for (let r = 0; r < 50; r++) {
      const row = document.createElement("div");
      row.className = "row";
      for (let c = 0; c < 4; c++) {
        const span = document.createElement("span");
        span.textContent = "x";
        row.appendChild(span);
      }
      panel.appendChild(row);
    }
    root.appendChild(panel);
  }
  const xterm = document.createElement("div");
  xterm.className = "xterm";
  const helper = document.createElement("textarea");
  helper.className = "xterm-helper-textarea";
  xterm.appendChild(helper);
  root.appendChild(xterm);
  const composer = document.createElement("textarea");
  root.appendChild(composer);
  document.body.appendChild(root);
  return { xterm: helper, textarea: composer, body: document.body };
}

const letters = "the quick brown fox jumps over the lazy dog 0123456789";
function typingEvents(): KeyboardEventInit[] {
  return Array.from({ length: N }, (_, i) => ({
    key: letters[i % letters.length]!,
    code: "KeyA",
    bubbles: true,
    cancelable: true,
  }));
}
// Modifier chords that do NOT match a default action (so no dispatch noise), plus Cmd+arrow.
function chordEvents(): KeyboardEventInit[] {
  const keys = ["j", "y", "u", "ArrowLeft", "ArrowRight", "4", "m"];
  return Array.from({ length: N }, (_, i) => ({
    key: keys[i % keys.length]!,
    code: "KeyJ",
    metaKey: true,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  }));
}

function run(label: string, target: HTMLElement, inits: KeyboardEventInit[]): void {
  const events = inits.map((init) => new KeyboardEvent("keydown", init));
  for (let i = 0; i < Math.min(1000, N); i++)
    target.dispatchEvent(new KeyboardEvent("keydown", inits[i]!));
  const samples: number[] = [];
  let heap = 0;
  for (let rep = 0; rep < 5; rep++) {
    const evs = rep === 0 ? events : inits.map((init) => new KeyboardEvent("keydown", init));
    const h0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    for (const ev of evs) target.dispatchEvent(ev);
    samples.push(((performance.now() - t0) * 1000) / N);
    heap = (process.memoryUsage().heapUsed - h0) / N;
  }
  samples.sort((a, b) => a - b);
  process.stdout.write(
    `[bench] ${label.padEnd(22)} median ${samples[2]!.toFixed(2)} µs/keydown  min ${samples[0]!.toFixed(2)}  heapΔ ~${heap.toFixed(0)} B/keydown\n`
  );
}

describe("useGlobalKeybindings keydown bench", () => {
  it("dispatches 10k keydowns per scenario", { timeout: 3_600_000 }, () => {
    const dom = buildDom();
    const { unmount } = renderHook(() => useGlobalKeybindings(true));
    run("typing:xterm", dom.xterm, typingEvents());
    run("typing:composer", dom.textarea, typingEvents());
    run("chord:body", dom.body, chordEvents());
    run("chord:xterm", dom.xterm, chordEvents());
    unmount();
    // Floor: the same dispatch with no handler registered.
    run("no-handler:xterm", dom.xterm, typingEvents());
  });
});
