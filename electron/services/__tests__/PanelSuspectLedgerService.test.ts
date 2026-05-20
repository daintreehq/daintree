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

  it("does not quarantine a panel after one strike", () => {
    const svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    expect(svc.getQuarantinedPanelIds().size).toBe(0);
    const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    expect(persisted.suspects.a).toBe(1);
  });

  it(`quarantines a panel once it crosses the threshold (${PANEL_SUSPECT_THRESHOLD} strikes)`, () => {
    let svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    const ids = svc.getQuarantinedPanelIds();
    expect(ids.has("a")).toBe(true);
    expect(svc.getStrikeCount("a")).toBe(2);
  });

  it("keeps a quarantined panel visible on the very next clean boot (no premature decay below threshold)", () => {
    let svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    expect(svc.getQuarantinedPanelIds().has("a")).toBe(true);
    // A single clean boot should NOT restore the panel — it stays quarantined
    // until PANEL_CLEAN_DECAY_COUNT clean launches have accumulated.
    svc = new PanelSuspectLedgerService();
    svc.recordCleanLaunch();
    expect(svc.getQuarantinedPanelIds().has("a")).toBe(true);
  });

  it("decays strike count after the configured number of clean launches", () => {
    let svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    for (let i = 0; i < PANEL_CLEAN_DECAY_COUNT; i++) {
      svc = new PanelSuspectLedgerService();
      svc.recordCleanLaunch();
    }
    // After PANEL_CLEAN_DECAY_COUNT clean launches, strike count decremented by 1.
    svc = new PanelSuspectLedgerService();
    svc.recordCleanLaunch();
    expect(svc.getStrikeCount("a")).toBe(1);
    // Below threshold now — not quarantined.
    expect(svc.getQuarantinedPanelIds().size).toBe(0);
  });

  it("clears strike count when restorePanel is called", () => {
    let svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    expect(svc.getQuarantinedPanelIds().has("a")).toBe(true);
    svc.restorePanel("a");
    expect(svc.getQuarantinedPanelIds().has("a")).toBe(false);
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
    svc.initialize([panel("a", false), panel("e", false)]);
    expect(svc.getStrikeCount("a")).toBe(2);
    expect(svc.getStrikeCount("e")).toBe(1);
    expect(svc.getStrikeCount("b")).toBe(0);
    expect(svc.getStrikeCount("c")).toBe(0);
    expect(svc.getStrikeCount("d")).toBe(0);
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

  it("does NOT purge ledger entries when initialize is called with an empty summary list", () => {
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        suspects: { a: 2, b: 1 },
        cleanCounts: { a: 1 },
      }),
      "utf8"
    );
    const svc = new PanelSuspectLedgerService();
    svc.initialize([]);
    const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    expect(persisted.suspects.a).toBe(2);
    expect(persisted.suspects.b).toBe(1);
    // Quarantine ID set must still surface the above-threshold entry.
    expect(svc.getQuarantinedPanelIds().has("a")).toBe(true);
  });

  it("counts duplicate panel IDs in one snapshot as a single strike", () => {
    const svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true), panel("a", true), panel("a", true)]);
    expect(svc.getStrikeCount("a")).toBe(1);
  });

  it("is idempotent — second initialize() in the same instance is a no-op", () => {
    const svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    svc.initialize([panel("a", true)]);
    const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    expect(persisted.suspects.a).toBe(1);
  });

  it("clean launch on a fresh ledger does not produce quarantined panels", () => {
    const svc = new PanelSuspectLedgerService();
    svc.recordCleanLaunch();
    expect(svc.getQuarantinedPanelIds().size).toBe(0);
  });

  it("a non-suspect appearance in the snapshot accrues a clean-launch credit", () => {
    let svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    expect(svc.getStrikeCount("a")).toBe(1);
    svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", false)]);
    const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    expect(persisted.cleanCounts.a).toBe(1);
  });

  it("recordCleanLaunch surfaces above-threshold panels via getQuarantinedPanelIds", () => {
    let svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    // Clean boot: quarantine ID set must still include "a".
    svc = new PanelSuspectLedgerService();
    svc.recordCleanLaunch();
    expect(svc.getQuarantinedPanelIds().has("a")).toBe(true);
  });

  it("mergeQuarantined preserves quarantined panels from existing state", () => {
    let svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    // "a" is quarantined; renderer's incoming list omits it.
    const incoming = [{ id: "b" }, { id: "c" }];
    const existing = [{ id: "a", extra: "snapshot" }, { id: "b" }, { id: "c" }];
    const merged = svc.mergeQuarantined(incoming, existing);
    expect(merged.map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
    const restored = merged.find((t) => t.id === "a") as { id: string; extra?: string };
    expect(restored.extra).toBe("snapshot");
  });

  it("mergeQuarantined returns incoming unchanged when nothing is quarantined", () => {
    const svc = new PanelSuspectLedgerService();
    svc.initialize([]);
    const incoming = [{ id: "x" }, { id: "y" }];
    const result = svc.mergeQuarantined(incoming, [{ id: "z" }]);
    expect(result).toBe(incoming);
  });

  it("mergeQuarantined drops renderer-sent entries for IDs that are quarantined", () => {
    let svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    svc = new PanelSuspectLedgerService();
    svc.initialize([panel("a", true)]);
    // Renderer accidentally includes the quarantined ID; merge favors the
    // existing-state snapshot.
    const incoming = [{ id: "a", source: "renderer" }];
    const existing = [{ id: "a", source: "existing" }];
    const merged = svc.mergeQuarantined(incoming, existing);
    expect(merged).toHaveLength(1);
    expect((merged[0] as { source: string }).source).toBe("existing");
  });
});
