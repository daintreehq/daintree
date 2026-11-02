import { afterEach, describe, expect, it } from "vitest";
import {
  clearClaudeUsageObservations,
  readClaudeUsageObservations,
  recordClaudeUsageObservation,
} from "../ClaudeUsageObservations.js";
import type { ClaudeUsageObservation } from "../../../../shared/types/ipc/agentQuota.js";

const reading = (overrides: Partial<ClaudeUsageObservation>): ClaudeUsageObservation => ({
  terminalId: "t1",
  window: "weekly limit",
  statement: "used",
  usedPercent: 80,
  resetsAt: 2_000,
  observedAt: 1_000,
  ...overrides,
});

describe("ClaudeUsageObservations", () => {
  afterEach(() => clearClaudeUsageObservations());

  it("answers nothing before any pane showed a message", () => {
    expect(readClaudeUsageObservations()).toEqual([]);
  });

  it("keeps the latest sighting per limit, from whichever pane", () => {
    recordClaudeUsageObservation(reading({ terminalId: "t1", usedPercent: 80, observedAt: 1_000 }));
    recordClaudeUsageObservation(reading({ terminalId: "t2", usedPercent: 87, observedAt: 2_000 }));
    recordClaudeUsageObservation(
      reading({ terminalId: "t1", window: "5-hour limit", statement: "reached", usedPercent: null })
    );

    expect(readClaudeUsageObservations()).toEqual([
      reading({
        terminalId: "t1",
        window: "5-hour limit",
        statement: "reached",
        usedPercent: null,
      }),
      reading({ terminalId: "t2", usedPercent: 87, observedAt: 2_000 }),
    ]);
  });

  it("keeps a newer sighting over one another pty host reports late", () => {
    recordClaudeUsageObservation(reading({ terminalId: "t2", usedPercent: 87, observedAt: 2_000 }));
    recordClaudeUsageObservation(reading({ terminalId: "t1", usedPercent: 80, observedAt: 1_000 }));

    expect(readClaudeUsageObservations()).toEqual([
      reading({ terminalId: "t2", usedPercent: 87, observedAt: 2_000 }),
    ]);
  });

  it("keeps a reading after its reset has passed", () => {
    recordClaudeUsageObservation(reading({ resetsAt: 1 }));
    expect(readClaudeUsageObservations()).toEqual([reading({ resetsAt: 1 })]);
  });

  it("hands out copies", () => {
    recordClaudeUsageObservation(reading({}));
    readClaudeUsageObservations()[0]!.usedPercent = 1;
    expect(readClaudeUsageObservations()[0]!.usedPercent).toBe(80);
  });
});
