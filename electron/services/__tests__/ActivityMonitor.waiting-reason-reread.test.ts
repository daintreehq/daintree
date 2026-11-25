import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityMonitor } from "../ActivityMonitor.js";
import {
  WAITING_REASON_CHECKLIST_ROWS,
  WAITING_REASON_SCAN_LINE_COUNT,
} from "../pty/WaitingReasonClassifier.js";

const RULE = "─".repeat(60);
const INPUT_ROW = "❯ ";
const FOOTER = "  ⏵⏵ accept edits on (shift+tab to cycle)";
const BANNER = "  ⎿  You've hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)";

// Claude Code 2.x after a plan limit: the banner in the transcript, the input
// row between its rules, and the auto-continue notice in the footer.
const LIMIT_SCREEN = [
  "● Refactoring the parser.",
  BANNER,
  "     /upgrade to increase your usage limit.",
  "",
  RULE,
  INPUT_ROW,
  RULE,
  "  Usage limit reached · continuing automatically at 10am · esc to cancel",
];

// The same pane once Escape cancels the auto-continue: the banner still sits
// in the transcript just above the input row.
const CANCELLED_SCREEN = [
  "● Refactoring the parser.",
  BANNER,
  "     /upgrade to increase your usage limit.",
  "",
  "  ⎿  Automatic continue cancelled · /rate-limit-options to re-arm",
  "",
  RULE,
  INPUT_ROW,
  RULE,
  FOOTER,
];

// A screen at the prompt with no blocking banner left in its tail.
const PROMPT_SCREEN = ["● Refactoring the parser.", "", RULE, INPUT_ROW, RULE, FOOTER];

const REASON_READ_ROWS = WAITING_REASON_SCAN_LINE_COUNT + WAITING_REASON_CHECKLIST_ROWS;

const monitors: ActivityMonitor[] = [];

function startClaude(
  id: string,
  initial: string[],
  options: { restored?: boolean; agentId?: string } = {}
) {
  const onStateChange = vi.fn();
  let visible = initial;
  let reasonReads = 0;
  const monitor = new ActivityMonitor(id, 1000, onStateChange, {
    agentId: options.agentId ?? "claude",
    getVisibleLines: (n) => {
      if (n === REASON_READ_ROWS) reasonReads++;
      return visible.slice(-n);
    },
    getCursorLine: () => visible.find((line) => line.startsWith("❯")) ?? visible.at(-1) ?? null,
    initialState: "idle",
    skipInitialStateEmit: true,
  });
  monitors.push(monitor);
  monitor.startPolling();
  if (!options.restored) {
    for (let i = 1; i <= 4; i++) {
      vi.advanceTimersByTime(650);
      visible = [`tick ${i}`];
      vi.advanceTimersByTime(50);
    }
    expect(monitor.getState()).toBe("busy");
  }
  return {
    monitor,
    onStateChange,
    show: (lines: string[]) => {
      visible = lines;
    },
    reasonReads: () => reasonReads,
  };
}

function settleOn(id: string, screen: string[], reason: string) {
  const pane = startClaude(id, ["waiting 0"]);
  pane.show(screen);
  vi.advanceTimersByTime(8200);
  expect(pane.monitor.getState()).toBe("idle");
  expect(pane.onStateChange).toHaveBeenLastCalledWith(
    id,
    1000,
    "idle",
    expect.objectContaining({ waitingReason: reason })
  );
  pane.onStateChange.mockClear();
  return pane;
}

function reasonUpdates(onStateChange: ReturnType<typeof vi.fn>) {
  return onStateChange.mock.calls
    .filter((call) => call[3]?.rereadAt !== undefined)
    .map((call) => call[3].waitingReason);
}

describe("ActivityMonitor waiting-reason re-read (#16093)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const monitor of monitors.splice(0)) monitor.dispose();
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  it("re-reads an idle agent's reason once its screen changes and settles", () => {
    const { monitor, onStateChange, show } = settleOn("reread", LIMIT_SCREEN, "error");

    // Escape is held back as a possible sequence start, so only the redraw
    // reaches the monitor.
    monitor.onInput("\x1b");
    monitor.onData("\x1b[2J redraw");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(5000);

    expect(monitor.getState()).toBe("idle");
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("reread", 1000, "idle", {
      trigger: "pattern",
      waitingReason: "prompt",
      rereadAt: expect.any(Number),
      promptDrawnAt: expect.any(Number),
      inputRowEmpty: true,
    });
    const [, , , metadata] = onStateChange.mock.calls[0]!;
    // Read off the screen it re-read: the empty input row in its frame (#18018).
    expect(metadata.promptDrawnAt).toBe(metadata.rereadAt);
  });

  it("keeps the error after Escape while the limit banner is still in view", () => {
    const { monitor, onStateChange, show, reasonReads } = settleOn(
      "reread-cancelled",
      LIMIT_SCREEN,
      "error"
    );
    const readsBefore = reasonReads();

    monitor.onInput("\x1b");
    monitor.onData("\x1b[2K  ⎿  Automatic continue cancelled · /rate-limit-options to re-arm");
    show(CANCELLED_SCREEN);
    vi.advanceTimersByTime(5000);

    expect(reasonReads()).toBe(readsBefore + 1);
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("reads a limit that lands while the agent stays idle", () => {
    const { monitor, onStateChange, show } = settleOn("reread-limit", PROMPT_SCREEN, "prompt");

    monitor.onData("banner");
    show(LIMIT_SCREEN);
    vi.advanceTimersByTime(5000);

    expect(reasonUpdates(onStateChange)).toEqual(["error"]);
  });

  it("reads the screen once per settled change, and never on time alone", () => {
    const { monitor, onStateChange, show, reasonReads } = settleOn(
      "reread-once",
      LIMIT_SCREEN,
      "error"
    );
    const readsBefore = reasonReads();

    vi.advanceTimersByTime(60_000);
    expect(reasonReads()).toBe(readsBefore);
    expect(onStateChange).not.toHaveBeenCalled();

    monitor.onData("redraw");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(5000);
    expect(reasonReads()).toBe(readsBefore + 1);
    expect(reasonUpdates(onStateChange)).toEqual(["prompt"]);

    // A later redraw is read again, but the same reason sends nothing more.
    monitor.onData("redraw again");
    vi.advanceTimersByTime(5000);
    expect(reasonReads()).toBe(readsBefore + 2);
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it("times the settle from the screen's last change", () => {
    const { monitor, onStateChange, show } = settleOn("reread-settle", LIMIT_SCREEN, "error");

    monitor.onData("redraw");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(900);
    monitor.onData("more redraw");
    vi.advanceTimersByTime(600);
    expect(onStateChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(reasonUpdates(onStateChange)).toEqual(["prompt"]);
  });

  it("waits out recent input, then reads without another redraw", () => {
    const { monitor, onStateChange, show } = settleOn("reread-input", LIMIT_SCREEN, "error");

    monitor.onData("redraw");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(900);
    monitor.onInput("\x1b");
    vi.advanceTimersByTime(300);
    expect(onStateChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(800);
    expect(reasonUpdates(onStateChange)).toEqual(["prompt"]);
  });

  it("reads past an empty Enter that never started a turn", () => {
    const { monitor, onStateChange, show } = settleOn("reread-enter", LIMIT_SCREEN, "error");

    monitor.onInput("\r");
    monitor.onData("redraw");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(5000);

    expect(monitor.getState()).toBe("idle");
    expect(reasonUpdates(onStateChange)).toEqual(["prompt"]);
  });

  it("reads a select dialog drawn after the settle, with no input row in view (#16209)", () => {
    const { monitor, onStateChange, show } = settleOn("reread-dialog", PROMPT_SCREEN, "prompt");

    monitor.onData("dialog");
    show([
      "● Refactoring the parser.",
      "",
      "Want to autocompact at 400k tokens instead? Your model doesn't change. Switch back any",
      "time with /autocompact.",
      "",
      "❯ Keep auto (1m tokens)",
      "  Autocompact at ‹ 400k › tokens",
      "↑/↓ choose · ←/→ change size · enter confirm · esc not now",
    ]);
    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual(["approval"]);

    // Dismissed, the empty input row is back and the wait is a prompt again.
    monitor.onData("\x1b[2J redraw");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual(["approval", "prompt"]);
  });

  it("never reads an approval phrase in a draft as a dialog (#16209)", () => {
    const { monitor, onStateChange, show } = settleOn(
      "reread-draft-phrase",
      PROMPT_SCREEN,
      "prompt"
    );

    monitor.onData("typing");
    show(
      PROMPT_SCREEN.map((line) =>
        line === INPUT_ROW ? "❯ Do you want to proceed with the migration?" : line
      )
    );
    vi.advanceTimersByTime(5000);
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("holds a dialog closed into a draft at approval until the input row is empty (#16209)", () => {
    const { monitor, onStateChange, show } = settleOn(
      "reread-dialog-draft",
      PROMPT_SCREEN,
      "prompt"
    );

    monitor.onData("dialog");
    show([
      "❯ Keep auto (1m tokens)",
      "  Autocompact at ‹ 400k › tokens",
      "↑/↓ choose · ←/→ change size · enter confirm · esc not now",
    ]);
    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual(["approval"]);

    // A send over the draft would merge into it, so the reading stays.
    monitor.onData("\x1b[2J redraw");
    show(PROMPT_SCREEN.map((line) => (line === INPUT_ROW ? "❯ restored draft" : line)));
    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual(["approval"]);

    monitor.onData("\x15");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual(["approval", "prompt"]);
  });

  it("changes nothing while the input row holds a draft, and reads it once emptied", () => {
    const { monitor, onStateChange, show } = settleOn("reread-draft", LIMIT_SCREEN, "error");

    monitor.onData("hello");
    show(PROMPT_SCREEN.map((line) => (line === INPUT_ROW ? "❯ hello" : line)));
    vi.advanceTimersByTime(5000);
    expect(onStateChange).not.toHaveBeenCalled();

    monitor.onData("\b\b\b\b\b");
    show(PROMPT_SCREEN);
    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual(["prompt"]);
  });

  it("reads a restored idle pane once, then waits for a change", () => {
    const { onStateChange, reasonReads } = startClaude("reread-restored", LIMIT_SCREEN, {
      restored: true,
    });

    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual(["error"]);
    const reads = reasonReads();

    vi.advanceTimersByTime(60_000);
    expect(reasonReads()).toBe(reads);
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it("reads a finished turn as a prompt wait under a footer that outlived the limit", () => {
    settleOn(
      "reread-footer",
      [
        "● The parser now handles empty input, and its tests pass.",
        "",
        RULE,
        INPUT_ROW,
        RULE,
        "  Usage limit reached · continuing automatically at 10am · esc to cancel",
      ],
      "prompt"
    );
  });
});

describe("ActivityMonitor and a selector drawn short of the pane's bottom (#18014)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const monitor of monitors.splice(0)) monitor.dispose();
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  // A resumed Claude on a fresh pane: its trust prompt at the top, nothing under it.
  const TRUST = [
    "Accessing workspace:",
    "",
    " /repo/wt-1",
    "",
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    " ❯ 1. Yes, I trust this folder",
    "   2. No, exit",
    "",
    " Enter to confirm · Esc to cancel",
  ];
  /** `drawn` at the top of a pane `rows` tall. */
  const fresh = (drawn: string[], rows = 48) => [
    ...drawn,
    ...Array.from({ length: rows - drawn.length }, () => ""),
  ];

  it("settles on a fresh pane's trust prompt as an approval wait", () => {
    settleOn("fresh-trust", fresh(TRUST), "approval");
  });

  it("settles on it as an approval wait with only its key hint in the classifier's window", () => {
    // The hint is the one drawn row in the bottom WAITING_REASON_SCAN_LINE_COUNT rows.
    settleOn(
      "fresh-trust-hint",
      fresh(TRUST, TRUST.length + WAITING_REASON_SCAN_LINE_COUNT - 1),
      "approval"
    );
  });

  it("settles on another startup selector the same way, whatever it asks", () => {
    const theme = [
      " Choose the text style that looks best with your terminal",
      "",
      " ❯ 1. Dark mode ✔",
      "   2. Light mode",
      "   3. Dark mode (colorblind-friendly)",
    ];
    settleOn("fresh-theme", fresh(theme), "approval");
  });

  it("still settles at its prompt on a fresh pane, and under a dialog answered above", () => {
    settleOn("fresh-prompt", fresh(["● Resumed.", "", RULE, INPUT_ROW, RULE, FOOTER]), "prompt");
    settleOn("fresh-answered", fresh([...TRUST, "FAKE_CLAUDE_READY"]), "prompt");
  });

  it("re-reads a selector drawn after the agent settled, though it never went busy", () => {
    const { monitor, onStateChange, show } = settleOn(
      "fresh-late-trust",
      fresh(["$ claude --resume 0199f8c1"]),
      "prompt"
    );

    monitor.onData("trust prompt");
    show(fresh(TRUST));
    vi.advanceTimersByTime(5000);

    expect(monitor.getState()).toBe("idle");
    expect(reasonUpdates(onStateChange)).toEqual(["approval"]);
  });

  it("re-reads its prompt once the trust prompt gives way to its empty input row, drawn as high", () => {
    const { monitor, onStateChange, show } = settleOn(
      "fresh-answered-quiet",
      fresh(TRUST),
      "approval"
    );

    // Answered, and redrawn without going busy: the input row is where the dialog was.
    monitor.onData("composer");
    show(fresh(["● Resumed.", "", RULE, INPUT_ROW, RULE, FOOTER]));
    vi.advanceTimersByTime(5000);

    expect(reasonUpdates(onStateChange)).toEqual(["prompt"]);
  });

  it("never re-reads a prompt off an input row with a selector drawn under it", () => {
    const { monitor, onStateChange, show } = settleOn(
      "fresh-selector-under-composer",
      fresh(TRUST),
      "approval"
    );

    monitor.onData("selector under the input row");
    show(fresh(["● Resumed.", "", RULE, INPUT_ROW, RULE, " ❯ 1. Allow", "   2. Deny"]));
    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual([]);

    // Boxed, with the ASCII highlight, or lettered.
    for (const selector of [
      ["│ > 1. Continue │", "│   2. Cancel   │"],
      ["  a) keep", "  b) drop"],
    ]) {
      monitor.onData("another selector under the input row");
      show(fresh(["● Resumed.", "", RULE, INPUT_ROW, RULE, ...selector]));
      vi.advanceTimersByTime(5000);
    }
    expect(reasonUpdates(onStateChange)).toEqual([]);
  });

  it("never re-reads a prompt off an input row left above a newer dialog", () => {
    const { monitor, onStateChange, show } = settleOn(
      "fresh-old-composer",
      fresh(TRUST),
      "approval"
    );

    // A layout no selector check knows, under a frame it left behind.
    monitor.onData("dialog under an old composer");
    show(fresh([RULE, INPUT_ROW, RULE, "", " Pick one:", "   a) keep", "   b) drop"]));
    vi.advanceTimersByTime(5000);

    expect(reasonUpdates(onStateChange)).toEqual([]);
  });
});

describe("ActivityMonitor and a CLI's folder-trust prompt (#18170)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const monitor of monitors.splice(0)) monitor.dispose();
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  const TRUST = [
    "Accessing workspace:",
    "",
    " /repo/wt-1",
    "",
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    " ❯ 1. Yes, I trust this folder",
    "   2. No, exit",
    "",
    " Enter to confirm · Esc to cancel",
  ];
  const TOOL_APPROVAL = [
    RULE,
    " Bash command",
    "",
    "   npm test",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No, and tell Claude what to do differently (esc)",
  ];
  const fresh = (drawn: string[], rows = 48) => [
    ...drawn,
    ...Array.from({ length: rows - drawn.length }, () => ""),
  ];
  const lastReading = (onStateChange: ReturnType<typeof vi.fn>) =>
    onStateChange.mock.calls.at(-1)?.[3];

  it("names the trust prompt a fresh pane settles on, drawn at its top or filling it", () => {
    const top = startClaude("trust-top", ["waiting 0"]);
    top.show(fresh(TRUST));
    vi.advanceTimersByTime(8200);
    expect(lastReading(top.onStateChange)).toMatchObject({
      waitingReason: "approval",
      approvalKind: "trust",
    });

    const full = startClaude("trust-full", ["waiting 0"]);
    full.show(TRUST);
    vi.advanceTimersByTime(8200);
    expect(lastReading(full.onStateChange)).toMatchObject({
      waitingReason: "approval",
      approvalKind: "trust",
    });
  });

  it("names nothing for another startup selector or a tool approval", () => {
    const theme = startClaude("trust-theme", ["waiting 0"]);
    theme.show(fresh([" Choose the text style", "", " ❯ 1. Dark mode ✔", "   2. Light mode"]));
    vi.advanceTimersByTime(8200);
    expect(lastReading(theme.onStateChange)).toMatchObject({ waitingReason: "approval" });
    expect(lastReading(theme.onStateChange)).not.toHaveProperty("approvalKind");
    const tool = startClaude("trust-tool", ["waiting 0"]);
    tool.show(TOOL_APPROVAL);
    vi.advanceTimersByTime(8200);
    expect(lastReading(tool.onStateChange)).toMatchObject({ waitingReason: "approval" });
    expect(lastReading(tool.onStateChange)).not.toHaveProperty("approvalKind");
  });

  it("drops the name once a tool approval is drawn under the old trust prompt, once", () => {
    const { monitor, onStateChange, show } = startClaude("trust-swap", ["waiting 0"]);
    show(fresh(TRUST));
    vi.advanceTimersByTime(8200);
    expect(lastReading(onStateChange)).toMatchObject({ approvalKind: "trust" });
    onStateChange.mockClear();

    monitor.onData("tool approval");
    show(fresh([...TRUST, "", ...TOOL_APPROVAL]));
    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual(["approval"]);
    expect(lastReading(onStateChange)).not.toHaveProperty("approvalKind");

    // The same screen again is no news.
    monitor.onData("redraw");
    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual(["approval"]);
  });

  it("names a trust prompt that replaced a plain approval, though its unnumbered list passes no selector check", () => {
    const { monitor, onStateChange, show } = startClaude("trust-after-theme", ["waiting 0"]);
    show([" Choose the text style", "", " ❯ 1. Dark mode ✔", "   2. Light mode"]);
    vi.advanceTimersByTime(8200);
    expect(lastReading(onStateChange)).toMatchObject({ waitingReason: "approval" });
    expect(lastReading(onStateChange)).not.toHaveProperty("approvalKind");
    onStateChange.mockClear();

    // Filling the pane, so the bottom rows the classifier reads hold it.
    monitor.onData("trust prompt");
    show([
      " Claude Code'll be able to read, edit, and execute files here.",
      "",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      "",
      " Enter to confirm · Esc to cancel",
    ]);
    vi.advanceTimersByTime(5000);
    expect(reasonUpdates(onStateChange)).toEqual(["approval"]);
    expect(lastReading(onStateChange)).toMatchObject({ approvalKind: "trust" });
  });

  it("names Codex's trust prompt when the bottom rows hold its options but not its question", () => {
    const codexTrust = [
      "> You are in /Users/me/proj",
      "",
      "  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.",
      "",
      "› 1. Yes, continue",
      "  2. No, quit",
      "",
      "  Press enter to continue",
    ];
    const pane = startClaude("trust-codex-short", ["waiting 0"], { agentId: "codex" });
    pane.show([...codexTrust, ...Array.from({ length: 8 }, () => "")]);
    vi.advanceTimersByTime(8200);
    expect(lastReading(pane.onStateChange)).toMatchObject({
      waitingReason: "approval",
      approvalKind: "trust",
    });
  });

  it("names a trust prompt drawn after the agent settled", () => {
    const { monitor, onStateChange, show } = settleOn(
      "trust-late",
      fresh(["$ claude --resume 0199f8c1"]),
      "prompt"
    );
    monitor.onData("trust prompt");
    show(fresh(TRUST));
    vi.advanceTimersByTime(5000);
    expect(lastReading(onStateChange)).toMatchObject({
      waitingReason: "approval",
      approvalKind: "trust",
    });
  });
});
