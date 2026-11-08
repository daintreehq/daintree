import { afterEach, describe, expect, it } from "vitest";
import {
  clearClaudeUsageObservations,
  readClaudeUsageObservations,
  readClaudeUsageRecords,
  recordClaudeUsageObservation,
  type ClaudeUsageRecord,
} from "../ClaudeUsageObservations.js";

const reading = (overrides: Partial<ClaudeUsageRecord>): ClaudeUsageRecord => ({
  terminalId: "t1",
  window: "weekly limit",
  statement: "used",
  usedPercent: 80,
  resetsAt: 2_000,
  observedAt: 1_000,
  configDir: "/home/me/.claude",
  ...overrides,
});

const withoutFolder = ({ configDir: _configDir, ...observation }: ClaudeUsageRecord) => observation;

describe("ClaudeUsageObservations", () => {
  afterEach(() => clearClaudeUsageObservations());

  it("answers nothing before any pane showed a message", () => {
    expect(readClaudeUsageRecords()).toEqual([]);
    expect(readClaudeUsageObservations()).toEqual([]);
  });

  it("keeps the latest sighting per limit within one folder, from whichever pane", () => {
    recordClaudeUsageObservation(reading({ terminalId: "t1", usedPercent: 80, observedAt: 1_000 }));
    recordClaudeUsageObservation(reading({ terminalId: "t2", usedPercent: 87, observedAt: 2_000 }));
    recordClaudeUsageObservation(
      reading({ terminalId: "t1", window: "5-hour limit", statement: "reached", usedPercent: null })
    );

    expect(readClaudeUsageRecords()).toEqual([
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

    expect(readClaudeUsageRecords()).toEqual([
      reading({ terminalId: "t2", usedPercent: 87, observedAt: 2_000 }),
    ]);
  });

  it("keeps one account's reading when another account's arrives for the same limit (#16370)", () => {
    recordClaudeUsageObservation(reading({ terminalId: "t1", usedPercent: 80, observedAt: 1_000 }));
    recordClaudeUsageObservation(
      reading({
        terminalId: "t2",
        usedPercent: 30,
        observedAt: 2_000,
        configDir: "/home/me/.claude-work",
      })
    );
    recordClaudeUsageObservation(
      reading({ terminalId: "t3", usedPercent: 55, observedAt: 3_000, configDir: null })
    );

    expect(readClaudeUsageRecords()).toEqual([
      reading({ terminalId: "t1", usedPercent: 80, observedAt: 1_000 }),
      reading({
        terminalId: "t2",
        usedPercent: 30,
        observedAt: 2_000,
        configDir: "/home/me/.claude-work",
      }),
      reading({ terminalId: "t3", usedPercent: 55, observedAt: 3_000, configDir: null }),
    ]);
  });

  it("answers agent.readQuota with the newest per limit across folders, without the folder", () => {
    recordClaudeUsageObservation(reading({ terminalId: "t1", usedPercent: 80, observedAt: 3_000 }));
    recordClaudeUsageObservation(
      reading({
        terminalId: "t2",
        usedPercent: 30,
        observedAt: 2_000,
        configDir: "/home/me/.claude-work",
      })
    );
    recordClaudeUsageObservation(
      reading({
        terminalId: "t2",
        window: "5-hour limit",
        statement: "approaching",
        usedPercent: null,
        configDir: "/home/me/.claude-work",
      })
    );

    const readings = readClaudeUsageObservations();
    expect(readings).toEqual([
      withoutFolder(
        reading({
          terminalId: "t2",
          window: "5-hour limit",
          statement: "approaching",
          usedPercent: null,
        })
      ),
      withoutFolder(reading({ terminalId: "t1", usedPercent: 80, observedAt: 3_000 })),
    ]);
    expect(readings.every((entry) => !("configDir" in entry))).toBe(true);
  });

  it("keeps a reading after its reset has passed", () => {
    recordClaudeUsageObservation(reading({ resetsAt: 1 }));
    expect(readClaudeUsageRecords()).toEqual([reading({ resetsAt: 1 })]);
  });

  it("hands out copies", () => {
    recordClaudeUsageObservation(reading({}));
    readClaudeUsageRecords()[0]!.usedPercent = 1;
    readClaudeUsageObservations()[0]!.usedPercent = 1;
    expect(readClaudeUsageRecords()[0]!.usedPercent).toBe(80);
    expect(readClaudeUsageObservations()[0]!.usedPercent).toBe(80);
  });
});
