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

function setup(options: { outcome?: WhenDoneOutcome } = {}) {
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
  const apply = vi.fn(async (target: ArmedTerminal) => {
    applied.push(target);
    return options.outcome ?? "applied";
  });
  const service = new TerminalWhenDone({
    readIncarnation: async () => incarnation.value,
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
    incarnation,
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
    const { service, restart, submitted } = setup();
    restart(5);
    await expect(service.set(TERMINAL, "close", PROJECT)).rejects.toThrow(/restarted/);
    expect(service.peek(TERMINAL)).toBeUndefined();
    expect(submitted).toEqual([]);
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
