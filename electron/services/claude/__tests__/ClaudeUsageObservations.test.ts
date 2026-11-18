import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetShellEnvironmentObservationForTests,
  recordShellEnvironment,
} from "../../../setup/shellEnvironmentObservation.js";
import {
  clearClaudeUsageObservations,
  observeClaudeUsage,
  readClaudeUsageObservations,
  readClaudeUsageRecords,
  recordClaudeUsageObservation,
  restoreClaudeUsageObservations,
  sealClaudeUsageObservations,
  type ClaudeUsageRecord,
} from "../ClaudeUsageObservations.js";
import {
  parseClaudeUsageDocument,
  serializeClaudeUsageDocument,
  type SavedClaudeUsageReading,
} from "../claudeUsageDocument.js";

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

describe("ClaudeUsageObservations across launches (#17610)", () => {
  const HOUR = 60 * 60 * 1000;
  const WORK = path.resolve(os.tmpdir(), "daintree-17610", "work");
  const PROFILE = path.resolve(os.tmpdir(), "daintree-17610", "profile");
  const OTHER = path.resolve(os.tmpdir(), "daintree-17610", "other");
  const WEEK = 7 * 24 * HOUR;
  const asIs = async (dir: string) => dir;
  const asIsSync = (dir: string) => dir;

  function memoryStorage(initial: string | null = null) {
    const storage = {
      value: initial,
      writes: 0,
      read: (): string | null => storage.value,
      write: (value: string) => {
        storage.value = value;
        storage.writes++;
      },
    };
    return storage;
  }

  const savedReading = (overrides: Partial<SavedClaudeUsageReading>): SavedClaudeUsageReading => ({
    window: "weekly limit",
    statement: "reached",
    usedPercent: null,
    resetsAt: Date.now() + HOUR,
    terminalId: "earlier",
    observedAt: Date.now() - HOUR,
    identity: WORK,
    configDir: WORK,
    ...overrides,
  });

  const savedPlaces = (value: string | null) =>
    parseClaudeUsageDocument(value, Date.now()).map((saved) => [saved.terminalId, saved.identity]);

  // Long enough for a queued save to read the probe and write.
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  afterEach(() => {
    clearClaudeUsageObservations();
    __resetShellEnvironmentObservationForTests();
  });

  it("saves each new reading under the folder this launch places it, in one write per burst", async () => {
    const storage = memoryStorage();
    restoreClaudeUsageObservations(storage, {
      readShellObservation: () => ({ shell: "/bin/zsh", env: { CLAUDE_CONFIG_DIR: PROFILE } }),
      canonicalKey: asIs,
    });
    const now = Date.now();
    const at = { resetsAt: now + HOUR, observedAt: now - 1_000 };

    recordClaudeUsageObservation(
      reading({ ...at, terminalId: "zsh-work", configDir: WORK, shell: "/bin/zsh" })
    );
    recordClaudeUsageObservation(
      reading({ ...at, terminalId: "zsh-profile", configDir: PROFILE, window: "5-hour limit" })
    );
    recordClaudeUsageObservation(
      reading({
        ...at,
        terminalId: "bash-work",
        configDir: WORK,
        shell: "/bin/bash",
        window: "5-hour limit",
      })
    );
    await settle();

    expect(storage.writes).toBe(1);
    // The zsh pane may have been moved by the profile; the bash one never ran it.
    expect(savedPlaces(storage.value)).toEqual([
      ["zsh-work", null],
      ["zsh-profile", PROFILE],
      ["bash-work", WORK],
    ]);
  });

  it("brings back an earlier launch's readings under the folder it settled on, minus the reset ones", async () => {
    const storage = memoryStorage(
      serializeClaudeUsageDocument([
        savedReading({ terminalId: "work" }),
        savedReading({
          terminalId: "unknown",
          window: "5-hour limit",
          identity: null,
          configDir: PROFILE,
        }),
        savedReading({ terminalId: "reset", window: "Opus limit", resetsAt: Date.now() - 1 }),
      ])
    );

    restoreClaudeUsageObservations(storage, { canonicalKey: asIs });

    expect(
      readClaudeUsageRecords().map((record) => [
        record.terminalId,
        record.savedIdentity,
        record.configDir,
        record.shell,
      ])
    ).toEqual([
      ["work", WORK, WORK, null],
      ["unknown", null, PROFILE, null],
    ]);
    // Nothing of this launch's own to save.
    await settle();
    expect(storage.writes).toBe(0);
  });

  it("keeps each launch's verdict: a later probe moves only this launch's readings", async () => {
    const now = Date.now();
    const storage = memoryStorage(
      serializeClaudeUsageDocument([
        savedReading({ terminalId: "earlier", observedAt: now - HOUR }),
      ])
    );
    restoreClaudeUsageObservations(storage, { canonicalKey: asIs });

    // Before the probe answers, a pane's launch folder stands.
    recordClaudeUsageObservation(
      reading({
        terminalId: "newer",
        configDir: WORK,
        shell: "/bin/zsh",
        observedAt: now - 1_000,
        resetsAt: now + HOUR,
      })
    );
    await settle();
    expect(savedPlaces(storage.value)).toEqual([["newer", WORK]]);

    // The profile exports another folder, so the zsh pane may not have been on WORK.
    recordShellEnvironment("/bin/zsh", { CLAUDE_CONFIG_DIR: PROFILE });
    await settle();
    expect(storage.writes).toBe(2);
    expect(savedPlaces(storage.value)).toEqual([
      ["earlier", WORK],
      ["newer", null],
    ]);

    // Every later answer counts too: one that drops the export puts it back.
    recordShellEnvironment("/bin/zsh", {});
    await settle();
    expect(storage.writes).toBe(3);
    expect(savedPlaces(storage.value)).toEqual([["newer", WORK]]);
    recordShellEnvironment("/bin/zsh", { CLAUDE_CONFIG_DIR: PROFILE });
    await settle();

    // The next launch's profile exports nothing: neither reading moves.
    clearClaudeUsageObservations();
    __resetShellEnvironmentObservationForTests();
    restoreClaudeUsageObservations(storage, { canonicalKey: asIs });

    expect(
      readClaudeUsageRecords().map((record) => [record.terminalId, record.savedIdentity])
    ).toEqual([
      ["earlier", WORK],
      ["newer", null],
    ]);
    expect(readClaudeUsageObservations()).toEqual([
      {
        window: "weekly limit",
        statement: "used",
        usedPercent: 80,
        resetsAt: now + HOUR,
        terminalId: "newer",
        observedAt: now - 1_000,
      },
    ]);
  });

  it("keeps unplaced readings from different folders apart, so one outlives the other's reset", async () => {
    const now = Date.now();
    const DAY = 24 * HOUR;
    const storage = memoryStorage();
    restoreClaudeUsageObservations(storage, {
      readShellObservation: () => ({ shell: "/bin/zsh", env: { CLAUDE_CONFIG_DIR: PROFILE } }),
      canonicalKey: asIs,
    });
    // Neither zsh pane was on the profile's folder, so neither can be placed.
    recordClaudeUsageObservation(
      reading({
        terminalId: "friday",
        configDir: WORK,
        observedAt: now - 2 * HOUR,
        resetsAt: now + 4 * DAY,
      })
    );
    recordClaudeUsageObservation(
      reading({
        terminalId: "tuesday",
        configDir: OTHER,
        observedAt: now - HOUR,
        resetsAt: now + DAY,
      })
    );
    await settle();
    expect(savedPlaces(storage.value)).toEqual([
      ["friday", null],
      ["tuesday", null],
    ]);

    // Two days on, the newer one's reset has passed and the older one's hasn't.
    clearClaudeUsageObservations();
    restoreClaudeUsageObservations(storage, { now: () => now + 2 * DAY, canonicalKey: asIs });

    expect(readClaudeUsageRecords().map((record) => record.terminalId)).toEqual(["friday"]);
  });

  it("never lets a sighting it can't place replace a saved one it could", () => {
    const now = Date.now();
    restoreClaudeUsageObservations(
      memoryStorage(serializeClaudeUsageDocument([savedReading({ observedAt: now - HOUR })])),
      {
        readShellObservation: () => ({ shell: "/bin/zsh", env: { CLAUDE_CONFIG_DIR: PROFILE } }),
        canonicalKey: asIs,
      }
    );

    // The same folder, but a zsh pane the profile may have moved.
    recordClaudeUsageObservation(
      reading({ terminalId: "unplaced", configDir: WORK, observedAt: now, resetsAt: now + HOUR })
    );

    expect(readClaudeUsageRecords().map((record) => record.terminalId)).toEqual([
      "earlier",
      "unplaced",
    ]);
  });

  it("saves readings that showed before the store opened", async () => {
    const now = Date.now();
    recordClaudeUsageObservation(
      reading({ terminalId: "early", configDir: WORK, observedAt: now, resetsAt: now + HOUR })
    );
    const storage = memoryStorage();

    restoreClaudeUsageObservations(storage, { canonicalKey: asIs });
    await settle();

    expect(savedPlaces(storage.value)).toEqual([["early", WORK]]);
  });

  it("leaves out of the save a reading whose reset has passed, and keeps answering with it", async () => {
    const now = Date.now();
    const storage = memoryStorage();
    restoreClaudeUsageObservations(storage, { canonicalKey: asIs });

    recordClaudeUsageObservation(
      reading({ terminalId: "spent", configDir: WORK, observedAt: now - HOUR, resetsAt: now - 1 })
    );
    await settle();

    expect(storage.writes).toBe(1);
    expect(JSON.parse(storage.value!).readings).toEqual([]);
    expect(readClaudeUsageRecords().map((record) => record.terminalId)).toEqual(["spent"]);
  });

  it("never writes over saved readings it couldn't read", async () => {
    const storage = memoryStorage();
    storage.read = () => {
      throw new Error("database locked");
    };
    restoreClaudeUsageObservations(storage, { canonicalKey: asIs });

    recordClaudeUsageObservation(reading({ observedAt: Date.now(), resetsAt: Date.now() + HOUR }));
    await settle();

    expect(storage.writes).toBe(0);
    expect(readClaudeUsageRecords()).toHaveLength(1);
  });

  it("stops saving once cleared, even with a save under way", async () => {
    let finish: ((dir: string) => void) | undefined;
    const storage = memoryStorage();
    restoreClaudeUsageObservations(storage, {
      readShellObservation: () => ({ shell: "/bin/zsh", env: { CLAUDE_CONFIG_DIR: PROFILE } }),
      canonicalKey: () => new Promise<string>((resolve) => (finish = resolve)),
    });
    recordClaudeUsageObservation(reading({ observedAt: Date.now(), resetsAt: Date.now() + HOUR }));
    await vi.waitFor(() => expect(finish).toBeDefined());

    clearClaudeUsageObservations();
    finish!(PROFILE);
    await settle();

    expect(storage.writes).toBe(0);
  });

  it("writes at quit what a late probe moved while a save was still resolving, then nothing", async () => {
    let finish: ((dir: string) => void) | undefined;
    const storage = memoryStorage();
    recordShellEnvironment("/bin/zsh", { CLAUDE_CONFIG_DIR: PROFILE });
    restoreClaudeUsageObservations(storage, {
      canonicalKey: () => new Promise<string>((resolve) => (finish = resolve)),
      canonicalKeySync: asIsSync,
    });
    recordClaudeUsageObservation(
      reading({ configDir: WORK, observedAt: Date.now(), resetsAt: Date.now() + HOUR })
    );
    await vi.waitFor(() => expect(finish).toBeDefined());

    // The save under way would file the zsh pane's reading as unknown.
    recordShellEnvironment("/bin/zsh", {});
    sealClaudeUsageObservations();
    expect(storage.writes).toBe(1);
    expect(savedPlaces(storage.value)).toEqual([["t1", WORK]]);

    finish!(PROFILE);
    recordClaudeUsageObservation(
      reading({ window: "5-hour limit", observedAt: Date.now(), resetsAt: Date.now() + HOUR })
    );
    await settle();
    expect(storage.writes).toBe(1);
  });

  it("writes nothing at quit when the last save already has every change", async () => {
    const storage = memoryStorage();
    restoreClaudeUsageObservations(storage, { canonicalKey: asIs, canonicalKeySync: asIsSync });
    recordClaudeUsageObservation(reading({ observedAt: Date.now(), resetsAt: Date.now() + HOUR }));
    await settle();

    sealClaudeUsageObservations();

    expect(storage.writes).toBe(1);
  });

  it("retries at quit a save that failed", async () => {
    const storage = memoryStorage();
    const write = storage.write;
    storage.write = () => {
      throw new Error("disk full");
    };
    restoreClaudeUsageObservations(storage, { canonicalKey: asIs, canonicalKeySync: asIsSync });
    recordClaudeUsageObservation(
      reading({ configDir: WORK, observedAt: Date.now(), resetsAt: Date.now() + HOUR })
    );
    await settle();
    storage.write = write;

    sealClaudeUsageObservations();

    expect(storage.writes).toBe(1);
    expect(savedPlaces(storage.value)).toEqual([["t1", WORK]]);
  });

  it("neither reads nor saves when restore comes after quit has sealed the store", async () => {
    const storage = memoryStorage();
    const read = vi.fn(storage.read);
    storage.read = read;
    sealClaudeUsageObservations();

    restoreClaudeUsageObservations(storage, { canonicalKey: asIs });
    recordClaudeUsageObservation(reading({ observedAt: Date.now(), resetsAt: Date.now() + HOUR }));
    await settle();

    expect(read).not.toHaveBeenCalled();
    expect(storage.writes).toBe(0);
  });

  it("stops answering with a reading that named no reset a week after it showed", () => {
    const now = Date.now();
    recordClaudeUsageObservation(
      reading({
        terminalId: "dated",
        configDir: WORK,
        resetsAt: now - HOUR,
        observedAt: now - WEEK - 2 * HOUR,
      })
    );
    recordClaudeUsageObservation(
      reading({
        terminalId: "stale",
        resetsAt: null,
        observedAt: now - WEEK - HOUR,
      })
    );
    recordClaudeUsageObservation(
      reading({ terminalId: "fresh", window: "5-hour limit", resetsAt: null, observedAt: now })
    );

    expect(readClaudeUsageRecords().map((record) => record.terminalId)).toEqual(["dated", "fresh"]);
    // A stale one no longer hides an older reading that named its reset.
    expect(readClaudeUsageObservations().map((observation) => observation.terminalId)).toEqual([
      "fresh",
      "dated",
    ]);
  });
});
