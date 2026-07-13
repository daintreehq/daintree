// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import {
  findPanelIdForElement,
  hasBlockingOverlay,
  hasUsefulFocus,
  isRescuableKeystroke,
  resolveRescueTarget,
  type RescueContext,
} from "../typeAnywhere";

/**
 * The safety rules in #11134 are a contract, not preferences: a rescue that
 * fires when it shouldn't sends the user's prompt to an agent they never chose,
 * or executes it against a raw shell. These tests are that contract.
 */

function keydown(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  const { key, ...rest } = init;
  return new KeyboardEvent("keydown", { key, ...rest });
}

/** AltGr can't be expressed via KeyboardEventInit — `getModifierState` needs a stub. */
function altGrKeydown(key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, ctrlKey: true, altKey: true });
  Object.defineProperty(e, "getModifierState", {
    value: (mod: string) => mod === "AltGraph",
  });
  return e;
}

/** PTY panels are `kind: "terminal"`; agent identity is derived from `launchAgentId`. */
function agentPanel(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: "Claude",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    hasPty: true,
    runtimeStatus: "running",
    launchAgentId: "claude",
    ...overrides,
  };
}

function makeContext(panels: PanelInstance[], overrides: Partial<RescueContext> = {}) {
  const panelsById: Record<string, PanelInstance> = {};
  for (const p of panels) panelsById[p.id] = p;
  return {
    panelsById,
    panelIds: panels.map((p) => p.id),
    lastTypedTerminalId: null,
    unavailableTerminalIds: new Set<string>(),
    ...overrides,
  };
}

describe("isRescuableKeystroke", () => {
  it("accepts a plain printable character", () => {
    expect(isRescuableKeystroke(keydown({ key: "a" }))).toBe(true);
  });

  it("accepts a shifted character", () => {
    expect(isRescuableKeystroke(keydown({ key: "A", shiftKey: true }))).toBe(true);
  });

  it("accepts punctuation and digits", () => {
    expect(isRescuableKeystroke(keydown({ key: "7" }))).toBe(true);
    expect(isRescuableKeystroke(keydown({ key: "?" }))).toBe(true);
  });

  it("accepts an AltGr character even though ctrl and alt are both set", () => {
    // German layout: AltGr+Q yields '@' with ctrlKey && altKey. A naive chord
    // test would refuse to rescue ordinary typing on these layouts.
    expect(isRescuableKeystroke(altGrKeydown("@"))).toBe(true);
  });

  it("rejects modifier chords", () => {
    expect(isRescuableKeystroke(keydown({ key: "a", metaKey: true }))).toBe(false);
    expect(isRescuableKeystroke(keydown({ key: "a", ctrlKey: true }))).toBe(false);
    expect(isRescuableKeystroke(keydown({ key: "a", altKey: true }))).toBe(false);
  });

  it("rejects Enter, Backspace and Space as the first key", () => {
    expect(isRescuableKeystroke(keydown({ key: "Enter" }))).toBe(false);
    expect(isRescuableKeystroke(keydown({ key: "Backspace" }))).toBe(false);
    expect(isRescuableKeystroke(keydown({ key: " " }))).toBe(false);
  });

  it("rejects named navigation and function keys", () => {
    expect(isRescuableKeystroke(keydown({ key: "ArrowLeft" }))).toBe(false);
    expect(isRescuableKeystroke(keydown({ key: "F1" }))).toBe(false);
    expect(isRescuableKeystroke(keydown({ key: "Escape" }))).toBe(false);
  });

  it("rejects key repeats", () => {
    expect(isRescuableKeystroke(keydown({ key: "a", repeat: true }))).toBe(false);
  });

  it("rejects IME composition, including Chromium's pre-isComposing 229 signal", () => {
    expect(isRescuableKeystroke(keydown({ key: "a", isComposing: true }))).toBe(false);
    expect(isRescuableKeystroke(keydown({ key: "a", keyCode: 229 }))).toBe(false);
  });

  it("rejects dead keys", () => {
    expect(isRescuableKeystroke(keydown({ key: "Dead" }))).toBe(false);
  });
});

describe("hasUsefulFocus", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("treats nothing and the body as not useful", () => {
    expect(hasUsefulFocus(null)).toBe(false);
    expect(hasUsefulFocus(document.body)).toBe(false);
  });

  it("treats a detached element as not useful", () => {
    expect(hasUsefulFocus(document.createElement("div"))).toBe(false);
  });

  it("treats form controls and editable content as useful", () => {
    document.body.innerHTML = `
      <input id="i" />
      <textarea id="t"></textarea>
      <div id="c" contenteditable="true"></div>`;
    expect(hasUsefulFocus(document.getElementById("i"))).toBe(true);
    expect(hasUsefulFocus(document.getElementById("t"))).toBe(true);
    expect(hasUsefulFocus(document.getElementById("c"))).toBe(true);
  });

  it("treats a terminal as useful even when it is the off-screen case", () => {
    document.body.innerHTML = `<div class="xterm"><div id="x" tabindex="0"></div></div>`;
    expect(hasUsefulFocus(document.getElementById("x"))).toBe(true);
  });

  it("treats an embedded browsing context as useful", () => {
    document.body.innerHTML = `<iframe id="f"></iframe>`;
    expect(hasUsefulFocus(document.getElementById("f"))).toBe(true);
  });

  it("treats a read-only viewer surface as NOT useful — it silently eats the key", () => {
    // The file viewer: focusable chrome, no typing target. This is the exact
    // reported failure ("is my prompt in my codes now?!").
    document.body.innerHTML = `<div id="v" tabindex="0" class="file-viewer"></div>`;
    expect(hasUsefulFocus(document.getElementById("v"))).toBe(false);
  });
});

describe("hasBlockingOverlay", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("is false with no modal", () => {
    expect(hasBlockingOverlay()).toBe(false);
  });

  it("detects a modal portalled outside the focused subtree", () => {
    // Radix renders dialog content in a portal, so an ancestry check from the
    // focused node would miss it and the rescue would steal the key.
    document.body.innerHTML = `<div role="dialog" aria-modal="true"></div>`;
    expect(hasBlockingOverlay()).toBe(true);
  });

  it("ignores a non-modal dialog", () => {
    document.body.innerHTML = `<div role="dialog"></div>`;
    expect(hasBlockingOverlay()).toBe(false);
  });
});

describe("findPanelIdForElement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("walks up to the owning panel", () => {
    document.body.innerHTML = `<div data-panel-id="p1"><span id="leaf"></span></div>`;
    expect(findPanelIdForElement(document.getElementById("leaf"))).toBe("p1");
  });

  it("returns null outside any panel", () => {
    document.body.innerHTML = `<span id="leaf"></span>`;
    expect(findPanelIdForElement(document.getElementById("leaf"))).toBeNull();
  });
});

describe("resolveRescueTarget", () => {
  it("routes to the agent the user last typed to, even with other agents open", () => {
    const ctx = makeContext([agentPanel("a1"), agentPanel("a2"), agentPanel("a3")], {
      lastTypedTerminalId: "a2",
    });
    expect(resolveRescueTarget(ctx)).toBe("a2");
  });

  it("refuses rather than falling through when the known target is mid-voice-submit", () => {
    // Falling back to another agent would route the prompt to an agent the user
    // never chose — the precise harm the issue is about.
    const ctx = makeContext([agentPanel("a1"), agentPanel("a2")], {
      lastTypedTerminalId: "a2",
      unavailableTerminalIds: new Set(["a2"]),
    });
    expect(resolveRescueTarget(ctx)).toBeNull();
  });

  it("refuses when the known target has exited", () => {
    const ctx = makeContext([agentPanel("a1"), agentPanel("a2", { runtimeStatus: "exited" })], {
      lastTypedTerminalId: "a2",
    });
    expect(resolveRescueTarget(ctx)).toBeNull();
  });

  it("falls back to the sole agent when there is no typing history yet", () => {
    const ctx = makeContext([agentPanel("only")]);
    expect(resolveRescueTarget(ctx)).toBe("only");
  });

  it("refuses with no history and multiple agents — nothing disambiguates them", () => {
    const ctx = makeContext([agentPanel("a1"), agentPanel("a2")]);
    expect(resolveRescueTarget(ctx)).toBeNull();
  });

  it("refuses with no agents at all", () => {
    expect(resolveRescueTarget(makeContext([]))).toBeNull();
  });

  it("never routes into a raw shell — a draft there would execute on Enter", () => {
    const shell = agentPanel("sh", { launchAgentId: undefined, title: "zsh" });
    expect(resolveRescueTarget(makeContext([shell]))).toBeNull();
  });

  it("does not treat a lone shell as the sole-candidate fallback", () => {
    const ctx = makeContext([agentPanel("sh", { launchAgentId: undefined }), agentPanel("a1")]);
    // Only a1 is a real agent, so it is unambiguous despite two panels.
    expect(resolveRescueTarget(ctx)).toBe("a1");
  });

  it("ignores agents outside the grid (dock, background)", () => {
    const ctx = makeContext([agentPanel("docked", { location: "dock" })]);
    expect(resolveRescueTarget(ctx)).toBeNull();
  });

  it("refuses when a stale target id is no longer present", () => {
    const ctx = makeContext([agentPanel("a1")], { lastTypedTerminalId: "gone" });
    expect(resolveRescueTarget(ctx)).toBeNull();
  });
});
