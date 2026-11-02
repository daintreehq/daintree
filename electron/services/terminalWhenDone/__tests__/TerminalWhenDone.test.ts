import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendHandbackInstruction,
  buildHandbackInstruction,
} from "../../../../shared/utils/handback.js";
import type { TerminalWhenDoneChange } from "../../../../shared/types/ipc/terminalWhenDone.js";
import {
  TerminalWhenDone,
  TerminalWhenDoneError,
  type ArmedTerminal,
  type WhenDoneIncarnation,
  type WhenDoneOutcome,
} from "../TerminalWhenDone.js";

const SPAWNED_AT = 1_800_000_000_040;
const PROJECT = "project-1";
const TERMINAL = "terminal-1";

function setup(options: { outcome?: WhenDoneOutcome; hold?: boolean } = {}) {
  let generation: number | undefined = 4;
  let shuttingDown = false;
  let nextCode = 0;
  const incarnation: { value: WhenDoneIncarnation | null } = {
    value: { projectId: PROJECT, spawnedAt: SPAWNED_AT, launchGeneration: 4 },
  };
  const notified: TerminalWhenDoneChange[] = [];
  const submitted: Array<{ terminalId: string; text: string; code: string }> = [];
  const applied: ArmedTerminal[] = [];
  const active: boolean[] = [];
  const stillCurrent: Array<() => boolean> = [];
  // Reads held open by `holdReads`, answered in any order by `answerRead`.
  const heldReads: Array<(value: WhenDoneIncarnation | null) => void> = [];
  let holdReads = false;
  const apply = vi.fn((target: ArmedTerminal, current: () => boolean) => {
    applied.push(target);
    stillCurrent.push(current);
    // `hold` leaves the apply waiting, as one does on the views' answers.
    if (options.hold) return new Promise<WhenDoneOutcome>(() => {});
    return Promise.resolve(options.outcome ?? "applied");
  });
  const service = new TerminalWhenDone({
    readIncarnation: () =>
      holdReads
        ? new Promise<WhenDoneIncarnation | null>((resolve) => heldReads.push(resolve))
        : Promise.resolve(incarnation.value),
    currentGeneration: () => generation,
    submitInstruction: (terminalId, text, code) => submitted.push({ terminalId, text, code }),
    notify: (_projectId, change) => notified.push(change),
    apply,
    isShuttingDown: () => shuttingDown,
    onActiveChange: (value) => active.push(value),
    mintCode: () => `code0${nextCode++}`,
    logWarn: () => {},
  });
  return {
    service,
    notified,
    submitted,
    applied,
    apply,
    active,
    stillCurrent,
    incarnation,
    holdReads: () => {
      holdReads = true;
    },
    answerRead: (index: number) => heldReads[index]?.(incarnation.value),
    restart: (next: number | undefined) => {
      generation = next;
    },
    shutDown: () => {
      shuttingDown = true;
    },
  };
}

const done = (
  code: string,
  overrides: Partial<{ spawnedAt: number; terminalId: string }> = {}
) => ({
  terminalId: TERMINAL,
  spawnedAt: SPAWNED_AT,
  code,
  report: "done" as const,
  ...overrides,
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TerminalWhenDone arming (#16171)", () => {
  it("stores nothing for keep, the default", async () => {
    const { service, submitted, notified, active } = setup();
    await service.set(TERMINAL, "keep", PROJECT);
    expect(service.peek(TERMINAL)).toBeUndefined();
    expect(submitted).toEqual([]);
    expect(notified).toEqual([]);
    expect(active).toEqual([]);
  });

  it("sends the instruction with a fresh code as one message and shows the choice", async () => {
    const { service, submitted, notified, active } = setup();
    await service.set(TERMINAL, "close", PROJECT);

    expect(submitted).toEqual([
      { terminalId: TERMINAL, text: buildHandbackInstruction("code00", "run"), code: "code00" },
    ]);
    expect(service.peek(TERMINAL)).toMatchObject({ choice: "close", outstanding: "code00" });
    expect(notified).toEqual([{ terminalId: TERMINAL, choice: "close" }]);
    expect(active).toEqual([true]);
  });

  it("renews the request with a new code when chosen again", async () => {
    const { service, submitted } = setup();
    await service.set(TERMINAL, "background", PROJECT);
    await service.set(TERMINAL, "background", PROJECT);
    expect(submitted.map((entry) => entry.code)).toEqual(["code00", "code01"]);
    expect(service.peek(TERMINAL)?.outstanding).toBe("code01");
  });

  it("refuses a terminal with no running agent, or one in another project", async () => {
    const { service, incarnation, submitted } = setup();
    incarnation.value = null;
    await expect(service.set(TERMINAL, "close", PROJECT)).rejects.toBeInstanceOf(
      TerminalWhenDoneError
    );
    incarnation.value = { projectId: "other", spawnedAt: SPAWNED_AT, launchGeneration: 4 };
    await expect(service.set(TERMINAL, "close", PROJECT)).rejects.toBeInstanceOf(
      TerminalWhenDoneError
    );
    expect(submitted).toEqual([]);
  });

  it("arms nothing when the terminal restarted while its host answered", async () => {
    const { service, restart, submitted, holdReads, answerRead } = setup();
    holdReads();
    const pending = service.set(TERMINAL, "close", PROJECT);
    restart(5);
    answerRead(0);
    await expect(pending).rejects.toThrow(/restarted/);
    expect(service.peek(TERMINAL)).toBeUndefined();
    expect(submitted).toEqual([]);
  });

  it("commits nothing a later Keep overtook while the host answered", async () => {
    const { service, submitted, notified, holdReads, answerRead } = setup();
    holdReads();
    const pending = service.set(TERMINAL, "close", PROJECT);
    await service.set(TERMINAL, "keep", PROJECT);
    answerRead(0);
    await pending;

    expect(service.peek(TERMINAL)).toBeUndefined();
    expect(submitted).toEqual([]);
    expect(notified).toEqual([]);
  });

  it("arms nothing for a caller that stopped driving the project while the host answered", async () => {
    const { service, submitted, holdReads, answerRead } = setup();
    holdReads();
    let driving = true;
    const pending = service.set(TERMINAL, "close", PROJECT, () => driving);
    driving = false;
    answerRead(0);

    await expect(pending).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    expect(service.peek(TERMINAL)).toBeUndefined();
    expect(submitted).toEqual([]);
  });

  it("keeps the latest of two choices whose reads answer out of order", async () => {
    const { service, submitted, holdReads, answerRead } = setup();
    holdReads();
    const first = service.set(TERMINAL, "close", PROJECT);
    const second = service.set(TERMINAL, "background", PROJECT);
    answerRead(1);
    await second;
    answerRead(0);
    await first;

    expect(service.peek(TERMINAL)?.choice).toBe("background");
    expect(submitted).toHaveLength(1);
  });

  it("disarms on keep and tells the views", async () => {
    const { service, notified, active } = setup();
    await service.set(TERMINAL, "close", PROJECT);
    await service.set(TERMINAL, "keep", PROJECT);
    expect(service.peek(TERMINAL)).toBeUndefined();
    expect(notified.at(-1)).toEqual({ terminalId: TERMINAL, choice: "keep" });
    expect(active).toEqual([true, false]);
  });
});

describe("TerminalWhenDone submissions", () => {
  it("leaves a terminal that isn't armed as it was", () => {
    const { service } = setup();
    expect(service.decorate(TERMINAL, "fix the bug")).toBeNull();
  });

  it("gives every prompt its own fresh code, which becomes the outstanding request", async () => {
    const { service } = setup();
    await service.set(TERMINAL, "close", PROJECT);

    const first = service.decorate(TERMINAL, "fix the bug");
    const second = service.decorate(TERMINAL, "fix the bug");

    expect(first).toEqual({
      text: appendHandbackInstruction("fix the bug", "code01", "run"),
      handbackCode: "code01",
      handbackInstruction: "run",
    });
    expect(second?.handbackCode).toBe("code02");
    expect(service.peek(TERMINAL)?.outstanding).toBe("code02");
  });

  it("keeps a caller's own code and swaps its instruction for the one offering needs-you", async () => {
    const { service } = setup();
    await service.set(TERMINAL, "background", PROJECT);

    const armed = service.decorate(
      TERMINAL,
      appendHandbackInstruction("review the diff", "mcpcd1"),
      "mcpcd1"
    );

    expect(armed).toEqual({
      text: appendHandbackInstruction("review the diff", "mcpcd1", "run"),
      handbackCode: "mcpcd1",
      handbackInstruction: "run",
    });
    expect(service.peek(TERMINAL)?.outstanding).toBe("mcpcd1");
  });

  it("decorates no bare Enter or slash command, which supersede the outstanding request", async () => {
    const { service } = setup();
    await service.set(TERMINAL, "close", PROJECT);

    expect(service.decorate(TERMINAL, "")).toBeNull();
    expect(service.peek(TERMINAL)?.outstanding).toBeNull();

    service.decorate(TERMINAL, "go on");
    expect(service.decorate(TERMINAL, "  /compact")).toBeNull();
    expect(service.peek(TERMINAL)?.outstanding).toBeNull();
  });

  it("drops the choice the moment a submission finds a newer incarnation", async () => {
    const { service, restart, notified } = setup();
    await service.set(TERMINAL, "close", PROJECT);
    restart(5);

    expect(service.decorate(TERMINAL, "fix the bug")).toBeNull();
    expect(service.peek(TERMINAL)).toBeUndefined();
    expect(notified.at(-1)).toEqual({ terminalId: TERMINAL, choice: "keep" });
  });
});

describe("TerminalWhenDone reports", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    await ctx.service.set(TERMINAL, "close", PROJECT);
  });

  it("applies the choice on done for the outstanding code, once", async () => {
    ctx.service.handleReport(done("code00"));
    ctx.service.handleReport(done("code00"));
    await flush();

    expect(ctx.applied).toHaveLength(1);
    expect(ctx.applied[0]).toMatchObject({ terminalId: TERMINAL, choice: "close" });
  });

  it("never moves anything on needs-you, and the request is answered", async () => {
    ctx.service.handleReport({ ...done("code00"), report: "needs-you" });
    ctx.service.handleReport(done("code00"));
    await flush();

    expect(ctx.apply).not.toHaveBeenCalled();
    expect(ctx.service.peek(TERMINAL)).toMatchObject({ choice: "close", outstanding: null });
  });

  it("ignores a wrong code, an earlier request's code and another incarnation's report", async () => {
    ctx.service.decorate(TERMINAL, "next step");

    ctx.service.handleReport(done("zzzzzz"));
    // The arming request was superseded by the later prompt.
    ctx.service.handleReport(done("code00"));
    ctx.service.handleReport(done("code01", { spawnedAt: SPAWNED_AT + 1 }));
    ctx.service.handleReport(done("code01", { terminalId: "terminal-2" }));
    await flush();

    expect(ctx.apply).not.toHaveBeenCalled();
    expect(ctx.service.peek(TERMINAL)?.outstanding).toBe("code01");
  });

  it("acts on nothing after a restart, and drops the choice", async () => {
    ctx.restart(5);
    ctx.service.handleReport(done("code00"));
    await flush();

    expect(ctx.apply).not.toHaveBeenCalled();
    expect(ctx.service.peek(TERMINAL)).toBeUndefined();
  });

  it("stops a done being applied once newer work, another choice or a restart arrives", async () => {
    // Each apply is still waiting on the views when the change lands.
    async function applying() {
      const pending = setup({ hold: true });
      await pending.service.set(TERMINAL, "close", PROJECT);
      pending.service.handleReport(done("code00"));
      await flush();
      expect(pending.stillCurrent[0]?.()).toBe(true);
      return pending;
    }

    const prompted = await applying();
    prompted.service.decorate(TERMINAL, "and one more thing");
    expect(prompted.stillCurrent[0]?.()).toBe(false);

    const kept = await applying();
    await kept.service.set(TERMINAL, "keep", PROJECT);
    expect(kept.stillCurrent[0]?.()).toBe(false);

    // A new choice stops it the moment it is asked, before its own host read answers.
    const rearmed = await applying();
    rearmed.holdReads();
    void rearmed.service.set(TERMINAL, "background", PROJECT);
    expect(rearmed.stillCurrent[0]?.()).toBe(false);

    const restarted = await applying();
    restarted.restart(5);
    expect(restarted.stillCurrent[0]?.()).toBe(false);

    const quitting = await applying();
    quitting.shutDown();
    expect(quitting.stillCurrent[0]?.()).toBe(false);
  });

  it("moves nothing while Daintree is quitting", async () => {
    ctx.shutDown();
    ctx.service.handleReport(done("code00"));
    await flush();
    expect(ctx.apply).not.toHaveBeenCalled();
  });

  it("forgets a closed terminal's choice", async () => {
    ctx.service.handleReport(done("code00"));
    await flush();
    expect(ctx.service.peek(TERMINAL)).toBeUndefined();
    expect(ctx.active).toEqual([true, false]);
  });
});

describe("TerminalWhenDone outcomes", () => {
  it("keeps a backgrounded terminal armed for its next prompt", async () => {
    const { service, applied } = setup();
    await service.set(TERMINAL, "background", PROJECT);
    service.handleReport(done("code00"));
    await flush();

    expect(applied).toHaveLength(1);
    expect(service.peek(TERMINAL)).toMatchObject({ choice: "background", outstanding: null });
    expect(service.decorate(TERMINAL, "and the tests")?.handbackCode).toBe("code01");
  });

  it("leaves a pane someone is using where it is, without trying again later", async () => {
    const { service, apply } = setup({ outcome: "in-use" });
    await service.set(TERMINAL, "close", PROJECT);
    service.handleReport(done("code00"));
    service.handleReport(done("code00"));
    await flush();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(service.peek(TERMINAL)).toMatchObject({ choice: "close", outstanding: null });
  });
});

describe("TerminalWhenDone lifecycle", () => {
  it("drops the choice when the agent or its terminal exits, and only for that incarnation", async () => {
    const { service } = setup();
    await service.set(TERMINAL, "close", PROJECT);

    service.handleExit(TERMINAL, SPAWNED_AT - 1);
    expect(service.peek(TERMINAL)).toBeDefined();
    service.handleExit(TERMINAL, SPAWNED_AT);
    expect(service.peek(TERMINAL)).toBeUndefined();

    await service.set(TERMINAL, "close", PROJECT);
    service.handleExit(TERMINAL);
    expect(service.peek(TERMINAL)).toBeUndefined();
  });

  it("drops the choice when the host holding the incarnation dies", async () => {
    const { service } = setup();
    await service.set(TERMINAL, "background", PROJECT);
    service.handleIncarnationLost(TERMINAL, 3);
    expect(service.peek(TERMINAL)).toBeDefined();
    service.handleIncarnationLost(TERMINAL, 4);
    expect(service.peek(TERMINAL)).toBeUndefined();
  });

  it("lists a project's armed terminals, never one that restarted", async () => {
    const { service, restart } = setup();
    await service.set(TERMINAL, "background", PROJECT);
    expect(service.list(PROJECT)).toEqual([{ terminalId: TERMINAL, choice: "background" }]);
    expect(service.list("other")).toEqual([]);
    restart(5);
    expect(service.list(PROJECT)).toEqual([]);
  });
});

describe("TerminalWhenDone launch arming (#16172)", () => {
  const launch = (overrides: Partial<{ launchGeneration: number; code: string }> = {}) => ({
    terminalId: TERMINAL,
    projectId: PROJECT,
    launchGeneration: 4,
    choice: "close" as const,
    code: "launch",
    ...overrides,
  });
  const confirmed = { success: true, launchGeneration: 4, spawnedAt: SPAWNED_AT };

  it("sends nothing and holds the launch's own code as the outstanding request", () => {
    const { service, submitted, active } = setup();

    expect(service.armLaunch(launch())).toBe(true);

    expect(submitted).toEqual([]);
    expect(active).toEqual([true]);
    expect(service.peek(TERMINAL)).toMatchObject({ outstanding: "launch", spawnedAt: null });
  });

  it("shows as armed only once the host confirms the spawn, with the incarnation it names", () => {
    const { service, notified } = setup();
    service.armLaunch(launch());

    expect(service.list(PROJECT)).toEqual([]);
    expect(notified).toEqual([]);

    service.handleSpawnResult(TERMINAL, confirmed);

    expect(service.list(PROJECT)).toEqual([{ terminalId: TERMINAL, choice: "close" }]);
    expect(notified).toEqual([{ terminalId: TERMINAL, choice: "close" }]);
    expect(service.peek(TERMINAL)?.spawnedAt).toBe(SPAWNED_AT);
  });

  it("applies the choice when the launch prompt's code reports done", async () => {
    const { service, applied } = setup();
    service.armLaunch(launch());
    service.handleSpawnResult(TERMINAL, confirmed);

    service.handleReport(done("launch"));
    await flush();

    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ choice: "close", spawnedAt: SPAWNED_AT });
  });

  it("acts on no report before the spawn is confirmed", async () => {
    const { service, apply } = setup();
    service.armLaunch(launch());

    service.handleReport(done("launch"));
    await flush();

    expect(apply).not.toHaveBeenCalled();
    expect(service.peek(TERMINAL)?.outstanding).toBe("launch");
  });

  it("drops a launch whose spawn failed, silently and without touching listeners twice", () => {
    const { service, notified, active } = setup();
    service.armLaunch(launch());

    service.handleSpawnResult(TERMINAL, { success: false, launchGeneration: 4 });

    expect(service.peek(TERMINAL)).toBeUndefined();
    expect(notified).toEqual([]);
    expect(active).toEqual([true, false]);
  });

  it("ignores another generation's spawn result", () => {
    const { service } = setup();
    service.armLaunch(launch());

    service.handleSpawnResult(TERMINAL, { success: false, launchGeneration: 3 });
    service.handleSpawnResult(TERMINAL, { ...confirmed, launchGeneration: 3 });

    expect(service.peek(TERMINAL)).toMatchObject({ spawnedAt: null });
  });

  it("never takes over a terminal that already holds a choice, or one respawned since", async () => {
    const { service } = setup();
    await service.set(TERMINAL, "background", PROJECT);

    expect(service.armLaunch(launch())).toBe(false);
    expect(service.peek(TERMINAL)?.choice).toBe("background");

    const other = setup();
    other.restart(5);
    expect(other.service.armLaunch(launch())).toBe(false);
    expect(other.service.peek(TERMINAL)).toBeUndefined();
  });

  it("gives a prompt sent before confirmation its own code, superseding the launch's", async () => {
    const { service, apply } = setup();
    service.armLaunch(launch());

    expect(service.decorate(TERMINAL, "and then this")?.handbackCode).toBe("code00");
    service.handleSpawnResult(TERMINAL, confirmed);
    service.handleReport(done("launch"));
    await flush();

    expect(apply).not.toHaveBeenCalled();
    expect(service.peek(TERMINAL)?.outstanding).toBe("code00");
  });

  it("is dropped by an exit, a lost host or Keep before it is confirmed", async () => {
    const exited = setup();
    exited.service.armLaunch(launch());
    exited.service.handleExit(TERMINAL, SPAWNED_AT);
    expect(exited.service.peek(TERMINAL)).toBeUndefined();

    const lost = setup();
    lost.service.armLaunch(launch());
    lost.service.handleIncarnationLost(TERMINAL, 4);
    expect(lost.service.peek(TERMINAL)).toBeUndefined();

    const kept = setup();
    kept.service.armLaunch(launch());
    await kept.service.set(TERMINAL, "keep", PROJECT);
    expect(kept.service.peek(TERMINAL)).toBeUndefined();
    expect(kept.notified).toEqual([]);
  });
});
