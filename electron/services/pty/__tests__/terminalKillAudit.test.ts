import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { infoMock, warnMock } = vi.hoisted(() => ({ infoMock: vi.fn(), warnMock: vi.fn() }));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ info: infoMock, warn: warnMock, error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../TerminalLineageLedger.js", () => ({
  probeStartTimesDetailed: vi.fn(),
}));

import {
  findSurvivors,
  logTerminalExit,
  logTerminalKill,
  parseProcessNames,
  runSurvivorCheck,
  scheduleSurvivorCheck,
  type KillAuditProbes,
  type ProcessName,
} from "../terminalKillAudit.js";

function makeProbes(
  startTimes: Record<number, string>,
  names: Record<number, ProcessName> | null,
  unresolved: number[] = []
): KillAuditProbes & { probeNames: ReturnType<typeof vi.fn> } {
  return {
    probeStartTimes: vi.fn(async () => ({
      startTimes: new Map(Object.entries(startTimes).map(([k, v]) => [Number(k), v])),
      unresolved: new Set(unresolved),
    })),
    probeNames: vi.fn(async () =>
      names ? new Map(Object.entries(names).map(([k, v]) => [Number(k), v])) : null
    ),
  };
}

beforeEach(() => {
  infoMock.mockReset();
  warnMock.mockReset();
});

describe("parseProcessNames", () => {
  it("reads the base name and zombie state, never more than comm", () => {
    const parsed = parseProcessNames(
      "  101 S    /usr/local/bin/node\n  102 Z+   (sh)\n  103 Ss   /Applications/My App.app/Contents/MacOS/My App\n"
    );
    expect(parsed.get(101)).toEqual({ name: "node", zombie: false });
    expect(parsed.get(102)).toEqual({ name: "(sh)", zombie: true });
    expect(parsed.get(103)).toEqual({ name: "My App", zombie: false });
  });
});

describe("findSurvivors", () => {
  const identities = new Map([
    [10, "t-shell"],
    [11, "t-npm"],
    [12, "t-vite"],
  ]);

  it("counts only PIDs whose start time still matches", async () => {
    const probes = makeProbes(
      { 11: "t-npm", 12: "someone-else" },
      {
        11: { name: "npm", zombie: false },
      }
    );

    const result = await findSurvivors(identities, probes);

    expect(result.survivors).toEqual([{ pid: 11, name: "npm" }]);
    expect(probes.probeNames).toHaveBeenCalledWith([11]);
  });

  it("drops zombies and processes the name probe no longer lists", async () => {
    const probes = makeProbes(
      { 10: "t-shell", 11: "t-npm" },
      {
        10: { name: "zsh", zombie: true },
      }
    );

    expect((await findSurvivors(identities, probes)).survivors).toEqual([]);
  });

  it("keeps a verified survivor with an unknown name when the name probe fails", async () => {
    const probes = makeProbes({ 12: "t-vite" }, null);

    expect((await findSurvivors(identities, probes)).survivors).toEqual([{ pid: 12, name: null }]);
  });

  it("reports PIDs the start-time probe could not resolve", async () => {
    const probes = makeProbes({}, {}, [10, 11, 12]);

    expect(await findSurvivors(identities, probes)).toEqual({
      survivors: [],
      unresolved: [10, 11, 12],
    });
    expect(probes.probeNames).not.toHaveBeenCalled();
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
    const probes = makeProbes({ 11: "t-npm" }, { 11: { name: "npm", zombie: false } });

    await runSurvivorCheck("t1", "project-closed", new Map([[11, "t-npm"]]), probes);

    expect(warnMock).toHaveBeenCalledWith(
      "Terminal t1 left processes running after kill (reason: project-closed): 11(npm)"
    );
  });

  it("records a clean kill", async () => {
    const probes = makeProbes({}, {});

    await runSurvivorCheck("t1", "kill", new Map([[11, "t-npm"]]), probes);

    expect(warnMock).not.toHaveBeenCalled();
    expect(infoMock).toHaveBeenCalledWith(
      "Terminal t1 kill verified, no survivors among 1 target(s) (reason: kill)"
    );
  });

  it("warns instead of throwing when a probe fails", async () => {
    const probes: KillAuditProbes = {
      probeStartTimes: vi.fn(async () => {
        throw new Error("ps missing");
      }),
      probeNames: vi.fn(),
    };

    await expect(runSurvivorCheck("t1", "kill", new Map([[11, "x"]]), probes)).resolves.toBe(
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
    const probes = makeProbes(
      { 11: "t-npm", 12: "t-vite" },
      {
        11: { name: "npm", zombie: false },
        12: { name: "vite", zombie: false },
      }
    );

    scheduleSurvivorCheck("t1", "kill", () => identities, 4000, probes);
    identities.set(12, "t-vite");
    await vi.advanceTimersByTimeAsync(3999);
    expect(probes.probeStartTimes).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(probes.probeStartTimes).toHaveBeenCalledWith([11, 12]);
    expect(warnMock.mock.calls[0]?.[0]).toContain("11(npm),12(vite)");
  });
});
