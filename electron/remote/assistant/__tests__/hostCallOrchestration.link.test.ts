// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const userData = vi.hoisted(() => ({ dir: "" }));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
    getPath: (key: string) => {
      if (key === "userData") return userData.dir;
      throw new Error(`unexpected getPath: ${key}`);
    },
  },
}));

import type { ActionId, ActionManifestEntry } from "../../../../shared/types/actions.js";
import {
  principalOwnerKey,
  relayOwnershipPrincipal,
} from "../../../services/mcp-server/resourceOwnership.js";
import {
  createSessionServer,
  type SessionServerDeps,
} from "../../../services/mcp-server/sessionServer.js";
import { SessionStore } from "../../../services/mcp-server/sessionStore.js";
import type { TerminalProcessRecord } from "../../../services/mcp-server/worktreeProcessGuard.js";
import type { WorktreeGitObservation } from "../../../services/mcp-server/worktreeRetirementGit.js";
import {
  RELAY_CALL_ID_META_KEY,
  type DispatchEnvelope,
} from "../../../services/mcp-server/shared.js";
import {
  discoverRuns,
  getRunCheckpointBucket,
  provisionRunCheckpointBucket,
} from "../../../services/AssistantRunCheckpointService.js";
import { AppError } from "../../../utils/errorTypes.js";
import type { LinkSession } from "../../link/session.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import type { MetricsSessionContext } from "../../metrics/hostMetricsHost.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import { HostControlLinkClient } from "../HostControlLinkClient.js";
import {
  installHostMcpRelay,
  type RelayMcpSession,
  type RelayMcpSessionSpec,
} from "../hostMcpRelay.js";
import { installAssistantSenderHostWith, senderIdForCredential } from "../hostSenders.js";
import { AssistantLinkMethod } from "../linkMethods.js";
import { SenderSessions } from "../senderSessions.js";
import type {
  HostThrowawayExecution,
  HostThrowawayExecutor,
  HostThrowawayOwner,
} from "../throwawayRelay.js";
import type {
  HostThrowawayCall,
  HostThrowawayRun,
} from "../../../../shared/types/hostThrowaway.js";

/**
 * Acceptance evidence for #14169: a Shell assistant's `host.call` across a
 * real link, through the real sender proof, relay, call ledger and MCP
 * session server on the host, down to a counted effect. Only the host's
 * dispatch into its views is a stand-in: it records each change it makes, so
 * every case counts what the host did, not what the caller was told.
 *
 * Bounds: no packaged Electron, no SSH, no renderer, no real terminal or git.
 * A lost answer is suppressed on the Shell's side of a live link, not dropped
 * by a network.
 */

const HOST_ID = "studio";
const PROJECT = "proj-2";
const CREDENTIAL = "C".repeat(43);
/** The owner the host keeps what a Shell's assistant made under: its sender and help session. */
const principal = (helpSessionId: string) =>
  principalOwnerKey(relayOwnershipPrincipal(senderIdForCredential(CREDENTIAL), helpSessionId));

const HOST: ObservedHost = {
  hostId: HOST_ID,
  name: "studio-01",
  connection: {
    status: "connected",
    rttMs: 12,
    handshake: {
      version: "1.0.0",
      commit: "abc1234",
      protocolVersion: 12,
      platform: "linux",
      arch: "x64",
    },
  },
  lastSeenAt: null,
  summary: null,
};

function entry(
  id: string,
  kind: "query" | "command" = "command",
  danger: "safe" | "confirm" = "safe"
): ActionManifestEntry {
  return {
    id: id as ActionId,
    name: id,
    title: id,
    description: `description for ${id}`,
    category: "test",
    kind,
    danger,
    enabled: true,
    requiresArgs: false,
    inputSchema: { type: "object", properties: {} },
  };
}

const MANIFEST: ActionManifestEntry[] = [
  entry("terminal.list", "query"),
  entry("agent.launch"),
  entry("terminal.closeOwned"),
  entry("terminal.interruptOwned"),
  {
    ...entry("terminal.sendCommandOwned"),
    outputSchema: {
      type: "object",
      properties: { sent: { type: "boolean" }, submissionToken: { type: "string" } },
    },
  },
  entry("worktree.deleteOwned", "command", "confirm"),
  entry("worktree.retireOwned", "command", "confirm"),
];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Effect = { actionId: string; args: Record<string, unknown> };

/**
 * The host's state behind its MCP gates: what its views would launch, submit,
 * create and delete. Every change lands in `effects`, the count each case
 * reads. Anything refused never reaches it.
 */
class Destination {
  readonly store = new SessionStore(() => {});
  readonly effects: Effect[] = [];
  readonly terminals = new Set<string>(["user-shell"]);
  readonly worktrees = new Set<string>();
  readonly dirty = new Set<string>();
  /** What this host's pty host reports running; nothing unless a test says so. */
  processes: TerminalProcessRecord[] = [];
  /** What git reports of a worktree here: clean and pushed unless a test says otherwise. */
  git: WorktreeGitObservation = {
    headOid: "c".repeat(40),
    branch: "feature/done",
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    unpushedCommits: 0,
  };
  readonly submissions = new Map<string, string[]>();
  accepts = true;
  /** Set to hold the next change until released, as a slow host would. */
  gate: { reached: (callId: string) => void; release: Promise<void> } | null = null;
  private next = 0;
  private readonly sessions: Client[] = [];

  count(actionId: string): number {
    return this.effects.filter((effect) => effect.actionId === actionId).length;
  }

  async open(spec: RelayMcpSessionSpec): Promise<RelayMcpSession> {
    const store = this.store;
    const sessionId = `relay-${++this.next}`;
    store.sessionTierMap.set(sessionId, spec.tier);
    store.sessionOriginMap.set(sessionId, "external");
    store.resourceOwnership.bindPrincipal(
      sessionId,
      relayOwnershipPrincipal(spec.senderId, spec.helpSessionId)
    );
    store.sessionWorkspaceMap.set(sessionId, spec.projectId);
    let callId = "";
    const deps: SessionServerDeps = {
      sessionStore: store,
      workspaceBinding: { workspaceId: spec.projectId },
      requestManifest: vi.fn().mockResolvedValue(MANIFEST),
      dispatchAction: (actionId: string, args: unknown) =>
        this.dispatch(spec, callId, actionId, (args ?? {}) as Record<string, unknown>),
      handleWaitUntilIdle: vi.fn(),
      handleWaitUntilIdleBatch: vi.fn(),
      handleSkillsSearch: vi.fn(() => ({ skills: [] })),
      handleSkillsLoad: vi.fn(),
      handleProjectRunCheck: vi.fn(),
      handleProjectRunCommand: vi.fn(),
      handleTerminalGetStatusViewless: vi.fn(),
      handleTerminalReadLastMessageOwned: vi.fn(),
      isTerminalIdInUse: (id: string) => this.terminals.has(id),
      readTerminalProcesses: async () => this.processes,
      readWorktreeGit: async () => this.git,
      // A closed pane's process exits once its grace is ended, as the pty host reports it.
      waitForClosedPanelExits: async (targets: Array<{ terminalId: string }>) => {
        const ids = new Set(targets.map((target) => target.terminalId));
        this.processes = this.processes.map((record) =>
          ids.has(record.id) ? { ...record, isExited: true } : record
        );
        return {
          processes: targets.map(({ terminalId }) => ({
            terminalId,
            outcome: "exited" as const,
            exitCode: 0,
            graceEnded: true,
          })),
        };
      },
      appendAuditRecord: vi.fn(),
      getCachedManifest: vi.fn(() => MANIFEST),
      resolveOwnPane: () => null,
      relay: { shellName: spec.shellName, refuseWrite: () => null },
    } as unknown as SessionServerDeps;
    const server = createSessionServer(sessionId, deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    store.relaySessions.set(sessionId, { transport: serverTransport, server });
    serverTransport.onclose = () => store.revokeSession(sessionId);
    const client = new Client({ name: "daintree-host-call", version: "0.0.0-test" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    this.sessions.push(client);
    return {
      isOpen: () => store.relaySessions.has(sessionId),
      callTool: async (tool, args, options) => {
        callId = options.callId;
        return (await client.callTool(
          { name: tool, arguments: args, _meta: { [RELAY_CALL_ID_META_KEY]: options.callId } },
          undefined,
          { timeout: options.timeoutMs }
        )) as never;
      },
      close: () => {
        store.revokeSession(sessionId);
        void client.close().catch(() => {});
      },
    };
  }

  /** Stands in for the host's views: each change is counted where it would land. */
  private async dispatch(
    spec: RelayMcpSessionSpec,
    callId: string,
    actionId: string,
    args: Record<string, unknown>
  ): Promise<DispatchEnvelope> {
    const ok = (result: unknown): DispatchEnvelope => ({ result: { ok: true, result } }) as never;
    const failed = (code: string, message: string): DispatchEnvelope =>
      ({ result: { ok: false, error: { code, message } } }) as never;
    if (actionId === "terminal.list") {
      return ok({ terminals: [...this.terminals].map((id) => ({ id })) });
    }
    if (actionId === "worktree.delete") {
      // With no view here, the person at the Shell is asked about this very call (#13501).
      const asked = await spec.requestApproval({
        actionId: "worktree.delete",
        args,
        lines: ["Deletes the worktree and its branch."],
        callId,
      } as never);
      // As the viewless executor reads the answer: a Shell's refusal is nobody approving.
      if (asked.decision === "rejected") return failed("USER_REJECTED", "Rejected");
      if (asked.decision === "timeout") return failed("CONFIRMATION_TIMEOUT", "Timed out");
      if (asked.decision !== "approved") {
        return failed("CONFIRMATION_REQUIRED", "No one could approve this here");
      }
    }
    if (this.gate) {
      const { reached, release } = this.gate;
      this.gate = null;
      reached(callId);
      await release;
    }
    this.effects.push({ actionId, args });
    switch (actionId) {
      case "agent.launch": {
        const terminalId =
          (args.requestedId as string | undefined) ?? `agent-${this.effects.length}`;
        this.terminals.add(terminalId);
        return ok({ launched: true, terminalId });
      }
      case "terminal.sendCommand": {
        const terminalId = args.terminalId as string;
        const token = `token-${this.effects.length}`;
        this.submissions.set(terminalId, [...(this.submissions.get(terminalId) ?? []), token]);
        return ok({
          sent: true,
          terminalId,
          command: args.command,
          submissionToken: token,
          message: "Queued",
        });
      }
      case "terminal.close": {
        const terminalId = args.terminalId as string;
        this.terminals.delete(terminalId);
        return ok({ closedIds: [terminalId] });
      }
      case "terminal.interrupt":
        return ok({ interrupted: true });
      case "worktree.delete": {
        const worktreeId = args.worktreeId as string;
        if (this.dirty.has(worktreeId)) {
          return failed("EXECUTION_ERROR", "worktree has uncommitted changes");
        }
        this.worktrees.delete(worktreeId);
        return ok({ deleted: true });
      }
      default:
        return ok(null);
    }
  }

  async dispose(): Promise<void> {
    for (const client of this.sessions.splice(0)) await client.close().catch(() => {});
    this.store.drain();
    this.store.grantCache.dispose();
  }
}

/**
 * The host's own throwaway runs (#14445), in memory: what the relay reaches
 * with no project, view or MCP session. Each launch, input and close lands in
 * `effects`, and a run answers only its owner, as the contract says.
 */
class ThrowawayRuns implements HostThrowawayExecutor {
  readonly effects: Array<{ tool: string; runId: string }> = [];
  private readonly runs = new Map<
    string,
    { owner: string; run: HostThrowawayRun; screen: string[] }
  >();
  private next = 0;

  count(tool: string): number {
    return this.effects.filter((effect) => effect.tool === tool).length;
  }

  get live(): number {
    return this.runs.size;
  }

  readonly ended: Array<{ owner: { senderId: string; helpSessionId?: string }; reason: string }> =
    [];

  endOwner(owner: { senderId: string; helpSessionId?: string }, reason: string): void {
    this.ended.push({ owner, reason });
    const prefix =
      owner.helpSessionId === undefined
        ? `${owner.senderId}\0`
        : `${owner.senderId}\0${owner.helpSessionId}`;
    for (const [runId, held] of [...this.runs]) {
      const matches =
        owner.helpSessionId === undefined ? held.owner.startsWith(prefix) : held.owner === prefix;
      if (matches) this.runs.delete(runId);
    }
  }

  async run(owner: HostThrowawayOwner, call: HostThrowawayCall): Promise<HostThrowawayExecution> {
    const key = `${owner.senderId}\0${owner.helpSessionId}`;
    if (call.tool === "throwaway.launch") {
      const runId = `run-${++this.next}`;
      const run: HostThrowawayRun = {
        runId,
        agentId: call.args.agentId,
        startedAt: 1_000,
        ageMs: 0,
        timeLimitMs: null,
        expiresAt: null,
        state: "running",
        endedAt: null,
        endReason: null,
      };
      this.runs.set(runId, { owner: key, run, screen: ["> "] });
      this.effects.push({ tool: call.tool, runId });
      return { status: "done", result: { tool: call.tool, run } };
    }
    const held = this.runs.get(call.args.runId);
    if (held === undefined || held.owner !== key) return { status: "failed", reason: "not-found" };
    const { run, screen } = held;
    switch (call.tool) {
      case "throwaway.status":
        return { status: "done", result: { tool: call.tool, run } };
      case "throwaway.output":
        return {
          status: "done",
          result: {
            tool: call.tool,
            run,
            content: screen.join("\n"),
            lineCount: screen.length,
            truncated: false,
          },
        };
      case "throwaway.sendCommand":
        this.effects.push({ tool: call.tool, runId: run.runId });
        screen.push(`> ${call.args.command}`, "Weekly usage: 42%");
        return { status: "done", result: { tool: call.tool, run, accepted: true } };
      case "throwaway.sendKeys":
        this.effects.push({ tool: call.tool, runId: run.runId });
        return { status: "done", result: { tool: call.tool, run, accepted: true } };
      case "throwaway.close": {
        this.effects.push({ tool: call.tool, runId: run.runId });
        this.runs.delete(run.runId);
        const closed: HostThrowawayRun = {
          ...run,
          state: "closed",
          endedAt: 2_000,
          endReason: "close",
        };
        return { status: "done", result: { tool: call.tool, run: closed, closed: true } };
      }
    }
  }
}

/** One Shell: its assistants' runtime and link client, reaching one host over a real link. */
function startShell(
  link: LinkSession,
  options: {
    runs: Map<string, OpenRun>;
    control: Set<string>;
    decision: () => "approved" | "rejected";
    /** Loses the next MCP_CALL answer after the host has answered it. */
    loseNextAnswer: { value: boolean };
    asked: string[];
  }
) {
  let ids = 0;
  const shellId = `${Math.random().toString(36).slice(2, 8)}`;
  // Stable, so the link client proves its sender on it once.
  const lossy = {
    get isOpen() {
      return link.isOpen;
    },
    registerCallHandler: link.registerCallHandler.bind(link),
    call: async (method: string, payload: unknown, callOptions?: { timeoutMs?: number }) => {
      const answer = await link.call(method as never, payload as never, callOptions as never);
      const relayed =
        method === AssistantLinkMethod.MCP_CALL || method === AssistantLinkMethod.THROWAWAY_CALL;
      if (relayed && options.loseNextAnswer.value) {
        options.loseNextAnswer.value = false;
        throw new AppError({ code: "OUTCOME_UNKNOWN", message: "No reply" });
      }
      return answer;
    },
  } as unknown as LinkSession;
  // eslint-disable-next-line prefer-const -- the client reads the runtime it was built before
  let runtime: HostCallRuntime;
  const client = new HostControlLinkClient({
    credential: () => CREDENTIAL,
    session: async () => lossy,
    onSessionOpened: (listener) => {
      listener(HOST_ID, link);
      return () => {};
    },
    noticeReceiver: () => runtime,
    approvalReceiver: () => runtime,
    noticeStatusDelayMs: 60_000,
  });
  runtime = new HostCallRuntime({
    getSessionLane: (id) => {
      const run = options.runs.get(id);
      return run ? { projectId: run.projectId, slot: run.slot } : null;
    },
    callerRun: (id) => options.runs.get(id) ?? null,
    client: () => client,
    hosts: () => [HOST],
    inLocalView: () => true,
    controlEnabled: (hostId) => options.control.has(hostId),
    askApproval: async (question) => {
      options.asked.push(question.actionId);
      return options.decision();
    },
    newId: () => `00000000-0000-4000-8000-${shellId}${String(++ids).padStart(6, "0")}`,
  });
  client.start();
  return {
    runtime,
    dispose: () => {
      runtime.dispose();
      client.dispose();
    },
  };
}

const RUN_A: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "help-a",
  terminalId: "t-a",
  launchGeneration: 1,
};

let dir: string;
let links: { host: LinkSession; client: LinkSession };
let destination: Destination;
let throwaways: ThrowawayRuns;
let relay: { dispose(): void };
let offSenders: () => void;
let runs: Map<string, OpenRun>;
let control: Set<string>;
let decision: "approved" | "rejected";
let loseNextAnswer: { value: boolean };
let asked: string[];
let shell: ReturnType<typeof startShell>;

/** The host's own directory, as its entries name it: `local`. */
const HOST_AGENTS = {
  coverage: "ok" as const,
  observedAt: 77,
  complete: true,
  omitted: 0,
  entries: [
    {
      state: "live" as const,
      role: "assistant" as const,
      subject: {
        hostId: "local",
        scope: { kind: "project" as const, projectId: PROJECT },
        terminalId: "t-host-help",
        incarnation: 5,
        lane: 0,
      },
      agentId: "claude",
      agentState: "idle" as const,
      waitingReason: null,
      since: null,
      label: null,
      attached: true,
      handback: null,
    },
  ],
};
const agentReads: Array<{ projectId?: string }> = [];
const agentReadFails = { value: false };

/** Relayed calls as they arrive on the host, before its ledger or anything else sees them. */
const arrivals = { mcpCalls: 0, projectReads: 0, sessionsOpened: 0 };

function hostSource(link: LinkSession) {
  const session = new Proxy(link, {
    get(target, property) {
      if (property === "registerCallHandler") {
        return (method: string, schema: unknown, handler: (payload: unknown) => unknown) =>
          target.registerCallHandler(
            method as never,
            schema as never,
            ((payload: unknown) => {
              if (method === AssistantLinkMethod.MCP_CALL) arrivals.mcpCalls++;
              return handler(payload);
            }) as never
          );
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ctx = {
    session,
    sessionId: "link-1",
    client: { clientName: "greg-mbp" },
  } as unknown as MetricsSessionContext;
  return {
    sessions: [ctx],
    onSession: () => () => {},
    onSessionExpired: () => () => {},
  };
}

/** The host's side, as `hostListener` installs it: sender proof, then the relay. */
function installHost(): void {
  const senders = new SenderSessions();
  const source = hostSource(links.host);
  offSenders = installAssistantSenderHostWith(source, { senders });
  relay = installHostMcpRelay(source, {
    senders: () => senders,
    acceptsRemoteControl: () => destination.accepts,
    hasProject: async (projectId) => {
      arrivals.projectReads++;
      return projectId === PROJECT;
    },
    openSession: (spec) => {
      arrivals.sessionsOpened++;
      return destination.open(spec);
    },
    throwawayRuns: () => throwaways,
    readAgents: async (options) => {
      agentReads.push(options);
      if (agentReadFails.value) throw new Error("pty host down");
      return HOST_AGENTS;
    },
  });
}

function call(
  tool: string,
  args: Record<string, unknown>,
  extra: {
    callId?: string;
    newCallId?: string;
    helpSessionId?: string;
    runtime?: HostCallRuntime;
  } = {}
) {
  return (extra.runtime ?? shell.runtime).call(
    extra.helpSessionId ?? "help-a",
    {
      hostId: HOST_ID,
      projectId: PROJECT,
      tool,
      args,
      ...(extra.callId !== undefined ? { callId: extra.callId } : {}),
      ...(extra.newCallId !== undefined ? { newCallId: extra.newCallId } : {}),
    },
    { tier: "full" }
  );
}

async function settled(promise: ReturnType<typeof call>) {
  const result = await promise;
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return result.value;
}

beforeEach(async () => {
  dir = await makeTempDir();
  userData.dir = dir;
  links = await openSessionPair(dir);
  destination = new Destination();
  throwaways = new ThrowawayRuns();
  arrivals.mcpCalls = 0;
  arrivals.projectReads = 0;
  arrivals.sessionsOpened = 0;
  agentReads.length = 0;
  agentReadFails.value = false;
  installHost();
  runs = new Map([["help-a", RUN_A]]);
  control = new Set([HOST_ID]);
  decision = "approved";
  loseNextAnswer = { value: false };
  asked = [];
  shell = startShell(links.client, {
    runs,
    control,
    decision: () => decision,
    loseNextAnswer,
    asked,
  });
});

afterEach(async () => {
  shell.dispose();
  relay.dispose();
  offSenders();
  await destination.dispose();
  links.host.close("test");
  links.client.close("test");
  await removeTempDir(dir);
});

const LAUNCH = { agentId: "claude", requestedId: "w-1" };
const SEND = { terminalId: "w-1", command: "npm test" };

/** A worker this run launched, to submit to: its only keyless write here. */
async function launchWorker() {
  const launched = await settled(call("agent.launch", LAUNCH));
  expect(launched.result).toMatchObject({ isError: false });
  return launched;
}

/** The host restarts its Daintree; its terminals live on, and the Shell links again. */
async function restartHost(): Promise<void> {
  shell.dispose();
  relay.dispose();
  offSenders();
  links.host.close("restart");
  links.client.close("restart");
  links = await openSessionPair(dir);
  installHost();
  shell = startShell(links.client, {
    runs,
    control,
    decision: () => decision,
    loseNextAnswer,
    asked,
  });
}

describe("host.call when an answer is lost (#14169)", () => {
  it("runs a launch once when its answer is lost and the call is resent by its callId", async () => {
    loseNextAnswer.value = true;
    const lost = await settled(call("agent.launch", LAUNCH));

    // Unknown is never success: the caller holds the callId and no result.
    expect(lost).toMatchObject({ outcome: "ambiguous", result: null });
    expect(lost.callId).toEqual(expect.any(String));
    expect(destination.count("agent.launch")).toBe(1);

    const resent = await settled(call("agent.launch", LAUNCH, { callId: lost.callId! }));
    expect(resent).toMatchObject({ outcome: "ok", callId: lost.callId });
    expect(resent.result).toMatchObject({ isError: false });
    expect(destination.count("agent.launch")).toBe(1);
  });

  it("never starts a callId the host holds no record of, and never reads it as done or gone", async () => {
    await launchWorker();
    const forgotten = await settled(
      call("terminal.sendCommandOwned", SEND, { callId: "never-sent" })
    );
    expect(forgotten).toMatchObject({ outcome: "expired", callId: "never-sent", result: null });
    expect(destination.count("terminal.sendCommand")).toBe(0);
  });

  it("refuses a known callId reused for another call, running nothing more", async () => {
    await launchWorker();
    const first = await settled(call("terminal.sendCommandOwned", SEND));
    const reused = await settled(
      call(
        "terminal.sendCommandOwned",
        { ...SEND, command: "npm run lint" },
        { callId: first.callId! }
      )
    );
    expect(reused).toMatchObject({ outcome: "conflict", result: null });
    expect(destination.submissions.get("w-1")).toHaveLength(1);
  });

  it("answers expired once the host restarted, so a resend never runs again", async () => {
    await launchWorker();
    loseNextAnswer.value = true;
    const lost = await settled(call("terminal.sendCommandOwned", SEND));
    expect(lost.outcome).toBe("ambiguous");

    await restartHost();

    const resent = await settled(call("terminal.sendCommandOwned", SEND, { callId: lost.callId! }));
    expect(resent).toMatchObject({ outcome: "expired", result: null });
    expect(destination.submissions.get("w-1")).toHaveLength(1);
  });

  describe("the whole host.call answer lost, callId and all", () => {
    it("hands a fresh launch the first one's answer while the host remembers it", async () => {
      // The answer, and the callId in it, never reach the assistant.
      await call("agent.launch", LAUNCH);

      // Its only way back is a fresh call: the host's own dedup replays the first answer.
      const retry = await settled(call("agent.launch", LAUNCH));
      expect(retry.outcome).toBe("ok");
      expect(retry.result).toMatchObject({ isError: false });
      expect(JSON.stringify(retry.result)).toContain("w-1");
      expect(destination.count("agent.launch")).toBe(1);
    });

    it("refuses a fresh launch under the caller's requestedId once that memory is gone", async () => {
      await call("agent.launch", LAUNCH);
      await restartHost();

      const retry = await settled(call("agent.launch", LAUNCH));
      expect(retry.outcome).toBe("ok");
      expect(retry.result).toMatchObject({ isError: true });
      expect(JSON.stringify(retry.result)).toContain("VALIDATION_ERROR");
      expect(destination.count("agent.launch")).toBe(1);
      expect([...destination.terminals]).toEqual(["user-shell", "w-1"]);
    });

    it("leaves a submission with no key the caller holds: a fresh send submits again", async () => {
      await launchWorker();
      // The answer carried the only receipts: its callId and the host-minted token.
      await call("terminal.sendCommandOwned", SEND);
      expect(destination.submissions.get("w-1")).toHaveLength(1);

      // A callId the caller makes up is a resend the host never starts.
      const guessed = await settled(
        call("terminal.sendCommandOwned", SEND, { callId: "caller-made-up" })
      );
      expect(guessed).toMatchObject({ outcome: "expired", result: null });
      expect(destination.submissions.get("w-1")).toHaveLength(1);

      // Sent with no id of its own, nothing the caller can present tells this
      // send from the lost one, so it is a second submission. #14240's
      // newCallId is the receipt; the test below sends with it.
      const again = await settled(call("terminal.sendCommandOwned", SEND));
      expect(again.outcome).toBe("ok");
      expect(destination.submissions.get("w-1")).toHaveLength(2);
      expect(new Set(destination.submissions.get("w-1")).size).toBe(2);
    });
  });
});

describe("a send under the caller's own newCallId, its whole answer lost (#14240)", () => {
  it("submits once when resent by that id, never after a restart, and again only under a new one", async () => {
    await launchWorker();
    loseNextAnswer.value = true;
    // None of this answer is read: the caller holds only the id it chose.
    await call("terminal.sendCommandOwned", SEND, { newCallId: "send-1" });
    expect(destination.submissions.get("w-1")).toHaveLength(1);

    const resent = await settled(call("terminal.sendCommandOwned", SEND, { callId: "send-1" }));
    expect(resent).toMatchObject({ outcome: "ok", callId: "send-1" });
    expect(JSON.stringify(resent.result)).toContain(destination.submissions.get("w-1")![0]);
    expect(destination.submissions.get("w-1")).toHaveLength(1);

    // The same id sent as new again is still that send: this Shell resends it.
    const repeated = await settled(
      call("terminal.sendCommandOwned", SEND, { newCallId: "send-1" })
    );
    expect(repeated).toEqual(resent);
    expect(destination.submissions.get("w-1")).toHaveLength(1);

    await restartHost();
    const forgotten = await settled(call("terminal.sendCommandOwned", SEND, { callId: "send-1" }));
    expect(forgotten).toMatchObject({ outcome: "expired", callId: "send-1", result: null });
    expect(destination.submissions.get("w-1")).toHaveLength(1);

    const another = await settled(call("terminal.sendCommandOwned", SEND, { newCallId: "send-2" }));
    expect(another).toMatchObject({ outcome: "ok", callId: "send-2" });
    expect(destination.submissions.get("w-1")).toHaveLength(2);
  });
});

describe("consent between a read and an effect (#14169)", () => {
  it("refuses a write once the person turns assistant control off after the read", async () => {
    await launchWorker();
    const read = await settled(call("terminal.list", {}));
    expect(read.outcome).toBe("ok");

    control.delete(HOST_ID);
    const write = await settled(call("terminal.sendCommandOwned", SEND));
    expect(write).toMatchObject({ outcome: "opted_out", callId: null, result: null });
    expect(destination.count("terminal.sendCommand")).toBe(0);
  });

  it("refuses a write once the host stops taking remote control after the read", async () => {
    await launchWorker();
    await settled(call("terminal.list", {}));
    destination.accepts = false;
    const write = await settled(call("terminal.sendCommandOwned", SEND));
    expect(write.outcome).not.toBe("ok");
    expect(write.result).toBeNull();
    expect(destination.count("terminal.sendCommand")).toBe(0);
  });
});

describe("an assistant run replaced while its write is pending (#14169)", () => {
  it("withdraws the person's approval of a delete once the asking run is replaced", async () => {
    await launchWorker();
    destination.worktrees.add("/wt/feature");
    destination.store.resourceOwnership.record(
      principal("help-a"),
      [{ kind: "worktree", id: "/wt/feature" }],
      PROJECT
    );
    // The person approves, but only once the run that asked has been replaced.
    const asking = shell.runtime;
    const originalAsk = asking.receiveApproval.bind(asking);
    const answers: unknown[] = [];
    vi.spyOn(asking, "receiveApproval").mockImplementation(async (hostId, payload) => {
      const pending = originalAsk(hostId, payload);
      runs.set("help-a", { ...RUN_A, launchGeneration: 2 });
      answers.push(await pending);
      return answers.at(-1) as never;
    });

    const deleted = await settled(call("worktree.deleteOwned", { worktreeId: "/wt/feature" }));

    expect(asked).toEqual(["worktree.delete"]);
    expect(answers).toEqual([expect.objectContaining({ decision: "refused" })]);
    expect(deleted.result).toMatchObject({ isError: true });
    expect(JSON.stringify(deleted.result)).toContain("CONFIRMATION_REQUIRED");
    expect(destination.count("worktree.delete")).toBe(0);
    expect(destination.worktrees.has("/wt/feature")).toBe(true);
  });

  it("joins the successor's resend of a call still running on the host, running it once", async () => {
    await launchWorker();
    const gate = deferred();
    const reached = deferred<string>();
    destination.gate = { reached: reached.resolve, release: gate.promise };
    const first = call("terminal.sendCommandOwned", SEND);
    // The callId as the host received it: what a successor would have to present.
    const callId = await reached.promise;

    // Replaced mid-call: the old run's submission is still being made on the host.
    runs.set("help-a", { ...RUN_A, launchGeneration: 2 });
    const before = arrivals.mcpCalls;
    const resent = call("terminal.sendCommandOwned", SEND, { callId });
    await vi.waitFor(() => expect(arrivals.mcpCalls).toBe(before + 1));
    gate.resolve();

    const [answered, joined] = await Promise.all([settled(first), settled(resent)]);
    expect(answered).toMatchObject({ outcome: "ok", callId });
    expect(joined).toMatchObject({ outcome: "ok", callId });
    expect(joined.result).toEqual(answered.result);
    expect(destination.submissions.get("w-1")).toHaveLength(1);
  });
});

describe("cleanup that keeps what it may not remove (#14169)", () => {
  it("closes only its own pane, keeps a foreign one and a dirty worktree, and says why", async () => {
    await launchWorker();
    destination.worktrees.add("/wt/dirty");
    destination.dirty.add("/wt/dirty");
    destination.store.resourceOwnership.record(
      principal("help-a"),
      [{ kind: "worktree", id: "/wt/dirty" }],
      PROJECT
    );

    const own = await settled(call("terminal.closeOwned", { terminalId: "w-1" }));
    const foreign = await settled(call("terminal.closeOwned", { terminalId: "user-shell" }));
    const dirty = await settled(call("worktree.deleteOwned", { worktreeId: "/wt/dirty" }));

    expect(own.result).toMatchObject({ isError: false });
    expect(foreign.result).toMatchObject({ isError: true });
    expect(JSON.stringify(foreign.result)).toContain("RESOURCE_NOT_OWNED");
    expect(dirty.result).toMatchObject({ isError: true });
    expect(JSON.stringify(dirty.result)).toContain("uncommitted changes");

    expect([...destination.terminals]).toEqual(["user-shell"]);
    expect(destination.worktrees.has("/wt/dirty")).toBe(true);
    expect(destination.count("terminal.close")).toBe(1);
    // A refused delete keeps the caller's hold, so it can retry once the work is committed.
    expect(
      destination.store.resourceOwnership.owns(principal("help-a"), "worktree", "/wt/dirty")
    ).toBe(true);
  });

  it("keeps a worktree the person's shell still runs in, asking no one (#15729)", async () => {
    await launchWorker();
    destination.worktrees.add("/wt/busy");
    destination.store.resourceOwnership.record(
      principal("help-a"),
      [{ kind: "worktree", id: "/wt/busy" }],
      PROJECT
    );
    destination.processes = [{ id: "user-shell", cwd: "/wt/busy", isExited: false }];

    const busy = await settled(call("worktree.deleteOwned", { worktreeId: "/wt/busy" }));

    expect(busy.result).toMatchObject({ isError: true });
    // The Shell's caller gets the host's whole refusal, details included.
    expect(JSON.parse((busy.result as { text: string }).text)).toMatchObject({
      code: "DISABLED",
      message: expect.stringContaining("'user-shell' (not recorded as created by this session)"),
      retriable: false,
      details: {
        reason: "worktree-has-running-terminals",
        worktreeId: "/wt/busy",
        terminals: [
          {
            terminalId: "user-shell",
            createdByThisSession: false,
            closableByThisSession: false,
            trashed: false,
            trashExpiresAt: null,
          },
        ],
      },
    });
    expect(asked).toEqual([]);
    expect(destination.count("worktree.delete")).toBe(0);
    expect(destination.terminals.has("user-shell")).toBe(true);
    expect(destination.worktrees.has("/wt/busy")).toBe(true);
    expect(
      destination.store.resourceOwnership.owns(principal("help-a"), "worktree", "/wt/busy")
    ).toBe(true);
  });
});

describe("retiring a worktree through host.call with no window open there (#15737)", () => {
  async function ownedWorktreeWithWorker(worktreeId: string) {
    await launchWorker();
    destination.worktrees.add(worktreeId);
    destination.store.resourceOwnership.record(
      principal("help-a"),
      [{ kind: "worktree", id: worktreeId }],
      PROJECT
    );
    destination.processes = [{ id: "w-1", cwd: worktreeId, isExited: false }];
  }

  it("closes its worker, waits for it, and deletes after the one question at the Shell", async () => {
    await ownedWorktreeWithWorker("/wt/done");

    const retired = await settled(call("worktree.retireOwned", { worktreeId: "/wt/done" }));

    expect(retired.result).toMatchObject({
      isError: false,
      structured: {
        worktreeId: "/wt/done",
        closedTerminalIds: ["w-1"],
        processes: [{ terminalId: "w-1", outcome: "exited" }],
      },
    });
    // The delete's own confirmation, relayed here, is the only thing asked.
    expect(asked).toEqual(["worktree.delete"]);
    expect(destination.count("terminal.close")).toBe(1);
    expect(destination.terminals.has("w-1")).toBe(false);
    expect(destination.worktrees.has("/wt/done")).toBe(false);
  });

  it("says its worker was closed when the person at the Shell rejects the delete", async () => {
    await ownedWorktreeWithWorker("/wt/kept");
    decision = "rejected";

    const kept = await settled(call("worktree.retireOwned", { worktreeId: "/wt/kept" }));

    expect(kept.result).toMatchObject({ isError: true });
    expect(JSON.parse((kept.result as { text: string }).text)).toMatchObject({
      code: "PARTIAL_SUCCESS",
      details: {
        failedStep: "delete",
        closedTerminalIds: ["w-1"],
        cause: { code: "USER_REJECTED" },
      },
    });
    expect(destination.terminals.has("w-1")).toBe(false);
    expect(destination.worktrees.has("/wt/kept")).toBe(true);
    expect(
      destination.store.resourceOwnership.owns(principal("help-a"), "worktree", "/wt/kept")
    ).toBe(true);
  });
});

describe("restarting the coordinating Shell mid-workload (#14169)", () => {
  it("finds its checkpoint, adopts nothing of the old run, and launches no duplicate", async () => {
    const projectKey = "a".repeat(64);
    const bucket = await provisionRunCheckpointBucket(projectKey);
    const runDir = path.join(bucket, "run-1", "writers", "coordinator");
    await fs.mkdir(runDir, { recursive: true });

    // A capped workload of two: the first unit launched and submitted, the second not yet.
    const launched = await settled(call("agent.launch", { agentId: "claude", requestedId: "w-1" }));
    const sent = await settled(
      call("terminal.sendCommandOwned", { terminalId: "w-1", command: "npm test" })
    );
    await fs.writeFile(
      path.join(runDir, "checkpoint.json"),
      JSON.stringify({
        schemaVersion: 1,
        units: [
          { requestedId: "w-1", launchCallId: launched.callId, sendCallId: sent.callId },
          { requestedId: "w-2" },
        ],
      })
    );

    // The Shell quits; a new one starts its assistant under a new help session.
    shell.dispose();
    runs.clear();
    runs.set("help-b", { ...RUN_A, sessionId: "help-b", launchGeneration: 2 });
    shell = startShell(links.client, {
      runs,
      control,
      decision: () => decision,
      loseNextAnswer,
      asked,
    });

    const found = await discoverRuns(projectKey);
    expect(found).toEqual([{ runId: "run-1", state: "unfinished", settledAt: null }]);
    expect(path.dirname(path.dirname(path.dirname(runDir)))).toBe(
      getRunCheckpointBucket(projectKey)
    );
    const checkpoint = JSON.parse(await fs.readFile(path.join(runDir, "checkpoint.json"), "utf8"));

    // Reconcile before any effect: the recorded units are found, not re-made.
    for (const unit of checkpoint.units as Array<{ requestedId: string; launchCallId?: string }>) {
      if (unit.launchCallId) {
        const resent = await settled(
          call(
            "agent.launch",
            { agentId: "claude", requestedId: unit.requestedId },
            { callId: unit.launchCallId, helpSessionId: "help-b" }
          )
        );
        // The old help session's call isn't the new one's to read back, and isn't run again.
        expect(resent).toMatchObject({
          outcome: "conflict",
          callId: unit.launchCallId,
          result: null,
        });
        const fresh = await settled(
          call(
            "agent.launch",
            { agentId: "claude", requestedId: unit.requestedId },
            { helpSessionId: "help-b" }
          )
        );
        expect(JSON.stringify(fresh.result)).toContain("VALIDATION_ERROR");
      } else {
        const fresh = await settled(
          call(
            "agent.launch",
            { agentId: "claude", requestedId: unit.requestedId },
            { helpSessionId: "help-b" }
          )
        );
        expect(fresh.result).toMatchObject({ isError: false });
      }
    }

    // The predecessor's worker stays the predecessor's: the new run can't type into it.
    const adopt = await settled(
      call(
        "terminal.sendCommandOwned",
        { terminalId: "w-1", command: "npm test" },
        { helpSessionId: "help-b" }
      )
    );
    expect(JSON.stringify(adopt.result)).toContain("RESOURCE_NOT_OWNED");

    expect(destination.count("agent.launch")).toBe(2);
    expect([...destination.terminals].sort()).toEqual(["user-shell", "w-1", "w-2"]);
    expect(destination.submissions.get("w-1")).toHaveLength(1);
  });
});

describe("host.call to a host's throwaway agents, with no window open there (#14446)", () => {
  function throwaway(
    tool: string,
    args: Record<string, unknown>,
    extra: { callId?: string; helpSessionId?: string; runtime?: HostCallRuntime } = {}
  ) {
    return (extra.runtime ?? shell.runtime).call(
      extra.helpSessionId ?? "help-a",
      {
        hostId: HOST_ID,
        throwaway: true,
        tool,
        args,
        ...(extra.callId !== undefined ? { callId: extra.callId } : {}),
      },
      { tier: "core" }
    );
  }

  async function ran(promise: ReturnType<typeof throwaway>) {
    const result = await settled(promise);
    expect(result).toMatchObject({ outcome: "ok", result: { isError: false } });
    return result.result!.structured as Record<string, unknown> & { run: HostThrowawayRun };
  }

  it("launches, reads, sends to and closes a run, never touching a project or session", async () => {
    const launched = await ran(throwaway("throwaway.launch", { agentId: "claude" }));
    const { runId } = launched.run;
    expect(launched.run).toMatchObject({ agentId: "claude", state: "running" });

    await expect(ran(throwaway("throwaway.status", { runId }))).resolves.toMatchObject({
      run: { runId, state: "running" },
    });
    await ran(throwaway("throwaway.sendCommand", { runId, command: "/usage" }));
    await ran(throwaway("throwaway.sendKeys", { runId, keys: ["Escape"] }));
    await expect(ran(throwaway("throwaway.output", { runId }))).resolves.toMatchObject({
      content: expect.stringContaining("Weekly usage: 42%"),
      truncated: false,
    });
    await expect(ran(throwaway("throwaway.close", { runId }))).resolves.toMatchObject({
      run: { state: "closed", endReason: "close" },
      closed: true,
    });

    expect(throwaways.effects.map((effect) => effect.tool)).toEqual([
      "throwaway.launch",
      "throwaway.sendCommand",
      "throwaway.sendKeys",
      "throwaway.close",
    ]);
    expect(throwaways.live).toBe(0);
    // The project path never ran: no project read, no MCP session, no view's dispatch.
    expect(arrivals).toMatchObject({ mcpCalls: 0, projectReads: 0, sessionsOpened: 0 });
    expect(destination.effects).toEqual([]);

    // Closed is gone: a fresh close finds nothing.
    await expect(settled(throwaway("throwaway.close", { runId }))).resolves.toMatchObject({
      outcome: "ok",
      result: { isError: true, structured: { code: "not-found" } },
    });
  });

  it("closes a help session's runs on the host when it ends here, leaving another's (#14447)", async () => {
    runs.set("help-b", { ...RUN_A, sessionId: "help-b", slot: 1 });
    await ran(throwaway("throwaway.launch", { agentId: "claude" }));
    await ran(throwaway("throwaway.launch", { agentId: "claude" }, { helpSessionId: "help-b" }));
    expect(throwaways.live).toBe(2);

    shell.runtime.endHelpSession("help-a");
    await vi.waitFor(() => expect(throwaways.ended).toHaveLength(1));
    expect(throwaways.ended[0]).toEqual({
      owner: { senderId: expect.any(String), helpSessionId: "help-a" },
      reason: "session-ended",
    });
    expect(throwaways.live).toBe(1);
    // Released once: a second end has nothing left to tell the host.
    shell.runtime.endHelpSession("help-a");
    // A session that launched nothing there sends nothing.
    shell.runtime.endHelpSession("help-c");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(throwaways.ended).toHaveLength(1);
  });

  it("launches once when the launch's answer is lost and it is resent by its callId", async () => {
    loseNextAnswer.value = true;
    const lost = await settled(throwaway("throwaway.launch", { agentId: "claude" }));
    expect(lost).toMatchObject({ outcome: "ambiguous", result: null });
    expect(throwaways.count("throwaway.launch")).toBe(1);

    const resent = await ran(
      throwaway("throwaway.launch", { agentId: "claude" }, { callId: lost.callId! })
    );
    expect(throwaways.count("throwaway.launch")).toBe(1);
    expect(throwaways.live).toBe(1);
    expect(resent.run.runId).toBe(throwaways.effects[0]!.runId);
  });

  it("releases a launch whose answer was lost when its session ends (#14447)", async () => {
    loseNextAnswer.value = true;
    const lost = await settled(throwaway("throwaway.launch", { agentId: "claude" }));
    expect(lost).toMatchObject({ outcome: "ambiguous", result: null });
    expect(throwaways.live).toBe(1);
    shell.runtime.endHelpSession("help-a");
    await vi.waitFor(() => expect(throwaways.live).toBe(0));
  });

  it("answers another help session's call on a run as not found", async () => {
    runs.set("help-b", { ...RUN_A, sessionId: "help-b", slot: 1 });
    const { run } = await ran(throwaway("throwaway.launch", { agentId: "claude" }));
    for (const tool of ["throwaway.output", "throwaway.close"]) {
      await expect(
        settled(throwaway(tool, { runId: run.runId }, { helpSessionId: "help-b" }))
      ).resolves.toMatchObject({ result: { isError: true, structured: { code: "not-found" } } });
    }
    expect(throwaways.live).toBe(1);
    expect(throwaways.count("throwaway.close")).toBe(0);
  });

  it("answers the host's own refusal as a project call's, and runs nothing", async () => {
    destination.accepts = false;
    await expect(
      settled(throwaway("throwaway.launch", { agentId: "claude" }))
    ).resolves.toMatchObject({ outcome: "policy_rejected", result: null });
    destination.accepts = true;
    control.clear();
    await expect(
      settled(throwaway("throwaway.launch", { agentId: "claude" }))
    ).resolves.toMatchObject({ outcome: "opted_out", callId: null });
    expect(throwaways.effects).toEqual([]);
  });
});

describe("host.list reading a host's agents over the link (#14455)", () => {
  const list = async (projectId?: string) => {
    const listed = await shell.runtime.list("help-a", { includeAgents: true, projectId });
    if (!listed.ok) throw new Error("refused");
    return listed.value.hosts[0]?.agents;
  };

  it("lists the host's assistants under this Shell's id for it, opening nothing there", async () => {
    const agents = await list(PROJECT);
    expect(agentReads).toEqual([{ projectId: PROJECT }]);
    expect(agents).toMatchObject({ coverage: "ok", observedAt: 77, complete: true, omitted: 0 });
    expect(agents?.entries).toEqual([
      {
        ...HOST_AGENTS.entries[0],
        subject: { ...HOST_AGENTS.entries[0]!.subject, hostId: HOST_ID },
      },
    ]);
    expect(arrivals.sessionsOpened).toBe(0);
    expect(arrivals.mcpCalls).toBe(0);
  });

  it("answers a read the host couldn't make with the last one, marked stale", async () => {
    await list();
    agentReadFails.value = true;
    expect(await list()).toMatchObject({ coverage: "stale", observedAt: 77, complete: false });
  });

  it("reads nothing past the host's consent, and keeps nothing it read before", async () => {
    await list();
    destination.accepts = false;
    expect(await list()).toMatchObject({ coverage: "unreachable", entries: [] });
    // The host refuses before reading.
    expect(agentReads).toHaveLength(1);
    destination.accepts = true;
    agentReadFails.value = true;
    expect(await list()).toMatchObject({ coverage: "unreachable", entries: [] });
  });

  it("asks nothing past the Shell's control switch, and keeps nothing it read before", async () => {
    await list();
    control.delete(HOST_ID);
    expect(await list()).toMatchObject({ coverage: "unreachable", entries: [] });
    expect(agentReads).toHaveLength(1);
    control.add(HOST_ID);
    agentReadFails.value = true;
    expect(await list()).toMatchObject({ coverage: "unreachable", entries: [] });
  });
});
