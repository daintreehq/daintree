import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real helper consults the global agent store for help terminals, which
// needs a live main process. No terminal here is one.
vi.mock("../../../services/assistantTerminal.js", () => ({
  isAssistantTerminalRecord: () => false,
}));

import {
  TerminalNotifyService,
  relayNoticePane,
  type LaneWake,
  type NotifyStateChange,
  type NotifyTerminalInfo,
  type RelayedNotice,
  type TerminalNotifyPtyClient,
} from "../../../services/mcp-server/terminalNotify.js";
import { formatHostNoticeLine } from "../../../services/mcp-server/noticeFormat.js";
import { buildViewlessTerminalStatus } from "../../../services/mcp-server/terminalStatus.js";
import {
  NOTIFY_COALESCE_MS,
  NOTIFY_TARGET_SETTLE_MS,
} from "../../../../shared/types/terminalNotify.js";
import type { AgentState, WaitingReason } from "../../../../shared/types/agent.js";
import type { TerminalStatusResult } from "../../../../shared/types/terminalStatus.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import { RelayNoticesPayloadSchema, type McpCallAnswer } from "../linkMethods.js";

const HOST_PROJECT = "proj-2";
const HOST_TERMINAL = "host-t-1";
const HOST_CLOCK = Date.parse("2026-10-18T10:00:00Z");
// Hours from the host's: a value that crossed machines would show it.
const SHELL_CLOCK = Date.parse("2026-10-18T13:27:41Z");

const RUN_A: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

const STUDIO: ObservedHost = {
  hostId: "studio",
  name: "studio-01",
  connection: { status: "disconnected" },
  lastSeenAt: null,
  summary: null,
};

type HostRecord = NotifyTerminalInfo & { id: string; spawnedAt: number };

/** The host's pty-host: its terminal records, moved the way `AgentStateService` moves them. */
class HostPtyHost implements TerminalNotifyPtyClient {
  readonly records = new Map<string, HostRecord>();
  readonly listeners = new Set<(payload: NotifyStateChange) => void>();

  /** Commits a transition to the record, then emits it under the same timestamp. */
  transition(id: string, state: AgentState, waitingReason?: WaitingReason): number {
    const record = this.records.get(id)!;
    const previousState = record.agentState ?? "idle";
    const timestamp = Date.now();
    record.agentState = state;
    record.waitingReason = waitingReason;
    record.lastStateChange = timestamp;
    for (const listener of [...this.listeners]) {
      listener({
        terminalId: id,
        state,
        previousState,
        timestamp,
        ...(waitingReason !== undefined ? { waitingReason } : {}),
      });
    }
    return timestamp;
  }

  async getTerminalAsync(id: string) {
    const record = this.records.get(id);
    return record === undefined ? null : { ...record };
  }
  submit() {}
  withdrawGuardedSubmission() {}
  on() {}
  off() {}

  /** What the host's `terminal.getStatus` reads: the same records. */
  get statusClient() {
    return {
      getTerminalProjectId: (id: string) => this.records.get(id)?.projectId ?? null,
      getTerminalsForProjectAsync: async (projectId: string) =>
        [...this.records.values()].filter((r) => r.projectId === projectId).map((r) => r.id),
      getTerminalAsync: async (id: string) => this.getTerminalAsync(id),
      getSerializedStateAsync: async () => null,
    };
  }
}

describe("a host notice's transition against the host's own status (#15726)", () => {
  let pty: HostPtyHost;
  let notify: TerminalNotifyService;
  let relayed: RelayedNotice[];
  let queued: LaneWake[];
  let runtime: HostCallRuntime;

  /** The link: a call relayed to the host comes back as the host answers it. */
  const relayCall = vi.fn(
    async (_hostId: string, payload: { tool: string; args: unknown }): Promise<McpCallAnswer> => {
      if (payload.tool !== "terminal.getStatus") {
        return { status: "done", result: { isError: false, structured: {}, text: null } };
      }
      const status = await buildViewlessTerminalStatus(
        { ptyClient: pty.statusClient as never },
        HOST_PROJECT,
        payload.args
      );
      return {
        status: "done",
        result: { isError: false, structured: JSON.parse(JSON.stringify(status)), text: null },
      };
    }
  );

  /** `terminal.getStatus` through `host.call`, as the Shell's assistant reads it. */
  async function hostStatus() {
    const settled = await runtime.call(
      "a",
      {
        hostId: "studio",
        projectId: HOST_PROJECT,
        tool: "terminal.getStatus",
        args: { terminalIds: [HOST_TERMINAL] },
      },
      { tier: "core" }
    );
    if (!settled.ok || settled.value.result === null) throw new Error("host.call failed");
    const [row] = (settled.value.result.structured as unknown as TerminalStatusResult).terminals;
    return row!;
  }

  /** What the host's outbox sends and the Shell's link parses. */
  function overTheWire(notices: readonly RelayedNotice[]) {
    const sent = { notices: notices.map((notice, i) => ({ noticeId: `n-${i + 1}`, ...notice })) };
    return RelayNoticesPayloadSchema.parse(JSON.parse(JSON.stringify(sent)));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(HOST_CLOCK);
    relayCall.mockClear();

    pty = new HostPtyHost();
    pty.records.set(HOST_TERMINAL, {
      id: HOST_TERMINAL,
      projectId: HOST_PROJECT,
      agentState: "working",
      lastStateChange: HOST_CLOCK - 60_000,
      spawnedAt: HOST_CLOCK - 120_000,
      detectedAgentId: "claude",
      hasPty: true,
    });
    notify = new TerminalNotifyService({
      getPtyClient: () => pty,
      onStateChanged: (listener) => {
        pty.listeners.add(listener);
        return () => pty.listeners.delete(listener);
      },
      onKilled: () => () => {},
      onTrashed: () => () => {},
      isEnabled: () => true,
      publish: () => {},
    });
    relayed = [];

    queued = [];
    let ids = 0;
    runtime = new HostCallRuntime({
      getSessionLane: (id) => (id === "a" ? { projectId: "proj-1", slot: 0 } : null),
      callerRun: (id) => (id === "a" ? RUN_A : null),
      client: () => ({ relayCall }) as never,
      hosts: () => [STUDIO],
      inLocalView: () => true,
      controlEnabled: () => true,
      queueNotice: (_lane, wake) => queued.push(wake),
      newId: () => `call-${++ids}`,
      now: () => SHELL_CLOCK,
    });
  });

  afterEach(() => {
    notify.dispose();
    vi.useRealTimers();
  });

  it("types the lastTransitionAt the host's terminal.getStatus answers through host.call for that state", async () => {
    // The Shell's call that asked for the notice, and the notice the host armed for it.
    await runtime.call(
      "a",
      {
        hostId: "studio",
        projectId: HOST_PROJECT,
        tool: "terminal.notifyWhenIdle",
        args: { terminalId: HOST_TERMINAL, notify: true },
      },
      { tier: "core" }
    );
    const pane = relayNoticePane("relay\u0000shell-1\u0000a", {
      projectId: HOST_PROJECT,
      helpSessionId: "a",
      callId: "call-1",
      deliver: (notices) => relayed.push(...notices),
    });
    await notify.whenIdle(pane, { terminalId: HOST_TERMINAL });

    const stoppedAt = pty.transition(HOST_TERMINAL, "waiting", "prompt");
    await vi.advanceTimersByTimeAsync(NOTIFY_TARGET_SETTLE_MS + NOTIFY_COALESCE_MS + 100);
    expect(relayed).toHaveLength(1);

    runtime.receiveNotices("studio", overTheWire(relayed));
    expect(queued).toHaveLength(1);
    const typed = queued[0]!.hostNotice!;
    const line = formatHostNoticeLine(typed.hostName, [typed.notice]);

    const sameState = await hostStatus();
    expect(sameState.agentState).toBe("waiting");
    expect(typed.notice.lastTransitionAt).toBe(sameState.lastTransitionAt);
    expect(sameState.lastTransitionAt).toBe(stoppedAt);
    expect(line).toContain(`(lastTransitionAt ${sameState.lastTransitionAt})`);

    // The terminal moves on before the line is typed: status then reads a
    // newer transition, and the notice still names the state it saw.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    pty.transition(HOST_TERMINAL, "working");
    await vi.advanceTimersByTimeAsync(30_000);
    pty.transition(HOST_TERMINAL, "waiting", "question");
    const later = await hostStatus();
    expect(later.lastTransitionAt).toBeGreaterThan(stoppedAt);
    expect(formatHostNoticeLine(typed.hostName, [typed.notice])).toBe(line);
  });
});
