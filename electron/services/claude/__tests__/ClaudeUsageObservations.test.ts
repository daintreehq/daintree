import { afterEach, describe, expect, it } from "vitest";
import {
  clearClaudeUsageObservations,
  observeClaudeUsage,
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
  shell: "/bin/zsh",
  ...overrides,
});

const withoutFolder = ({
  configDir: _configDir,
  shell: _shell,
  ...observation
}: ClaudeUsageRecord) => observation;

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

  it("keeps readings from panes in different shells apart, though their folder is one", () => {
    recordClaudeUsageObservation(reading({ terminalId: "t1", usedPercent: 80, observedAt: 1_000 }));
    recordClaudeUsageObservation(
      reading({ terminalId: "t2", usedPercent: 30, observedAt: 2_000, shell: "/bin/bash" })
    );

    expect(readClaudeUsageRecords().map((record) => [record.terminalId, record.shell])).toEqual([
      ["t1", "/bin/zsh"],
      ["t2", "/bin/bash"],
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
    expect(readings.every((entry) => !("configDir" in entry) && !("shell" in entry))).toBe(true);
  });

  it("answers agent.readQuota with the newer reading even when its folder was seen second", () => {
    recordClaudeUsageObservation(reading({ terminalId: "t1", usedPercent: 40, observedAt: 1_000 }));
    recordClaudeUsageObservation(
      reading({
        terminalId: "t2",
        usedPercent: 70,
        observedAt: 2_000,
        configDir: "/home/me/.claude-work",
      })
    );

    expect(readClaudeUsageObservations()).toEqual([
      withoutFolder(reading({ terminalId: "t2", usedPercent: 70, observedAt: 2_000 })),
    ]);
  });

  it("files a reading under its folder as resolved when it showed (#16370)", async () => {
    // A link first points at one login's folder, then at another's.
    let target = "/accounts/work";
    const canonical = async (dir: string) => (dir === "/accounts/current" ? target : dir);

    await observeClaudeUsage(
      reading({ terminalId: "t1", usedPercent: 80, configDir: "/accounts/current" }),
      canonical
    );
    target = "/accounts/personal";
    await observeClaudeUsage(
      reading({
        terminalId: "t2",
        usedPercent: 20,
        observedAt: 2_000,
        configDir: "/accounts/current",
      }),
      canonical
    );
    await observeClaudeUsage(reading({ terminalId: "t3", configDir: null }), canonical);

    expect(readClaudeUsageRecords()).toEqual([
      reading({ terminalId: "t1", usedPercent: 80, configDir: "/accounts/work" }),
      reading({
        terminalId: "t2",
        usedPercent: 20,
        observedAt: 2_000,
        configDir: "/accounts/personal",
      }),
      reading({ terminalId: "t3", configDir: null }),
    ]);
  });

  it("drops a reading whose folder was still resolving when the store was cleared", async () => {
    let finish: (dir: string) => void = () => {};
    const pending = observeClaudeUsage(
      reading({}),
      () => new Promise<string>((resolve) => (finish = resolve))
    );

    clearClaudeUsageObservations();
    finish("/home/me/.claude");
    await pending;

    expect(readClaudeUsageRecords()).toEqual([]);
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
