// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CHORD_TIMEOUT_MS } from "@/services/KeybindingService";
import { SettingsShortcutCapture } from "../SettingsShortcutCapture";

// Deliberately not the shipping 1000ms: the bar has to follow the constant, not
// happen to agree with it.
vi.mock("@/services/KeybindingService", async () => {
  const actual = await vi.importActual<typeof import("@/services/KeybindingService")>(
    "@/services/KeybindingService"
  );
  return {
    ...actual,
    CHORD_TIMEOUT_MS: 2400,
    keybindingService: {
      findConflicts: vi.fn(() => []),
      beginShortcutCapture: vi.fn(() => () => {}),
      formatComboForDisplay: vi.fn((combo: string) => combo),
      getOverride: vi.fn(() => undefined),
      getDefaultCombo: vi.fn(() => undefined),
    },
    normalizeKeyForBinding: vi.fn((e: KeyboardEvent) => e.key),
  };
});

vi.mock("@/lib/platform", () => ({
  isMac: vi.fn(() => false),
  isWindows: vi.fn(() => false),
  isLinux: vi.fn(() => false),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

const INDEX_CSS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../index.css");

const bar = () => document.querySelector<HTMLElement>("[data-chord-window]");

function press(key: string) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ctrlKey: true })
    );
  });
}

function renderArmed() {
  render(
    <SettingsShortcutCapture onCapture={vi.fn()} onCancel={vi.fn()} excludeActionId="test.action" />
  );
  fireEvent.click(screen.getByText("Click to record shortcut"));
}

describe("SettingsShortcutCapture chord window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the bar only while the recorder waits for a second stroke", () => {
    renderArmed();
    expect(bar()).toBeNull();

    press("k");
    expect(bar()).not.toBeNull();

    press("s");
    expect(bar()).toBeNull();
  });

  it("drains over the same window the recorder waits, and leaves when it ends", () => {
    renderArmed();
    press("k");

    expect(bar()!.style.getPropertyValue("--chord-window")).toBe(`${CHORD_TIMEOUT_MS}ms`);

    act(() => {
      vi.advanceTimersByTime(CHORD_TIMEOUT_MS - 1);
    });
    expect(bar()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(bar()).toBeNull();
  });

  it("is hidden from assistive technology, leaving the status copy to speak", () => {
    renderArmed();
    press("k");

    expect(bar()!.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(bar()!.closest('[role="status"]')?.textContent).toMatch(/second key/i);
    expect(bar()!.textContent).toBe("");
  });

  it("starts a fresh bar each time the window reopens", () => {
    renderArmed();
    press("k");
    const first = bar();

    act(() => {
      vi.advanceTimersByTime(CHORD_TIMEOUT_MS);
    });
    fireEvent.click(screen.getByText("Record again"));
    press("k");

    // A reused node would keep its finished animation and show an empty bar.
    expect(bar()).not.toBeNull();
    expect(bar()).not.toBe(first);
  });
});

/** The body of every block opened by `prelude`, however deeply nested. */
function blocksAfter(css: string, prelude: RegExp): string[] {
  const bodies: string[] = [];
  const re = new RegExp(prelude.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    const open = css.indexOf("{", match.index + match[0].length - 1);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}" && --depth === 0) {
        bodies.push(css.slice(open + 1, i));
        break;
      }
    }
  }
  return bodies;
}

describe("chord window motion contract", () => {
  const css = fs.readFileSync(INDEX_CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const topLevel = css.replace(/@variant[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");

  it("drains from full to empty on a linear clock set by the component", () => {
    const [rule] = blocksAfter(topLevel, /\.animate-chord-window\s*\{/);
    const name = /animation:\s*([\w-]+)/.exec(rule ?? "")?.[1];
    expect(rule).toMatch(/var\(--chord-window\)/);
    expect(rule).toMatch(/\blinear\b/);

    const [frames] = blocksAfter(css, new RegExp(`@keyframes\\s+${name}\\s*\\{`));
    const [from] = blocksAfter(frames ?? "", /from\s*\{/);
    const [to] = blocksAfter(frames ?? "", /to\s*\{/);
    expect(from).toMatch(/scaleX\(1\)/);
    expect(to).toMatch(/scaleX\(0\)/);
  });

  it("holds still under reduced motion instead of draining or vanishing", () => {
    const reduced = blocksAfter(css, /@variant\s+reduce-motion\s*\{/).flatMap((body) =>
      blocksAfter(body, /\.animate-chord-window\s*\{/)
    );
    expect(reduced.length).toBeGreaterThan(0);
    for (const rule of reduced) {
      expect(rule).toMatch(/animation:\s*none/);
      expect(rule).not.toMatch(/display:\s*none|opacity:\s*0|scaleX\(0/);
    }
  });

  it("keeps a system colour under forced colors, where its background would become Canvas", () => {
    const forced = blocksAfter(css, /@media\s*\(forced-colors:\s*active\)\s*\{/).flatMap((body) =>
      blocksAfter(body, /\[data-chord-window\]\s*\{/)
    );
    expect(forced.length).toBeGreaterThan(0);
    expect(forced.join("")).toMatch(
      /background-color:\s*(CanvasText|ButtonText|Highlight|GrayText)/
    );
    expect(forced.join("")).toMatch(/forced-color-adjust:\s*none/);
  });
});
