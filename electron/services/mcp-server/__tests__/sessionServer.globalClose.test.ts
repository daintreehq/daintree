import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
}));

import { createSessionServer, type SessionServerDeps } from "../sessionServer.js";
import {
  CONFIRMATION_REQUIRED_CODE,
  CONFIRMATION_TIMEOUT_CODE,
  RELAY_CALL_ID_META_KEY,
  RESOURCE_NOT_OWNED_CODE,
  USER_REJECTED_CODE,
} from "../shared.js";
import { GlobalWorkerSteer, type WorkerSteerRecord } from "../../assistants/GlobalWorkerSteer.js";
import type { ViewlessApprovalDecision } from "../../viewless/index.js";
import { SessionStore } from "../sessionStore.js";
import {
  callTool,
  fakeDeps,
  makeManifestEntry,
  makeMockTransport,
  toolErrorPayload,
} from "./helpers/sessionServerFixture.js";

/**
 * The global Assistant closing a finished agent it didn't launch (#16750),
 * through the target host's real session gate and a real steer's read of the
 * agent over a fake pty-host, with the calling Shell's answer stubbed.
 */

const SESSION = "relay-session";
const PROJECT = "proj-1";
const CALL_ID = "call-1";
const WORKER = "term-worker";
const OTHER = "term-other";
const SHELL = "term-shell";
const MINE = "term-mine";
const ASSISTANT = "term-assistant";

const TOOLS = ["terminal.closeOwned", "terminal.closeMany"];

const EDGE = "────────";
/** A Claude Code screen with its framed input box holding `box`. */
function claudeScreen(box: string): string {
  return `⏺ Done.\r\n${EDGE}\r\n${box}\r\n${EDGE}\r\n  ? for shortcuts`;
}
const EMPTY_BOX = claudeScreen("❯ ");
const TYPED_BOX = claudeScreen("❯ also fix the lint");
const SUGGESTION_BOX = claudeScreen("❯ \x1b[2mopen the PR\x1b[22m");

function atPrompt(extra: Partial<WorkerSteerRecord> = {}): WorkerSteerRecord {
  return {
    projectId: PROJECT,
    detectedAgentId: "claude",
    agentState: "waiting",
    title: "Fix the flaky test",
    lastStateChange: 1_000,
    hasPty: true,
    ...extra,
  };
}

const APPROVED: ViewlessApprovalDecision = {
  decision: "approved",
  deadline: Number.MAX_SAFE_INTEGER,
};
const SKIPPED: ViewlessApprovalDecision = {
  decision: "approved",
  deadline: Number.MAX_SAFE_INTEGER,
  authorization: "skip-preference",
};

const stores: SessionStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.drain();
    store.grantCache.dispose();
  }
});

function harness(
  options: {
    global?: boolean;
    answer?: ViewlessApprovalDecision;
    refuseWrite?:
      { code: string; message: string } | (() => { code: string; message: string } | null);
  } = {}
) {
  const records = new Map<string, WorkerSteerRecord>([
    [WORKER, atPrompt()],
    [OTHER, atPrompt({ agentState: "completed" })],
    [SHELL, atPrompt({ detectedAgentId: undefined, agentState: "idle" })],
    [MINE, atPrompt()],
    [ASSISTANT, atPrompt()],
  ]);
  const screens = new Map<string, string>([
    [WORKER, EMPTY_BOX],
    [OTHER, EMPTY_BOX],
    [SHELL, "$ "],
    [MINE, EMPTY_BOX],
    [ASSISTANT, EMPTY_BOX],
  ]);
  const generations = new Map<string, number>([
    [WORKER, 4],
    [OTHER, 2],
    [SHELL, 1],
    [MINE, 1],
    [ASSISTANT, 1],
  ]);
  const steer = new GlobalWorkerSteer({
    getTerminalProjectId: (id) => (records.has(id) ? PROJECT : null),
    getLiveGeneration: (id) => generations.get(id) ?? null,
    isAssistantTerminal: (id) => id === ASSISTANT,
    getTerminal: async (id) => {
      const record = records.get(id);
      return record ? { ...record } : null;
    },
    serializedState: async (id) => {
      const data = screens.get(id);
      return data === undefined ? null : { data };
    },
    submit: vi.fn(),
    write: vi.fn(),
    doubleEscape: vi.fn(),
    sleep: async () => {},
  });
  const store = new SessionStore(() => {}, {
    launchGenerationOf: (id) => generations.get(id) ?? null,
  });
  stores.push(store);
  store.sessionTierMap.set(SESSION, "core");
  store.sessionOriginMap.set(SESSION, "external");
  store.sessionWorkspaceMap.set(SESSION, PROJECT);
  store.resourceOwnership.bindPrincipal(SESSION, "relay-principal");
  const owner = store.resourceOwnership.ownerOf(SESSION);
  store.resourceOwnership.record(owner, [{ kind: "terminal", id: MINE }]);
  const askClose = vi.fn(
    async (
      _callId: string,
      _ask: Parameters<NonNullable<NonNullable<SessionServerDeps["relay"]>["askClose"]>>[1]
    ): Promise<ViewlessApprovalDecision> => options.answer ?? APPROVED
  );
  const dispatchAction = vi.fn(async (_id: string, args: unknown) => ({
    result: {
      ok: true as const,
      result: { closedIds: [(args as { terminalId: string }).terminalId] },
    },
  }));
  const deps = fakeDeps({
    sessionStore: store,
    requestManifest: vi.fn().mockResolvedValue(TOOLS.map(makeManifestEntry)),
    dispatchAction: dispatchAction as unknown as SessionServerDeps["dispatchAction"],
    relay: {
      shellName: "studio-01",
      ...(options.global !== false ? { global: true as const } : {}),
      refuseWrite: () =>
        typeof options.refuseWrite === "function"
          ? options.refuseWrite()
          : (options.refuseWrite ?? null),
      askClose,
    },
    globalSteer: steer,
    terminalGenerationOf: (id) => generations.get(id),
  });
  return { deps, store, owner, records, screens, generations, askClose, dispatchAction };
}

async function serve(deps: SessionServerDeps) {
  const server = createSessionServer(SESSION, deps);
  const transport = makeMockTransport();
  deps.sessionStore.relaySessions.set(SESSION, { transport, server } as never);
  await server.connect(transport);
  return server;
}

/** A relayed call, as `openRelaySession` sends one: under its Shell's callId. */
function relayed(name: string, args: Record<string, unknown>) {
  return { name, arguments: args, _meta: { [RELAY_CALL_ID_META_KEY]: CALL_ID } } as {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/** A batch's per-item answers, as its text carries them. */
function batchAnswer(result: { content: unknown }): {
  results: Array<{ target: string; ok: boolean; error?: { code?: string } }>;
} {
  const [first] = result.content as Array<{ text: string }>;
  return JSON.parse(first!.text);
}

describe("the global Assistant closing an agent it didn't launch (#16750)", () => {
  it("trashes a palette-launched agent waiting at its prompt once the Shell approves", async () => {
    const { deps, store, owner, askClose, dispatchAction } = harness();
    const server = await serve(deps);

    const result = await callTool(server, relayed("terminal.closeOwned", { terminalId: WORKER }));

    expect(result.isError).toBeFalsy();
    expect(askClose).toHaveBeenCalledTimes(1);
    const [callId, ask] = askClose.mock.calls[0]!;
    expect(callId).toBe(CALL_ID);
    expect(ask).toMatchObject({
      actionId: "terminal.close",
      args: { terminalId: WORKER },
      subject: "Fix the flaky test",
      closeClass: "handback",
    });
    expect(ask.lines.join("\n")).toContain(WORKER);
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(dispatchAction.mock.calls[0]![0]).toBe("terminal.close");
    expect(dispatchAction.mock.calls[0]![1]).toEqual({ terminalId: WORKER });
    // Nothing of it is the assistant's: no record released, no wait gained.
    expect(store.resourceOwnership.get(owner, "terminal", WORKER)).toBeUndefined();
    expect(store.resourceOwnership.closedRecord(owner, WORKER)).toBeUndefined();
    expect(store.resourceOwnership.get(owner, "terminal", MINE)).toBeDefined();
    expect(deps.appendAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "terminal.closeOwned",
        admission: "global-close",
        confirmationDecision: "approved",
      })
    );
  });

  it("closes a finished agent without asking anyone when the Shell's preference skips", async () => {
    const { deps, dispatchAction } = harness({ answer: SKIPPED });
    const server = await serve(deps);

    const result = await callTool(server, relayed("terminal.closeOwned", { terminalId: OTHER }));

    expect(result.isError).toBeFalsy();
    expect(dispatchAction).toHaveBeenCalledWith(
      "terminal.close",
      { terminalId: OTHER },
      false,
      "skip-preference",
      CALL_ID
    );
    expect(deps.appendAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ admission: "global-close", authorization: "skip-preference" })
    );
  });

  it("closes one whose input box holds only the CLI's own suggestion", async () => {
    const { deps, screens, dispatchAction } = harness();
    screens.set(WORKER, SUGGESTION_BOX);
    const server = await serve(deps);

    const result = await callTool(server, relayed("terminal.closeOwned", { terminalId: WORKER }));

    expect(result.isError).toBeFalsy();
    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("closes nothing once the answer's time has run out", async () => {
    const { deps, dispatchAction } = harness({
      answer: { decision: "approved", deadline: Date.now() - 1 },
    });
    const server = await serve(deps);

    const result = await callTool(server, relayed("terminal.closeOwned", { terminalId: WORKER }));

    expect(toolErrorPayload(result).code).toBe(CONFIRMATION_TIMEOUT_CODE);
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("answers a project driven elsewhere alike for every id, before reading any", async () => {
    const { deps, askClose, dispatchAction } = harness({
      refuseWrite: { code: "DRIVEN_ELSEWHERE", message: "Another machine drives this project." },
    });
    const server = await serve(deps);

    const eligible = await callTool(server, relayed("terminal.closeOwned", { terminalId: WORKER }));
    const missing = await callTool(
      server,
      relayed("terminal.closeOwned", { terminalId: "term-nope" })
    );

    expect(toolErrorPayload(eligible)).toEqual(toolErrorPayload(missing));
    expect(toolErrorPayload(eligible).code).toBe("DRIVEN_ELSEWHERE");
    expect(askClose).not.toHaveBeenCalled();
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("asks nobody once the drive moves while the agent is read, alike for every id", async () => {
    let checks = 0;
    const { deps, askClose, dispatchAction } = harness({
      // Free for the first check of each call, taken by the second.
      refuseWrite: () =>
        ++checks % 2 === 1
          ? null
          : { code: "DRIVEN_ELSEWHERE", message: "Another machine drives this project." },
    });
    const server = await serve(deps);

    const eligible = await callTool(server, relayed("terminal.closeOwned", { terminalId: WORKER }));
    const missing = await callTool(
      server,
      relayed("terminal.closeOwned", { terminalId: "term-nope" })
    );

    expect(toolErrorPayload(eligible).code).toBe("DRIVEN_ELSEWHERE");
    expect(toolErrorPayload(missing)).toEqual(toolErrorPayload(eligible));
    expect(askClose).not.toHaveBeenCalled();
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("settles a record its own launch of the very run made while it asked", async () => {
    const h = harness();
    h.askClose.mockImplementationOnce(async () => {
      h.store.resourceOwnership.record(h.owner, [{ kind: "terminal", id: WORKER }]);
      h.store.workerCreations.note(h.owner, [WORKER]);
      return APPROVED;
    });
    const server = await serve(h.deps);

    const result = await callTool(server, relayed("terminal.closeOwned", { terminalId: WORKER }));

    expect(result.isError).toBeFalsy();
    expect(h.store.resourceOwnership.get(h.owner, "terminal", WORKER)).toBeUndefined();
    expect(h.store.resourceOwnership.closedRecord(h.owner, WORKER)?.launchGeneration).toBe(4);
  });

  it("leaves a record it can't tie to the run it closed", async () => {
    const h = harness();
    h.askClose.mockImplementationOnce(async () => {
      h.store.resourceOwnership.record(h.owner, [{ kind: "terminal", id: WORKER }]);
      return APPROVED;
    });
    const server = await serve(h.deps);

    await callTool(server, relayed("terminal.closeOwned", { terminalId: WORKER }));

    expect(h.store.resourceOwnership.get(h.owner, "terminal", WORKER)).toBeDefined();
    expect(h.store.resourceOwnership.closedRecord(h.owner, WORKER)).toBeUndefined();
  });

  it("puts an agent stopped on an error to the person, and no skip closes it", async () => {
    const { deps, records, askClose, dispatchAction } = harness({ answer: SKIPPED });
    records.set(WORKER, atPrompt({ waitingReason: "error" }));
    const server = await serve(deps);

    const skipped = await callTool(server, relayed("terminal.closeOwned", { terminalId: WORKER }));

    expect(askClose.mock.calls[0]![1].closeClass).toBe("requires-person");
    expect(toolErrorPayload(skipped).code).toBe(CONFIRMATION_REQUIRED_CODE);
    expect(dispatchAction).not.toHaveBeenCalled();

    askClose.mockResolvedValueOnce(APPROVED);
    const approved = await callTool(server, relayed("terminal.closeOwned", { terminalId: WORKER }));
    expect(approved.isError).toBeFalsy();
    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["working", { agentState: "working" as const }, EMPTY_BOX],
    ["waiting on an approval", { waitingReason: "approval" as const }, EMPTY_BOX],
    ["waiting on a question", { waitingReason: "question" as const }, EMPTY_BOX],
    ["idle", { agentState: "idle" as const }, EMPTY_BOX],
    ["holding a typed draft", {}, TYPED_BOX],
    ["with a submission still going in", { hasPendingSubmission: true }, EMPTY_BOX],
    ["with an unreadable input box", {}, "$ "],
  ])(
    "refuses an agent %s as the ledger refuses an id it doesn't hold",
    async (_why, extra, screen) => {
      const { deps, records, screens, askClose, dispatchAction } = harness();
      records.set(WORKER, atPrompt(extra));
      screens.set(WORKER, screen);
      const server = await serve(deps);

      const refused = await callTool(
        server,
        relayed("terminal.closeOwned", { terminalId: WORKER })
      );
      const missing = await callTool(
        server,
        relayed("terminal.closeOwned", { terminalId: "term-nope" })
      );

      expect(toolErrorPayload(refused).code).toBe(RESOURCE_NOT_OWNED_CODE);
      // One refusal for every miss: nothing tells a finished agent apart from no agent.
      expect(toolErrorPayload(refused).message.replace(WORKER, "<id>")).toBe(
        toolErrorPayload(missing).message.replace("term-nope", "<id>")
      );
      expect(askClose).not.toHaveBeenCalled();
      expect(dispatchAction).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["a plain shell", SHELL],
    ["an assistant", ASSISTANT],
  ])("refuses %s without asking", async (_what, terminalId) => {
    const { deps, askClose, dispatchAction } = harness();
    const server = await serve(deps);

    const refused = await callTool(server, relayed("terminal.closeOwned", { terminalId }));

    expect(toolErrorPayload(refused).code).toBe(RESOURCE_NOT_OWNED_CODE);
    expect(askClose).not.toHaveBeenCalled();
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it.each([
    ["declines", { decision: "rejected" as const }, USER_REJECTED_CODE],
    ["doesn't answer in time", { decision: "timeout" as const }, CONFIRMATION_TIMEOUT_CODE],
    ["can't be asked", { decision: "unavailable" as const }, CONFIRMATION_REQUIRED_CODE],
  ])("closes nothing when the person %s", async (_how, answer, code) => {
    const { deps, dispatchAction } = harness({ answer });
    const server = await serve(deps);

    const result = await callTool(server, relayed("terminal.closeOwned", { terminalId: WORKER }));

    expect(toolErrorPayload(result).code).toBe(code);
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the person typed while it was asked",
      (h: ReturnType<typeof harness>) => {
        h.records.set(WORKER, atPrompt({ lastTypedInputAt: 1_500 }));
        h.screens.set(WORKER, TYPED_BOX);
      },
    ],
    [
      "a key reached it before its echo",
      (h: ReturnType<typeof harness>) =>
        h.records.set(WORKER, atPrompt({ lastTypedInputAt: 1_500 })),
    ],
    [
      "the run was replaced under its id",
      (h: ReturnType<typeof harness>) => h.generations.set(WORKER, 5),
    ],
    [
      "the agent took another turn and stopped again",
      (h: ReturnType<typeof harness>) =>
        h.records.set(WORKER, atPrompt({ lastStateChange: 1_800 })),
    ],
    [
      "its hand-back stop became an error",
      (h: ReturnType<typeof harness>) =>
        h.records.set(WORKER, atPrompt({ waitingReason: "error" })),
    ],
  ])("closes nothing when %s", async (_what, change) => {
    const h = harness();
    h.askClose.mockImplementationOnce(async () => {
      change(h);
      return APPROVED;
    });
    const server = await serve(h.deps);

    const result = await callTool(server, relayed("terminal.closeOwned", { terminalId: WORKER }));

    // Asked, so the refusal came from the read after the answer.
    expect(h.askClose).toHaveBeenCalledTimes(1);
    expect(toolErrorPayload(result).code).toBe(RESOURCE_NOT_OWNED_CODE);
    expect(h.dispatchAction).not.toHaveBeenCalled();
  });

  it("keeps a project assistant's relayed close on the ledger", async () => {
    const { deps, askClose, dispatchAction } = harness({ global: false });
    const server = await serve(deps);

    const refused = await callTool(server, relayed("terminal.closeOwned", { terminalId: WORKER }));

    expect(toolErrorPayload(refused).code).toBe(RESOURCE_NOT_OWNED_CODE);
    expect(toolErrorPayload(refused).message).not.toContain("global Assistant");
    expect(askClose).not.toHaveBeenCalled();
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("closes what it launched on the owned path, asking nobody", async () => {
    const { deps, store, owner, askClose, dispatchAction } = harness();
    const server = await serve(deps);

    const result = await callTool(server, relayed("terminal.closeOwned", { terminalId: MINE }));

    expect(result.isError).toBeFalsy();
    expect(askClose).not.toHaveBeenCalled();
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(store.resourceOwnership.get(owner, "terminal", MINE)).toBeUndefined();
  });

  it("asks once about a batch and closes only the finished agents in it", async () => {
    const { deps, askClose, dispatchAction } = harness();
    const server = await serve(deps);
    const terminalIds = [WORKER, SHELL, MINE, OTHER];

    const result = await callTool(server, relayed("terminal.closeMany", { terminalIds }));

    expect(result.isError).toBeFalsy();
    expect(askClose).toHaveBeenCalledTimes(1);
    const [, ask] = askClose.mock.calls[0]!;
    // Asked about the call as the Shell made it, naming only what it would close.
    expect(ask).toMatchObject({
      actionId: "terminal.closeMany",
      args: { terminalIds },
      closeClass: "handback",
    });
    expect(ask.lines.join("\n")).toContain(WORKER);
    expect(ask.lines.join("\n")).toContain(OTHER);
    expect(ask.lines.join("\n")).not.toContain(SHELL);
    expect(ask.lines.join("\n")).not.toContain(MINE);
    expect(ask.lines.join("\n")).toContain("also closes up to 1 panel the assistant launched");
    expect(
      dispatchAction.mock.calls.map(([, args]) => (args as { terminalId: string }).terminalId)
    ).toEqual([WORKER, MINE, OTHER]);
    const { results } = batchAnswer(result);
    expect(results.map(({ target, ok, error }) => [target, ok, error?.code])).toEqual([
      [WORKER, true, undefined],
      [SHELL, false, RESOURCE_NOT_OWNED_CODE],
      [MINE, true, undefined],
      [OTHER, true, undefined],
    ]);
  });

  it("keeps a batch item on the admission its question read, whatever the ledger says later", async () => {
    const h = harness();
    h.askClose.mockImplementationOnce(async () => {
      // The run is replaced and a record lands under its id while asked.
      h.generations.set(WORKER, 9);
      h.store.resourceOwnership.record(h.owner, [{ kind: "terminal", id: WORKER }]);
      return APPROVED;
    });
    const server = await serve(h.deps);

    const result = await callTool(server, relayed("terminal.closeMany", { terminalIds: [WORKER] }));

    expect(batchAnswer(result).results).toMatchObject([
      { target: WORKER, ok: false, error: { code: RESOURCE_NOT_OWNED_CODE } },
    ]);
    expect(h.dispatchAction).not.toHaveBeenCalled();
    expect(h.store.resourceOwnership.get(h.owner, "terminal", WORKER)).toBeDefined();
  });

  it("keeps a batch item it read as ineligible refused, whatever the ledger says later", async () => {
    const h = harness();
    h.askClose.mockImplementationOnce(async () => {
      h.store.resourceOwnership.record(h.owner, [{ kind: "terminal", id: SHELL }]);
      return APPROVED;
    });
    const server = await serve(h.deps);

    const result = await callTool(
      server,
      relayed("terminal.closeMany", { terminalIds: [WORKER, SHELL] })
    );

    expect(batchAnswer(result).results.map(({ target, ok }) => [target, ok])).toEqual([
      [WORKER, true],
      [SHELL, false],
    ]);
    expect(
      h.dispatchAction.mock.calls.map(([, args]) => (args as { terminalId: string }).terminalId)
    ).toEqual([WORKER]);
  });

  it("makes a batch holding an agent stopped on an error the person's question", async () => {
    const { deps, records, askClose, dispatchAction } = harness({ answer: SKIPPED });
    records.set(OTHER, atPrompt({ waitingReason: "error" }));
    const server = await serve(deps);

    const result = await callTool(
      server,
      relayed("terminal.closeMany", { terminalIds: [WORKER, OTHER, MINE] })
    );

    expect(askClose).toHaveBeenCalledTimes(1);
    expect(askClose.mock.calls[0]![1].closeClass).toBe("requires-person");
    // The skip answered nothing, and a question nobody approved closes nothing,
    // the assistant's own panel included.
    expect(toolErrorPayload(result).code).toBe(CONFIRMATION_REQUIRED_CODE);
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it.each([
    ["declined", { decision: "rejected" as const }, USER_REJECTED_CODE],
    ["unanswered", { decision: "timeout" as const }, CONFIRMATION_TIMEOUT_CODE],
  ])("closes nothing of a batch whose question was %s", async (_how, answer, code) => {
    const { deps, dispatchAction } = harness({ answer });
    const server = await serve(deps);

    const result = await callTool(
      server,
      relayed("terminal.closeMany", { terminalIds: [WORKER, MINE] })
    );

    expect(toolErrorPayload(result).code).toBe(code);
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(deps.appendAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "terminal.closeMany", admission: "global-close" })
    );
  });
});
