// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import {
  useFleetRunStore,
  subscribeFleetRunWatcher,
  summarizeFleetRun,
  FLEET_HOST_OBSERVE_INTERVAL_MS,
  FLEET_HOST_OBSERVE_LIMIT_MS,
  FLEET_HOST_SETTLE_GRACE_MS,
} from "@/store/fleetRunStore";
import { RUN_HISTORY_DRAFT_PREVIEW_MAX_LENGTH } from "@shared/types/ipc/runHistory";
import type { FleetExecutionResult } from "@/components/Fleet/fleetExecution";
import type { PtyPanelData } from "@shared/types/panel";
import type { AgentState } from "@shared/types/agent";

const appendMock = vi.fn<(input: unknown) => Promise<void>>();

function makeAgent(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: `title-${id}`,
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "working",
    hasPty: true,
    ...overrides,
  } as PtyPanelData;
}

function seedPanels(terminals: PtyPanelData[]): void {
  const panelsById: Record<string, PtyPanelData> = {};
  for (const t of terminals) panelsById[t.id] = t;
  usePanelStore.setState({ panelsById, panelIds: terminals.map((t) => t.id) });
}

function setAgentState(id: string, agentState: AgentState): void {
  const { panelsById, panelIds } = usePanelStore.getState();
  const panel = panelsById[id] as PtyPanelData;
  usePanelStore.setState({
    panelsById: { ...panelsById, [id]: { ...panel, agentState } },
    panelIds,
  });
}

function removePanel(id: string): void {
  const { panelsById, panelIds } = usePanelStore.getState();
  const next = { ...panelsById };
  delete next[id];
  usePanelStore.setState({ panelsById: next, panelIds: panelIds.filter((p) => p !== id) });
}

function makeResult(
  perTarget: FleetExecutionResult["perTarget"],
  overrides: Partial<FleetExecutionResult> = {}
): FleetExecutionResult {
  const successCount = perTarget.filter((t) => t.status === "fulfilled").length;
  return {
    total: perTarget.length,
    successCount,
    failureCount: perTarget.length - successCount,
    perTarget,
    failedIds: perTarget.filter((t) => t.status === "rejected").map((t) => t.terminalId),
    permanentlyFailedIds: perTarget.filter((t) => t.kind === "permanent").map((t) => t.terminalId),
    transientlyFailedIds: perTarget.filter((t) => t.kind === "transient").map((t) => t.terminalId),
    cancelled: false,
    skippedCount: 0,
    ...overrides,
  };
}

function lastAppendedRecord(): Record<string, unknown> {
  expect(appendMock).toHaveBeenCalled();
  return appendMock.mock.calls[appendMock.mock.calls.length - 1]![0] as Record<string, unknown>;
}

beforeEach(() => {
  appendMock.mockReset();
  appendMock.mockResolvedValue(undefined);
  useFleetRunStore.getState()._reset();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
    crossHostTargets: [],
  });
  useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
  Object.assign(window, {
    electron: { runHistory: { append: (input: unknown) => appendMock(input) } },
  });
});

describe("beginRun", () => {
  it("creates a submitting run with panel snapshots, deduping duplicate ids", () => {
    seedPanels([makeAgent("a"), makeAgent("b", { worktreeId: "wt-2" })]);
    const runId = useFleetRunStore.getState().beginRun(["a", "b", "a"], { draft: "hello" });
    const run = useFleetRunStore.getState().run!;
    expect(run.runId).toBe(runId);
    expect(run.status).toBe("submitting");
    expect(run.isRetry).toBe(false);
    expect(run.draftPreview).toBe("hello");
    expect(run.targets.map((t) => t.terminalId)).toEqual(["a", "b"]);
    expect(run.targets[0]!.title).toBe("title-a");
    expect(run.targets[1]!.worktreeId).toBe("wt-2");
    expect(run.targets[0]!.agentState).toBe("working");
  });

  it("caps the stored draft preview at the run-history limit", () => {
    seedPanels([makeAgent("a")]);
    useFleetRunStore
      .getState()
      .beginRun(["a"], { draft: "x".repeat(RUN_HISTORY_DRAFT_PREVIEW_MAX_LENGTH + 50) });
    expect(useFleetRunStore.getState().run!.draftPreview.length).toBe(
      RUN_HISTORY_DRAFT_PREVIEW_MAX_LENGTH
    );
  });

  it("supersedes a watching run and records it to run history immediately", () => {
    seedPanels([makeAgent("a")]);
    const first = useFleetRunStore.getState().beginRun(["a"], { draft: "one" });
    useFleetRunStore
      .getState()
      .applySubmissionResult(first, makeResult([{ terminalId: "a", status: "fulfilled" }]));
    expect(useFleetRunStore.getState().run!.status).toBe("watching");
    expect(appendMock).not.toHaveBeenCalled();

    const second = useFleetRunStore.getState().beginRun(["a"], { draft: "two" });
    expect(useFleetRunStore.getState().run!.runId).toBe(second);
    const record = lastAppendedRecord();
    expect(record.status).toBe("superseded");
    expect(record.runId).toBe(first);
  });

  it("holds a run superseded mid-submission until its outcomes arrive, then records them", () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    const first = useFleetRunStore.getState().beginRun(["a", "b"], { draft: "one" });
    // Pre-empted before executeFleetBroadcast resolved — no record yet.
    const second = useFleetRunStore.getState().beginRun(["a", "b"], { draft: "two" });
    expect(appendMock).not.toHaveBeenCalled();

    // The aborted broadcast's result lands late (stale runId): one batch was
    // dispatched before the abort. The superseded record must carry it.
    useFleetRunStore
      .getState()
      .applySubmissionResult(
        first,
        makeResult([{ terminalId: "a", status: "fulfilled" }], { cancelled: true, skippedCount: 1 })
      );
    const record = lastAppendedRecord();
    expect(record.status).toBe("superseded");
    expect(record.runId).toBe(first);
    expect(record.successCount).toBe(1);
    const perTarget = record.perTarget as Array<Record<string, unknown>>;
    expect(perTarget).toHaveLength(1);
    expect(perTarget[0]).toMatchObject({ terminalId: "a", status: "fulfilled" });

    // The current run is untouched by the stale result.
    const current = useFleetRunStore.getState().run!;
    expect(current.runId).toBe(second);
    expect(current.status).toBe("submitting");
  });
});

describe("applySubmissionResult", () => {
  it("splits sent / failed(kind) / skipped and enters watching while agents work", () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c"), makeAgent("d")]);
    const runId = useFleetRunStore.getState().beginRun(["a", "b", "c", "d"], { draft: "hello" });
    useFleetRunStore.getState().applySubmissionResult(
      runId,
      makeResult(
        [
          { terminalId: "a", status: "fulfilled" },
          { terminalId: "b", status: "rejected", reason: "EPIPE", kind: "permanent" },
          { terminalId: "c", status: "rejected", reason: "ENOSPC", kind: "transient" },
        ],
        { cancelled: true, skippedCount: 1 }
      )
    );
    // cancelled: true finalizes immediately — use a fresh non-cancelled run
    // below for the watching assertion; here we assert the split + skip.
    const run = useFleetRunStore.getState().run!;
    expect(run.status).toBe("cancelled");
    const byId = new Map(run.targets.map((t) => [t.terminalId, t]));
    expect(byId.get("a")!.submission).toBe("sent");
    expect(byId.get("b")!.submission).toBe("failed");
    expect(byId.get("b")!.failureKind).toBe("permanent");
    expect(byId.get("c")!.failureKind).toBe("transient");
    expect(byId.get("c")!.failureReason).toBe("ENOSPC");
    expect(byId.get("d")!.submission).toBe("skipped");
    const record = lastAppendedRecord();
    expect(record.status).toBe("cancelled");
    expect(record.cancelled).toBe(true);
  });

  it("enters watching when a sent agent is still working", () => {
    seedPanels([makeAgent("a", { agentState: "working" })]);
    const runId = useFleetRunStore.getState().beginRun(["a"], { draft: "go" });
    useFleetRunStore
      .getState()
      .applySubmissionResult(runId, makeResult([{ terminalId: "a", status: "fulfilled" }]));
    expect(useFleetRunStore.getState().run!.status).toBe("watching");
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("completes immediately when every sent agent is already at rest", () => {
    seedPanels([makeAgent("a", { agentState: "completed" })]);
    const runId = useFleetRunStore.getState().beginRun(["a"], { draft: "go" });
    useFleetRunStore
      .getState()
      .applySubmissionResult(runId, makeResult([{ terminalId: "a", status: "fulfilled" }]));
    const run = useFleetRunStore.getState().run!;
    expect(run.status).toBe("completed");
    expect(run.endedAt).toBeDefined();
    expect(lastAppendedRecord().status).toBe("completed");
  });

  it("finalizes as failed when no target accepted the write", () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    const runId = useFleetRunStore.getState().beginRun(["a", "b"], { draft: "go" });
    useFleetRunStore.getState().applySubmissionResult(
      runId,
      makeResult([
        { terminalId: "a", status: "rejected", reason: "EPIPE", kind: "permanent" },
        { terminalId: "b", status: "rejected", reason: "ENOSPC", kind: "transient" },
      ])
    );
    expect(useFleetRunStore.getState().run!.status).toBe("failed");
    const record = lastAppendedRecord();
    expect(record.status).toBe("failed");
    expect(record.failureCount).toBe(2);
    expect(record.successCount).toBe(0);
  });

  it("ignores a stale runId", () => {
    seedPanels([makeAgent("a")]);
    useFleetRunStore.getState().beginRun(["a"], { draft: "current" });
    useFleetRunStore
      .getState()
      .applySubmissionResult("not-the-run", makeResult([{ terminalId: "a", status: "fulfilled" }]));
    expect(useFleetRunStore.getState().run!.status).toBe("submitting");
  });
});

describe("reconcile / watching phase", () => {
  function startWatchingRun(ids: string[]): string {
    // Runs normally execute against an armed fleet; arming keeps the
    // finalized summary visible (a drained fleet clears it — see below).
    useFleetArmingStore.getState().armIds(ids);
    const runId = useFleetRunStore.getState().beginRun(ids, { draft: "go" });
    useFleetRunStore
      .getState()
      .applySubmissionResult(
        runId,
        makeResult(ids.map((id) => ({ terminalId: id, status: "fulfilled" as const })))
      );
    expect(useFleetRunStore.getState().run!.status).toBe("watching");
    return runId;
  }

  it("settles targets as they leave working and completes when all settled", () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    startWatchingRun(["a", "b"]);

    setAgentState("a", "completed");
    useFleetRunStore.getState().reconcile();
    let run = useFleetRunStore.getState().run!;
    expect(run.status).toBe("watching");
    expect(run.targets.find((t) => t.terminalId === "a")!.settled).toBe(true);
    expect(run.targets.find((t) => t.terminalId === "b")!.settled).toBe(false);

    setAgentState("b", "waiting");
    useFleetRunStore.getState().reconcile();
    run = useFleetRunStore.getState().run!;
    expect(run.status).toBe("completed");
    expect(lastAppendedRecord().status).toBe("completed");
    expect(useAnnouncerStore.getState().polite?.msg).toBe(
      "Fleet run finished — 1 waiting for input"
    );
  });

  it("counts waiting as settled but keeps it distinct from done", () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    startWatchingRun(["a", "b"]);
    setAgentState("a", "waiting");
    setAgentState("b", "completed");
    useFleetRunStore.getState().reconcile();
    const counts = summarizeFleetRun(useFleetRunStore.getState().run!);
    expect(counts.waiting).toBe(1);
    expect(counts.done).toBe(1);
    expect(counts.working).toBe(0);
  });

  it("does not un-settle a target whose agent resumes working (ratchet)", () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    startWatchingRun(["a", "b"]);
    setAgentState("a", "waiting");
    useFleetRunStore.getState().reconcile();
    expect(useFleetRunStore.getState().run!.targets[0]!.settled).toBe(true);

    // The user answered the prompt and the agent resumed — the run keeps the
    // target settled (bounded-wait semantics), only its live state updates.
    setAgentState("a", "working");
    useFleetRunStore.getState().reconcile();
    const target = useFleetRunStore.getState().run!.targets[0]!;
    expect(target.settled).toBe(true);
    expect(target.agentState).toBe("working");
  });

  it("marks a vanished panel gone and settled", () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    startWatchingRun(["a", "b"]);
    removePanel("a");
    useFleetRunStore.getState().reconcile();
    const target = useFleetRunStore.getState().run!.targets[0]!;
    expect(target.gone).toBe(true);
    expect(target.settled).toBe(true);
  });

  it("records per-target final agent state and failure kinds in run history", () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    const runId = useFleetRunStore.getState().beginRun(["a", "b", "c"], {
      draft: "go",
      isRetry: true,
    });
    useFleetRunStore.getState().applySubmissionResult(
      runId,
      makeResult([
        { terminalId: "a", status: "fulfilled" },
        { terminalId: "b", status: "fulfilled" },
        { terminalId: "c", status: "rejected", reason: "EPIPE", kind: "permanent" },
      ])
    );
    setAgentState("a", "completed");
    setAgentState("b", "waiting");
    useFleetRunStore.getState().reconcile();

    const record = lastAppendedRecord();
    expect(record.kind).toBe("fleet");
    expect(record.runId).toBe(runId);
    expect(record.isRetry).toBe(true);
    expect(record.draftPreview).toBe("go");
    const perTarget = record.perTarget as Array<Record<string, unknown>>;
    expect(perTarget).toHaveLength(3);
    expect(perTarget[0]).toMatchObject({
      terminalId: "a",
      status: "fulfilled",
      finalAgentState: "completed",
      title: "title-a",
    });
    expect(perTarget[1]).toMatchObject({ terminalId: "b", finalAgentState: "waiting" });
    expect(perTarget[2]).toMatchObject({
      terminalId: "c",
      status: "rejected",
      failureKind: "permanent",
      reason: "EPIPE",
    });
    // Rejected targets carry no agent-state claim — nothing was submitted.
    expect(perTarget[2]!.finalAgentState).toBeUndefined();
  });

  it("appends run history exactly once per run", () => {
    seedPanels([makeAgent("a")]);
    startWatchingRun(["a"]);
    setAgentState("a", "completed");
    useFleetRunStore.getState().reconcile();
    useFleetRunStore.getState().reconcile();
    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  it("records but does not retain a run that finishes after the fleet drained", () => {
    seedPanels([makeAgent("a")]);
    startWatchingRun(["a"]);
    // User exits fleet mode while the agent is still working.
    useFleetArmingStore.getState().clear();
    setAgentState("a", "completed");
    useFleetRunStore.getState().reconcile();
    // History and announcement still fire; no stale summary lingers for the
    // next fleet the user arms.
    expect(lastAppendedRecord().status).toBe("completed");
    expect(useFleetRunStore.getState().run).toBeNull();
  });
});

describe("dismiss", () => {
  it("is a no-op while the run is in flight", () => {
    seedPanels([makeAgent("a")]);
    const runId = useFleetRunStore.getState().beginRun(["a"], { draft: "go" });
    useFleetRunStore
      .getState()
      .applySubmissionResult(runId, makeResult([{ terminalId: "a", status: "fulfilled" }]));
    useFleetRunStore.getState().dismiss();
    expect(useFleetRunStore.getState().run).not.toBeNull();
  });

  it("clears a finalized run", () => {
    seedPanels([makeAgent("a", { agentState: "idle" })]);
    const runId = useFleetRunStore.getState().beginRun(["a"], { draft: "go" });
    useFleetRunStore
      .getState()
      .applySubmissionResult(runId, makeResult([{ terminalId: "a", status: "fulfilled" }]));
    expect(useFleetRunStore.getState().run!.status).toBe("completed");
    useFleetRunStore.getState().dismiss();
    expect(useFleetRunStore.getState().run).toBeNull();
  });
});

describe("subscribeFleetRunWatcher", () => {
  it("reconciles on panel-store changes and completes the run", () => {
    seedPanels([makeAgent("a")]);
    useFleetArmingStore.getState().armIds(["a"]);
    const unsubscribe = subscribeFleetRunWatcher();
    try {
      const runId = useFleetRunStore.getState().beginRun(["a"], { draft: "go" });
      useFleetRunStore
        .getState()
        .applySubmissionResult(runId, makeResult([{ terminalId: "a", status: "fulfilled" }]));
      expect(useFleetRunStore.getState().run!.status).toBe("watching");

      // The watcher reacts to the panel-store update — no manual reconcile.
      setAgentState("a", "completed");
      expect(useFleetRunStore.getState().run!.status).toBe("completed");
    } finally {
      unsubscribe();
    }
  });

  it("dismisses a finalized summary when the fleet drains, but keeps a watching run", () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    useFleetArmingStore.getState().armIds(["a", "b"]);
    const unsubscribe = subscribeFleetRunWatcher();
    try {
      // Watching run survives a drain — its agents are still working and the
      // history record is still owed.
      const first = useFleetRunStore.getState().beginRun(["a"], { draft: "go" });
      useFleetRunStore
        .getState()
        .applySubmissionResult(first, makeResult([{ terminalId: "a", status: "fulfilled" }]));
      expect(useFleetRunStore.getState().run!.status).toBe("watching");
      useFleetArmingStore.getState().clear();
      expect(useFleetRunStore.getState().run!.status).toBe("watching");

      // Finalized summary is dismissed by the next drain.
      setAgentState("a", "completed");
      expect(useFleetRunStore.getState().run).toBeNull();

      useFleetArmingStore.getState().armIds(["a", "b"]);
      const second = useFleetRunStore.getState().beginRun(["b"], { draft: "again" });
      seedPanels([makeAgent("a"), makeAgent("b", { agentState: "completed" })]);
      useFleetRunStore
        .getState()
        .applySubmissionResult(second, makeResult([{ terminalId: "b", status: "fulfilled" }]));
      expect(useFleetRunStore.getState().run!.status).toBe("completed");
      useFleetArmingStore.getState().clear();
      expect(useFleetRunStore.getState().run).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it("stops reconciling after unsubscribe", () => {
    seedPanels([makeAgent("a")]);
    useFleetArmingStore.getState().armIds(["a"]);
    const unsubscribe = subscribeFleetRunWatcher();
    const runId = useFleetRunStore.getState().beginRun(["a"], { draft: "go" });
    useFleetRunStore
      .getState()
      .applySubmissionResult(runId, makeResult([{ terminalId: "a", status: "fulfilled" }]));
    unsubscribe();
    setAgentState("a", "completed");
    expect(useFleetRunStore.getState().run!.status).toBe("watching");
  });
});

describe("history resilience", () => {
  it("does not throw when window.electron.runHistory is unavailable", () => {
    Object.assign(window, { electron: undefined });
    seedPanels([makeAgent("a", { agentState: "idle" })]);
    const runId = useFleetRunStore.getState().beginRun(["a"], { draft: "go" });
    expect(() =>
      useFleetRunStore
        .getState()
        .applySubmissionResult(runId, makeResult([{ terminalId: "a", status: "fulfilled" }]))
    ).not.toThrow();
    expect(useFleetRunStore.getState().run!.status).toBe("completed");
  });
});

describe("agents on other hosts", () => {
  const REMOTE = "host-fleet:studio-01:t1";

  function armRemote(): void {
    useFleetArmingStore.getState().armCrossHostTarget({
      key: REMOTE,
      hostId: "studio-01",
      hostName: "studio-01",
      terminalId: "t1",
      title: "Claude",
    });
  }

  function startMixedRun(): string {
    seedPanels([makeAgent("a", { agentState: "working" })]);
    useFleetArmingStore.getState().armId("a");
    armRemote();
    const runId = useFleetRunStore.getState().beginRun(["a", REMOTE], { draft: "go" });
    useFleetRunStore.getState().applySubmissionResult(
      runId,
      makeResult([
        { terminalId: "a", status: "fulfilled" },
        { terminalId: REMOTE, status: "fulfilled" },
      ])
    );
    return runId;
  }

  it("is sent but unobserved after submission, never done because it has no panel here", () => {
    armRemote();
    const runId = useFleetRunStore.getState().beginRun([REMOTE], { draft: "go" });
    useFleetRunStore
      .getState()
      .applySubmissionResult(runId, makeResult([{ terminalId: REMOTE, status: "fulfilled" }]));
    const run = useFleetRunStore.getState().run!;
    expect(run.status).toBe("watching");
    expect(run.targets[0]).toMatchObject({
      settled: false,
      gone: false,
      title: "Claude · studio-01",
    });
    const counts = summarizeFleetRun(run);
    expect(counts).toMatchObject({ sent: 1, unobserved: 1, done: 0, working: 0 });
    useFleetRunStore.getState().reconcile();
    expect(useFleetRunStore.getState().run!.status).toBe("watching");
  });

  it("does not let a mixed run finish when only this view's panes have settled", () => {
    startMixedRun();
    setAgentState("a", "completed");
    useFleetRunStore.getState().reconcile();
    const run = useFleetRunStore.getState().run!;
    expect(run.status).toBe("watching");
    expect(summarizeFleetRun(run)).toMatchObject({ done: 1, unobserved: 1 });
  });

  it("follows what the host reports, and finishes once it reports the agent at rest", () => {
    const runId = startMixedRun();
    setAgentState("a", "completed");
    useFleetRunStore.getState().reconcile();
    const startedAt = useFleetRunStore.getState().run!.startedAt;
    // Seen at rest before the grace: it may not have picked the prompt up yet.
    useFleetRunStore
      .getState()
      .observeHost("studio-01", [{ terminalId: "t1", agentState: "idle" }], startedAt + 1);
    expect(useFleetRunStore.getState().run!.status).toBe("watching");
    // At rest before it could have started reads as sent, not working.
    expect(summarizeFleetRun(useFleetRunStore.getState().run!)).toMatchObject({
      working: 0,
      unobserved: 1,
    });
    useFleetRunStore
      .getState()
      .observeHost("studio-01", [{ terminalId: "t1", agentState: "working" }], startedAt + 2);
    expect(summarizeFleetRun(useFleetRunStore.getState().run!)).toMatchObject({
      working: 1,
      unobserved: 0,
    });
    useFleetRunStore
      .getState()
      .observeHost("studio-01", [{ terminalId: "t1", agentState: "waiting" }], startedAt + 3);
    const run = useFleetRunStore.getState().run!;
    expect(run.runId).toBe(runId);
    expect(run.status).toBe("completed");
    expect(summarizeFleetRun(run)).toMatchObject({ waiting: 1, done: 1 });
  });

  it("measures the settle grace from when the host took the submit, not from the run's start", () => {
    vi.useFakeTimers();
    try {
      seedPanels([makeAgent("a", { agentState: "completed" })]);
      armRemote();
      const runId = useFleetRunStore.getState().beginRun(["a", REMOTE], { draft: "go" });
      const startedAt = useFleetRunStore.getState().run!.startedAt;
      // The submit spent a reconnect's worth of time in flight.
      vi.setSystemTime(startedAt + FLEET_HOST_SETTLE_GRACE_MS * 2);
      useFleetRunStore.getState().applySubmissionResult(
        runId,
        makeResult([
          { terminalId: "a", status: "fulfilled" },
          { terminalId: REMOTE, status: "fulfilled" },
        ])
      );
      useFleetRunStore
        .getState()
        .observeHost(
          "studio-01",
          [{ terminalId: "t1", agentState: "idle" }],
          startedAt + FLEET_HOST_SETTLE_GRACE_MS * 2 + 1
        );
      expect(useFleetRunStore.getState().run!.status).toBe("watching");
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles an agent the host no longer lists as gone, but not on a list cut short", () => {
    startMixedRun();
    setAgentState("a", "completed");
    useFleetRunStore.getState().reconcile();
    const at = useFleetRunStore.getState().run!.startedAt + FLEET_HOST_SETTLE_GRACE_MS;
    useFleetRunStore.getState().observeHost("studio-01", [], at, false);
    expect(useFleetRunStore.getState().run!.status).toBe("watching");
    useFleetRunStore.getState().observeHost("studio-01", [], at);
    const run = useFleetRunStore.getState().run!;
    expect(run.status).toBe("completed");
    expect(run.targets.find((t) => t.terminalId === REMOTE)).toMatchObject({ gone: true });
  });

  it("asks the host while it waits on it, and stops asking after the limit", async () => {
    vi.useFakeTimers();
    try {
      const listFleetTargets = vi.fn(async () => ({
        targets: [
          {
            hostId: "studio-01",
            terminalId: "t1",
            title: "Claude",
            projectId: null,
            projectName: null,
            agentId: "claude",
            agentState: "working" as const,
          },
        ],
        complete: true,
      }));
      Object.assign(window, {
        electron: {
          runHistory: { append: (input: unknown) => appendMock(input) },
          hostMetrics: { listFleetTargets },
        },
      });
      const unsubscribe = subscribeFleetRunWatcher();
      startMixedRun();
      await vi.advanceTimersByTimeAsync(FLEET_HOST_OBSERVE_INTERVAL_MS);
      expect(listFleetTargets).toHaveBeenCalledWith({ hostId: "studio-01" });
      expect(summarizeFleetRun(useFleetRunStore.getState().run!).unobserved).toBe(0);
      setAgentState("a", "completed");
      await vi.advanceTimersByTimeAsync(FLEET_HOST_OBSERVE_LIMIT_MS);
      const run = useFleetRunStore.getState().run!;
      expect(run.status).toBe("completed");
      // Last seen working is not how it ended: it reads as sent, not done.
      expect(summarizeFleetRun(run)).toMatchObject({ unobserved: 1, done: 1 });
      const calls = listFleetTargets.mock.calls.length;
      await vi.advanceTimersByTimeAsync(FLEET_HOST_OBSERVE_INTERVAL_MS * 3);
      expect(listFleetTargets.mock.calls.length).toBe(calls);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a target the host's degraded read omitted unobserved, not gone", async () => {
    vi.useFakeTimers();
    try {
      let complete = false;
      const listFleetTargets = vi.fn(async () => ({ targets: [], complete }));
      Object.assign(window, {
        electron: {
          runHistory: { append: (input: unknown) => appendMock(input) },
          hostMetrics: { listFleetTargets },
        },
      });
      const unsubscribe = subscribeFleetRunWatcher();
      startMixedRun();
      setAgentState("a", "completed");
      useFleetRunStore.getState().reconcile();
      await vi.advanceTimersByTimeAsync(FLEET_HOST_OBSERVE_INTERVAL_MS * 3);
      expect(listFleetTargets).toHaveBeenCalled();
      let run = useFleetRunStore.getState().run!;
      expect(run.status).toBe("watching");
      expect(run.targets.find((t) => t.terminalId === REMOTE)?.gone).not.toBe(true);
      complete = true;
      await vi.advanceTimersByTimeAsync(FLEET_HOST_OBSERVE_INTERVAL_MS);
      run = useFleetRunStore.getState().run!;
      expect(run.targets.find((t) => t.terminalId === REMOTE)).toMatchObject({ gone: true });
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never asks any host when the run has only this view's panes", async () => {
    vi.useFakeTimers();
    try {
      const listFleetTargets = vi.fn(async () => ({ targets: [], complete: true }));
      Object.assign(window, {
        electron: {
          runHistory: { append: (input: unknown) => appendMock(input) },
          hostMetrics: { listFleetTargets },
        },
      });
      const unsubscribe = subscribeFleetRunWatcher();
      seedPanels([makeAgent("a", { agentState: "working" })]);
      useFleetArmingStore.getState().armId("a");
      const runId = useFleetRunStore.getState().beginRun(["a"], { draft: "go" });
      useFleetRunStore
        .getState()
        .applySubmissionResult(runId, makeResult([{ terminalId: "a", status: "fulfilled" }]));
      await vi.advanceTimersByTimeAsync(FLEET_HOST_OBSERVE_INTERVAL_MS * 3);
      expect(listFleetTargets).not.toHaveBeenCalled();
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
