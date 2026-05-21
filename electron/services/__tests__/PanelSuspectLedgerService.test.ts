import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { PanelSummary, PendingCrash } from "../../../shared/types/ipc/crashRecovery.js";

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => ""),
}));

const utilsMock = vi.hoisted(() => ({
  resilientAtomicWriteFileSync: vi.fn(),
}));

vi.mock("electron", () => ({
  app: appMock,
}));

vi.mock("../../utils/fs.js", () => utilsMock);

import {
  PanelSuspectLedgerService,
  PANEL_DECAY_CLEAN_LAUNCHES,
  PANEL_DECAY_TTL_MS,
  PANEL_QUARANTINE_THRESHOLD,
  __resetPanelSuspectLedgerForTesting,
  getPanelSuspectLedger,
  initializePanelSuspectLedger,
} from "../PanelSuspectLedgerService.js";

function suspectPanel(id: string, overrides: Partial<PanelSummary> = {}): PanelSummary {
  return {
    id,
    kind: "terminal",
    title: `Panel ${id}`,
    cwd: "/tmp/example",
    worktreeId: "wt-main",
    location: "grid",
    isSuspect: true,
    ...overrides,
  };
}

function stablePanel(id: string, overrides: Partial<PanelSummary> = {}): PanelSummary {
  return suspectPanel(id, { isSuspect: false, ...overrides });
}

function pendingCrash(panels: PanelSummary[]): PendingCrash {
  return {
    logPath: "/tmp/example/crash.json",
    entry: {
      id: "crash-1",
      timestamp: Date.now(),
      appVersion: "0.0.0",
      platform: process.platform,
      osVersion: "0",
      arch: process.arch,
    },
    hasBackup: true,
    panels,
  };
}

describe("PanelSuspectLedgerService", () => {
  let tmpDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-suspect-ledger-test-"));
    appMock.getPath.mockReturnValue(tmpDir);
    ledgerPath = path.join(tmpDir, "panel-suspect-ledger.json");
    utilsMock.resilientAtomicWriteFileSync.mockImplementation(
      (fp: string, data: string, enc?: BufferEncoding) => {
        fs.writeFileSync(fp, data, enc ?? "utf-8");
      }
    );
    __resetPanelSuspectLedgerForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
    __resetPanelSuspectLedgerForTesting();
  });

  function readLedgerFile(): { version: 1; panels: Record<string, unknown> } {
    return JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
      version: 1;
      panels: Record<string, unknown>;
    };
  }

  it("starts empty on a fresh install", () => {
    const ledger = new PanelSuspectLedgerService();
    ledger.initialize(null);

    expect(ledger.getQuarantinedPanelIds().size).toBe(0);
    expect(ledger.getQuarantinedPanels()).toEqual([]);
    expect(fs.existsSync(ledgerPath)).toBe(true);
    expect(readLedgerFile().panels).toEqual({});
  });

  it("increments consecutive suspect count for each suspect crash", () => {
    const ledger = new PanelSuspectLedgerService();
    ledger.initialize(pendingCrash([suspectPanel("p1")]));

    const state = readLedgerFile();
    expect((state.panels.p1 as { consecutiveSuspectCount: number }).consecutiveSuspectCount).toBe(
      1
    );

    // Second crashed boot — same suspect panel.
    __resetPanelSuspectLedgerForTesting();
    const ledger2 = new PanelSuspectLedgerService();
    ledger2.initialize(pendingCrash([suspectPanel("p1")]));

    const state2 = readLedgerFile();
    expect((state2.panels.p1 as { consecutiveSuspectCount: number }).consecutiveSuspectCount).toBe(
      2
    );
  });

  it("quarantines a panel after threshold consecutive suspect appearances", () => {
    const ledger1 = new PanelSuspectLedgerService();
    ledger1.initialize(pendingCrash([suspectPanel("p1")]));
    expect(ledger1.getQuarantinedPanelIds().has("p1")).toBe(false);

    __resetPanelSuspectLedgerForTesting();
    const ledger2 = new PanelSuspectLedgerService();
    ledger2.initialize(pendingCrash([suspectPanel("p1")]));

    expect(PANEL_QUARANTINE_THRESHOLD).toBe(2);
    expect(ledger2.getQuarantinedPanelIds().has("p1")).toBe(true);
    expect(ledger2.getQuarantinedPanels()).toEqual([
      expect.objectContaining({ id: "p1", title: "Panel p1", kind: "terminal" }),
    ]);
  });

  it("does not increment for panels not flagged isSuspect on the crash", () => {
    const ledger1 = new PanelSuspectLedgerService();
    ledger1.initialize(pendingCrash([suspectPanel("p1")]));

    __resetPanelSuspectLedgerForTesting();
    const ledger2 = new PanelSuspectLedgerService();
    ledger2.initialize(pendingCrash([stablePanel("p1")]));

    // The same panel survived this crash unscathed — its suspect count should
    // stay at 1 (not be incremented), and cleanLaunchesSince should advance.
    const state = readLedgerFile();
    const record = state.panels.p1 as {
      consecutiveSuspectCount: number;
      cleanLaunchesSince: number;
    };
    expect(record.consecutiveSuspectCount).toBe(1);
    expect(record.cleanLaunchesSince).toBe(1);
    expect(ledger2.getQuarantinedPanelIds().has("p1")).toBe(false);
  });

  it("decays a record after enough clean launches", () => {
    const ledger1 = new PanelSuspectLedgerService();
    ledger1.initialize(pendingCrash([suspectPanel("p1")]));
    // Crossing the quarantine threshold so decay is meaningful.
    __resetPanelSuspectLedgerForTesting();
    const ledger2 = new PanelSuspectLedgerService();
    ledger2.initialize(pendingCrash([suspectPanel("p1")]));
    expect(ledger2.getQuarantinedPanelIds().has("p1")).toBe(true);

    // Now N clean launches in a row.
    for (let i = 0; i < PANEL_DECAY_CLEAN_LAUNCHES; i++) {
      ledger2.markCleanLaunch();
    }
    expect(ledger2.getQuarantinedPanelIds().has("p1")).toBe(false);
    expect(readLedgerFile().panels).toEqual({});
  });

  it("decays a stale record via the TTL fallback even with no clean shutdowns", () => {
    const ledger1 = new PanelSuspectLedgerService();
    ledger1.initialize(pendingCrash([suspectPanel("p1")]));
    __resetPanelSuspectLedgerForTesting();
    const ledger2 = new PanelSuspectLedgerService();
    ledger2.initialize(pendingCrash([suspectPanel("p1")]));
    expect(ledger2.getQuarantinedPanelIds().has("p1")).toBe(true);

    // Jump past the TTL.
    vi.advanceTimersByTime(PANEL_DECAY_TTL_MS + 1);

    __resetPanelSuspectLedgerForTesting();
    const ledger3 = new PanelSuspectLedgerService();
    ledger3.initialize(null);
    expect(ledger3.getQuarantinedPanelIds().has("p1")).toBe(false);
  });

  it("clearQuarantinedPanel removes the record and persists", () => {
    const ledger1 = new PanelSuspectLedgerService();
    ledger1.initialize(pendingCrash([suspectPanel("p1"), suspectPanel("p2")]));
    __resetPanelSuspectLedgerForTesting();
    const ledger2 = new PanelSuspectLedgerService();
    ledger2.initialize(pendingCrash([suspectPanel("p1"), suspectPanel("p2")]));
    expect(ledger2.getQuarantinedPanelIds().size).toBe(2);

    expect(ledger2.clearQuarantinedPanel("p1")).toBe(true);
    expect(ledger2.getQuarantinedPanelIds().has("p1")).toBe(false);
    expect(ledger2.getQuarantinedPanelIds().has("p2")).toBe(true);
    // Idempotent — calling again is a no-op.
    expect(ledger2.clearQuarantinedPanel("p1")).toBe(false);
    expect(readLedgerFile().panels.p1).toBeUndefined();
    expect(readLedgerFile().panels.p2).toBeDefined();
  });

  it("clearQuarantinedPanel restores the in-memory record and returns false on write failure", () => {
    const ledger1 = new PanelSuspectLedgerService();
    ledger1.initialize(pendingCrash([suspectPanel("p1")]));
    __resetPanelSuspectLedgerForTesting();
    const ledger2 = new PanelSuspectLedgerService();
    ledger2.initialize(pendingCrash([suspectPanel("p1")]));
    expect(ledger2.getQuarantinedPanelIds().has("p1")).toBe(true);

    utilsMock.resilientAtomicWriteFileSync.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(ledger2.clearQuarantinedPanel("p1")).toBe(false);
    // Record should still be in the in-memory ledger so the next clean
    // launch (or retry) writes a consistent view.
    expect(ledger2.getQuarantinedPanelIds().has("p1")).toBe(true);
  });

  it("clearQuarantinedPanel returns false for unknown panel ids", () => {
    const ledger = new PanelSuspectLedgerService();
    ledger.initialize(null);
    expect(ledger.clearQuarantinedPanel("not-here")).toBe(false);
  });

  it("quarantines a corrupt ledger file and resets", () => {
    fs.writeFileSync(ledgerPath, "not valid json!!!", "utf8");

    const ledger = new PanelSuspectLedgerService();
    ledger.initialize(null);

    expect(ledger.getQuarantinedLedgerPath()).toMatch(
      /panel-suspect-ledger\.json\.corrupted\.\d+$/
    );
    expect(fs.existsSync(ledger.getQuarantinedLedgerPath()!)).toBe(true);
    expect(ledger.getQuarantinedPanelIds().size).toBe(0);
  });

  it("quarantines a ledger file with invalid structure", () => {
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 2, foo: "bar" }), "utf8");

    const ledger = new PanelSuspectLedgerService();
    ledger.initialize(null);

    expect(ledger.getQuarantinedLedgerPath()).toMatch(
      /panel-suspect-ledger\.json\.corrupted\.\d+$/
    );
  });

  it("drops individual malformed records on read but keeps valid siblings", () => {
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        panels: {
          good: {
            consecutiveSuspectCount: 2,
            cleanLaunchesSince: 0,
            lastSuspectAt: Date.now(),
            title: "Good",
            kind: "terminal",
          },
          bad: { wrongShape: true },
        },
      }),
      "utf8"
    );

    const ledger = new PanelSuspectLedgerService();
    ledger.initialize(null);

    expect(ledger.getQuarantinedPanelIds().has("good")).toBe(true);
    expect(ledger.getQuarantinedPanelIds().has("bad")).toBe(false);
    expect(ledger.getQuarantinedLedgerPath()).toBeNull();
  });

  it("does nothing surprising on a clean boot with no pending crash", () => {
    const ledger = new PanelSuspectLedgerService();
    ledger.initialize(null);
    expect(ledger.getQuarantinedPanelIds().size).toBe(0);
  });

  it("initialize is idempotent — a second call is a no-op", () => {
    const ledger = new PanelSuspectLedgerService();
    ledger.initialize(pendingCrash([suspectPanel("p1")]));
    const recordedAfterFirst = readLedgerFile().panels.p1 as { consecutiveSuspectCount: number };
    expect(recordedAfterFirst.consecutiveSuspectCount).toBe(1);

    // Calling initialize again with the same crash should not double-count.
    ledger.initialize(pendingCrash([suspectPanel("p1")]));
    const recordedAfterSecond = readLedgerFile().panels.p1 as {
      consecutiveSuspectCount: number;
    };
    expect(recordedAfterSecond.consecutiveSuspectCount).toBe(1);
  });

  it("refreshes display metadata when a tracked panel is seen again", () => {
    const ledger1 = new PanelSuspectLedgerService();
    ledger1.initialize(pendingCrash([suspectPanel("p1", { title: "Old title" })]));

    __resetPanelSuspectLedgerForTesting();
    const ledger2 = new PanelSuspectLedgerService();
    ledger2.initialize(pendingCrash([stablePanel("p1", { title: "New title", cwd: "/tmp/new" })]));

    const record = readLedgerFile().panels.p1 as { title: string; cwd: string };
    expect(record.title).toBe("New title");
    expect(record.cwd).toBe("/tmp/new");
  });

  it("ignores panels with empty ids", () => {
    const ledger = new PanelSuspectLedgerService();
    ledger.initialize(pendingCrash([suspectPanel("", { title: "ghost" })]));
    expect(Object.keys(readLedgerFile().panels)).toEqual([]);
  });

  it("sweeps stale .tmp files older than the orphan TTL", () => {
    const orphanPath = path.join(
      tmpDir,
      `panel-suspect-ledger.json.${Date.now() - 10 * 60 * 1000}-abc.tmp`
    );
    fs.writeFileSync(orphanPath, "partial", "utf8");
    expect(fs.existsSync(orphanPath)).toBe(true);

    const ledger = new PanelSuspectLedgerService();
    ledger.initialize(null);

    expect(fs.existsSync(orphanPath)).toBe(false);
  });

  it("prunes corrupted siblings beyond the retention count", () => {
    // Create 6 corrupted siblings, keeping 3.
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `panel-suspect-ledger.json.corrupted.${1000 + i}`),
        "old",
        "utf8"
      );
    }

    const ledger = new PanelSuspectLedgerService();
    ledger.initialize(null);

    const siblings = fs
      .readdirSync(tmpDir)
      .filter((e) => e.startsWith("panel-suspect-ledger.json.corrupted."));
    expect(siblings.length).toBe(3);
  });

  it("getPanelSuspectLedger returns a singleton across calls", () => {
    const a = getPanelSuspectLedger();
    const b = getPanelSuspectLedger();
    expect(a).toBe(b);
  });

  it("initializePanelSuspectLedger initializes the singleton", () => {
    const service = initializePanelSuspectLedger(pendingCrash([suspectPanel("p1")]));
    expect(service.isInitialized()).toBe(true);
    expect(readLedgerFile().panels.p1).toBeDefined();
  });
});
