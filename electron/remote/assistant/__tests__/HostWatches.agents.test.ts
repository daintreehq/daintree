import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostWatchArgs } from "../../../../shared/types/hostControl.js";
import type {
  AgentDirectory,
  AgentDirectoryLiveEntry,
} from "../../../../shared/types/agentDirectory.js";
import { NOTIFY_TARGET_SETTLE_MS } from "../../../../shared/types/terminalNotify.js";
import type { LaneWake } from "../../../services/mcp-server/terminalNotify.js";
import { formatHostWatchLine } from "../../../services/mcp-server/noticeFormat.js";
import type { AgentWaitingHeard, AgentWaitingListener } from "../../metrics/agentWaiting.js";
import type { ObservedHost, OpenRun } from "../HostCallRuntime.js";
import { HostWatches, type AgentWatchRead } from "../HostWatches.js";

const RUN: OpenRun = {
  projectId: "global",
  slot: 0,
  sessionId: "a",
  terminalId: "t-assistant",
  launchGeneration: 1,
};

const CONNECTED = { status: "connected", rttMs: 9 } as ObservedHost["connection"];

function host(hostId: string, name: string, connected = true): ObservedHost {
  return {
    hostId,
    name,
    connection: connected ? CONNECTED : { status: "disconnected" },
    lastSeenAt: null,
    summary: null,
  };
}

function waiting(
  terminalId: string,
  overrides: Partial<AgentDirectoryLiveEntry> & { projectId?: string } = {}
): AgentDirectoryLiveEntry {
  const { projectId = "proj-1", ...rest } = overrides;
  return {
    state: "live",
    role: "worker",
    subject: {
      hostId: "local",
      scope: { kind: "project", projectId },
      terminalId,
      incarnation: 3,
    },
    agentId: "claude",
    agentState: "waiting",
    waitingReason: "approval",
    since: 1_000,
    label: null,
    attached: null,
    handback: null,
    ...rest,
  };
}

function directory(entries: AgentDirectoryLiveEntry[], coverage: "ok" | "stale" = "ok") {
  return { coverage, observedAt: 1, complete: true, omitted: 0, entries } as AgentDirectory;
}

function heard(terminalId: string, overrides: Partial<AgentWaitingHeard> = {}): AgentWaitingHeard {
  return {
    source: "event",
    terminalId,
    projectId: "proj-1",
    worktreeId: "/work/app",
    incarnation: 3,
    agentIncarnation: 0,
    waitingReason: "approval",
    refined: false,
    seenAt: 5_000,
    ...overrides,
  };
}

describe("HostWatches on agents starting to wait (#16188)", () => {
  let now: number;
  let hosts: ObservedHost[];
  let control: Set<string>;
  let running: boolean;
  let listener: AgentWaitingListener | null;
  let agentSubscriptions: number;
  let linkSubscriptions: number;
  let reads: Map<string, AgentWatchRead | Promise<AgentWatchRead>>;
  let queued: LaneWake[];
  let ids: number;
  let watches: HostWatches;

  const make = () =>
    new HostWatches({
      hosts: () => hosts,
      controlOn: (hostId) => hostId === "local" || control.has(hostId),
      stillRunning: () => running,
      observe: () => {
        linkSubscriptions += 1;
        return () => {
          linkSubscriptions -= 1;
        };
      },
      observeAgents: (next) => {
        listener = next;
        agentSubscriptions += 1;
        return () => {
          listener = null;
          agentSubscriptions -= 1;
        };
      },
      readAgents: async (hostId) => (await reads.get(hostId)) ?? { status: "unread" },
      localName: () => "this Mac",
      queueNotice: (_lane, wake) => queued.push(wake),
      now: () => now,
      newId: () => `id-${++ids}`,
    });

  const arm = (args: Partial<HostWatchArgs> = {}) =>
    watches.armAgents(RUN, { operation: "arm", agentsWaiting: true, ...args });

  const advance = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = Date.parse("2026-11-03T10:00:00Z");
    hosts = [host("studio", "studio-01")];
    control = new Set(["studio"]);
    running = true;
    listener = null;
    agentSubscriptions = 0;
    linkSubscriptions = 0;
    reads = new Map<string, AgentWatchRead>([
      ["local", { status: "read", directory: directory([]), waitingEvents: true }],
      ["studio", { status: "read", directory: directory([]), waitingEvents: true }],
    ]);
    queued = [];
    ids = 0;
    watches = make();
  });

  afterEach(() => {
    watches.dispose();
    vi.useRealTimers();
  });

  it("listens to no agent until one is armed, and to nothing once it fires", async () => {
    await expect(
      watches.armAgents(RUN, { operation: "arm", hostId: "studio", connection: "disconnected" })
    ).resolves.toMatchObject({ outcome: "unsupported" });
    expect(
      watches.run(RUN, { operation: "arm", hostId: "studio", connection: "disconnected" })
    ).toMatchObject({ armed: true });
    expect(agentSubscriptions).toBe(0);

    const result = await arm();
    expect(result).toMatchObject({ outcome: "ok", armed: true });
    expect(result.watches[0]).toMatchObject({ hostId: null, hostName: null, status: "armed" });
    expect(agentSubscriptions).toBe(1);

    listener?.("studio", heard("t-1"));
    advance(NOTIFY_TARGET_SETTLE_MS);
    expect(queued).toHaveLength(1);
    expect(agentSubscriptions).toBe(0);
    // The link watch still holds its own listener and timer.
    expect(linkSubscriptions).toBe(1);
    watches.endSession("a");
    expect(watches.isActive()).toBe(false);
  });

  it("names who already waits for the reasons asked, and how each host is heard", async () => {
    hosts = [
      host("studio", "studio-01"),
      host("old", "old-box"),
      host("shy", "shy-box"),
      host("down", "down-box", false),
      host("mute", "mute-box"),
      host("off", "off-box"),
    ];
    control = new Set(["studio", "old", "shy", "down", "mute"]);
    reads.set("local", {
      status: "read",
      waitingEvents: true,
      directory: directory([
        waiting("t-local"),
        // The arming run's own pane is never named to it.
        waiting(RUN.terminalId, { role: "assistant" }),
        // The fallback reason and a working agent are not what it asked for.
        waiting("t-prompt", { waitingReason: "prompt" }),
        waiting("t-busy", { agentState: "working", waitingReason: null }),
      ]),
    });
    reads.set("studio", {
      status: "read",
      waitingEvents: true,
      directory: directory([
        waiting("t-q", {
          waitingReason: "question",
          subject: {
            hostId: "studio",
            scope: { kind: "project", projectId: "proj-2" },
            terminalId: "t-q",
            incarnation: 7,
          },
        }),
      ]),
    });
    reads.set("old", { status: "read", directory: directory([]), waitingEvents: false });
    reads.set("shy", { status: "refused" });
    reads.set("down", { status: "link-down" });
    reads.set("mute", { status: "unread" });

    const result = await arm();
    expect(result.agents?.matches).toEqual([
      expect.objectContaining({ hostId: "local", terminalId: "t-local", incarnation: 3 }),
      expect.objectContaining({
        hostId: "studio",
        projectId: "proj-2",
        terminalId: "t-q",
        incarnation: 7,
        agentIncarnation: null,
        waitingReason: "question",
        seenAt: 1_000,
      }),
    ]);
    expect(result.agents?.hosts).toEqual([
      { hostId: "local", name: "this Mac", hears: "events" },
      { hostId: "studio", name: "studio-01", hears: "events" },
      { hostId: "old", name: "old-box", hears: "older-host" },
      { hostId: "shy", name: "shy-box", hears: "host-refused" },
      { hostId: "down", name: "down-box", hears: "link-down" },
      { hostId: "mute", name: "mute-box", hears: "unread" },
    ]);
    // No notice comes for those already waiting.
    advance(NOTIFY_TARGET_SETTLE_MS * 2);
    expect(queued).toHaveLength(0);
  });

  it("names nobody from a directory read before, or a host switched off while it was read", async () => {
    reads.set("local", {
      status: "read",
      directory: directory([waiting("t-old")], "stale"),
      waitingEvents: true,
    });
    let finish!: (read: AgentWatchRead) => void;
    reads.set(
      "studio",
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = arm();
    await Promise.resolve();
    control.delete("studio");
    finish({
      status: "read",
      directory: directory([waiting("t-remote")]),
      waitingEvents: true,
    });
    const result = await pending;
    expect(result.agents?.matches).toEqual([]);
    expect(result.agents?.hosts.map((entry) => entry.hostId)).toEqual(["local"]);
  });

  it("hears a wait that starts while the arm still reads", async () => {
    let finish!: (read: AgentWatchRead) => void;
    reads.set(
      "studio",
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = arm();
    await Promise.resolve();
    expect(listener).not.toBeNull();
    listener?.("studio", heard("t-1"));
    finish({ status: "read", directory: directory([]), waitingEvents: true });
    await pending;
    advance(NOTIFY_TARGET_SETTLE_MS);
    expect(queued).toHaveLength(1);
  });

  it("reports a prompt that becomes an approval as the approval, once the settle ends", async () => {
    await arm({ note: "cover approvals" });
    listener?.("studio", heard("t-1", { waitingReason: "prompt" }));
    advance(NOTIFY_TARGET_SETTLE_MS * 3);
    // The fallback reason alone is not what it waits for.
    expect(queued).toHaveLength(0);

    listener?.("studio", heard("t-1", { waitingReason: "approval", refined: true, seenAt: 6_000 }));
    advance(NOTIFY_TARGET_SETTLE_MS - 1);
    expect(queued).toHaveLength(0);
    advance(1);
    expect(queued).toHaveLength(1);
    const notice = queued[0]!.hostWatch!;
    expect(notice.agents?.seen).toEqual([
      expect.objectContaining({
        hostId: "studio",
        hostName: "studio-01",
        terminalId: "t-1",
        waitingReason: "approval",
        seenAt: 6_000,
      }),
    ]);
    const line = formatHostWatchLine(notice);
    expect(line).toContain('terminal t-1 on host "studio-01"');
    expect(line).toContain("waiting on an approval");
    expect(line).toContain("by that host's clock");
    expect(line).toContain('Your note: "cover approvals"');
    expect(line).toMatch(/through host\.call/);
    expect(watches.run(RUN, { operation: "list" }).watches[0]).toMatchObject({ status: "fired" });
  });

  it("puts every wait that lands in one settle in one notice, each with its latest reason", async () => {
    await arm();
    listener?.("studio", heard("t-1", { waitingReason: "question" }));
    advance(500);
    listener?.("local", heard("t-2", { waitingReason: "approval" }));
    // One the settle holds turns into a reason it doesn't watch, and drops out.
    listener?.("studio", heard("t-3", { waitingReason: "approval" }));
    listener?.("studio", heard("t-3", { waitingReason: "prompt", refined: true }));
    advance(NOTIFY_TARGET_SETTLE_MS);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.hostWatch!.agents?.seen.map((agent) => agent.terminalId)).toEqual([
      "t-1",
      "t-2",
    ]);
    expect(formatHostWatchLine(queued[0]!.hostWatch!)).toContain("2 agents start waiting");
  });

  it("keeps watching when the settle ends on nothing it asked for", async () => {
    await arm();
    listener?.("studio", heard("t-1", { waitingReason: "question" }));
    listener?.("studio", heard("t-1", { waitingReason: "prompt", refined: true }));
    advance(NOTIFY_TARGET_SETTLE_MS);
    expect(queued).toHaveLength(0);
    expect(watches.run(RUN, { operation: "list" }).watches[0]).toMatchObject({ status: "armed" });
    listener?.("studio", heard("t-2"));
    advance(NOTIFY_TARGET_SETTLE_MS);
    expect(queued).toHaveLength(1);
  });

  it("hears only the host and project it was armed on, and never its own pane", async () => {
    await arm({ hostId: "studio", projectId: "proj-1", waitingReasons: ["approval", "error"] });
    listener?.("local", heard("t-local"));
    listener?.("studio", heard("t-other", { projectId: "proj-9" }));
    listener?.("studio", heard("t-error", { waitingReason: "error" }));
    advance(NOTIFY_TARGET_SETTLE_MS);
    expect(queued[0]!.hostWatch!.agents?.seen.map((agent) => agent.terminalId)).toEqual([
      "t-error",
    ]);

    queued = [];
    await watches.armAgents(RUN, { operation: "arm", agentsWaiting: true, hostId: "local" });
    listener?.("local", heard(RUN.terminalId));
    advance(NOTIFY_TARGET_SETTLE_MS);
    expect(queued).toHaveLength(0);
    listener?.("local", heard("t-worker"));
    advance(NOTIFY_TARGET_SETTLE_MS);
    expect(formatHostWatchLine(queued[0]!.hostWatch!)).toContain("terminal t-worker on this machine");
  });

  it("hears an older host's attention only for any reason, and never a host that sends its own", async () => {
    hosts = [host("studio", "studio-01"), host("old", "old-box")];
    control = new Set(["studio", "old"]);
    reads.set("old", { status: "unsupported" });
    const legacy = (terminalId: string) =>
      heard(terminalId, {
        source: "attention",
        waitingReason: null,
        incarnation: null,
        agentIncarnation: null,
        worktreeId: null,
        seenAt: null,
      });

    const filtered = await arm();
    expect(filtered.agents?.hosts).toContainEqual({
      hostId: "old",
      name: "old-box",
      hears: "older-host",
    });
    listener?.("old", legacy("t-old"));
    advance(NOTIFY_TARGET_SETTLE_MS);
    expect(queued).toHaveLength(0);
    watches.run(RUN, { operation: "cancel", watchId: filtered.watches[0]!.watchId });

    const any = await arm({ waitingReasons: ["any"] });
    expect(any.watches[0]!.condition.agentsWaiting).toEqual({
      waitingReasons: ["any"],
      projectId: null,
    });
    expect(any.agents?.hosts).toContainEqual({ hostId: "old", name: "old-box", hears: "attention" });
    // A host that sends its own waits is heard once, not again through the person's notice.
    listener?.("studio", legacy("t-new"));
    listener?.("old", legacy("t-old"));
    advance(NOTIFY_TARGET_SETTLE_MS);
    const seen = queued[0]!.hostWatch!.agents!.seen;
    expect(seen.map((agent) => agent.terminalId)).toEqual(["t-old"]);
    expect(formatHostWatchLine(queued[0]!.hostWatch!)).toMatch(
      /t-old on host "old-box" \(project proj-1\) waiting\./
    );
  });

  it("is lost with its one host's control, and on every host stops hearing the one switched off", async () => {
    const scoped = await arm({ hostId: "studio" });
    expect(scoped.watches[0]).toMatchObject({ hostId: "studio", hostName: "studio-01" });
    control.delete("studio");
    // Its next look, here the timer's, finds the switch off.
    advance(30 * 60_000);
    expect(queued[0]!.hostWatch).toMatchObject({ event: "lost", lostReason: "control-off" });

    queued = [];
    control.add("studio");
    await arm();
    control.delete("studio");
    listener?.("studio", heard("t-1"));
    advance(NOTIFY_TARGET_SETTLE_MS);
    expect(queued).toHaveLength(0);
  });

  it("types nothing a host showed once its control is turned off before the line goes", async () => {
    await arm();
    listener?.("studio", heard("t-1"));
    listener?.("local", heard("t-2"));
    advance(NOTIFY_TARGET_SETTLE_MS);
    const wake = queued[0]!;
    control.delete("studio");
    expect(wake.recheck()).toEqual({ kind: "ready" });
    expect(wake.hostWatch!.agents?.seen.map((agent) => agent.terminalId)).toEqual(["t-2"]);

    queued = [];
    control.add("studio");
    await arm();
    listener?.("studio", heard("t-3"));
    advance(NOTIFY_TARGET_SETTLE_MS);
    control.delete("studio");
    expect(queued[0]!.recheck()).toEqual({ kind: "unavailable", reason: "control-off" });
  });

  it("expires with a notice, and keeps one watch per scope and condition", async () => {
    const first = await arm({ expiresInSeconds: 60 });
    const again = await arm({ expiresInSeconds: 60 });
    expect(again.detail).toMatch(/already armed/);
    expect(again.watches[0]!.watchId).toBe(first.watches[0]!.watchId);
    const other = await arm({ waitingReasons: ["question", "approval", "question"] });
    expect(other.watches[0]!.watchId).toBe(first.watches[0]!.watchId);

    advance(60_000);
    expect(queued[0]!.hostWatch).toMatchObject({ event: "expired" });
    expect(formatHostWatchLine(queued[0]!.hostWatch!)).toMatch(
      /watch hw-id-1 on every host you control expired without seeing an agent start waiting on an approval or a question/
    );
    expect(watches.isActive()).toBe(false);
  });

  it("refuses an unknown host, one with control off, and a Shell that can't hear agents", async () => {
    await expect(arm({ hostId: "nope" })).resolves.toMatchObject({ outcome: "not_found" });
    control.clear();
    await expect(arm({ hostId: "studio" })).resolves.toMatchObject({ outcome: "opted_out" });
    const deaf = new HostWatches({
      hosts: () => hosts,
      controlOn: () => true,
      stillRunning: () => true,
      queueNotice: () => {},
      now: () => now,
      newId: () => "x",
    });
    await expect(
      deaf.armAgents(RUN, { operation: "arm", agentsWaiting: true })
    ).resolves.toMatchObject({ outcome: "unsupported" });
    expect(agentSubscriptions).toBe(0);
  });

  it("forgets a watch whose run was replaced, and never tells the successor", async () => {
    await arm();
    running = false;
    listener?.("studio", heard("t-1"));
    advance(NOTIFY_TARGET_SETTLE_MS);
    expect(queued).toHaveLength(0);
    expect(agentSubscriptions).toBe(0);
  });
});
