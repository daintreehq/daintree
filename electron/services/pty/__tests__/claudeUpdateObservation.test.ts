import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { events } from "../../events.js";
import {
  UPDATE_FOOTER_REAPPEAR_MS,
  clearUpdateInstalled,
  noteUpdateFooter,
  noteUpdateFooterProcess,
} from "../claudeUpdateObservation.js";
import type { TerminalInfo } from "../types.js";
import type { AgentUpdateInstalledChangedPayload } from "../../../../shared/types/ipc/agent.js";

const SLASH = { namesRestart: true };
const PLAIN = { namesRestart: false };

describe("claudeUpdateObservation", () => {
  let terminal: TerminalInfo;
  let published: AgentUpdateInstalledChangedPayload[];
  let unsubscribe: () => void;

  beforeEach(() => {
    terminal = { id: "t1" } as TerminalInfo;
    published = [];
    unsubscribe = events.on("agent:update-installed-changed", (payload) => {
      published.push(payload);
    });
  });

  afterEach(() => unsubscribe());

  it("records the footer's first frame and publishes it once", () => {
    noteUpdateFooter(terminal, SLASH, 1_000);
    noteUpdateFooter(terminal, SLASH, 2_000);
    noteUpdateFooter(terminal, SLASH, 3_000);

    expect(terminal.updateInstalled).toEqual({ observedAt: 1_000, namesRestart: true });
    expect(published).toEqual([
      {
        terminalId: "t1",
        updateInstalled: { observedAt: 1_000, namesRestart: true },
        timestamp: 1_000,
      },
    ]);
  });

  it("keeps the observation while the footer is off screen", () => {
    noteUpdateFooter(terminal, SLASH, 1_000);
    noteUpdateFooter(terminal, null, 2_000);
    noteUpdateFooter(terminal, null, 10 * 60_000);

    expect(terminal.updateInstalled).toEqual({ observedAt: 1_000, namesRestart: true });
    expect(published).toHaveLength(1);
  });

  it("re-stamps when what the footer says about /restart changes", () => {
    noteUpdateFooter(terminal, SLASH, 1_000);
    noteUpdateFooter(terminal, PLAIN, 2_000);
    noteUpdateFooter(terminal, SLASH, 3_000);

    expect(published.map((p) => p.updateInstalled)).toEqual([
      { observedAt: 1_000, namesRestart: true },
      { observedAt: 2_000, namesRestart: false },
      { observedAt: 3_000, namesRestart: true },
    ]);
  });

  it("treats a repaint that blanks the footer for a moment as the same sighting", () => {
    noteUpdateFooter(terminal, SLASH, 1_000);
    noteUpdateFooter(terminal, null, 2_000);
    noteUpdateFooter(terminal, SLASH, 2_000 + UPDATE_FOOTER_REAPPEAR_MS - 1);

    expect(published).toHaveLength(1);
  });

  it("measures the time away from the first frame without it, not the last with it", () => {
    // Hours of quiet with the footer up produce no frames; one repaint that
    // blanks it for a frame hasn't been away for hours.
    noteUpdateFooter(terminal, SLASH, 1_000);
    const later = 5 * 60 * 60_000;
    noteUpdateFooter(terminal, null, later);
    noteUpdateFooter(terminal, SLASH, later + 50);

    expect(terminal.updateInstalled?.observedAt).toBe(1_000);
    expect(published).toHaveLength(1);
  });

  it("re-stamps a footer back after a while off screen", () => {
    noteUpdateFooter(terminal, SLASH, 1_000);
    noteUpdateFooter(terminal, null, 2_000);
    noteUpdateFooter(terminal, null, 30_000);
    const back = 2_000 + UPDATE_FOOTER_REAPPEAR_MS;
    noteUpdateFooter(terminal, SLASH, back);

    expect(terminal.updateInstalled).toEqual({ observedAt: back, namesRestart: true });
    expect(published).toHaveLength(2);
  });

  it("clears with a null publish, once", () => {
    noteUpdateFooter(terminal, SLASH, 1_000);
    clearUpdateInstalled(terminal, 5_000);
    clearUpdateInstalled(terminal, 6_000);

    expect(terminal.updateInstalled).toBeUndefined();
    expect(published.at(-1)).toEqual({ terminalId: "t1", updateInstalled: null, timestamp: 5_000 });
    expect(published).toHaveLength(2);
  });

  it("publishes nothing when there was nothing to clear", () => {
    clearUpdateInstalled(terminal, 1_000);

    expect(published).toEqual([]);
  });

  it("reads a footer already up when the pane first counts as Claude's", () => {
    // Frames before detection clear nothing, so they mustn't fence: Claude
    // keeps the footer up, and a fenced one would wait for it to go first.
    clearUpdateInstalled(terminal, 1_000);
    clearUpdateInstalled(terminal, 2_000);
    noteUpdateFooter(terminal, SLASH, 3_000);

    expect(terminal.updateInstalled).toEqual({ observedAt: 3_000, namesRestart: true });
  });

  it("doesn't credit a footer left on screen to the next run", () => {
    noteUpdateFooter(terminal, SLASH, 1_000);
    clearUpdateInstalled(terminal, 2_000);
    noteUpdateFooter(terminal, SLASH, 3_000);
    noteUpdateFooter(terminal, SLASH, 4_000 + UPDATE_FOOTER_REAPPEAR_MS);

    expect(terminal.updateInstalled).toBeUndefined();

    noteUpdateFooter(terminal, null, 5_000 + UPDATE_FOOTER_REAPPEAR_MS);
    noteUpdateFooter(terminal, PLAIN, 6_000 + UPDATE_FOOTER_REAPPEAR_MS);

    expect(terminal.updateInstalled).toEqual({
      observedAt: 6_000 + UPDATE_FOOTER_REAPPEAR_MS,
      namesRestart: false,
    });
  });

  it("adopts the first Claude process named after an observation and clears on another", () => {
    noteUpdateFooter(terminal, SLASH, 1_000);
    noteUpdateFooterProcess(terminal, 4242, 2_000);
    noteUpdateFooterProcess(terminal, 4242, 3_000);

    expect(terminal.updateInstalled).toBeDefined();

    noteUpdateFooterProcess(terminal, 5151, 4_000);

    expect(terminal.updateInstalled).toBeUndefined();
    expect(published.at(-1)?.updateInstalled).toBeNull();
  });

  it("ignores process passes while nothing is observed", () => {
    noteUpdateFooterProcess(terminal, 4242, 1_000);
    noteUpdateFooter(terminal, SLASH, 2_000);
    // The pass before the observation must not have been adopted for it.
    noteUpdateFooterProcess(terminal, 5151, 3_000);
    noteUpdateFooterProcess(terminal, 5151, 4_000);

    expect(terminal.updateInstalled).toEqual({ observedAt: 2_000, namesRestart: true });
  });

  it("forgets the adopted process with the observation it belonged to", () => {
    noteUpdateFooter(terminal, SLASH, 1_000);
    noteUpdateFooterProcess(terminal, 4242, 2_000);
    clearUpdateInstalled(terminal, 3_000);
    noteUpdateFooter(terminal, null, 4_000);
    noteUpdateFooter(terminal, SLASH, 5_000);
    noteUpdateFooterProcess(terminal, 5151, 6_000);

    expect(terminal.updateInstalled).toEqual({ observedAt: 5_000, namesRestart: true });
  });
});
