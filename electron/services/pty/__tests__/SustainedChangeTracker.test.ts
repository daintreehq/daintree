import { describe, expect, it } from "vitest";
import {
  AGENT_WORKING_RECOVERY_MAX_QUIET_MS,
  AGENT_WORKING_RECOVERY_MIN_CHANGED_FRAMES,
  AGENT_WORKING_RECOVERY_WINDOW_MS,
  SustainedChangeTracker,
  createVisibleCellContentSnapshot,
  createVisibleContentSnapshot,
  measureVisibleContentDelta,
  normalizeVisibleContent,
  type VisibleContentCell,
} from "../SustainedChangeTracker.js";

function makeTracker(): SustainedChangeTracker {
  return new SustainedChangeTracker({
    windowMs: AGENT_WORKING_RECOVERY_WINDOW_MS,
    minChangedFrames: AGENT_WORKING_RECOVERY_MIN_CHANGED_FRAMES,
    maxQuietMs: AGENT_WORKING_RECOVERY_MAX_QUIET_MS,
  });
}

function cell(partial: Partial<VisibleContentCell> = {}): VisibleContentCell {
  const chars = partial.chars ?? "-";
  return {
    chars,
    code: partial.code ?? chars.codePointAt(0) ?? 0,
    width: partial.width ?? 1,
    fgColorMode: partial.fgColorMode ?? 0,
    fgColor: partial.fgColor ?? 0,
    attributes: partial.attributes ?? 0,
  };
}

function row(text: string, partial: Partial<VisibleContentCell> = {}): VisibleContentCell[] {
  return Array.from(text).map((chars) =>
    cell({
      ...partial,
      chars,
      code: chars.codePointAt(0) ?? 0,
    })
  );
}

describe("visible content normalization", () => {
  it("removes whitespace and line breaks before comparison", () => {
    expect(normalizeVisibleContent(["Claude Code", "  Waiting"])).toBe("ClaudeCodeWaiting");
    expect(normalizeVisibleContent("Claude\nCode\tWaiting")).toBe("ClaudeCodeWaiting");
  });

  it("collapses consecutive repeated characters before comparison", () => {
    expect(normalizeVisibleContent("-----")).toBe("-");
    expect(normalizeVisibleContent("══════")).toBe("═");
    expect(normalizeVisibleContent("···· ready")).toBe("·ready");
  });

  it("does not collapse repeated content characters before comparison", () => {
    expect(normalizeVisibleContent("book")).toBe("book");
    expect(normalizeVisibleContent("step 11")).toBe("step11");

    expect(
      measureVisibleContentDelta(
        createVisibleContentSnapshot("step 1"),
        createVisibleContentSnapshot("step 11")
      )
    ).toEqual({
      changed: true,
      changedChars: 1,
    });
  });

  it("treats line reflow as unchanged visible content", () => {
    const before = createVisibleContentSnapshot(["Claude Code is waiting"]);
    const after = createVisibleContentSnapshot(["Claude", "Code is", "waiting"]);

    expect(measureVisibleContentDelta(before, after)).toEqual({
      changed: false,
      changedChars: 0,
    });
  });

  it("treats repeated separator width changes as unchanged visible content", () => {
    const before = createVisibleContentSnapshot(["-----"]);
    const after = createVisibleContentSnapshot(["----------"]);

    expect(measureVisibleContentDelta(before, after)).toEqual({
      changed: false,
      changedChars: 0,
    });
  });

  it("measures a one-character visible change", () => {
    const before = createVisibleContentSnapshot(["Working 1"]);
    const after = createVisibleContentSnapshot(["Working 2"]);

    expect(measureVisibleContentDelta(before, after)).toEqual({
      changed: true,
      changedChars: 1,
    });
  });

  it("includes color changes in cell snapshots", () => {
    const before = createVisibleCellContentSnapshot([row("●●●", { fgColorMode: 1, fgColor: 1 })]);
    const after = createVisibleCellContentSnapshot([row("●●●", { fgColorMode: 1, fgColor: 2 })]);

    expect(measureVisibleContentDelta(before, after)).toEqual({
      changed: true,
      changedChars: 1,
    });
  });

  it("ignores styled whitespace in cell snapshots", () => {
    const before = createVisibleCellContentSnapshot([row("   ")]);
    const after = createVisibleCellContentSnapshot([row("   ", { attributes: 1 << 2 })]);

    expect(measureVisibleContentDelta(before, after)).toEqual({
      changed: false,
      changedChars: 0,
    });
  });

  it("ignores cells without actual character content", () => {
    const before = createVisibleCellContentSnapshot([
      [cell({ chars: "", code: 47 })],
      row("/exit"),
    ]);
    const after = createVisibleCellContentSnapshot([row("/exit")]);

    expect(after.hash).toBe(before.hash);
    expect(measureVisibleContentDelta(before, after)).toEqual({
      changed: false,
      changedChars: 0,
    });
  });

  it("ignores background row-bar changes on visible text cells", () => {
    const before = createVisibleCellContentSnapshot([row("/exit")]);
    const after = createVisibleCellContentSnapshot([row("/exit", { attributes: 1 << 5 })]);

    expect(after.hash).toBe(before.hash);
    expect(measureVisibleContentDelta(before, after)).toEqual({
      changed: false,
      changedChars: 0,
    });
  });

  it("treats wrap-only changes with styled padding as the same snapshot", () => {
    const before = createVisibleCellContentSnapshot([
      [
        ...row("Captures the regression in fcbb3f765 plus the race window"),
        ...row("     ", { attributes: 1 << 5 }),
      ],
      row("between addPanel resolving and setTerminal(newId) firing"),
    ]);
    const after = createVisibleCellContentSnapshot([
      row("Captures the regression in fcbb3f765 plus the race"),
      [
        ...row("window between addPanel resolving and setTerminal(newId)"),
        ...row("     ", { attributes: (1 << 5) | 1 }),
      ],
      row("firing"),
    ]);

    expect(after.hash).toBe(before.hash);
    expect(after.length).toBe(before.length);
    expect(measureVisibleContentDelta(before, after)).toEqual({
      changed: false,
      changedChars: 0,
    });
  });

  it("treats viewport prefix growth as unchanged visible activity", () => {
    const before = createVisibleCellContentSnapshot([
      row("/exit"),
      row("See ya!"),
      row("/exit"),
      row("Goodbye!"),
      row('Try "create a util logging.py that..."'),
    ]);
    const after = createVisibleCellContentSnapshot([
      row("* recap: Filed issue #6951 capturing the dock regression"),
      row("/exit"),
      row("See ya!"),
      row("/exit"),
      row("Goodbye!"),
      row('Try "create a util logging.py that..."'),
    ]);

    expect(after.hash).not.toBe(before.hash);
    expect(measureVisibleContentDelta(before, after)).toEqual({
      changed: false,
      changedChars: 0,
    });
    expect(measureVisibleContentDelta(after, before)).toEqual({
      changed: false,
      changedChars: 0,
    });
  });
});

describe("SustainedChangeTracker", () => {
  it("requires sustained tiny changes before triggering recovery", () => {
    const tracker = makeTracker();

    expect(tracker.observe(1000, { changedChars: 1 })).toBe(false);
    expect(tracker.observe(1700, { changedChars: 1 })).toBe(false);
    expect(tracker.observe(2400, { changedChars: 1 })).toBe(false);
    expect(tracker.observe(3100, { changedChars: 1 })).toBe(true);
  });

  it("does not trigger on a fast burst of tiny changes", () => {
    const tracker = makeTracker();

    expect(tracker.observe(1000, { changedChars: 1 })).toBe(false);
    expect(tracker.observe(1100, { changedChars: 1 })).toBe(false);
    expect(tracker.observe(1200, { changedChars: 1 })).toBe(false);
    expect(tracker.observe(1300, { changedChars: 1 })).toBe(false);
  });

  it("triggers on repeated large visible changes after one second", () => {
    const tracker = makeTracker();

    expect(tracker.observe(1000, { changedChars: 80 })).toBe(false);
    expect(tracker.observe(1500, { changedChars: 80 })).toBe(false);
    expect(tracker.observe(2000, { changedChars: 80 })).toBe(true);
  });

  it("resets after a quiet gap", () => {
    const tracker = makeTracker();

    expect(tracker.observe(1000, { changedChars: 1 })).toBe(false);
    expect(tracker.observe(1700, { changedChars: 1 })).toBe(false);
    expect(tracker.observe(4801, { changedChars: 0 })).toBe(false);
    expect(tracker.observe(4900, { changedChars: 1 })).toBe(false);
    expect(tracker.observe(5600, { changedChars: 1 })).toBe(false);
    expect(tracker.observe(6300, { changedChars: 1 })).toBe(false);
    expect(tracker.observe(7000, { changedChars: 1 })).toBe(true);
  });
});
