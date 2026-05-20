import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { PanelSummary } from "../../../shared/types/ipc/crashRecovery.js";

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => ""),
}));

const utilsMock = vi.hoisted(() => ({
  resilientAtomicWriteFileSync: vi.fn((p: string, data: string) => {
    fs.writeFileSync(p, data, "utf8");
  }),
}));

vi.mock("electron", () => ({
  app: appMock,
}));

vi.mock("../../utils/fs.js", () => utilsMock);

import {
  PANEL_CLEAN_DECAY_COUNT,
  PANEL_SUSPECT_THRESHOLD,
  PanelSuspectLedgerService,
} from "../PanelSuspectLedgerService.js";

function panel(id: string, isSuspect: boolean, overrides: Partial<PanelSummary> = {}): PanelSummary {
  return {
    id,
    kind: "terminal",
    title: `Panel ${id}`,
    cwd: `/repo/${id}`,
    worktreeId: `wt-${id}`,
    location: "grid",
    isSuspect,
    ...overrides,
  };
}

describe("PanelSuspectLedgerService", () => {
  let tmpDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-suspect-ledger-"));
    appMock.getPath.mockReturnValue(tmpDir);
    ledgerPath = path.join(tmpDir, "panel-suspect-ledger.json");
    utilsMock.resilientAtomicWriteFileSync.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty quarantine list on first crash with one suspect panel below threshold", () => {
    const svc = new PanelSuspectLedgerService();
    const result = svc.initialize([panel("a", true)]);
    expect(result).toEqual([]);
    const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    expect(persisted.suspects.a).toBe(1);
  });

  it(`quarantines a panel once it crosses the threshold (${PANEL_SUSPECT_THRESHOLD} strikes)`, () => {
    let svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    svc = new PanelSuspectLedgerService();
    const result = svc.initialize([panel("a", true)]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
    expect(result[0].suspectCount).toBe(2);
  });

  it("does not quarantine a panel that has only one strike", () => {
    let svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true), panel("b", false)]);
    svc = new PanelSuspectLedgerService();
    const result = svc.initialize([panel("a", false), panel("b", false)]);
    expect(result).toEqual([]);
  });

  it("decays strike count after the configured number of clean launches", () => {
    let svc = new PanelSuspectLedgerService();
    // Two strikes — quarantined
    svc.initialize([panel("a", true)]);
    svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    // The required number of clean launches via recordCleanLaunch
    for (let i = 0; i < PANEL_CLEAN_DECAY_COUNT; i++) {
      svc = new PanelSuspectLedgerService();
      svc.recordCleanLaunch();
    }
    // Next crash boot should no longer quarantine
    svc = new PanelSuspectLedgerService();
    const result = svc.initialize([panel("a", true)]);
    // After decay (2 → 1) the new strike brings it back to 2 → quarantined
    expect(result).toHaveLength(1);
  });

  it("clears strike count when restorePanel is called", () => {
    let svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    expect(svc.getQuarantinedPanels()).toHaveLength(1);
    svc.restorePanel("a");
    expect(svc.getQuarantinedPanels()).toHaveLength(0);
    const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    expect(persisted.suspects.a).toBeUndefined();
  });

  it("ignores corrupt entries in the ledger file (NaN, negative, non-numeric)", () => {
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        suspects: { a: 2, b: -1, c: "five", d: NaN, e: 1.7 },
        cleanCounts: {},
      }),
      "utf8"
    );
    const svc = new PanelSuspectLedgerService();
    const result = svc.initialize([panel("a", false), panel("e", false)]);
    // a survives at 2 with one decay credit (cleanCounts[a]=1, not yet decayed)
    // e survives at 1 (Math.floor(1.7))
    expect(result.map((p) => p.id)).toEqual(["a"]);
  });

  it("quarantines a corrupt ledger file and uses a fresh ledger", () => {
    fs.writeFileSync(ledgerPath, "{not valid json", "utf8");
    const svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    const entries = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("panel-suspect-ledger.json.corrupted."));
    expect(entries.length).toBe(1);
    const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    expect(persisted.suspects.a).toBe(1);
  });

  it("treats a missing version as invalid and quarantines the file", () => {
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({ suspects: { a: 5 }, cleanCounts: {} }),
      "utf8"
    );
    const svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    const entries = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("panel-suspect-ledger.json.corrupted."));
    expect(entries.length).toBe(1);
    const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    expect(persisted.suspects.a).toBe(1);
  });

  it("drops ledger entries for panels that no longer appear in the snapshot", () => {
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        suspects: { a: 3, b: 2 },
        cleanCounts: { a: 1 },
      }),
      "utf8"
    );
    const svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", false)]);
    const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    expect(persisted.suspects.b).toBeUndefined();
    expect(persisted.cleanCounts.b).toBeUndefined();
  });

  it("is idempotent — second initialize() in the same instance is a no-op", () => {
    const svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    const result = svc.initialize([panel("a", true)]);
    // Strike count should not have doubled
    const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    expect(persisted.suspects.a).toBe(1);
    expect(result).toEqual(svc.getQuarantinedPanels());
  });

  it("clean launch on a fresh ledger does not produce quarantined panels", () => {
    const svc = new PanelSuspectLedgerService();
    svc.recordCleanLaunch();
    expect(svc.getQuarantinedPanels()).toEqual([]);
  });

  it("clean launches reset cleanCount streak when a strike interrupts decay", () => {
    let svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    // 1 clean launch (cleanCounts[a] = 1)
    svc = new PanelSuspectLedgerService();
    svc.recordCleanLaunch();
    let persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    expect(persisted.cleanCounts.a).toBe(1);
    // New strike resets cleanCounts[a]
    svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    expect(persisted.cleanCounts.a).toBeUndefined();
    expect(persisted.suspects.a).toBe(3);
  });

  it("getQuarantinedPanelIds returns an empty set when nothing is quarantined", () => {
    const svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    expect(svc.getQuarantinedPanelIds().size).toBe(0);
  });
});
