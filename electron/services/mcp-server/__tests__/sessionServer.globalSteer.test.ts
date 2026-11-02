import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
}));

import { WORKER_STEER_REFUSALS } from "../../../../shared/types/assistantControl.js";
import { createSessionServer, type SessionServerDeps } from "../sessionServer.js";
import { RESOURCE_NOT_OWNED_CODE } from "../shared.js";
import { GlobalWorkerSteer, type WorkerSteerRecord } from "../../assistants/GlobalWorkerSteer.js";
import { stampTypedInput } from "../../../../shared/utils/terminalInputProvenance.js";
import { SessionStore } from "../sessionStore.js";
import {
  callTool,
  fakeDeps,
  makeManifestEntry,
  makeMockTransport,
  toolErrorPayload,
} from "./helpers/sessionServerFixture.js";

/**
 * The global Assistant steering a worker it didn't launch (#14551), through
 * the target host's real session gate and a real steer over a fake pty-host,
 * for a relayed call from this machine's global Assistant and from another
 * machine's.
 */

const SESSION = "relay-session";
const PROJECT = "proj-1";
const WORKER = "term-worker";
const SHELL = "term-shell";
const MINE = "term-mine";
const HANDED = "term-handed";

const TOOLS = [
  "terminal.sendCommandOwned",
  "terminal.sendKeysOwned",
  "terminal.interruptOwned",
  "terminal.revealOwned",
  "terminal.closeOwned",
  "terminal.restartOnPresetOwned",
  "terminal.injectOwned",
];

const LANES = [
  { lane: "local", shellName: "this machine" },
  { lane: "remote", shellName: "studio-01" },
] as const;

function atPrompt(extra: Partial<WorkerSteerRecord> = {}): WorkerSteerRecord {
  return {
    projectId: PROJECT,
    detectedAgentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    lastStateChange: 1_000,
    hasPty: true,
    ...extra,
  };
}

const stores: SessionStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.drain();
    store.grantCache.dispose();
  }
});

function harness(options: {
  shellName: string;
  global: boolean;
  tier?: "core" | "full";
  refuseWrite?: { code: string; message: string } | null;
}) {
  const records = new Map<string, WorkerSteerRecord>([
    [WORKER, atPrompt()],
    [SHELL, atPrompt({ detectedAgentId: undefined, agentState: "idle" })],
    [MINE, atPrompt()],
    [HANDED, atPrompt()],
  ]);
  const generations = new Map<string, number>([
    [WORKER, 4],
    [SHELL, 2],
    [MINE, 1],
    [HANDED, 3],
  ]);
  const pty = {
    submit: vi.fn(),
    write: vi.fn(),
    doubleEscape: vi.fn(),
  };
  let clock = 2_000;
  const steer = new GlobalWorkerSteer({
    getTerminalProjectId: (id) => (records.has(id) ? PROJECT : null),
    getLiveGeneration: (id) => generations.get(id) ?? null,
    isAssistantTerminal: () => false,
    getTerminal: async (id) => {
      const record = records.get(id);
      return record ? { ...record } : null;
    },
    serializedState: async () => ({ data: "❯ 1. Yes\n  2. No" }),
    submit: pty.submit,
    write: (id, data, inputOwner) => {
      pty.write(id, data, inputOwner);
      const record = records.get(id);
      if (record) stampTypedInput(record, ++clock, inputOwner);
    },
    doubleEscape: pty.doubleEscape,
    sleep: async () => {},
  });
  const store = new SessionStore(() => {});
  stores.push(store);
  store.sessionTierMap.set(SESSION, options.tier ?? "core");
  store.sessionOriginMap.set(SESSION, "external");
  store.sessionWorkspaceMap.set(SESSION, PROJECT);
  // Held under the relay principal, as `openRelaySession` binds one.
  store.resourceOwnership.bindPrincipal(SESSION, "relay-principal");
  const owner = store.resourceOwnership.ownerOf(SESSION);
  store.resourceOwnership.record(owner, [{ kind: "terminal", id: MINE }]);
  store.terminalAdoption.adopt({
    terminalId: HANDED,
    orchestratorPaneId: "pane-1",
    principalId: "relay-principal",
  });
  const refuseWrite = vi.fn(() => options.refuseWrite ?? null);
  const deps = fakeDeps({
    sessionStore: store,
    requestManifest: vi.fn().mockResolvedValue(TOOLS.map(makeManifestEntry)),
    dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result: { ran: true } } }),
    relay: {
      shellName: options.shellName,
      ...(options.global ? { global: true as const } : {}),
      refuseWrite,
    },
    // A project assistant's session is handed no steer; the gate must not
    // need its absence to refuse, so both are given one here.
    globalSteer: steer,
  });
  return { deps, store, pty, records, generations, refuseWrite };
}

/** Live as `openRelaySession` leaves one: the relay holds its transport. */
/** A success's answer, as its text carries it: the stub manifest declares no output schema. */
function answerOf(result: { content: unknown }): unknown {
  const [first] = result.content as Array<{ text: string }>;
  return JSON.parse(first!.text);
}

async function serve(deps: SessionServerDeps) {
  const server = createSessionServer(SESSION, deps);
  const transport = makeMockTransport();
  deps.sessionStore.relaySessions.set(SESSION, { transport, server } as never);
  await server.connect(transport);
  return server;
}

describe.each(LANES)("a global Assistant's relayed call ($lane) (#14551)", ({ shellName }) => {
  it("prompts, keys and interrupts a worker it didn't launch, in main", async () => {
    const { deps, store, pty, records } = harness({ shellName, global: true });
    const server = await serve(deps);

    const sent = await callTool(server, {
      name: "terminal.sendCommandOwned",
      arguments: { terminalId: WORKER, command: "Rebase onto develop", generation: 4 },
    });
    expect(sent.isError).toBeFalsy();
    expect(answerOf(sent)).toMatchObject({ sent: true, terminalId: WORKER });
    expect(pty.submit).toHaveBeenCalledTimes(1);
    const [, text] = pty.submit.mock.calls[0]!;
    expect(text).toContain(`From the Daintree Assistant on ${shellName}`);

    records.set(WORKER, atPrompt({ waitingReason: "approval" }));
    const keyed = await callTool(server, {
      name: "terminal.sendKeysOwned",
      arguments: { terminalId: WORKER, keys: ["1", "Enter"], generation: 4 },
    });
    expect(keyed.isError).toBeFalsy();
    expect(answerOf(keyed)).toMatchObject({ terminalId: WORKER, keys: ["1", "Enter"] });
    expect(pty.write.mock.calls.map(([, data]) => data)).toEqual(["1", "\r"]);

    records.set(WORKER, atPrompt({ agentState: "working", waitingReason: undefined }));
    const interrupted = await callTool(server, {
      name: "terminal.interruptOwned",
      arguments: { terminalId: WORKER, generation: 4 },
    });
    expect(interrupted.isError).toBeFalsy();
    expect(pty.doubleEscape).toHaveBeenCalledWith(WORKER, store.resourceOwnership.ownerOf(SESSION));

    // Nothing reached a view, and steering it handed over nothing.
    expect(deps.dispatchAction).not.toHaveBeenCalled();
    expect(store.resourceOwnership.creatorOf("terminal", WORKER)).toBeUndefined();
    expect(
      store.terminalAdoption.get(store.resourceOwnership.ownerOf(SESSION), WORKER)
    ).toBeUndefined();
  });

  it("files its keys under its principal, so its next keys aren't someone's (#16094)", async () => {
    const { deps, pty, records, store } = harness({ shellName, global: true });
    records.set(WORKER, atPrompt());
    const server = await serve(deps);
    const press = () =>
      callTool(server, {
        name: "terminal.sendKeysOwned",
        arguments: { terminalId: WORKER, keys: ["Escape"], generation: 4 },
      });

    const first = await press();
    const second = await press();

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(answerOf(second)).toMatchObject({ keys: ["Escape"], inputSinceSettle: "own-keys" });
    // The principal, not the session: a reconnected session is the same assistant.
    const owner = store.resourceOwnership.ownerOf(SESSION);
    expect(owner).not.toBe(SESSION);
    expect(pty.write.mock.calls.map(([, , inputOwner]) => inputOwner)).toEqual([owner, owner]);

    const sent = await callTool(server, {
      name: "terminal.sendCommandOwned",
      arguments: { terminalId: WORKER, command: "go", generation: 4 },
    });
    expect(sent.isError).toBe(true);
    expect(JSON.stringify(sent.content)).toContain("keys you sent");
    expect(pty.submit).not.toHaveBeenCalled();
  });

  it("runs a fixed slash form unstamped and refuses any other, in main (#16101)", async () => {
    const { deps, pty, records } = harness({ shellName, global: true });
    records.set(WORKER, atPrompt({ detectedAgentId: "codex" }));
    const server = await serve(deps);

    const resumed = await callTool(server, {
      name: "terminal.sendCommandOwned",
      arguments: { terminalId: WORKER, command: "/goal resume", generation: 4 },
    });
    expect(resumed.isError).toBeFalsy();
    expect(answerOf(resumed)).toMatchObject({ sent: true, command: "/goal resume" });
    expect(pty.submit).toHaveBeenCalledWith(
      WORKER,
      "/goal resume",
      expect.any(String),
      undefined,
      null
    );

    const cleared = await callTool(server, {
      name: "terminal.sendCommandOwned",
      arguments: { terminalId: WORKER, command: "/clear", generation: 4 },
    });
    expect(toolErrorPayload(cleared).code).toBe(WORKER_STEER_REFUSALS.commandNotAllowed);
    // The caller hears the steer's own code; the audit files it as a restriction.
    expect(vi.mocked(deps.appendAuditRecord).mock.calls.at(-1)![0]).toMatchObject({
      toolId: "terminal.sendCommandOwned",
      outcome: { kind: "result", value: { ok: false, error: { code: "RESTRICTED" } } },
    });

    expect(pty.submit).toHaveBeenCalledTimes(1);
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("refuses a plain shell, a restarted run and a terminal someone typed into", async () => {
    const { deps, pty, records, generations } = harness({ shellName, global: true });
    const server = await serve(deps);

    const shell = await callTool(server, {
      name: "terminal.sendKeysOwned",
      arguments: { terminalId: SHELL, keys: ["Enter"], generation: 2 },
    });
    expect(toolErrorPayload(shell).code).toBe(WORKER_STEER_REFUSALS.notAgent);

    generations.set(WORKER, 5);
    const restarted = await callTool(server, {
      name: "terminal.sendCommandOwned",
      arguments: { terminalId: WORKER, command: "go on", generation: 4 },
    });
    expect(toolErrorPayload(restarted).code).toBe(WORKER_STEER_REFUSALS.restarted);

    generations.set(WORKER, 4);
    records.set(WORKER, atPrompt({ lastTypedInputAt: 1_200 }));
    for (const [name, args] of [
      ["terminal.sendCommandOwned", { command: "go on" }],
      ["terminal.sendKeysOwned", { keys: ["Enter"] }],
      ["terminal.interruptOwned", {}],
    ] as const) {
      if (name === "terminal.interruptOwned") {
        records.set(
          WORKER,
          atPrompt({ agentState: "working", waitingReason: undefined, lastTypedInputAt: 1_200 })
        );
      }
      const typed = await callTool(server, {
        name,
        arguments: { terminalId: WORKER, generation: 4, ...args },
      });
      expect(toolErrorPayload(typed).code, name).toBe(WORKER_STEER_REFUSALS.typing);
    }

    expect(pty.submit).not.toHaveBeenCalled();
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.doubleEscape).not.toHaveBeenCalled();
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("still refuses to close, restart or inject into a worker it didn't launch", async () => {
    const { deps, pty } = harness({ shellName, global: true, tier: "full" });
    const server = await serve(deps);

    for (const name of [
      "terminal.closeOwned",
      "terminal.restartOnPresetOwned",
      "terminal.injectOwned",
    ]) {
      const result = await callTool(server, {
        name,
        arguments: { terminalId: WORKER, generation: 4, presetId: "default" },
      });
      expect(toolErrorPayload(result).code, name).toBe(RESOURCE_NOT_OWNED_CODE);
    }
    expect(deps.dispatchAction).not.toHaveBeenCalled();
    expect(pty.doubleEscape).not.toHaveBeenCalled();
  });

  it.each([
    ["launched", MINE],
    ["was handed", HANDED],
  ])(
    "sends any slash command to what it %s verbatim, on the owned path",
    async (_how, terminalId) => {
      const { deps, pty } = harness({ shellName, global: true });
      const server = await serve(deps);

      // A form the steer would run and one it would refuse take the same path.
      for (const command of ["/compact", "/clear"]) {
        const result = await callTool(server, {
          name: "terminal.sendCommandOwned",
          arguments: { terminalId, command },
        });

        expect(result.isError, command).toBeFalsy();
        expect(deps.dispatchAction).toHaveBeenLastCalledWith(
          "terminal.sendCommand",
          expect.objectContaining({ terminalId, command }),
          expect.anything()
        );
      }
      expect(pty.submit).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["launched", MINE],
    ["was handed", HANDED],
  ])("keeps what it %s on the owned path, unchanged", async (_how, terminalId) => {
    const { deps, pty } = harness({ shellName, global: true });
    const server = await serve(deps);

    const result = await callTool(server, {
      name: "terminal.sendKeysOwned",
      arguments: { terminalId, keys: ["Enter"] },
    });

    expect(result.isError).toBeFalsy();
    expect(deps.dispatchAction).toHaveBeenCalledWith(
      "terminal.sendKeys",
      expect.objectContaining({ terminalId, keys: ["Enter"] }),
      expect.anything()
    );
    expect(pty.write).not.toHaveBeenCalled();
  });

  it("answers to the host's drive rule before anything is written", async () => {
    const { deps, pty, refuseWrite } = harness({
      shellName,
      global: true,
      refuseWrite: { code: "DRIVEN_ELSEWHERE", message: "Another machine drives it." },
    });
    const server = await serve(deps);

    const result = await callTool(server, {
      name: "terminal.sendKeysOwned",
      arguments: { terminalId: WORKER, keys: ["Enter"], generation: 4 },
    });

    expect(toolErrorPayload(result).code).toBe("DRIVEN_ELSEWHERE");
    expect(refuseWrite).toHaveBeenCalledWith(PROJECT);
    expect(pty.write).not.toHaveBeenCalled();
  });
});

describe.each(LANES)("a global Assistant's relayed reveal ($lane) (#16096)", ({ shellName }) => {
  const reveal = (terminalId: string, extra: Record<string, unknown> = {}) => ({
    name: "terminal.revealOwned",
    arguments: { terminalId, ...extra },
  });

  it("shows the person a worker it didn't launch, with someone typing into it, and takes nothing", async () => {
    const { deps, store, pty, records } = harness({ shellName, global: true });
    records.set(WORKER, atPrompt({ lastTypedInputAt: 1_500, hasPendingSubmission: true }));
    const server = await serve(deps);

    const result = await callTool(
      server,
      // A destination of its own is never forwarded: the run is in this project.
      reveal(WORKER, { generation: 4, workspaceId: "proj-elsewhere", runId: SHELL })
    );

    expect(result.isError).toBeFalsy();
    expect(deps.dispatchAction).toHaveBeenCalledTimes(1);
    expect(deps.dispatchAction).toHaveBeenCalledWith(
      "pilot.openRun",
      { runId: WORKER, workspaceId: PROJECT },
      false
    );
    expect(store.resourceOwnership.creatorOf("terminal", WORKER)).toBeUndefined();
    expect(
      store.terminalAdoption.get(store.resourceOwnership.ownerOf(SESSION), WORKER)
    ).toBeUndefined();
    expect(pty.submit).not.toHaveBeenCalled();
    expect(pty.write).not.toHaveBeenCalled();
  });

  it("refuses what a prompt can't reach, and shows nothing", async () => {
    const { deps, records, generations } = harness({ shellName, global: true });
    const server = await serve(deps);

    const shell = await callTool(server, reveal(SHELL, { generation: 2 }));
    expect(toolErrorPayload(shell).code).toBe(WORKER_STEER_REFUSALS.notAgent);

    const unnamed = await callTool(server, reveal(WORKER));
    expect(toolErrorPayload(unnamed).code).toBe("VALIDATION_ERROR");
    expect(toolErrorPayload(unnamed).message).toContain("incarnation");

    generations.set(WORKER, 5);
    const restarted = await callTool(server, reveal(WORKER, { generation: 4 }));
    expect(toolErrorPayload(restarted).code).toBe(WORKER_STEER_REFUSALS.restarted);

    generations.set(WORKER, 4);
    records.set(WORKER, atPrompt({ isExited: true }));
    const exited = await callTool(server, reveal(WORKER, { generation: 4 }));
    expect(toolErrorPayload(exited).code).toBe(WORKER_STEER_REFUSALS.notAgent);
    expect(toolErrorPayload(exited).message).toContain("Nothing was shown.");

    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it.each([
    ["launched", MINE],
    ["was handed", HANDED],
  ])("keeps what it %s on the owned reveal, with no generation", async (_how, terminalId) => {
    const { deps } = harness({ shellName, global: true });
    const server = await serve(deps);

    const result = await callTool(server, reveal(terminalId));

    expect(result.isError).toBeFalsy();
    expect(deps.dispatchAction).toHaveBeenCalledWith(
      "pilot.openRun",
      { runId: terminalId, workspaceId: PROJECT },
      false
    );
  });

  it("answers to the host's drive rule before anything is shown", async () => {
    const { deps, refuseWrite } = harness({
      shellName,
      global: true,
      refuseWrite: { code: "DRIVEN_ELSEWHERE", message: "Another machine drives it." },
    });
    const server = await serve(deps);

    const result = await callTool(server, reveal(WORKER, { generation: 4 }));

    expect(toolErrorPayload(result).code).toBe("DRIVEN_ELSEWHERE");
    expect(refuseWrite).toHaveBeenCalledWith(PROJECT);
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });
});

describe.each(LANES)("a project assistant's relayed call ($lane) (#14551)", ({ shellName }) => {
  it("gains nothing: the same tools on the same worker are refused as not its own", async () => {
    const { deps, pty } = harness({ shellName, global: false });
    const server = await serve(deps);

    for (const [name, args] of [
      ["terminal.sendCommandOwned", { command: "go on" }],
      ["terminal.sendKeysOwned", { keys: ["Enter"] }],
      ["terminal.interruptOwned", {}],
      ["terminal.revealOwned", {}],
    ] as const) {
      // Naming itself global in its arguments changes nothing.
      const result = await callTool(server, {
        name,
        arguments: { terminalId: WORKER, generation: 4, global: true, ...args },
      });
      expect(toolErrorPayload(result).code, name).toBe(RESOURCE_NOT_OWNED_CODE);
    }
    expect(pty.submit).not.toHaveBeenCalled();
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.doubleEscape).not.toHaveBeenCalled();
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });
});
