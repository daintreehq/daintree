import { describe, expect, it } from "vitest";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { CanopyCard, CanopyReadMark } from "@shared/types/ipc/canopy";
import type { AgentDirectory, AgentDirectoryLiveEntry } from "@shared/types/agentDirectory";
import { buildPilotGroups, type PilotRowContext } from "@/components/Pilot/pilotRows";
import { ALL_HOSTS_ID } from "@/store/canopyStore";
import { buildCanopyInbox, itemPriority, splitInbox, type CanopyItem } from "../canopyModel";
import { buildAssistantItems, type CanopyAssistantItem } from "../canopyAssistants";
import { allHostsKey } from "../canopyAllHosts";
import { placeOf } from "../canopyInboxPlace";
import {
  entryNeedsYou,
  entryShelved,
  isWorkerEntry,
  nextAfterEntry,
  projectCanopyInbox,
  stepEntry,
  type CanopyInboxEntry,
  type CanopyInboxProjectionInput,
} from "../canopyInboxProjection";

const NOW = 1_700_000_000_000;
const SPAWNED = NOW - 3_600_000;
const OWN = "mac";
const OTHER = "studio";

function run(runId: string, overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    runId,
    workspaceId: "p1",
    spawnedAt: SPAWNED,
    cwd: "/Users/dev/app",
    agentId: "claude",
    ...overrides,
  };
}

function card(runId: string, overrides: Partial<CanopyCard> = {}): CanopyCard {
  return {
    runId,
    spawnedAt: SPAWNED,
    revision: 1,
    category: "working",
    confidence: 0.9,
    attentionProbability: 0.9,
    attentionScore: null,
    priority: 90,
    task: null,
    risk: "unknown",
    riskReason: null,
    action: null,
    progress: null,
    steps: null,
    tests: "unknown",
    changes: "unknown",
    handledAt: null,
    wordsFromEarlierRead: false,
    priorityFromEarlierRead: false,
    stage: "described",
    wordsCategory: null,
    describing: false,
    headline: null,
    summary: null,
    question: null,
    options: [],
    secretPrompt: false,
    activity: null,
    glance: { recap: null, said: null, doing: null, action: null },
    statusLine: null,
    contextLeft: null,
    stalledSince: null,
    observedAt: NOW,
    ...overrides,
  };
}

const ctx: PilotRowContext = {
  workspaces: new Map([
    [allHostsKey(OWN, "p1"), { kind: "project", name: "app", emoji: "🌳" }],
    [allHostsKey(OTHER, "p1"), { kind: "project", name: "app", emoji: "🌳" }],
  ]),
  currentWorkspaceId: null,
  nowMs: NOW,
};

/** Runs as All hosts lists them: each id keyed by its host. */
function workers(
  runs: { host: string; run: FleetRunRow }[],
  cards: { host: string; card: CanopyCard }[] = [],
  reads: { host: string; mark: CanopyReadMark }[] = []
): CanopyItem[] {
  return buildCanopyInbox(
    buildPilotGroups(
      runs.map(({ host, run: r }) => ({
        ...r,
        runId: allHostsKey(host, r.runId),
        workspaceId: allHostsKey(host, r.workspaceId),
      })),
      ctx
    ),
    new Map(
      cards.map(({ host, card: c }) => {
        const runId = allHostsKey(host, c.runId);
        return [runId, { ...c, runId }];
      })
    ),
    undefined,
    new Map(),
    new Map(),
    NOW,
    new Map(),
    new Map(
      reads.map(({ host, mark }) => {
        const runId = allHostsKey(host, mark.runId);
        return [runId, { ...mark, runId }];
      })
    )
  );
}

function live(
  hostId: string,
  terminalId: string,
  overrides: Partial<AgentDirectoryLiveEntry> = {}
): AgentDirectoryLiveEntry {
  return {
    state: "live",
    role: "assistant",
    subject: { hostId, scope: { kind: "project", projectId: "p1" }, terminalId, incarnation: 1 },
    agentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    since: 100,
    label: null,
    attached: true,
    handback: null,
    ...overrides,
  };
}

function assistants(entries: AgentDirectoryLiveEntry[]): CanopyAssistantItem[] {
  const directory: AgentDirectory = {
    coverage: "ok",
    observedAt: NOW,
    complete: true,
    omitted: 0,
    entries,
  };
  return buildAssistantItems(directory, { projectName: () => "app", seen: {}, now: NOW });
}

function project(
  items: CanopyItem[],
  helpers: CanopyAssistantItem[],
  overrides: Partial<CanopyInboxProjectionInput> = {}
) {
  const { inbox, archived } = splitInbox(items);
  return projectCanopyInbox({
    ownHostId: OWN,
    workers: inbox,
    assistants: helpers,
    listedWorkers: inbox,
    shownAssistants: helpers,
    shownArchived: archived,
    workerPlace: (item) => placeOf(item, ALL_HOSTS_ID, OWN),
    ...overrides,
  });
}

const names = (entries: readonly CanopyInboxEntry[]) =>
  entries.map((entry) =>
    entry.role === "worker" ? `${entry.hostId ?? "own"}:${entry.item.row.run.runId}` : entry.key
  );

/** The items with these ids, in this order: a list as the user left it, not as ranked. */
const inOrder = (items: readonly CanopyItem[], ids: readonly string[]) =>
  ids.map((id) => items.find((item) => item.row.run.runId.endsWith(`.${id}`))!);

const approval = { agentState: "waiting", waitingReason: "approval", since: NOW - 5_000 } as const;

describe("projectCanopyInbox", () => {
  it("names every worker and assistant by its host and role, so ids shared across hosts never collide", () => {
    const items = workers([
      { host: OWN, run: run("t1", approval) },
      { host: OTHER, run: run("t1", approval) },
    ]);
    const helpers = assistants([live(OWN, "t1"), live(OTHER, "t1")]);
    const { inbox } = project(items, helpers);

    expect(new Set(inbox.map((entry) => entry.key)).size).toBe(4);
    expect(inbox.map((entry) => [entry.role, entry.hostId])).toEqual([
      ["worker", null],
      ["worker", OTHER],
      ["assistant", null],
      ["assistant", OTHER],
    ]);
  });

  it("gives a worker the same key in its own host's view as in All hosts", () => {
    const keyed = project(workers([{ host: OTHER, run: run("t1", approval) }]), []).inbox[0]!;
    const own = buildCanopyInbox(buildPilotGroups([run("t1", approval)], ctx), new Map());
    const single = projectCanopyInbox({
      ownHostId: OWN,
      workers: own,
      assistants: [],
      listedWorkers: own,
      shownAssistants: [],
      shownArchived: [],
      workerPlace: (item) => placeOf(item, OTHER, OWN),
    }).inbox[0]!;

    expect(single.key).toBe(keyed.key);
    expect(single.hostId).toBe(OTHER);
  });

  it("calls the window's own host null, however the place names it", () => {
    const items = workers([{ host: OWN, run: run("t1", approval) }]);
    const viaKey = project(items, []).inbox[0]!;
    const named = project(items, [], {
      workerPlace: () => ({ hostId: OWN, runId: "t1" }),
    }).inbox[0]!;

    expect(named.hostId).toBeNull();
    expect(named.key).toBe(viaKey.key);
  });

  it("holds what needs the user across hosts and roles, and leaves out a parked ask", () => {
    const items = workers([
      { host: OWN, run: run("ask", approval) },
      { host: OTHER, run: run("parked", { ...approval, park: { parkedAt: NOW } }) },
      { host: OTHER, run: run("busy", { agentState: "working", since: NOW - 60_000 }) },
    ]);
    const helpers = assistants([
      live(OWN, "a1", { agentState: "waiting", waitingReason: "question" }),
      live(OTHER, "a2"),
    ]);
    const projection = project(items, helpers);

    expect(names(projection.needsYou)).toEqual([`own:${allHostsKey(OWN, "ask")}`, helpers[0]!.id]);
    const parked = projection.inbox.find(
      (entry) => entry.role === "worker" && entry.item.row.run.runId.endsWith("parked")
    )!;
    expect(entryShelved(parked)).toBe(true);
    expect(entryNeedsYou(parked)).toBe(false);
    // Shelved is not hidden: it is still in the inbox and the keyboard's walk.
    expect(projection.navigation).toContain(parked);
  });

  it("never shelves an assistant, and counts it only for what its own run asks", () => {
    const helpers = assistants([
      live(OWN, "a1", { agentState: "waiting", waitingReason: "approval" }),
      live(OWN, "a2", { agentState: "working", waitingReason: null }),
    ]);
    const { inbox } = project([], helpers);

    expect(inbox.map(entryNeedsYou)).toEqual([true, false]);
    expect(inbox.map(entryShelved)).toEqual([false, false]);
  });

  it("drops a stale reading's ask once Daintree sees the run back at work", () => {
    const items = workers(
      [
        { host: OWN, run: run("moved", { agentState: "working", since: NOW - 1_000 }) },
        { host: OTHER, run: run("still", { ...approval, waitingReason: "question" }) },
      ],
      [
        {
          host: OWN,
          card: card("moved", {
            category: "question",
            priority: 88,
            question: "Ship it?",
            options: ["Yes", "No"],
            observedAt: NOW - 60_000,
          }),
        },
        {
          host: OTHER,
          card: card("still", {
            category: "question",
            priority: 88,
            observedAt: NOW - 60_000,
          }),
        },
      ]
    );
    const projection = project(items, []);
    const moved = projection.inbox.find((entry) => entry.key.includes("moved"))!;

    expect(moved.role === "worker" && moved.item.stale).toBe(true);
    expect(moved.role === "worker" && moved.item.card?.question).toBeNull();
    expect(entryNeedsYou(moved)).toBe(false);
    // A run that only went on waiting on the same kind of ask still holds it.
    expect(projection.needsYou.map((entry) => entry.key)).toEqual([
      JSON.stringify(["worker", OTHER, "still"]),
    ]);
  });

  it("ranks a busy run unlooked-at for a while without counting it, unlike a stalled one", () => {
    const busy = {
      agentState: "working",
      since: NOW - 3_000_000,
      spawnedAt: NOW - 3_000_000,
    } as const;
    const items = workers([
      { host: OWN, run: run("unseen", busy) },
      { host: OWN, run: run("quiet", { ...busy, quietSince: NOW - 600_000 }) },
    ]);
    const projection = project(items, []);
    const unseen = items.find((item) => item.runId.endsWith("unseen"))!;

    expect(itemPriority(unseen, NOW)).toBeGreaterThanOrEqual(55);
    expect(projection.needsYou.map((entry) => entry.key)).toEqual([
      JSON.stringify(["worker", OWN, "quiet"]),
    ]);
  });

  it("counts the whole inbox, whatever the filters list, and walks only what is listed", () => {
    const items = workers([
      { host: OWN, run: run("ask", approval) },
      { host: OTHER, run: run("other", approval) },
    ]);
    const helpers = assistants([
      live(OWN, "a1", { agentState: "waiting", waitingReason: "question" }),
    ]);
    const projection = project(items, helpers, { listedWorkers: [items[1]!], shownAssistants: [] });

    expect(projection.needsYou).toHaveLength(3);
    expect(names(projection.navigation)).toEqual([`${OTHER}:${allHostsKey(OTHER, "other")}`]);
  });

  it("walks listed workers, then assistants, then the archived runs shown", () => {
    const items = buildCanopyInbox(
      buildPilotGroups(
        [run("a", approval), run("b", { agentState: "idle" }), run("gone", { agentState: "idle" })],
        ctx
      ),
      new Map(),
      undefined,
      new Map([["gone", { runId: "gone", spawnedAt: SPAWNED, kind: "archived", at: NOW }]])
    );
    const helpers = assistants([live(OWN, "a1")]);
    const local = (overrides: Partial<CanopyInboxProjectionInput> = {}) =>
      project(items, helpers, { workerPlace: (item) => placeOf(item, null, OWN), ...overrides });

    expect(local().navigation.map((entry) => entry.role)).toEqual([
      "worker",
      "worker",
      "assistant",
      "worker",
    ]);
    expect(local().navigation.at(-1)!.key).toBe(JSON.stringify(["worker", OWN, "gone"]));
    expect(local({ shownArchived: [] }).navigation).toHaveLength(3);
    expect(local().inbox.some((entry) => entry.key.includes("gone"))).toBe(false);
  });

  it("hands back the same entry for a run in every list it is in", () => {
    const items = workers([{ host: OWN, run: run("ask", approval) }]);
    const helpers = assistants([
      live(OWN, "a1", { agentState: "waiting", waitingReason: "question" }),
    ]);
    const projection = project(items, helpers);

    expect(projection.inbox.filter(isWorkerEntry)).toHaveLength(1);
    for (const index of [0, 1]) {
      expect(projection.navigation[index]).toBe(projection.inbox[index]);
      expect(projection.needsYou[index]).toBe(projection.inbox[index]);
    }
  });
});

describe("stepEntry", () => {
  const order = project(
    workers([
      { host: OWN, run: run("a", approval) },
      { host: OTHER, run: run("b", approval) },
    ]),
    assistants([live(OWN, "a1")])
  ).navigation;

  it("steps across roles and clamps at both ends", () => {
    expect(stepEntry(order, order[1]!.key, 1)).toBe(order[2]);
    expect(stepEntry(order, order[2]!.key, -1)).toBe(order[1]);
    expect(stepEntry(order, order[2]!.key, 1)).toBe(order[2]);
    expect(stepEntry(order, order[0]!.key, -1)).toBe(order[0]);
  });

  it("enters at the top going down and at the bottom going up", () => {
    expect(stepEntry(order, null, 1)).toBe(order[0]);
    expect(stepEntry(order, "missing", -1)).toBe(order[2]);
    expect(stepEntry([], null, 1)).toBeUndefined();
  });
});

describe("nextAfterEntry", () => {
  const unread = (runId: string): { host: string; mark: CanopyReadMark } => ({
    host: OWN,
    mark: { runId, spawnedAt: SPAWNED, turn: 2, readTurn: 1, markedUnreadAt: null, version: 1 },
  });
  const idle = { agentState: "idle", since: NOW - 10_000 } as const;

  it("moves on to the next that needs the user, past runs that don't and a parked ask", () => {
    const items = workers([
      { host: OWN, run: run("done", approval) },
      { host: OWN, run: run("parked", { ...approval, park: { parkedAt: NOW } }) },
      { host: OWN, run: run("idle", idle) },
      { host: OTHER, run: run("next", { ...approval, since: NOW - 1_000 }) },
    ]);
    const order = project(items, [], {
      listedWorkers: inOrder(items, ["done", "parked", "idle", "next"]),
    }).navigation;

    expect(nextAfterEntry(order, order[0]!.key)).toBe(order[3]);
  });

  it("takes an unread run, but never a parked or snoozed one however unread", () => {
    const items = workers(
      [
        { host: OWN, run: run("done", approval) },
        { host: OWN, run: run("parked", { ...idle, park: { parkedAt: NOW } }) },
        { host: OWN, run: run("snoozed", { ...idle, snooze: { snoozedAt: NOW } }) },
        { host: OWN, run: run("fresh", idle) },
      ],
      [],
      [unread("parked"), unread("snoozed"), unread("fresh")]
    );
    const order = project(items, [], {
      listedWorkers: inOrder(items, ["done", "parked", "snoozed", "fresh"]),
    }).navigation;

    expect(order.map(entryShelved)).toEqual([false, true, true, false]);
    expect(nextAfterEntry(order, order[0]!.key)).toBe(order[3]);
  });

  it("goes back to the first wanted run above, then to a plain neighbour", () => {
    const order = project(
      workers([
        { host: OWN, run: run("first", { ...approval, since: NOW - 9_000 }) },
        { host: OWN, run: run("second", { ...approval, since: NOW - 8_000 }) },
        { host: OWN, run: run("last", { ...approval, since: NOW - 7_000 }) },
        { host: OWN, run: run("idle", idle) },
      ]),
      []
    ).navigation;
    const keyOf = (id: string) => JSON.stringify(["worker", OWN, id]);

    expect(nextAfterEntry(order, keyOf("last"))!.key).toBe(keyOf("first"));
    const quiet = order.filter((entry) => !entryNeedsYou(entry));
    expect(quiet.map((entry) => entry.key)).toEqual([keyOf("idle")]);
    expect(nextAfterEntry(quiet, keyOf("idle"))).toBeUndefined();
  });

  it("with nothing wanted, takes the run below, or above from the bottom", () => {
    const order = project(
      workers([
        { host: OWN, run: run("top", idle) },
        { host: OWN, run: run("middle", idle) },
        { host: OWN, run: run("bottom", idle) },
      ]),
      []
    ).navigation;

    expect(order.some(entryNeedsYou)).toBe(false);
    expect(nextAfterEntry(order, order[0]!.key)).toBe(order[1]);
    expect(nextAfterEntry(order, order[1]!.key)).toBe(order[2]);
    expect(nextAfterEntry(order, order[2]!.key)).toBe(order[1]);
  });

  it("moves on to an assistant that asks, as one entry among the rest", () => {
    const helpers = assistants([
      live(OWN, "a1", { agentState: "waiting", waitingReason: "question" }),
    ]);
    const items = workers([
      { host: OWN, run: run("done", approval) },
      { host: OWN, run: run("idle", idle) },
    ]);
    const order = project(items, helpers).navigation;

    expect(order.map((entry) => entry.role)).toEqual(["worker", "worker", "assistant"]);
    expect(nextAfterEntry(order, order[0]!.key)).toBe(order[2]);
  });

  it("from a run not listed, lands on the first wanted one, or nowhere", () => {
    const order = project(workers([{ host: OWN, run: run("idle", idle) }]), []).navigation;

    expect(nextAfterEntry(order, null)).toBeUndefined();
    const asks = project(workers([{ host: OWN, run: run("ask", approval) }]), []).navigation;
    expect(nextAfterEntry(asks, "missing")).toBe(asks[0]);
  });
});
