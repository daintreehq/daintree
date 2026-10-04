import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { infoMock, warnMock } = vi.hoisted(() => ({ infoMock: vi.fn(), warnMock: vi.fn() }));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ info: infoMock, warn: warnMock, error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../TerminalLineageLedger.js", () => ({ PROBE_ENV: {} }));

import {
  findSurvivors,
  logTerminalExit,
  logTerminalKill,
  parseProcessRows,
  runSurvivorCheck,
  scheduleSurvivorCheck,
  type ProcessRow,
} from "../terminalKillAudit.js";

function row(startTime: string | null, name: string | null = null, zombie = false): ProcessRow {
  return { startTime, name, zombie };
}

function makeProbe(rows: Record<number, ProcessRow> | null) {
  return vi.fn(async (_pids: number[]) =>
    rows ? new Map(Object.entries(rows).map(([k, v]) => [Number(k), v])) : null
  );
}

beforeEach(() => {
  infoMock.mockReset();
  warnMock.mockReset();
});

describe("parseProcessRows", () => {
  it("reads state, the census-form start time and the base name", () => {
    const parsed = parseProcessRows(
      "  101 S    Sun Oct  4 15:31:06 2026     node\n" +
        "  102 Z+   Mon Sep 28 09:00:00 2026     sh\n" +
        "  103 Ss   Sun Oct  4 15:31:06 2026     My App\n"
    );
    expect(parsed.get(101)).toEqual(row("Sun Oct  4 15:31:06 2026", "node"));
    expect(parsed.get(102)).toEqual(row("Mon Sep 28 09:00:00 2026", "sh", true));
    expect(parsed.get(103)?.name).toBe("My App");
  });

  it("keeps a row whose start time cannot be read as unidentified", () => {
    expect(parseProcessRows("  101 S    garbled\n").get(101)).toEqual(row(null));
  });
});

describe("findSurvivors", () => {
  const identities = new Map([
    [10, "t-shell"],
    [11, "t-npm"],
    [12, "t-vite"],
  ]);

  it("counts only PIDs whose start time still matches", async () => {
    const probe = makeProbe({ 11: row("t-npm", "npm"), 12: row("someone-else", "bash") });

    expect(await findSurvivors(identities, probe)).toEqual({
      survivors: [{ pid: 11, name: "npm" }],
      unresolved: [],
    });
    expect(probe).toHaveBeenCalledWith([10, 11, 12]);
  });

  it("drops zombies", async () => {
    const probe = makeProbe({ 10: row("t-shell", "zsh", true) });

    expect((await findSurvivors(identities, probe)).survivors).toEqual([]);
  });

  it("treats every target as unverified when the probe cannot run", async () => {
    expect(await findSurvivors(identities, makeProbe(null))).toEqual({
      survivors: [],
      unresolved: [10, 11, 12],
    });
  });

  it("treats an unparseable row as unverified rather than gone", async () => {
    const probe = makeProbe({ 12: row(null) });

    expect(await findSurvivors(identities, probe)).toEqual({ survivors: [], unresolved: [12] });
  });
});

describe("kill records", () => {
  it("logs which terminal, why, and what was targeted", () => {
    logTerminalKill("dev-preview-1", "trash-expired", 500, [502, 501, 500], true);

    expect(infoMock).toHaveBeenCalledWith(
      "Killing terminal dev-preview-1 (reason: trash-expired, shell: 500, targets: 502,501,500)"
    );
  });

  it("says when survivors cannot be verified", () => {
    logTerminalKill("t1", "kill", undefined, [], false);

    expect(infoMock.mock.calls[0]?.[0]).toContain("survivor check unavailable");
  });

  it("logs exits with code and signal", () => {
    logTerminalExit("t1", 0, 15, "kill");

    expect(infoMock).toHaveBeenCalledWith("Terminal t1 exited (code: 0, signal: 15, reason: kill)");
  });

  it("warns with pid and name for every survivor", async () => {
    const probe = makeProbe({ 11: row("t-npm", "npm") });

    await runSurvivorCheck("t1", "project-closed", new Map([[11, "t-npm"]]), probe);

    expect(warnMock).toHaveBeenCalledWith(
      "Terminal t1 left processes running after kill (reason: project-closed): 11(npm)"
    );
  });

  it("records a clean kill", async () => {
    await runSurvivorCheck("t1", "kill", new Map([[11, "t-npm"]]), makeProbe({}));

    expect(warnMock).not.toHaveBeenCalled();
    expect(infoMock).toHaveBeenCalledWith(
      "Terminal t1 kill verified, no survivors among 1 target(s) (reason: kill)"
    );
  });

  it("does not claim a clean kill when targets could not be verified", async () => {
    await runSurvivorCheck("t1", "kill", new Map([[11, "t-npm"]]), makeProbe(null));

    expect(infoMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      "Survivor check incomplete for terminal t1 (reason: kill): no survivors confirmed, unverified: 11"
    );
  });

  it("warns instead of throwing when a probe fails", async () => {
    const probe = vi.fn(async () => {
      throw new Error("ps missing");
    });

    await expect(runSurvivorCheck("t1", "kill", new Map([[11, "x"]]), probe)).resolves.toBe(
      undefined
    );
    expect(warnMock.mock.calls[0]?.[0]).toContain("Survivor check failed for terminal t1");
  });
});

describe("scheduleSurvivorCheck", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads identities at check time so escalation targets are included", async () => {
    const identities = new Map([[11, "t-npm"]]);
    const probe = makeProbe({ 11: row("t-npm", "npm"), 12: row("t-vite", "vite") });

    scheduleSurvivorCheck("t1", "kill", () => identities, 4000, probe);
    identities.set(12, "t-vite");
    await vi.advanceTimersByTimeAsync(3999);
    expect(probe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(probe).toHaveBeenCalledWith([11, 12]);
    expect(warnMock.mock.calls[0]?.[0]).toContain("11(npm),12(vite)");
  });
});
