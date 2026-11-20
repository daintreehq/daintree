// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { DecisionsStatus } from "@shared/types/decisions";
import type {
  DecisionDeclineResultRead,
  DecisionQuestionAttachment,
  DecisionQuestionImagePartResult,
  DecisionQuestionCancelResult,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionDeclineResult,
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionMarkResult,
  DecisionQuestionReference,
  DecisionQuestionStanding,
  DecisionQuestionSummariesResult,
  DeclineDecisionQuestionPayload,
  MarkDecisionQuestionsPayload,
} from "@shared/types/decisionsQuestion";
import type { DecisionsInvolvementRead } from "@shared/types/decisionsInvolvement";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { BackendTerminalInfo } from "@shared/types/ipc/terminal";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isMac } from "@/lib/platform";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { answerKey, useDecisionsAnswerStore } from "@/store/decisionsAnswerStore";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";

let decisionsOn = true;
const onListeners = new Set<() => void>();
vi.mock("@/hooks/useDecisionsOn", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    onListeners.add(listener);
    return () => onListeners.delete(listener);
  };
  const snapshot = () => (decisionsOn ? "on" : "off");
  return {
    useDecisionsSwitch: () => useSyncExternalStore(subscribe, snapshot),
    useDecisionsOn: () => useSyncExternalStore(subscribe, () => snapshot() === "on"),
  };
});

let remote = false;
vi.mock("@/hooks/useHostPlatform", () => ({
  isRemoteWindow: () => remote,
  currentHostId: () => (remote ? "studio" : "local"),
}));
vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => "project-a" }));

/** The panels of this view (project A). */
let panels: Record<string, { location: string }> = {};
vi.mock("@/store/panelStore", () => ({
  usePanelStore: (select: (state: { panelsById: typeof panels }) => unknown) =>
    select({ panelsById: panels }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (select: (state: { projects: { id: string; name: string }[] }) => unknown) =>
    select({ projects: [{ id: "project-a", name: "Alpha" }] }),
}));
/** This view's worktrees (project A), by id; null while the view has none. */
let localWorktrees: Map<string, { name: string; branch?: string }> | null = null;
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreOptional: (
    select: (state: { worktrees: NonNullable<typeof localWorktrees> }) => unknown,
    fallback: unknown
  ) => (localWorktrees === null ? fallback : select({ worktrees: localWorktrees })),
}));

const getAllTerminals = vi.fn<() => Promise<BackendTerminalInfo[]>>();
vi.mock("@/clients/terminalClient", () => ({
  terminalClient: { getAll: () => getAllTerminals() },
}));

const dispatch = vi.fn<(id: string, args: unknown) => Promise<{ ok: boolean }>>();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (id: string, args: unknown) => dispatch(id, args) },
}));

import { DecisionsInboxDialog } from "../DecisionsInboxDialog";
import { preparationFacts } from "../decisionQuestionModel";

type ByReference = { reference: DecisionQuestionReference };
const listQuestions = vi.fn<() => Promise<DecisionQuestionList>>();
const getStatus = vi.fn<() => Promise<DecisionsStatus>>();
const getQuestionContentByReference =
  vi.fn<(payload: ByReference) => Promise<DecisionQuestionContentResult>>();
const getQuestionSummariesByReference =
  vi.fn<
    (payload: {
      references: DecisionQuestionReference[];
    }) => Promise<DecisionQuestionSummariesResult>
  >();
const cancelQuestionByReference =
  vi.fn<(payload: ByReference) => Promise<DecisionQuestionCancelResult>>();
const declineQuestion =
  vi.fn<(payload: DeclineDecisionQuestionPayload) => Promise<DecisionQuestionDeclineResult>>();
const getDeclineResult =
  vi.fn<(payload: { declineId: string }) => Promise<DecisionDeclineResultRead>>();
const getInvolvement = vi.fn<() => Promise<DecisionsInvolvementRead>>();
const markQuestions =
  vi.fn<(payload: MarkDecisionQuestionsPayload) => Promise<DecisionQuestionMarkResult>>();
let listListeners: Array<(list: DecisionQuestionList) => void> = [];
let statusListeners: Array<(status: DecisionsStatus) => void> = [];

function reference(questionId: string, over: Partial<DecisionQuestionReference> = {}) {
  return { hostId: "host_1", projectId: "project-a", terminalId: "t1", questionId, ...over };
}

function terminal(info: Partial<BackendTerminalInfo> & { id: string }): BackendTerminalInfo {
  return { cwd: "/repos", spawnedAt: 0, ...info };
}

function item(
  questionId: string,
  alias: number,
  standing: DecisionQuestionStanding,
  over: Partial<DecisionQuestionListItem> = {}
): DecisionQuestionListItem {
  return {
    reference: reference(questionId),
    alias,
    agentKind: "claude",
    projectLabel: "Alpha (as asked)",
    worktreeId: "w1",
    worktreeRoot: "/repos/alpha/feature-x",
    requirement: "human-required",
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: null,
    settledAt: null,
    standing,
    replyRequest: null,
    stall: null,
    ...over,
  };
}

const OPEN: DecisionQuestionStanding = { kind: "waiting", reason: "open" };

/** Project A's open question, project B's answer being delivered, and A's expired one. */
const LIST: DecisionQuestionList = {
  revision: 1,
  questions: [
    item(
      "question-1",
      1,
      { kind: "settled", outcome: "expired" },
      { askedAt: "2026-11-02T08:00:00.000Z", settledAt: "2026-11-02T11:00:00Z" }
    ),
    item("question-2", 2, OPEN, { askedAt: "2026-11-02T09:00:00.000Z" }),
    item(
      "question-3",
      3,
      { kind: "to-type" },
      {
        reference: reference("question-3", { projectId: "project-b", terminalId: "t9" }),
        projectLabel: "Beta",
        agentKind: "codex",
        askedAt: "2026-11-02T10:00:00.000Z",
      }
    ),
  ],
};

function content(questionId: string, alias: number, over: Partial<DecisionQuestionContent> = {}) {
  const question: DecisionQuestionContent = {
    questionId,
    alias,
    terminalId: "t1",
    reference: reference(questionId),
    revision: 1,
    question: `Body of question ${alias}`,
    context: null,
    kind: "choice",
    options: [{ id: "yes", label: "Ship it", description: null }],
    allowText: false,
    requirement: "human-required",
    askedAt: "2026-11-02T10:00:00.000Z",
    expiresAt: null,
    status: "expired",
    closedReason: null,
    deliveryStatus: "terminal-delivered",
    attachments: [],
    thread: [],
    ...over,
  };
  return question;
}

const CONTENT: Record<string, DecisionQuestionContent> = {
  "question-1": content("question-1", 1),
  "question-2": content("question-2", 2, { status: "open" }),
  "question-3": content("question-3", 3, {
    status: "human-answered",
    reference: reference("question-3", { projectId: "project-b", terminalId: "t9" }),
  }),
  "question-4": content("question-4", 4, { status: "open" }),
};

function waitFor(check: () => void) {
  return vi.waitFor(check, { timeout: 4000 });
}

/** This computer's runs, across its projects, as main's fleet snapshot last reported them. */
function fleet(
  runs: (Partial<FleetRunRow> & Pick<FleetRunRow, "runId" | "workspaceId">)[],
  degraded = false
) {
  act(() => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: runs.map((run) => ({ spawnedAt: 0, cwd: "/repos/alpha", ...run })),
        changedAt: 0,
        degraded,
        lastSuccessfulAt: 0,
      },
    });
  });
}

/** A row's quiet line: who asked, and where. */
function originOf(alias: string) {
  return (
    rowNamed(alias).querySelector('[data-testid="decisions-inbox-row-origin"]')?.textContent ?? ""
  );
}

function push(list: DecisionQuestionList) {
  act(() => {
    for (const listener of [...listListeners]) listener(list);
  });
}

function pushStatus(status: DecisionsStatus) {
  act(() => {
    for (const listener of [...statusListeners]) listener(status);
  });
}

function rows() {
  return screen.queryAllByTestId("decisions-inbox-row");
}

/** A row's alias: its trailing id, or its line when the line couldn't be read and the alias names it. */
function aliasOf(row: HTMLElement): string | null {
  return (
    row.querySelector('[data-testid="decisions-inbox-row-alias"]')?.textContent ??
    row.querySelector('[data-testid="decisions-inbox-row-line"]')?.textContent ??
    null
  );
}

function rowNamed(alias: string) {
  const row = rows().find((candidate) => aliasOf(candidate) === alias);
  if (!row) throw new Error(`no row ${alias}`);
  return row;
}

/** What a screen reader says of a row: its accessible name, which leaves out what is drawn aria-hidden. */
function nameOf(row: HTMLElement) {
  let name = "";
  screen.getAllByRole("button", {
    name: (accessible, element) => {
      if (element === row) name = accessible;
      return element === row;
    },
  });
  return name;
}

/** What a row draws: its text without the part only a screen reader gets. */
function drawnText(row: HTMLElement) {
  const copy = row.cloneNode(true);
  if (!(copy instanceof HTMLElement)) throw new Error("a row clones to an element");
  for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
  return copy.textContent ?? "";
}

function shownBody() {
  return screen.getByTestId("decision-question-content").textContent ?? "";
}

function open(options?: { terminalId?: string }) {
  act(() => useDecisionsInboxStore.getState().open(options));
}

function readsOf(questionId: string) {
  return getQuestionContentByReference.mock.calls.filter(
    ([payload]) => payload.reference.questionId === questionId
  ).length;
}

beforeEach(() => {
  decisionsOn = true;
  remote = false;
  panels = {};
  localWorktrees = null;
  useFleetSnapshotStore.setState({ snapshot: null });
  listListeners = [];
  statusListeners = [];
  useDecisionsInboxStore.setState({ isOpen: false, request: { terminalId: null, seq: 0 } });
  listQuestions.mockReset().mockResolvedValue(LIST);
  getStatus
    .mockReset()
    .mockResolvedValue({ state: "connected", relayOrigin: "https://relay.example", revision: 1 });
  getQuestionContentByReference.mockReset().mockImplementation(async ({ reference }) => {
    const question = CONTENT[reference.questionId];
    return question ? { result: "read", question } : { result: "not-found" };
  });
  getQuestionSummariesByReference.mockReset().mockImplementation(async ({ references }) => ({
    result: "read",
    summaries: references.map((ref) => ({
      questionId: ref.questionId,
      result: "read" as const,
      line: `Line of ${ref.questionId}`,
    })),
  }));
  cancelQuestionByReference.mockReset().mockResolvedValue({ result: "cancelling" });
  declineQuestion.mockReset().mockImplementation(async ({ declineId }) => ({
    result: "submitted",
    declineId,
    outcome: { status: "declined" },
  }));
  getDeclineResult.mockReset().mockResolvedValue({ result: "not-found" });
  useDecisionsAnswerStore.getState().clear();
  getInvolvement.mockReset().mockResolvedValue({
    result: "read",
    role: "owner",
    settable: true,
    preference: {
      status: "available",
      normalMode: "recommend",
      consultCount: 2,
      override: null,
      mode: "recommend",
      overrideActive: false,
      revision: 3,
      setOn: "phone",
      setAt: "2026-11-18T09:00:00.000Z",
      lastSyncedAt: "2026-11-18T09:59:00.000Z",
      stale: false,
    },
  });
  getAllTerminals.mockReset().mockResolvedValue([]);
  dispatch.mockReset().mockResolvedValue({ ok: true });
  markQuestions
    .mockReset()
    .mockImplementation(async ({ questions }) => ({ result: "marked", marked: questions.length }));
  Reflect.set(window, "electron", {
    decisions: {
      listQuestions,
      getStatus,
      getQuestionContentByReference,
      getQuestionSummariesByReference,
      cancelQuestionByReference,
      declineQuestion,
      getDeclineResult,
      getInvolvement,
      markQuestions,
    },
    events: {
      on: (
        name: string,
        callback: ((list: DecisionQuestionList) => void) & ((status: DecisionsStatus) => void)
      ) => {
        if (name === "decisions:questions-changed") {
          listListeners.push(callback);
          return () => {
            listListeners = listListeners.filter((listener) => listener !== callback);
          };
        }
        if (name === "decisions:status-changed") {
          statusListeners.push(callback);
          return () => {
            statusListeners = statusListeners.filter((listener) => listener !== callback);
          };
        }
        return () => {};
      },
    },
    terminal: { onDecisionState: () => () => {} },
  });
  render(
    <TooltipProvider>
      <DecisionsInboxDialog />
    </TooltipProvider>
  );
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
});

describe("DecisionsInboxDialog", () => {
  it("lists every question in its group, each named by its line, agent, place, age and state", async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const groups = Array.from(
      screen.getByTestId("decisions-inbox-list").querySelectorAll("section")
    ).map((section) => section.getAttribute("data-testid"));
    expect(groups).toEqual([
      "decisions-inbox-group-needs-you",
      "decisions-inbox-group-delivering",
      "decisions-inbox-group-history",
    ]);
    expect(screen.getByTestId("decisions-inbox-group-needs-you").textContent).toContain("q-2");
    expect(screen.getByTestId("decisions-inbox-group-delivering").textContent).toContain("q-3");
    expect(screen.getByTestId("decisions-inbox-group-history").textContent).toContain("q-1");

    await waitFor(() => expect(rowNamed("q-2").textContent).toContain("Line of question-2"));
    const own = rowNamed("q-2");
    // This view's project by its current name, a worktree by its folder.
    expect(own.textContent).toContain(getEffectiveAgentConfig("claude")!.name);
    expect(own.textContent).toContain("Alpha");
    expect(own.textContent).not.toContain("Alpha (as asked)");
    expect(own.textContent).toContain("feature-x");
    expect(own.textContent).toContain("Waiting for an answer");
    // The agent is named in words beside its mark (#18039), and the dots between agent, project
    // and worktree are hidden from assistive technology.
    expect(drawnText(own)).toContain(getEffectiveAgentConfig("claude")!.name);
    const dots = Array.from(own.querySelectorAll("span")).filter(
      (span) => span.textContent?.trim() === "·"
    );
    expect(dots).toHaveLength(2);
    for (const dot of dots) expect(dot.getAttribute("aria-hidden")).toBe("true");
    // Another project's question keeps the name it was asked under, and its own agent.
    const other = rowNamed("q-3");
    expect(other.textContent).toContain("Beta");
    expect(other.textContent).toContain(getEffectiveAgentConfig("codex")!.name);
    expect(other.textContent).not.toContain(getEffectiveAgentConfig("claude")!.name);
    // Each row's age is its own question's: History's is when it closed, the rest's when it was asked.
    const ages = ["q-1", "q-2", "q-3"].map(
      (alias) => rowNamed(alias).querySelector("time")?.getAttribute("datetime") ?? null
    );
    expect(ages).toEqual(
      LIST.questions.map((entry) => new Date(entry.settledAt ?? entry.askedAt).toISOString())
    );
    // The close time is named for the ear; the others stay "asked".
    expect(nameOf(rowNamed("q-1"))).toMatch(/Closed,/);
    expect(nameOf(rowNamed("q-2"))).toMatch(/Asked,/);
    // One read of the lines, by reference, for every row.
    expect(getQuestionSummariesByReference).toHaveBeenCalledOnce();
    expect(getQuestionSummariesByReference.mock.calls[0]![0].references).toHaveLength(3);
  });

  describe("telling two agents in one place apart (#18039)", () => {
    const CLAUDE = getEffectiveAgentConfig("claude")!.name;
    // Two Claude runs in the main checkout, whose folder is the project's own name.
    const TWINS: DecisionQuestionList = {
      revision: 1,
      questions: [
        item("question-2", 2, OPEN, { worktreeRoot: "/repos/alpha" }),
        item("question-4", 4, OPEN, {
          reference: reference("question-4", { terminalId: "t4" }),
          worktreeRoot: "/repos/alpha",
          askedAt: "2026-11-02T10:30:00.000Z",
        }),
      ],
    };
    const INDEXING = {
      runId: "t1",
      workspaceId: "project-a",
      agentId: "claude" as const,
      agentState: "waiting" as const,
      title: "Index migrations",
      titleMode: "user" as const,
    };
    const AUTH = {
      runId: "t4",
      workspaceId: "project-a",
      agentId: "claude" as const,
      agentState: "waiting" as const,
      title: CLAUDE,
      lastObservedTitle: "Fix auth tests",
    };

    function headerOrigin() {
      return screen.getByTestId("decisions-inbox-detail-origin").textContent ?? "";
    }

    beforeEach(() => {
      listQuestions.mockResolvedValue(TWINS);
    });

    it("names each row and the detail by the pane that asked, ahead of the project", async () => {
      fleet([INDEXING, AUTH]);
      open();
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(originOf("q-2")).toBe(`${CLAUDE} in “Index migrations” · Alpha`);
      expect(originOf("q-4")).toBe(`${CLAUDE} in “Fix auth tests” · Alpha`);
      await waitFor(() => expect(headerOrigin()).toBe("“Index migrations” · Alpha"));
      fireEvent.click(rowNamed("q-4"));
      await waitFor(() => expect(headerOrigin()).toBe("“Fix auth tests” · Alpha"));

      // A retitle reaches the row as the fleet reports it, and only that pane's.
      fleet([{ ...INDEXING, title: "Schema backfill" }, AUTH]);
      expect(originOf("q-2")).toBe(`${CLAUDE} in “Schema backfill” · Alpha`);
      expect(originOf("q-4")).toBe(`${CLAUDE} in “Fix auth tests” · Alpha`);
      // A pane no longer on this computer has no title to give.
      fleet([{ ...INDEXING, title: "Schema backfill" }]);
      expect(originOf("q-4")).toBe(`${CLAUDE} · Alpha`);
      expect(headerOrigin()).toBe("Alpha");
    });

    it("titles another project's question from that project's own run", async () => {
      listQuestions.mockResolvedValue({
        revision: 1,
        questions: [
          item("question-3", 3, OPEN, {
            reference: reference("question-3", { projectId: "project-b", terminalId: "t9" }),
            projectLabel: "Beta",
          }),
        ],
      });
      fleet([
        { ...INDEXING, runId: "t8", workspaceId: "project-b", title: "Another pane" },
        { ...INDEXING, runId: "t9", workspaceId: "project-b", title: "Billing" },
      ]);
      open();
      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(originOf("q-3")).toBe(`${CLAUDE} in “Billing” · feature-x · Beta`);
      await waitFor(() => expect(headerOrigin()).toBe("“Billing” · feature-x · Beta"));
    });

    it("never takes a title from a run in another project or on another machine with the same id", async () => {
      listQuestions.mockResolvedValue({
        revision: 1,
        questions: [
          TWINS.questions[0]!,
          item("question-4", 4, OPEN, {
            reference: reference("question-4", { hostId: "qhost_studio_0001", terminalId: "t4" }),
            remoteHost: { hostId: "studio", name: "Studio", connected: true },
            worktreeRoot: "/repos/alpha",
          }),
        ],
      });
      fleet([
        { ...INDEXING, workspaceId: "project-b", title: "Elsewhere" },
        { ...INDEXING, runId: "t4", title: "Local pane" },
      ]);
      open();
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(originOf("q-2")).toBe(`${CLAUDE} · Alpha`);
      expect(originOf("q-4")).toBe(`${CLAUDE} on Studio · alpha · Alpha (as asked)`);
    });

    it("keeps only a title the person gave a pane that another agent has taken over", async () => {
      fleet([
        {
          ...INDEXING,
          agentId: "codex",
          title: "Codex",
          titleMode: "default",
          lastObservedTitle: "Migrate billing",
        },
      ]);
      open();
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(originOf("q-2")).toBe(`${CLAUDE} · Alpha`);
      fleet([{ ...INDEXING, agentId: "codex", lastObservedTitle: "Migrate billing" }]);
      expect(originOf("q-2")).toBe(`${CLAUDE} in “Index migrations” · Alpha`);
    });

    it("keeps a title through a fleet read that came back incomplete, and drops it once a full one has no pane", async () => {
      fleet([INDEXING]);
      open();
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(originOf("q-2")).toBe(`${CLAUDE} in “Index migrations” · Alpha`);
      fleet([INDEXING], true);
      expect(originOf("q-2")).toBe(`${CLAUDE} in “Index migrations” · Alpha`);
      fleet([]);
      expect(originOf("q-2")).toBe(`${CLAUDE} · Alpha`);
    });

    it("puts a closed question's outcome after who asked, and says it once", async () => {
      listQuestions.mockResolvedValue({
        revision: 1,
        questions: [
          item(
            "question-1",
            1,
            { kind: "settled", outcome: "expired" },
            { worktreeRoot: "/repos/alpha", settledAt: "2026-11-02T11:00:00Z" }
          ),
        ],
      });
      fleet([INDEXING]);
      open();
      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(originOf("q-1")).toBe(`${CLAUDE} in “Index migrations” · Expired unanswered · Alpha`);
      expect(nameOf(rowNamed("q-1")).match(/Expired unanswered/g)).toHaveLength(1);
    });

    it("names a Remote Host's question by its Host whether or not it's connected, and by its own place", async () => {
      // This view knows worktree w1 by another name: a Host's question keeps the folder it was asked in.
      localWorktrees = new Map([["w1", { name: "alpha-local", branch: "feature/local" }]]);
      const host = (connected: boolean) =>
        item("question-4", 4, OPEN, {
          reference: reference("question-4", { hostId: "qhost_studio_0001", terminalId: "t4" }),
          remoteHost: { hostId: "studio", name: "Studio", connected },
          askedAt: "2026-11-02T10:30:00.000Z",
        });
      const local = item("question-2", 2, OPEN);
      listQuestions.mockResolvedValue({ revision: 1, questions: [local, host(true)] });
      open();
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(originOf("q-2")).toBe(`${CLAUDE} · feature/local · Alpha`);
      // Its project as the Host asked it, never a local one that shares its id.
      expect(originOf("q-4")).toBe(`${CLAUDE} on Studio · feature-x · Alpha (as asked)`);
      fireEvent.click(rowNamed("q-4"));
      await waitFor(() => expect(headerOrigin()).toBe("On Studio · feature-x · Alpha (as asked)"));

      push({ revision: 2, questions: [local, host(false)] });
      await waitFor(() =>
        expect(originOf("q-4")).toBe(
          `${CLAUDE} on Studio · Away, as last reported · feature-x · Alpha (as asked)`
        )
      );
      expect(headerOrigin()).toBe(
        "On Studio · Away, as last reported · feature-x · Alpha (as asked)"
      );
    });
  });

  it("shows a History row with no close time by when it was asked, and says so (#18025)", async () => {
    listQuestions.mockResolvedValue({
      revision: 1,
      questions: [
        item(
          "question-1",
          1,
          { kind: "settled", outcome: "expired" },
          { askedAt: "2026-11-02T08:00:00.000Z", settledAt: null }
        ),
        item("question-2", 2, OPEN, {
          askedAt: "2026-11-02T09:00:00.000Z",
          settledAt: "2026-11-02T11:00:00Z",
        }),
      ],
    });
    open();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const time = (alias: string) =>
      rowNamed(alias).querySelector("time")?.getAttribute("datetime") ?? null;
    expect(time("q-1")).toBe("2026-11-02T08:00:00.000Z");
    expect(nameOf(rowNamed("q-1"))).toMatch(/Asked,/);
    expect(nameOf(rowNamed("q-1"))).not.toMatch(/Closed,/);
    // Outside History the asked time stays, whatever a stray settled time says.
    expect(time("q-2")).toBe("2026-11-02T09:00:00.000Z");
  });

  it("shows the first question beside the list, read by reference", async () => {
    open();
    await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
    expect(getQuestionContentByReference).toHaveBeenCalledWith({
      reference: reference("question-2"),
    });
    expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("decisions-inbox-detail-title").textContent).toContain("q-2");
  });

  it("shows the agent's preparation beside the list before the answer form, and none for a question without one (#18042)", async () => {
    const preparation = {
      agentsConsulted: 3,
      outcome: "agreed" as const,
      summary: "All three agreed: the cache stays in Postgres.",
    };
    getQuestionContentByReference.mockImplementation(async ({ reference: ref }) => {
      const question = CONTENT[ref.questionId];
      if (!question) return { result: "not-found" };
      return {
        result: "read",
        question: ref.questionId === "question-2" ? { ...question, preparation } : question,
      };
    });
    open();
    const section = await screen.findByRole("region", { name: "The agent's preparation" });
    for (const fact of preparationFacts(preparation)) expect(section.textContent).toContain(fact);
    expect(section.textContent).toContain(preparation.summary);
    const answer = screen.getByRole("region", { name: "Your answer" });
    expect(section.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    fireEvent.click(rowNamed("q-1"));
    await waitFor(() => expect(shownBody()).toContain("Body of question 1"));
    expect(screen.queryByTestId("decision-question-preparation")).toBeNull();
  });

  it("waits on the dialog while the list loads, then puts the keyboard on the question shown", async () => {
    let resolveList!: (list: DecisionQuestionList) => void;
    listQuestions.mockImplementationOnce(
      () => new Promise<DecisionQuestionList>((resolve) => (resolveList = resolve))
    );
    open();
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // Not Close: Enter there would dismiss the inbox before anything shows.
    expect(document.activeElement?.tagName).not.toBe("BUTTON");
    await act(async () => resolveList(LIST));
    await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
  });

  it("shows what agents are told beneath the questions, keeping the first focus on the list", async () => {
    open();
    await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
    await waitFor(() =>
      expect(screen.getByTestId("decisions-involvement-mode").textContent).toBe(
        "Bring a recommendation"
      )
    );
    expect(screen.getByTestId("decisions-involvement-change")).not.toBeNull();
    expect(document.activeElement).toBe(rowNamed("q-2"));
  });

  it("reads the preference only while open and on", async () => {
    decisionsOn = false;
    open();
    await screen.findByRole("dialog");
    expect(getInvolvement).not.toHaveBeenCalled();
  });

  it("starts at the question of the pane that opened it", async () => {
    open({ terminalId: "t9" });
    await waitFor(() => expect(rowNamed("q-3").getAttribute("aria-current")).toBe("true"));
    await waitFor(() => expect(shownBody()).toContain("Body of question 3"));
  });

  it("picks from this opening's list, never one an earlier opening read", async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    act(() => useDecisionsInboxStore.getState().close());

    // Pane t4 asks its first question while the inbox is closed.
    let resolveList!: (list: DecisionQuestionList) => void;
    listQuestions.mockImplementationOnce(
      () => new Promise<DecisionQuestionList>((resolve) => (resolveList = resolve))
    );
    open({ terminalId: "t4" });
    expect(rows()).toHaveLength(0);
    await act(async () =>
      resolveList({
        revision: 2,
        questions: [
          ...LIST.questions,
          item("question-4", 4, OPEN, { reference: reference("question-4", { terminalId: "t4" }) }),
        ],
      })
    );
    await waitFor(() => expect(rowNamed("q-4").getAttribute("aria-current")).toBe("true"));
    await waitFor(() => expect(shownBody()).toContain("Body of question 4"));
  });

  it("keeps the chosen question as the list regroups, and takes its place's when it goes", async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(rowNamed("q-3"));
    await waitFor(() => expect(shownBody()).toContain("Body of question 3"));

    // q-3 settles and moves from second place to the top of history; it stays shown.
    const settled = {
      ...LIST.questions[2]!,
      standing: { kind: "settled", outcome: "answered", handled: false } as const,
      settledAt: "2026-11-02T12:00:00Z",
    };
    push({ revision: 2, questions: [LIST.questions[0]!, LIST.questions[1]!, settled] });
    await waitFor(() =>
      expect(screen.getByTestId("decisions-inbox-group-history").textContent).toContain("q-3")
    );
    expect(rows().map(aliasOf)).toEqual(["q-2", "q-3", "q-1"]);
    expect(rowNamed("q-3").getAttribute("aria-current")).toBe("true");
    expect(shownBody()).toContain("Body of question 3");
    expect(getQuestionSummariesByReference).toHaveBeenCalledOnce();

    // Gone from the list: the question now at its place, q-1, is shown instead.
    push({ revision: 3, questions: [LIST.questions[0]!, LIST.questions[1]!] });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rowNamed("q-1").getAttribute("aria-current")).toBe("true");
    await waitFor(() => expect(shownBody()).toContain("Body of question 1"));
  });

  it("moves an ask whose deadline passes to Awaiting update, keeping it shown and the keyboard where it was (#17943)", async () => {
    const expiresAt = new Date(Date.now() + 500).toISOString();
    const timed = item("question-2", 2, OPEN, {
      askedAt: "2026-11-02T09:00:00.000Z",
      expiresAt,
      replyMode: "advisory",
    });
    listQuestions.mockResolvedValue({ revision: 1, questions: [LIST.questions[0]!, timed] });
    const shown = CONTENT["question-2"]!;
    CONTENT["question-2"] = { ...shown, expiresAt, replyMode: "advisory" };
    try {
      open();
      await waitFor(() => expect(rows()).toHaveLength(2));
      fireEvent.click(rowNamed("q-2"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      // Inside a day: when to reply by, in this computer's time, and the time left.
      expect(rowNamed("q-2").textContent).toMatch(
        /Advisory · Reply by .+ · Less than a minute left/
      );
      expect(screen.getByTestId("decisions-inbox-group-needs-you").textContent).toContain("q-2");
      const focused = rowNamed("q-2");
      focused.focus();

      await waitFor(() =>
        expect(screen.getByTestId("decisions-inbox-group-awaiting").textContent).toContain("q-2")
      );
      expect(rowNamed("q-2").textContent).toMatch(/Deadline passed, awaiting an update/);
      expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true");
      expect(document.activeElement?.getAttribute("data-inbox-key")).toBe(
        focused.getAttribute("data-inbox-key")
      );
      // The reader keeps a clock of its own, so it can flip a moment after the list.
      await waitFor(() =>
        expect(screen.getByTestId("decision-question-deadline").textContent).toMatch(
          /Deadline passed/
        )
      );
      // Nothing there to set aside: it no longer waits on the person. The button stays, unavailable,
      // so a keyboard on it isn't dropped.
      expect(screen.getByTestId("decisions-inbox-clear").getAttribute("aria-disabled")).toBe(
        "true"
      );
      fireEvent.click(screen.getByTestId("decisions-inbox-clear"));
      expect(markQuestions).not.toHaveBeenCalledWith(expect.objectContaining({ action: "clear" }));
    } finally {
      CONTENT["question-2"] = shown;
    }
  });

  it("says Clear stays on this computer before it's pressed (#17943)", async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(rowNamed("q-2"));
    const clear = await screen.findByTestId("decisions-inbox-clear");
    const hint = document.getElementById(clear.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toMatch(/this computer only/);
    expect(hint?.textContent).toMatch(/Nothing is declined or sent/);
  });

  it("moves through native buttons with one tab stop, reading none it passes", async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    await waitFor(() => expect(readsOf("question-2")).toBeGreaterThan(0));
    // Native buttons, so Enter and Space choose a row as a click does.
    for (const row of rows()) expect(row.tagName).toBe("BUTTON");
    expect(rows().filter((row) => row.tabIndex === 0)).toEqual([rowNamed("q-2")]);

    act(() => rows()[0]!.focus());
    fireEvent.keyDown(rows()[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[1]);
    fireEvent.keyDown(rows()[1]!, { key: "End" });
    expect(document.activeElement).toBe(rows()[2]);
    fireEvent.keyDown(rows()[2]!, { key: "Home" });
    expect(document.activeElement).toBe(rows()[0]);
    fireEvent.keyDown(rows()[0]!, { key: "End" });
    // Arrowing past reads nothing; choosing does, at once.
    expect(readsOf("question-1")).toBe(0);
    expect(rows()[2]!.getAttribute("aria-current")).toBeNull();
    fireEvent.click(rows()[2]!);
    expect(rows()[2]!.getAttribute("aria-current")).toBe("true");
    await waitFor(() => expect(readsOf("question-1")).toBe(1));
    expect(readsOf("question-3")).toBe(0);
    expect(rows().filter((row) => row.tabIndex === 0)).toEqual([rows()[2]]);
  });

  it("puts the keyboard back on a focused row that moves to another group", async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    act(() => rowNamed("q-2").focus());
    push({
      revision: 2,
      questions: [
        LIST.questions[0]!,
        { ...LIST.questions[1]!, standing: { kind: "to-type" } },
        LIST.questions[2]!,
      ],
    });
    await waitFor(() =>
      expect(screen.getByTestId("decisions-inbox-group-delivering").textContent).toContain("q-2")
    );
    expect(document.activeElement).toBe(rowNamed("q-2"));
  });

  it("leaves the keyboard where it went when a row it left moves later", async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
    act(() => rowNamed("q-2").blur());
    // The blur's own turn has passed before the list moves.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(document.body);
    push({
      revision: 2,
      questions: [
        LIST.questions[0]!,
        { ...LIST.questions[1]!, standing: { kind: "to-type" } },
        LIST.questions[2]!,
      ],
    });
    await waitFor(() =>
      expect(screen.getByTestId("decisions-inbox-group-delivering").textContent).toContain("q-2")
    );
    expect(document.activeElement).toBe(document.body);
  });

  describe("from the keyboard (#18038)", () => {
    const step = (key: "ArrowUp" | "ArrowDown") => ({
      key,
      ...(isMac() ? { metaKey: true } : { altKey: true }),
    });
    /** `LIST` with project A's second open question, q-4, which asks for words. */
    const WITH_TEXT: DecisionQuestionList = {
      revision: 1,
      questions: [
        ...LIST.questions,
        item("question-4", 4, OPEN, {
          reference: reference("question-4", { terminalId: "t4" }),
          askedAt: "2026-11-02T09:30:00.000Z",
        }),
      ],
    };
    /** `WITH_TEXT` with a third open question, q-5, which offers a choice. */
    const THREE_OPEN: DecisionQuestionList = {
      revision: 1,
      questions: [
        ...WITH_TEXT.questions,
        item("question-5", 5, OPEN, {
          reference: reference("question-5", { terminalId: "t5" }),
          askedAt: "2026-11-02T09:45:00.000Z",
        }),
      ],
    };
    const choiceOption = (name: RegExp = /Ship it/) => screen.getByRole("radio", { name });
    const wordsField = () => screen.getByTestId("decision-answer-text");
    const detail = () => screen.getByTestId("decisions-inbox-detail");
    const closeButton = () => screen.getByRole("button", { name: "Close dialog" });
    /** The question's own words, which the keyboard can be sent to. */
    const wordsOf = (alias: number) =>
      screen.getByText(`Body of question ${alias}`).closest<HTMLElement>('[tabindex="-1"]');
    const said = () => useAnnouncerStore.getState().polite?.msg ?? null;
    const seenIds = () =>
      markQuestions.mock.calls
        .filter(([payload]) => payload.action === "seen")
        .flatMap(([payload]) => payload.questions.map((q) => q.reference.questionId));
    /** Holds one question's reads until the returned call lets them through. */
    function holdReadsOf(questionId: string) {
      const base = getQuestionContentByReference.getMockImplementation()!;
      let land!: () => void;
      const held = new Promise<void>((resolve) => (land = resolve));
      getQuestionContentByReference.mockImplementation(async (payload) => {
        if (payload.reference.questionId === questionId) await held;
        return base(payload);
      });
      return () => act(async () => land());
    }
    /** Time that passes only for the dwell's timers, which these tests step through. */
    function fakeTimers() {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
    }
    function pass(ms: number) {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    }
    let kept: DecisionQuestionContent;

    beforeEach(() => {
      useAnnouncerStore.setState({ polite: null, assertive: null });
      CONTENT["question-5"] = content("question-5", 5, {
        status: "open",
        terminalId: "t5",
        reference: reference("question-5", { terminalId: "t5" }),
      });
      kept = CONTENT["question-4"]!;
      CONTENT["question-4"] = content("question-4", 4, {
        status: "open",
        kind: "text",
        options: [],
        allowText: true,
        terminalId: "t4",
        reference: reference("question-4", { terminalId: "t4" }),
      });
    });

    afterEach(() => {
      CONTENT["question-4"] = kept;
      delete CONTENT["question-5"];
    });

    it("shows the row the arrows rest on only once they've stayed, reading and marking none they passed", async () => {
      const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
      onTestFinished(() => hasFocus.mockRestore());
      const unseen = { ask: null, seen: false, cleared: false };
      listQuestions.mockResolvedValue({
        revision: 1,
        questions: THREE_OPEN.questions.map((question) => ({ ...question, inbox: unseen })),
      });
      open();
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
      await waitFor(() => expect(seenIds()).toEqual(["question-2"]));
      expect(rows().map(aliasOf).slice(0, 3)).toEqual(["q-2", "q-4", "q-5"]);
      fakeTimers();

      // Down to q-4, on to q-5, and back to q-4: each press starts the rest again.
      fireEvent.keyDown(rowNamed("q-2"), { key: "ArrowDown" });
      pass(100);
      fireEvent.keyDown(rowNamed("q-4"), { key: "ArrowDown" });
      pass(100);
      fireEvent.keyDown(rowNamed("q-5"), { key: "ArrowUp" });
      expect(document.activeElement).toBe(rowNamed("q-4"));
      pass(299);
      expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true");
      pass(1);
      expect(rowNamed("q-4").getAttribute("aria-current")).toBe("true");
      vi.useRealTimers();

      await waitFor(() => expect(shownBody()).toContain("Body of question 4"));
      await waitFor(() => expect(seenIds()).toEqual(["question-2", "question-4"]));
      expect(readsOf("question-5")).toBe(0);
      // The keyboard stays in the list, which is still a single stop.
      expect(document.activeElement).toBe(rowNamed("q-4"));
      expect(rows().filter((row) => row.tabIndex === 0)).toEqual([rowNamed("q-4")]);
      // Its row has just been read out in full: only which question now shows.
      expect(said()).toBe("Showing q-4");
    });

    it("shows nothing new for focus put on a row, nor once the keyboard has left and come back", async () => {
      open();
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      fakeTimers();

      // Focus put back on a row (a regroup, a dialog closing) isn't the arrows resting there.
      act(() => rowNamed("q-3").focus());
      pass(1000);
      expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true");

      fireEvent.keyDown(rowNamed("q-3"), { key: "ArrowDown" });
      expect(document.activeElement).toBe(rowNamed("q-1"));
      pass(200);
      act(() => closeButton().focus());
      act(() => rowNamed("q-1").focus());
      pass(1000);
      expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true");
      vi.useRealTimers();
      await act(async () => {});
      expect(readsOf("question-3")).toBe(0);
      expect(readsOf("question-1")).toBe(0);
      expect(said()).toBeNull();
    });

    it("takes the keyboard across into the answer: its first choice, else its words field", async () => {
      const land4 = holdReadsOf("question-4");
      listQuestions.mockResolvedValue(WITH_TEXT);
      open();
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));

      // Right with anything else held isn't the way across.
      expect(fireEvent.keyDown(rowNamed("q-2"), { key: "ArrowRight", shiftKey: true })).toBe(true);
      expect(document.activeElement).toBe(rowNamed("q-2"));
      fireEvent.keyDown(rowNamed("q-2"), { key: "ArrowRight" });
      expect(document.activeElement).toBe(choiceOption());

      // A row the arrows only just reached: shown at once, the keyboard waiting in the pane
      // while it's read, then in its field.
      act(() => rowNamed("q-4").focus());
      fireEvent.keyDown(rowNamed("q-4"), { key: "ArrowRight" });
      expect(rowNamed("q-4").getAttribute("aria-current")).toBe("true");
      expect(document.activeElement).toBe(detail());
      await land4();
      await waitFor(() => expect(document.activeElement).toBe(wordsField()));
    });

    it("lands on the choice already made, not the first, so the next arrow doesn't change it", async () => {
      const shown = CONTENT["question-2"]!;
      CONTENT["question-2"] = {
        ...shown,
        options: [
          { id: "yes", label: "Ship it", description: null },
          { id: "no", label: "Hold it", description: null },
        ],
      };
      onTestFinished(() => {
        CONTENT["question-2"] = shown;
      });
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      fireEvent.click(choiceOption(/Hold it/));
      act(() => rowNamed("q-2").focus());

      fireEvent.keyDown(rowNamed("q-2"), { key: "ArrowRight" });
      expect(document.activeElement).toBe(choiceOption(/Hold it/));
    });

    it("takes the keyboard to the question's words when it takes no answer here", async () => {
      open();
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
      act(() => rowNamed("q-3").focus());
      fireEvent.keyDown(rowNamed("q-3"), { key: "ArrowRight" });
      await waitFor(() => expect(shownBody()).toContain("Body of question 3"));
      await waitFor(() => expect(document.activeElement).toBe(wordsOf(3)));
    });

    it("steps between questions from inside the answer, landing in the next one's answer", async () => {
      listQuestions.mockResolvedValue(WITH_TEXT);
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      expect(rows().map(aliasOf).slice(0, 2)).toEqual(["q-2", "q-4"]);
      act(() => choiceOption().focus());

      fireEvent.keyDown(choiceOption(), step("ArrowDown"));
      expect(rowNamed("q-4").getAttribute("aria-current")).toBe("true");
      await waitFor(() => expect(shownBody()).toContain("Body of question 4"));
      await waitFor(() => expect(document.activeElement).toBe(wordsField()));

      fireEvent.keyDown(wordsField(), step("ArrowUp"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      await waitFor(() => expect(document.activeElement).toBe(choiceOption()));
    });

    it("steps from a question's words to the next one's words, not into its answer", async () => {
      listQuestions.mockResolvedValue(WITH_TEXT);
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      act(() => wordsOf(2)!.focus());

      fireEvent.keyDown(wordsOf(2)!, step("ArrowDown"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 4"));
      await waitFor(() => expect(document.activeElement).toBe(wordsOf(4)));
    });

    it("steps the list's row with the question shown, at once, from the row the keyboard is on, stopping at the ends", async () => {
      open();
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));

      expect(fireEvent.keyDown(rowNamed("q-2"), step("ArrowUp"))).toBe(false);
      expect(document.activeElement).toBe(rowNamed("q-2"));
      expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true");

      // From q-3, which the arrows reached but hasn't shown yet: on to q-1, not q-3.
      fireEvent.keyDown(rowNamed("q-2"), { key: "ArrowDown" });
      fireEvent.keyDown(rowNamed("q-3"), step("ArrowDown"));
      expect(document.activeElement).toBe(rowNamed("q-1"));
      expect(rowNamed("q-1").getAttribute("aria-current")).toBe("true");
      fireEvent.keyDown(rowNamed("q-1"), step("ArrowDown"));
      expect(document.activeElement).toBe(rowNamed("q-1"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 1"));
      expect(readsOf("question-3")).toBe(0);
      expect(rows().filter((row) => row.tabIndex === 0)).toEqual([rowNamed("q-1")]);
    });

    it("steps the question shown from elsewhere in the dialog, leaving the keyboard there", async () => {
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      act(() => closeButton().focus());

      fireEvent.keyDown(closeButton(), step("ArrowDown"));
      expect(rowNamed("q-3").getAttribute("aria-current")).toBe("true");
      await waitFor(() => expect(shownBody()).toContain("Body of question 3"));
      expect(document.activeElement).toBe(closeButton());
    });

    it("says which question is shown when it changes away from its row, once, and not an opening's first", async () => {
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      expect(said()).toBeNull();
      act(() => closeButton().focus());

      fireEvent.keyDown(closeButton(), step("ArrowDown"));
      await waitFor(() => expect(said()).toBe("Showing q-3: Line of question-3"));
      // The list renewed shows nothing new and says nothing more.
      useAnnouncerStore.setState({ polite: null });
      push({ revision: 2, questions: LIST.questions.map((question) => ({ ...question })) });
      await act(async () => {});
      expect(said()).toBeNull();

      // Opened again, its first question is said by the keyboard on its row.
      act(() => useDecisionsInboxStore.getState().close());
      open();
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      expect(said()).toBeNull();
    });

    it("waits for a question's line before saying it, from off its row", async () => {
      const land3 = holdReadsOf("question-3");
      let lines!: (result: DecisionQuestionSummariesResult) => void;
      getQuestionSummariesByReference.mockImplementationOnce(
        () => new Promise<DecisionQuestionSummariesResult>((resolve) => (lines = resolve))
      );
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      act(() => closeButton().focus());

      fireEvent.keyDown(closeButton(), step("ArrowDown"));
      await act(async () => {});
      expect(said()).toBeNull();
      await act(async () =>
        lines({
          result: "read",
          summaries: ["question-1", "question-2", "question-3"].map((questionId) => ({
            questionId,
            result: "read" as const,
            line: `Line of ${questionId}`,
          })),
        })
      );
      expect(said()).toBe("Showing q-3: Line of question-3");
      await land3();
    });

    it("keeps where a step was going through a second step taken before the first is read", async () => {
      const land4 = holdReadsOf("question-4");
      listQuestions.mockResolvedValue(THREE_OPEN);
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      expect(rows().map(aliasOf).slice(0, 3)).toEqual(["q-2", "q-4", "q-5"]);
      act(() => choiceOption().focus());

      fireEvent.keyDown(choiceOption(), step("ArrowDown"));
      await act(async () => {});
      // q-4 is being read: the keyboard waits in the pane.
      expect(readsOf("question-4")).toBeGreaterThan(0);
      expect(screen.queryByTestId("decision-question-content")).toBeNull();
      expect(document.activeElement).toBe(detail());

      fireEvent.keyDown(detail(), step("ArrowDown"));
      expect(rowNamed("q-5").getAttribute("aria-current")).toBe("true");
      await waitFor(() => expect(shownBody()).toContain("Body of question 5"));
      await waitFor(() => expect(document.activeElement).toBe(choiceOption()));

      // q-4's read landing late moves nothing.
      await land4();
      expect(shownBody()).toContain("Body of question 5");
      expect(document.activeElement).toBe(choiceOption());
    });

    it("lands nowhere once another question is shown while the keyboard waits", async () => {
      const land4 = holdReadsOf("question-4");
      listQuestions.mockResolvedValue(WITH_TEXT);
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      act(() => choiceOption().focus());
      fireEvent.keyDown(choiceOption(), step("ArrowDown"));
      expect(document.activeElement).toBe(detail());

      // A pointer picks q-3, then q-4 again, neither taking focus with it.
      fireEvent.click(rowNamed("q-3"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 3"));
      expect(document.activeElement).toBe(detail());
      fireEvent.click(rowNamed("q-4"));
      await land4();
      await waitFor(() => expect(shownBody()).toContain("Body of question 4"));
      expect(document.activeElement).toBe(detail());
    });

    it("leaves the keyboard where it went while the question it was sent to is read", async () => {
      const land4 = holdReadsOf("question-4");
      listQuestions.mockResolvedValue(WITH_TEXT);
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      act(() => choiceOption().focus());
      fireEvent.keyDown(choiceOption(), step("ArrowDown"));
      act(() => closeButton().focus());

      await land4();
      await waitFor(() => expect(shownBody()).toContain("Body of question 4"));
      expect(document.activeElement).toBe(closeButton());
    });

    it("ignores the step with another modifier held, or while an input method composes", async () => {
      open();
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
      const row = rowNamed("q-2");
      expect(fireEvent.keyDown(row, { ...step("ArrowDown"), shiftKey: true })).toBe(true);
      expect(fireEvent.keyDown(row, { ...step("ArrowDown"), isComposing: true })).toBe(true);
      expect(fireEvent.keyDown(row, { ...step("ArrowDown"), keyCode: 229 })).toBe(true);
      expect(document.activeElement).toBe(row);
      expect(row.getAttribute("aria-current")).toBe("true");
      // And steps once nothing else is.
      fireEvent.keyDown(row, step("ArrowDown"));
      expect(rowNamed("q-3").getAttribute("aria-current")).toBe("true");
    });

    it("leaves an image opened full size its own keys", async () => {
      const attachments: DecisionQuestionAttachment[] = [
        {
          attachmentId: "attach_000a",
          role: "reference",
          alt: "The header",
          mime: "image/png",
          size: 3,
          sha256: "a".repeat(64),
        },
      ];
      const shown = CONTENT["question-2"]!;
      CONTENT["question-2"] = { ...shown, attachments };
      const decisions = Reflect.get(window, "electron").decisions;
      decisions.getQuestionImageByReference = vi.fn(
        async (): Promise<DecisionQuestionImagePartResult> => ({
          result: "read",
          part: {
            attachmentId: "attach_000a",
            mime: "image/png",
            sha256: "a".repeat(64),
            size: 3,
            offset: 0,
            bytes: new Uint8Array([1, 2, 3]),
          },
        })
      );
      const { createObjectURL, revokeObjectURL } = URL;
      URL.createObjectURL = () => "blob:header";
      URL.revokeObjectURL = () => {};
      try {
        open();
        await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
        fireEvent.click(await screen.findByRole("button", { name: "Open Reference image 1" }));
        const viewer = await screen.findByTestId("decision-image-viewer");
        await waitFor(() => expect(viewer.contains(document.activeElement)).toBe(true));

        fireEvent.keyDown(document.activeElement!, step("ArrowDown"));
        expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true");
        expect(screen.queryByTestId("decision-image-viewer")).not.toBeNull();
      } finally {
        // The loader lets its URLs go as it unmounts, before the stubs are put back.
        cleanup();
        CONTENT["question-2"] = shown;
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;
      }
    });
  });

  it("says when no relay is connected, and nothing once one is", async () => {
    getStatus.mockResolvedValue({ state: "not-connected", revision: 1 });
    open();
    const notice = await screen.findByTestId("decisions-inbox-connection");
    const noRelay = notice.textContent;
    expect(noRelay).toContain("Settings → Decisions");

    pushStatus({ state: "reconnecting", relayOrigin: "https://relay.example", revision: 2 });
    await waitFor(() =>
      expect(screen.getByTestId("decisions-inbox-connection").textContent).not.toBe(noRelay)
    );
    pushStatus({ state: "connected", relayOrigin: "https://relay.example", revision: 3 });
    await waitFor(() => expect(screen.queryByTestId("decisions-inbox-connection")).toBeNull());
    // The questions this computer holds stay listed throughout.
    expect(rows()).toHaveLength(3);
  });

  it("waits for the relay's status before calling an empty list new, and not for good", async () => {
    listQuestions.mockResolvedValue({ revision: 1, questions: [] });
    let rejectStatus!: (error: Error) => void;
    getStatus.mockImplementationOnce(
      () => new Promise<DecisionsStatus>((_resolve, reject) => (rejectStatus = reject))
    );
    open();
    await waitFor(() => expect(listQuestions).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId("decisions-inbox-empty")).toBeNull();
    expect(screen.queryByTestId("decisions-inbox-waiting")).toBeNull();
    // Status unknown (#18022): the list says only what it holds, rather than that nothing was asked.
    await act(async () => rejectStatus(new Error("gone")));
    await waitFor(() =>
      expect(screen.getByTestId("decisions-inbox-waiting").textContent).toMatch(
        /^No questions on this computer\. .*status couldn't be read/
      )
    );
    expect(screen.queryByTestId("decisions-inbox-empty")).toBeNull();
    pushStatus({ state: "connected", relayOrigin: "https://relay.example", revision: 2 });
    await screen.findByTestId("decisions-inbox-empty");
    expect(screen.queryByTestId("decisions-inbox-waiting")).toBeNull();
  });

  it("doesn't call an empty list new while the store can't be read", async () => {
    listQuestions.mockResolvedValue({ revision: 1, questions: [] });
    getStatus.mockResolvedValue({
      state: "not-connected",
      relayOrigin: "https://relay.example",
      problem: "storage",
      revision: 1,
    });
    open();
    await screen.findByTestId("decisions-inbox-connection");
    expect(screen.queryByTestId("decisions-inbox-empty")).toBeNull();
    // Nor that this computer holds none (#18022): the notice says none can be read.
    await act(async () => {});
    expect(screen.queryByTestId("decisions-inbox-waiting")).toBeNull();

    pushStatus({ state: "connected", relayOrigin: "https://relay.example", revision: 2 });
    await screen.findByTestId("decisions-inbox-empty");
  });

  it("says when there's nothing yet, and offers Retry when the list can't be read", async () => {
    listQuestions.mockRejectedValueOnce(new Error("gone"));
    open();
    const failed = await screen.findByTestId("decisions-inbox-failed");
    const retryButton = within(failed).getByRole("button", { name: "Retry" });
    // The one thing to do, in the list's column.
    await waitFor(() => expect(document.activeElement).toBe(retryButton));
    expect(screen.queryByTestId("decisions-inbox-waiting")).toBeNull();
    listQuestions.mockResolvedValue({ revision: 4, questions: [] });
    fireEvent.click(retryButton);
    await screen.findByTestId("decisions-inbox-empty");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("decisions-inbox-groups"))
    );
    expect(screen.queryByTestId("decisions-inbox-failed")).toBeNull();
    expect(screen.queryByTestId("decisions-inbox-detail-title")).toBeNull();
  });

  it("reads every line once, in reads the IPC takes, and leaves an unreadable row named by alias", async () => {
    const many = Array.from({ length: 130 }, (_, index) =>
      item(`question-${String(index).padStart(3, "0")}`, 100 + index, OPEN)
    );
    listQuestions.mockResolvedValue({ revision: 1, questions: many });
    getQuestionSummariesByReference.mockImplementation(async ({ references }) => ({
      result: "read",
      summaries: references.map((ref) =>
        ref.questionId === "question-000"
          ? { questionId: ref.questionId, result: "unreadable" as const }
          : { questionId: ref.questionId, result: "read" as const, line: `Line ${ref.questionId}` }
      ),
    }));
    open();
    await waitFor(() => expect(rowNamed("q-229").textContent).toContain("Line question-129"));
    const asked = getQuestionSummariesByReference.mock.calls.map(([payload]) => payload.references);
    for (const references of asked) expect(references.length).toBeLessThanOrEqual(64);
    const ids = asked.flat().map((ref) => ref.questionId);
    expect(ids.slice().sort()).toEqual(many.map((entry) => entry.reference.questionId).sort());
    expect(within(rowNamed("q-100")).getByTestId("decisions-inbox-row-line").textContent).toBe(
      "q-100"
    );
  });

  it("says what Decline does before it's pressed, and gives focus back to it with no tooltip after Keep question (#18041)", async () => {
    open();
    const decline = await screen.findByRole("button", { name: "Decline question" });
    const description = (button: HTMLElement) =>
      document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
    expect(description(decline)).toMatch(/chose not to answer/);
    // Each action in the bar says what it does: Clear stays here, Decline is sent.
    expect(description(screen.getByTestId("decisions-inbox-clear"))).toMatch(/this computer only/);
    expect(description(decline)).not.toBe(description(screen.getByTestId("decisions-inbox-clear")));
    // The consequential one looks it: never styled as the local, reversible Clear beside it.
    expect(decline.dataset.variant).not.toBe(
      screen.getByTestId("decisions-inbox-clear").dataset.variant
    );

    // A press focuses the button it lands on, which the confirmation hands focus back to.
    act(() => decline.focus());
    fireEvent.click(decline);
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep question" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(decline));
    // Focus coming back opens no tooltip the pointer never asked for; a hover still does.
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(description(decline)).toMatch(/chose not to answer/);
    fireEvent.pointerMove(decline, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toMatch(/chose not to answer/);
    expect(declineQuestion).not.toHaveBeenCalled();
  });

  it("declines the question shown only after the confirmation naming it, at the revision read (#17239)", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Decline question" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Decline question q-2?");
    expect(declineQuestion).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Decline question" }));
    });
    await waitFor(() => expect(declineQuestion).toHaveBeenCalledOnce());
    expect(declineQuestion).toHaveBeenCalledWith({
      reference: reference("question-2"),
      declineId: expect.any(String),
      expectedRevision: 1,
    });
    expect(cancelQuestionByReference).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(screen.getByTestId("decisions-inbox-dismiss-status").textContent).toMatch(/^Declined/)
    );
  });

  it("withdraws the question shown only after a second confirmation, once the relay can't take a decline", async () => {
    declineQuestion.mockImplementationOnce(async ({ declineId }) => ({
      result: "submitted",
      declineId,
      outcome: { status: "unsupported", by: "relay" },
    }));
    open();
    const decline = await screen.findByTestId("decisions-inbox-dismiss");
    const declineVariant = decline.dataset.variant;
    act(() => decline.focus());
    fireEvent.click(decline);
    const asked = await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(asked).getByRole("button", { name: "Decline question" }));
    });
    expect(asked.textContent).toContain("Withdraw question q-2?");
    fireEvent.click(within(asked).getByRole("button", { name: "Keep question" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByTestId("decisions-inbox-dismiss-status").textContent).toContain(
      "Your relay needs an update"
    );
    expect(cancelQuestionByReference).not.toHaveBeenCalled();

    const offered = await screen.findByTestId("decisions-inbox-withdraw");
    await waitFor(() => expect(document.activeElement).toBe(offered));
    expect(
      document.getElementById(offered.getAttribute("aria-describedby") ?? "")?.textContent
    ).toMatch(/withdrawn when it checks/);
    // As consequential as the Decline it takes the place of.
    expect(offered.dataset.variant).toBe(declineVariant);
    fireEvent.click(offered);
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Withdraw question q-2?");
    const withdraw = within(confirm).getByRole("button", { name: "Withdraw question" });
    await waitFor(() => expect(withdraw.hasAttribute("aria-disabled")).toBe(false));
    await act(async () => {
      fireEvent.click(withdraw);
    });
    await waitFor(() => expect(cancelQuestionByReference).toHaveBeenCalledOnce());
    expect(cancelQuestionByReference).toHaveBeenCalledWith({ reference: reference("question-2") });
    expect(declineQuestion).toHaveBeenCalledOnce();
  });

  it("offers no decline for a question that has stopped waiting", async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(rowNamed("q-1"));
    await waitFor(() => expect(shownBody()).toContain("Body of question 1"));
    expect(screen.queryByTestId("decisions-inbox-dismiss")).toBeNull();
  });

  it("offers no new follow-up under the shown answer's delivery warning, and offers it again once it's marked handled (#18028)", async () => {
    const stalled = item(
      "question-3",
      3,
      { kind: "needs-attention", deliveryStatus: "delivery-uncertain" },
      {
        reference: reference("question-3", { projectId: "project-b", terminalId: "t9" }),
        stall: { answerRevision: 1, followUpIds: [], reason: "resume_timeout" },
      }
    );
    listQuestions.mockResolvedValue({ revision: 1, questions: [LIST.questions[1]!, stalled] });
    const shown = CONTENT["question-3"]!;
    CONTENT["question-3"] = { ...shown, terminalId: "t9" };
    const said: string[] = [];
    const announce = useAnnouncerStore.getState().announce;
    useAnnouncerStore.setState({ announce: (message: string) => said.push(message) });
    onTestFinished(() => useAnnouncerStore.setState({ announce }));
    const pausedText = () => screen.queryByTestId("decision-follow-up-paused")?.textContent ?? null;
    try {
      open();
      await waitFor(() => expect(rows()).toHaveLength(2));
      fireEvent.click(rowNamed("q-3"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 3"));
      expect(screen.getByTestId("decisions-inbox-attention").textContent).toContain(
        "Delivery uncertain"
      );
      const composer = await screen.findByTestId("decision-follow-up-composer");
      expect(pausedText()).toMatch(/can't send a new follow-up until it's resolved/);
      expect(screen.queryByTestId("decision-follow-up-send")).toBeNull();
      expect(composer.textContent).not.toMatch(/Typed into the terminal that asked/);
      // Already so as it opened: shown, never announced.
      expect(said.filter((message) => message.includes("new follow-up"))).toEqual([]);

      // The other row's question takes a follow-up as ever: the stall is only the one it names.
      // Still open, its answer leads and the follow-up waits behind its control (#18040).
      fireEvent.click(rowNamed("q-2"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      fireEvent.click(await screen.findByTestId("decision-follow-up-open"));
      await waitFor(() => expect(screen.queryByTestId("decision-follow-up-send")).not.toBeNull());
      expect(pausedText()).toBeNull();

      fireEvent.click(rowNamed("q-3"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 3"));
      await waitFor(() => expect(pausedText()).not.toBeNull());

      // Marked handled: the question's own read is unchanged, the list no longer holds it.
      push({
        revision: 2,
        questions: [
          LIST.questions[1]!,
          {
            ...stalled,
            standing: { kind: "settled", outcome: "answered", handled: true },
            stall: null,
          },
        ],
      });
      await waitFor(() => expect(screen.queryByTestId("decision-follow-up-send")).not.toBeNull());
      expect(screen.queryByTestId("decisions-inbox-attention")).toBeNull();
      expect(pausedText()).toBeNull();
      expect(screen.getByTestId("decision-follow-up-composer").textContent).toMatch(
        /Typed into the terminal that asked/
      );
    } finally {
      CONTENT["question-3"] = shown;
    }
  });

  it("says once what stopped and why, and sends a Remote Host's question to its Host (#18026)", async () => {
    const closed = {
      closedReason: "expired",
      closureNotice: { delivery: "needs-attention", disposition: "fallback-due" },
    } as const;
    const stalled = item(
      "question-3",
      3,
      { kind: "needs-attention", deliveryStatus: "needs-attention" },
      {
        reference: reference("question-3", { projectId: "project-b", terminalId: "t9" }),
        ...closed,
        stall: { answerRevision: 0, followUpIds: [], reason: "pane_gone" },
      }
    );
    listQuestions.mockResolvedValue({ revision: 1, questions: [LIST.questions[1]!, stalled] });
    const shown = CONTENT["question-3"]!;
    CONTENT["question-3"] = { ...shown, terminalId: "t9", status: "expired", ...closed };
    const callout = () => screen.getByTestId("decisions-inbox-attention").textContent ?? "";
    try {
      open();
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(rowNamed("q-3").textContent).toContain("Timeout notice not typed in");
      fireEvent.click(rowNamed("q-3"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 3"));
      expect(callout()).toContain(
        "The timeout notice wasn't typed in. The terminal that asked was closed. Choose what happens to it."
      );
      expect(screen.getByTestId("decisions-inbox-review-attention")).not.toBeNull();
      // The warning states the notice's delivery, so the facts keep only what it says of the plan.
      await waitFor(() =>
        expect(screen.getByTestId("decision-question-notice").textContent).toBe(
          "The timeout notice says the agent may go ahead with its plan."
        )
      );
      expect(screen.getByTestId("decision-question-content").textContent).not.toMatch(
        /stopped before it was typed/
      );
      // Only the notice's delivery goes: the rest of the facts stay.
      expect(screen.getByTestId("decision-question-status").textContent).toBe("Expired unanswered");

      push({
        revision: 2,
        questions: [
          LIST.questions[1]!,
          { ...stalled, remoteHost: { hostId: "atlas", name: "Atlas", connected: true } },
        ],
      });
      await waitFor(() =>
        expect(callout()).toMatch(/Atlas keeps it, so it can't be resolved from this computer\./)
      );
      expect(callout()).not.toMatch(/Choose/);
      expect(screen.queryByTestId("decisions-inbox-review-attention")).toBeNull();
    } finally {
      CONTENT["question-3"] = shown;
    }
  });

  describe("a Remote Host's question while its Host is away (#17946)", () => {
    const AWAY_REFERENCE = reference("question-9", { hostId: "qhost_studio_0001" });
    const AWAY = {
      ...item("question-9", 9, OPEN, {
        reference: AWAY_REFERENCE,
        remoteHost: { hostId: "studio", name: "Studio", connected: false },
      }),
      inbox: { ask: null, seen: true, cleared: false },
    };

    beforeEach(() => {
      listQuestions.mockResolvedValue({ revision: 2, questions: [AWAY] });
    });

    it("declines it from what was last read of it, and never offers withdrawing in its place", async () => {
      getQuestionContentByReference.mockResolvedValue({
        result: "host-not-connected",
        lastRead: { result: "read", revision: 4, alias: 9, readAt: Date.now() - 60_000 },
      });
      declineQuestion.mockImplementation(async ({ declineId }) => ({
        result: "submitted",
        declineId,
        outcome: { status: "unsupported", by: "asking-desktop" },
      }));
      open();
      await waitFor(() =>
        expect(screen.getByTestId("decision-question-unavailable").textContent).toMatch(
          /isn't connected.*last read it 1 minute ago, so you can still decline it/
        )
      );
      fireEvent.click(await screen.findByTestId("decisions-inbox-dismiss"));
      const confirm = await screen.findByRole("alertdialog");
      expect(confirm.textContent).toContain("Decline question q-9?");
      expect(confirm.textContent).toMatch(/If it hasn't changed since this computer last read it/);
      await act(async () => {
        fireEvent.click(within(confirm).getByRole("button", { name: "Decline question" }));
      });
      await waitFor(() =>
        expect(declineQuestion).toHaveBeenCalledExactlyOnceWith({
          reference: AWAY_REFERENCE,
          declineId: expect.any(String),
          expectedRevision: 4,
        })
      );

      // Not taken: said plainly, with nothing withdrawn and no withdrawal offered instead.
      await waitFor(() =>
        expect(confirm.textContent).toMatch(
          /Daintree on the computer that asked q-9 needs an update/
        )
      );
      expect(within(confirm).queryByRole("button", { name: "Withdraw question" })).toBeNull();
      fireEvent.click(within(confirm).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.queryByTestId("decisions-inbox-withdraw")).toBeNull();
      expect(cancelQuestionByReference).not.toHaveBeenCalled();
    });

    it("never offers withdrawing for a decline signed from the last read once the Host went away under the confirmation", async () => {
      getQuestionContentByReference.mockResolvedValue({
        result: "read",
        question: content("question-9", 9, {
          reference: AWAY_REFERENCE,
          status: "open",
          revision: 4,
        }),
      });
      declineQuestion.mockImplementation(async ({ declineId }) => ({
        result: "submitted",
        declineId,
        outcome: { status: "unsupported", by: "relay" },
      }));
      open();
      fireEvent.click(await screen.findByTestId("decisions-inbox-dismiss"));
      const confirm = await screen.findByRole("alertdialog");
      // The Host goes away while the person reads the confirmation opened on a live read.
      getQuestionContentByReference.mockResolvedValue({
        result: "host-not-connected",
        lastRead: { result: "read", revision: 4, alias: 9, readAt: Date.now() },
      });
      await act(async () => {
        fireEvent.click(within(confirm).getByRole("button", { name: "Decline question" }));
      });
      await waitFor(() =>
        expect(confirm.textContent).toMatch(/Your relay needs an update.*q-9 wasn't declined/)
      );
      expect(declineQuestion).toHaveBeenCalledOnce();
      expect(confirm.textContent).not.toContain("Withdraw question");
      expect(confirm.textContent).not.toMatch(/withdraw it instead/);
      expect(cancelQuestionByReference).not.toHaveBeenCalled();
    });

    it("offers no withdrawal for a decline signed from the last read once the Host is back", async () => {
      const declineId = "0190f0aa-1111-4222-8333-44445555ee01";
      useDecisionsAnswerStore.getState().update(answerKey(AWAY_REFERENCE), (record) => ({
        ...record,
        decline: {
          declineId,
          payload: { reference: AWAY_REFERENCE, declineId, expectedRevision: 4 },
          phase: { kind: "settled", outcome: { status: "unsupported", by: "relay" } },
          resubmitted: false,
          lastReadAt: 1_000,
        },
      }));
      getQuestionContentByReference.mockResolvedValue({
        result: "read",
        question: content("question-9", 9, {
          reference: AWAY_REFERENCE,
          status: "open",
          revision: 4,
        }),
      });
      open();
      await waitFor(() =>
        expect(screen.getByTestId("decisions-inbox-dismiss-status").textContent).toMatch(
          /^Your relay needs an update.*q-9 wasn't declined\.$/
        )
      );
      expect(screen.queryByTestId("decisions-inbox-withdraw")).toBeNull();
      // A new Decline, from the live read, is its own decision.
      expect(screen.getByTestId("decisions-inbox-dismiss")).toBeTruthy();
    });

    it("says why it can't be declined when nothing read here says where it stands, and keeps Clear", async () => {
      getQuestionContentByReference.mockResolvedValue({
        result: "host-not-connected",
        lastRead: { result: "not-read" },
      });
      open();
      await waitFor(() =>
        expect(screen.getByTestId("decision-question-unavailable").textContent).toMatch(
          /isn't connected.*can't be declined until the Host is back/
        )
      );
      expect(screen.queryByTestId("decisions-inbox-dismiss")).toBeNull();
      expect(screen.getByTestId("decisions-inbox-clear").textContent).toBe("Clear from Needs you");
      expect(declineQuestion).not.toHaveBeenCalled();
    });
  });

  describe("going to the terminal that asked", () => {
    it("focuses a panel of this view only once the inbox has closed", async () => {
      panels = { t1: { location: "grid" } };
      open();
      const go = await screen.findByTestId("decisions-inbox-go-to-terminal");
      expect(
        document.getElementById(go.getAttribute("aria-describedby") ?? "")?.textContent
      ).toMatch(/terminal that asked/);
      fireEvent.click(go);
      expect(useDecisionsInboxStore.getState().isOpen).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
      await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      expect(dispatch).toHaveBeenCalledWith("panel.focus", { panelId: "t1" });
    });

    it("forgets a way to the terminal once the inbox opens again before it had gone", async () => {
      panels = { t1: { location: "grid" } };
      open();
      fireEvent.click(await screen.findByTestId("decisions-inbox-go-to-terminal"));
      open();
      await waitFor(() => expect(rows()).toHaveLength(3));
      act(() => useDecisionsInboxStore.getState().close());
      await waitFor(() => expect(screen.queryByTestId("decisions-inbox-dialog")).toBeNull());
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("offers nothing for a panel that's gone or in the trash", async () => {
      panels = { t1: { location: "trash" } };
      open();
      await screen.findByTestId("decision-question-content");
      expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
    });

    it("switches to another project whose terminal still runs here", async () => {
      getAllTerminals.mockResolvedValue([
        terminal({ id: "t9", projectId: "project-b", hasPty: true }),
      ]);
      open({ terminalId: "t9" });
      const go = await screen.findByTestId("decisions-inbox-go-to-terminal");
      fireEvent.click(go);
      await waitFor(() =>
        expect(dispatch).toHaveBeenCalledWith("pilot.openRun", {
          runId: "t9",
          workspaceId: "project-b",
        })
      );
    });

    it("looks again before switching, and stays when the terminal has gone", async () => {
      getAllTerminals.mockResolvedValue([
        terminal({ id: "t9", projectId: "project-b", hasPty: true }),
      ]);
      open({ terminalId: "t9" });
      const go = await screen.findByTestId("decisions-inbox-go-to-terminal");
      getAllTerminals.mockResolvedValue([]);
      await act(async () => {
        fireEvent.click(go);
      });
      await waitFor(() =>
        expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull()
      );
      expect(useDecisionsInboxStore.getState().isOpen).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("does nothing from a button pressed while the inbox is closing", async () => {
      getAllTerminals.mockResolvedValue([
        terminal({ id: "t9", projectId: "project-b", hasPty: true }),
      ]);
      open({ terminalId: "t9" });
      const go = await screen.findByTestId("decisions-inbox-go-to-terminal");
      const looks = getAllTerminals.mock.calls.length;
      act(() => useDecisionsInboxStore.getState().close());
      fireEvent.click(go);
      await act(async () => {});
      expect(getAllTerminals.mock.calls.length).toBe(looks);
      await waitFor(() => expect(screen.queryByTestId("decisions-inbox-dialog")).toBeNull());
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("drops a look that lands after another question was chosen", async () => {
      getAllTerminals.mockResolvedValue([
        terminal({ id: "t9", projectId: "project-b", hasPty: true }),
      ]);
      open({ terminalId: "t9" });
      const go = await screen.findByTestId("decisions-inbox-go-to-terminal");
      let resolveLook!: (terminals: BackendTerminalInfo[]) => void;
      getAllTerminals.mockImplementationOnce(
        () => new Promise<BackendTerminalInfo[]>((resolve) => (resolveLook = resolve))
      );
      fireEvent.click(go);
      fireEvent.click(rowNamed("q-2"));
      await waitFor(() => expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true"));
      await act(async () =>
        resolveLook([terminal({ id: "t9", projectId: "project-b", hasPty: true })])
      );
      expect(useDecisionsInboxStore.getState().isOpen).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("never matches the same terminal id in another project, nor a trashed one", async () => {
      getAllTerminals.mockResolvedValue([
        terminal({ id: "t9", projectId: "project-c", hasPty: true }),
        terminal({ id: "t9", projectId: "project-b", isTrashed: true }),
      ]);
      open({ terminalId: "t9" });
      await waitFor(() => expect(getAllTerminals).toHaveBeenCalled());
      await screen.findByTestId("decision-question-content");
      expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
    });

    it("offers nothing in a Remote Host's window for this computer's own question, and names questions as they were asked", async () => {
      remote = true;
      panels = { t1: { location: "grid" } };
      // The window's runs are the Host's, whatever their ids: none titles this computer's question.
      fleet([
        {
          runId: "t1",
          workspaceId: "project-a",
          agentId: "claude",
          title: "Host pane",
          titleMode: "user",
        },
      ]);
      open();
      await screen.findByTestId("decision-question-content");
      expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
      expect(getAllTerminals).not.toHaveBeenCalled();
      // Its projects are another computer's, whatever their ids.
      expect(rowNamed("q-2").textContent).toContain("Alpha (as asked)");
      expect(originOf("q-2")).toBe(
        `${getEffectiveAgentConfig("claude")!.name} · feature-x · Alpha (as asked)`
      );
    });

    describe("across machines whose ids repeat (#18049)", () => {
      const STUDIO = { hostId: "studio", name: "Studio", connected: true };
      const BUILD_BOX = { hostId: "build-box", name: "Build box", connected: true };

      /** One open question per machine (this computer's for undefined), each in project A's terminal t1. */
      function onMachines(...hosts: Array<typeof STUDIO | undefined>): DecisionQuestionList {
        return {
          revision: 1,
          questions: hosts.map((remoteHost, index) =>
            item(`question-${index + 1}`, index + 1, OPEN, {
              reference: reference(`question-${index + 1}`, {
                hostId: remoteHost === undefined ? "host_1" : `host_${remoteHost.hostId}`,
              }),
              askedAt: `2026-11-02T0${index + 1}:00:00.000Z`,
              ...(remoteHost === undefined ? {} : { remoteHost }),
            })
          ),
        };
      }

      beforeEach(() => {
        panels = { t1: { location: "grid" } };
        getQuestionContentByReference.mockImplementation(async ({ reference: asked }) => ({
          result: "read",
          question: content(asked.questionId, Number(asked.questionId.slice(-1)), {
            reference: asked,
          }),
        }));
      });

      it("opens a Host's window at its own pane's question, and goes to that pane", async () => {
        remote = true;
        listQuestions.mockResolvedValue(onMachines(undefined, STUDIO, BUILD_BOX));
        open({ terminalId: "t1" });
        await waitFor(() => expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true"));
        fireEvent.click(await screen.findByTestId("decisions-inbox-go-to-terminal"));
        await waitFor(() =>
          expect(dispatch).toHaveBeenCalledWith("panel.focus", { panelId: "t1" })
        );
        expect(getAllTerminals).not.toHaveBeenCalled();
      });

      it("offers no way from a Host's window to its own question in another project, or to a pane gone or trashed", async () => {
        remote = true;
        const elsewhere = onMachines(STUDIO);
        elsewhere.questions[0] = {
          ...elsewhere.questions[0]!,
          reference: reference("question-1", { hostId: "host_studio", projectId: "project-b" }),
        };
        listQuestions.mockResolvedValue(elsewhere);
        getAllTerminals.mockResolvedValue([
          terminal({ id: "t1", projectId: "project-b", hasPty: true }),
        ]);
        open({ terminalId: "t1" });
        await screen.findByTestId("decision-question-content");
        expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
        act(() => useDecisionsInboxStore.getState().close());
        await waitFor(() => expect(screen.queryByTestId("decisions-inbox-dialog")).toBeNull());

        listQuestions.mockResolvedValue(onMachines(STUDIO));
        const trashedOrGone: Array<Record<string, { location: string }>> = [
          { t1: { location: "trash" } },
          {},
        ];
        for (const shown of trashedOrGone) {
          panels = shown;
          open({ terminalId: "t1" });
          await screen.findByTestId("decision-question-content");
          expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
          act(() => useDecisionsInboxStore.getState().close());
          await waitFor(() => expect(screen.queryByTestId("decisions-inbox-dialog")).toBeNull());
        }
        expect(getAllTerminals).not.toHaveBeenCalled();
      });

      it("offers no way from a Host's window to another machine's terminal with the same ids", async () => {
        remote = true;
        listQuestions.mockResolvedValue(onMachines(undefined, STUDIO, BUILD_BOX));
        open();
        await waitFor(() => expect(rows()).toHaveLength(3));
        for (const other of ["q-1", "q-3"]) {
          fireEvent.click(rowNamed(other));
          await waitFor(() => expect(rowNamed(other).getAttribute("aria-current")).toBe("true"));
          await screen.findByTestId("decision-question-content");
          expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
        }
        expect(getAllTerminals).not.toHaveBeenCalled();
      });

      it("takes no Host's question for this computer's in its own window, by pane or by name", async () => {
        listQuestions.mockResolvedValue(onMachines(STUDIO, undefined));
        open({ terminalId: "t1" });
        // The opener's pane is this computer's t1, so its own question, not Studio's.
        await waitFor(() => expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true"));
        expect(await screen.findByTestId("decisions-inbox-go-to-terminal")).toBeTruthy();
        expect(rowNamed("q-2").textContent).toContain("Alpha");
        expect(rowNamed("q-2").textContent).not.toContain("Alpha (as asked)");

        fireEvent.click(rowNamed("q-1"));
        await waitFor(() => expect(rowNamed("q-1").getAttribute("aria-current")).toBe("true"));
        await screen.findByTestId("decision-question-content");
        expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
        expect(getAllTerminals).not.toHaveBeenCalled();
        expect(rowNamed("q-1").textContent).toContain("Alpha (as asked)");
      });
    });
  });

  describe("seen and cleared on this computer (#17895)", () => {
    const unmarked: NonNullable<DecisionQuestionListItem["inbox"]> = {
      ask: null,
      seen: false,
      cleared: false,
    };
    /** `LIST` as this computer lists it: question-2, in Needs you, carrying `inbox`. */
    function marked(inbox = unmarked, revision = 2, extra: DecisionQuestionListItem[] = []) {
      return {
        revision,
        questions: [
          ...LIST.questions.map((question) =>
            question.reference.questionId === "question-2" ? { ...question, inbox } : question
          ),
          ...extra,
        ],
      };
    }
    const seenCalls = () => markQuestions.mock.calls.filter(([p]) => p.action === "seen");

    beforeEach(() => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("marks the question it shows seen once its read is on screen, at the ask the list names", async () => {
      listQuestions.mockResolvedValue(marked());
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      await waitFor(() =>
        expect(seenCalls().map(([payload]) => payload)).toEqual([
          { action: "seen", questions: [{ reference: reference("question-2"), ask: null }] },
        ])
      );
      // Once the list says it took, nothing more is sent for it.
      push(marked({ ...unmarked, seen: true }, 3));
      await act(async () => {});
      expect(seenCalls()).toHaveLength(1);
    });

    it("marks nothing seen while its window doesn't have focus, and does once it has", async () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      listQuestions.mockResolvedValue(marked());
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      await act(async () => {});
      expect(seenCalls()).toHaveLength(0);

      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(seenCalls()).toHaveLength(1));
    });

    it("marks nothing seen while another modal covers the inbox, and does once it closes", async () => {
      let land!: (read: DecisionQuestionContentResult) => void;
      getQuestionContentByReference.mockImplementation(
        () => new Promise<DecisionQuestionContentResult>((resolve) => (land = resolve))
      );
      listQuestions.mockResolvedValue(marked());
      open();
      await waitFor(() => expect(readsOf("question-2")).toBe(1));
      // An image opened full size over the reader: a modal of its own, on top of the inbox.
      const cover = document.createElement("div");
      cover.setAttribute("role", "dialog");
      cover.setAttribute("aria-modal", "true");
      cover.tabIndex = -1;
      document.body.appendChild(cover);
      try {
        act(() => cover.focus());
        await act(async () => land({ result: "read", question: CONTENT["question-2"]! }));
        await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
        await act(async () => {});
        expect(seenCalls()).toHaveLength(0);

        // Closed: the keyboard comes back into the inbox.
        act(() => {
          cover.remove();
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
          rowNamed("q-2").focus();
        });
        await waitFor(() => expect(seenCalls()).toHaveLength(1));
      } finally {
        cover.remove();
      }
    });

    it("waits for a read that holds the agent's follow-up the ask names before marking it seen", async () => {
      const followUp = {
        type: "message" as const,
        messageId: "note-1",
        from: "agent" as const,
        text: "Also check the staging branch",
        images: [],
        expectsReply: false,
        sentAt: "2026-11-02T10:05:00.000Z",
        deliveryStatus: null,
        unreadable: false,
      };
      // Seen at the question alone; the list's first push is the baseline the reader compares with.
      listQuestions.mockResolvedValue(marked({ ...unmarked, seen: true }));
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      push(marked({ ...unmarked, seen: true }, 2));
      await waitFor(() => expect(readsOf("question-2")).toBe(2));
      // The agent follows up: the list says so, and only that moves, so the question is read again.
      let land!: (read: DecisionQuestionContentResult) => void;
      getQuestionContentByReference.mockImplementation(
        () => new Promise<DecisionQuestionContentResult>((resolve) => (land = resolve))
      );
      push(marked({ ...unmarked, ask: "note-1" }, 3));
      await waitFor(() => expect(readsOf("question-2")).toBe(3));
      await act(async () => {});
      // The read on screen predates the follow-up.
      expect(seenCalls()).toHaveLength(0);

      await act(async () =>
        land({ result: "read", question: { ...CONTENT["question-2"]!, thread: [followUp] } })
      );
      await waitFor(() =>
        expect(seenCalls().map(([payload]) => payload.questions[0]?.ask)).toEqual(["note-1"])
      );
    });

    it("holds Clear while the read on screen predates what the question asks now", async () => {
      listQuestions.mockResolvedValue(marked({ ...unmarked, seen: true }));
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      let land!: (read: DecisionQuestionContentResult) => void;
      getQuestionContentByReference.mockImplementation(
        () => new Promise<DecisionQuestionContentResult>((resolve) => (land = resolve))
      );
      push(marked({ ...unmarked, ask: "note-1" }, 3));
      const clear = screen.getByTestId("decisions-inbox-clear");
      await waitFor(() => expect(clear.getAttribute("aria-disabled")).toBe("true"));
      fireEvent.click(clear);
      await act(async () => {});
      expect(markQuestions.mock.calls.filter(([p]) => p.action === "clear")).toHaveLength(0);

      // The read with the follow-up lands: Clear takes it, at that ask.
      await act(async () =>
        land({
          result: "read",
          question: {
            ...CONTENT["question-2"]!,
            thread: [
              {
                type: "message",
                messageId: "note-1",
                from: "agent",
                text: "One more thing",
                images: [],
                expectsReply: false,
                sentAt: "2026-11-02T10:05:00.000Z",
                deliveryStatus: null,
                unreadable: false,
              },
            ],
          },
        })
      );
      await waitFor(() => expect(clear.getAttribute("aria-disabled")).toBeNull());
      fireEvent.click(clear);
      await waitFor(() =>
        expect(markQuestions).toHaveBeenCalledWith({
          action: "clear",
          questions: [{ reference: reference("question-2"), ask: "note-1" }],
        })
      );
    });

    it("marks the first question to reach an empty inbox seen as it shows, with no focus moving", async () => {
      listQuestions.mockResolvedValue({ revision: 1, questions: [] });
      open();
      await waitFor(() => expect(screen.getByTestId("decisions-inbox-empty")).toBeTruthy());
      await act(async () => {});
      push(marked(unmarked, 2));
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      await waitFor(() => expect(seenCalls()).toHaveLength(1));
    });

    it("marks a follow-up seen only once it's scrolled into view", async () => {
      const observed: Array<{ target: Element; fire: (visible: boolean) => void }> = [];
      vi.stubGlobal(
        "IntersectionObserver",
        class implements IntersectionObserver {
          readonly root = null;
          readonly rootMargin = "0px";
          readonly scrollMargin = "0px";
          readonly thresholds = [0];
          constructor(private readonly callback: IntersectionObserverCallback) {}
          observe(target: Element) {
            observed.push({
              target,
              fire: (visible) => {
                const rect = target.getBoundingClientRect();
                const entry: IntersectionObserverEntry = {
                  boundingClientRect: rect,
                  intersectionRatio: visible ? 1 : 0,
                  intersectionRect: rect,
                  isIntersecting: visible,
                  rootBounds: null,
                  target,
                  time: 0,
                };
                this.callback([entry], this);
              },
            });
          }
          unobserve() {}
          disconnect() {}
          takeRecords(): IntersectionObserverEntry[] {
            return [];
          }
        }
      );
      const followUp = {
        type: "message" as const,
        messageId: "note-1",
        from: "agent" as const,
        text: "Also check the staging branch",
        images: [],
        expectsReply: false,
        sentAt: "2026-11-02T10:05:00.000Z",
        deliveryStatus: null,
        unreadable: false,
      };
      getQuestionContentByReference.mockImplementation(async ({ reference: ref }) => ({
        result: "read",
        question:
          ref.questionId === "question-2"
            ? { ...CONTENT["question-2"]!, thread: [followUp] }
            : CONTENT[ref.questionId]!,
      }));
      listQuestions.mockResolvedValue(marked({ ...unmarked, ask: "note-1" }));
      try {
        open();
        await waitFor(() => expect(observed.length).toBeGreaterThan(0));
        const entry = observed.at(-1)!;
        expect(entry.target.getAttribute("data-message-id")).toBe("note-1");
        act(() => entry.fire(false));
        await act(async () => {});
        expect(seenCalls()).toHaveLength(0);

        act(() => entry.fire(true));
        await waitFor(() =>
          expect(seenCalls().map(([payload]) => payload.questions[0]?.ask)).toEqual(["note-1"])
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("clears the question shown from Needs you without a confirmation, and restores it", async () => {
      listQuestions.mockResolvedValue(marked());
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      const button = screen.getByTestId("decisions-inbox-clear");
      fireEvent.click(button);
      await waitFor(() =>
        expect(markQuestions).toHaveBeenCalledWith({
          action: "clear",
          questions: [{ reference: reference("question-2"), ask: null }],
        })
      );
      // No confirmation, nothing withdrawn or declined.
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(cancelQuestionByReference).not.toHaveBeenCalled();
      expect(declineQuestion).not.toHaveBeenCalled();

      push(marked({ ...unmarked, seen: true, cleared: true }, 3));
      await waitFor(() =>
        expect(screen.getByTestId("decisions-inbox-group-cleared").textContent).toContain("q-2")
      );
      expect(screen.queryByTestId("decisions-inbox-group-needs-you")).toBeNull();
      // Still the question shown, and one button that now undoes it.
      expect(shownBody()).toContain("Body of question 2");
      expect(screen.getByTestId("decisions-inbox-clear")).toBe(button);
      fireEvent.click(button);
      await waitFor(() =>
        expect(markQuestions).toHaveBeenLastCalledWith({
          action: "restore",
          questions: [{ reference: reference("question-2"), ask: null }],
        })
      );
    });

    it("clears a question it can't read, as for a Host that isn't connected", async () => {
      getQuestionContentByReference.mockResolvedValue({ result: "host-not-connected" });
      const away = {
        ...item("question-9", 9, OPEN, {
          reference: reference("question-9", { hostId: "qhost_studio_0001" }),
          remoteHost: { hostId: "studio", name: "Studio", connected: false },
        }),
        inbox: { ask: "note-3", seen: false, cleared: false },
      };
      listQuestions.mockResolvedValue({ revision: 2, questions: [away] });
      open();
      await waitFor(() => expect(readsOf("question-9")).toBe(1));
      await act(async () => {});
      fireEvent.click(screen.getByTestId("decisions-inbox-clear"));
      await waitFor(() =>
        expect(markQuestions).toHaveBeenCalledWith({
          action: "clear",
          questions: [{ reference: away.reference, ask: "note-3" }],
        })
      );
      // Never read, never seen.
      expect(seenCalls()).toHaveLength(0);
    });

    it("clears all of Needs you at once, seen questions included, each at the ask shown", async () => {
      const second = {
        ...item("question-4", 4, OPEN),
        inbox: { ask: "note-9", seen: true, cleared: false },
      };
      listQuestions.mockResolvedValue(marked(unmarked, 2, [second]));
      open();
      await waitFor(() => expect(rows()).toHaveLength(4));
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
      const clearAll = screen.getByTestId("decisions-inbox-clear-all");
      const footer = clearAll.parentElement!;
      act(() => clearAll.focus());
      expect(document.activeElement).toBe(clearAll);
      fireEvent.click(clearAll);
      await waitFor(() =>
        expect(markQuestions).toHaveBeenCalledWith({
          action: "clear",
          questions: [
            { reference: reference("question-2"), ask: null },
            { reference: reference("question-4"), ask: "note-9" },
          ],
        })
      );

      // With Needs you empty the button goes (#18022), and the keyboard on it moves to the list.
      push(
        marked({ ...unmarked, cleared: true }, 3, [
          { ...second, inbox: { ...second.inbox, cleared: true } },
        ])
      );
      await waitFor(() =>
        expect(screen.queryByTestId("decisions-inbox-group-needs-you")).toBeNull()
      );
      expect(screen.queryByTestId("decisions-inbox-clear-all")).toBeNull();
      // Beta's question keeps the switch between projects beneath the list (#18051).
      expect(footer.isConnected).toBe(true);
      expect(footer.contains(screen.getByRole("radiogroup", { name: "Questions shown" }))).toBe(
        true
      );
      await waitFor(() =>
        expect(document.activeElement).toBe(rows().find((row) => row.tabIndex === 0))
      );
      expect(screen.getByTestId("decisions-inbox-waiting").textContent).toBe(
        "No questions waiting on you"
      );
    });

    it("draws a cleared row as set aside, not as a live ask, while a screen reader still hears it was cleared", async () => {
      const asking = item("question-4", 4, OPEN, { askedAt: "2026-11-02T09:30:00.000Z" });
      listQuestions.mockResolvedValue(marked({ ...unmarked, cleared: true }, 2, [asking]));
      open();
      await waitFor(() =>
        expect(screen.getByTestId("decisions-inbox-group-cleared").textContent).toContain("q-2")
      );
      const cleared = rowNamed("q-2");
      const live = rowNamed("q-4");
      const ended = rowNamed("q-1");
      const delivering = rowNamed("q-3");
      const glyph = (row: HTMLElement) => row.querySelector("svg[data-agent-state-glyph]")!;
      const line = (row: HTMLElement) =>
        row.querySelector('[data-testid="decisions-inbox-row-line"]')!.getAttribute("class");

      // Still the question's own mark, so it doesn't read as closed or as a delivery.
      expect(glyph(cleared).innerHTML).toBe(glyph(live).innerHTML);
      expect(glyph(cleared).innerHTML).not.toBe(glyph(ended).innerHTML);
      expect(glyph(cleared).innerHTML).not.toBe(glyph(delivering).innerHTML);
      // In History's quiet ink, not the live ask's.
      expect(glyph(cleared).getAttribute("class")).toBe(glyph(ended).getAttribute("class"));
      expect(glyph(cleared).getAttribute("class")).not.toBe(glyph(live).getAttribute("class"));
      // Its title steps down to History's weight.
      expect(line(cleared)).toBe(line(ended));
      expect(line(cleared)).not.toBe(line(live));
      // The Cleared heading says it; the row doesn't repeat it, though a screen reader hears it once.
      expect(drawnText(cleared)).not.toMatch(/cleared on this computer/i);
      expect(nameOf(cleared).match(/cleared on this computer/gi)).toHaveLength(1);
      expect(nameOf(live)).not.toMatch(/cleared on this computer/i);
    });

    it("still draws what sets a cleared row apart: a deadline inside a day, one that passed, a reply asked for", async () => {
      const inbox = { ask: null, seen: true, cleared: true };
      const hour = 60 * 60_000;
      const soonAt = new Date(Date.now() + 3 * hour).toISOString();
      const passedAt = new Date(Date.now() - 60_000).toISOString();
      // Question 4 is the live ask with the same deadline, for what a cleared row's chip is drawn against.
      const live = item("question-4", 4, OPEN, { expiresAt: soonAt });
      const soon = item("question-5", 5, OPEN, { expiresAt: soonAt, inbox });
      const passed = item("question-6", 6, OPEN, { expiresAt: passedAt, inbox });
      const reply = item(
        "question-7",
        7,
        { kind: "waiting", reason: "reply" },
        { replyRequest: "note-1", inbox: { ...inbox, ask: "note-1" } }
      );
      const queued = item("question-8", 8, { kind: "queued" }, { expiresAt: passedAt, inbox });
      listQuestions.mockResolvedValue(
        marked({ ...unmarked, cleared: true }, 2, [live, soon, passed, reply, queued])
      );
      open();
      await waitFor(() => expect(rows()).toHaveLength(8));
      const group = screen.getByTestId("decisions-inbox-group-cleared");
      for (const alias of ["q-2", "q-5", "q-6", "q-7", "q-8"]) {
        expect(group.textContent).toContain(alias);
      }
      expect(screen.getByTestId("decisions-inbox-group-needs-you").textContent).toContain("q-4");
      const clock = (row: HTMLElement) =>
        [...row.querySelectorAll("svg")].find((icon) =>
          icon.parentElement?.textContent?.includes("Reply by")
        )!;

      // A deadline inside a day: the chip, drawn and spoken, without the live ask's amber clock.
      expect(drawnText(rowNamed("q-5"))).toMatch(/Reply by .+ · \d+ hours left/);
      expect(nameOf(rowNamed("q-5"))).toMatch(
        /cleared on this computer, reply by .+ · \d+ hours left/
      );
      expect(clock(rowNamed("q-5")).getAttribute("class")).not.toBe(
        clock(rowNamed("q-4")).getAttribute("class")
      );
      // Past it, an ask no longer waits on the person, to the eye or the ear, however the list stands it.
      for (const alias of ["q-6", "q-8"]) {
        expect(drawnText(rowNamed(alias))).toContain("Deadline passed");
        expect(drawnText(rowNamed(alias))).not.toMatch(/Reply by|left/);
        expect(nameOf(rowNamed(alias))).toMatch(
          /Deadline passed, awaiting an update, cleared on this computer/
        );
        expect(nameOf(rowNamed(alias))).not.toMatch(
          /waiting for an answer|you can answer it here/i
        );
      }
      // A reply the agent asked for after the answer, said once.
      expect(drawnText(rowNamed("q-7"))).toContain("Answered; the agent asked for a reply");
      expect(nameOf(rowNamed("q-7")).match(/Answered; the agent asked for a reply/g)).toHaveLength(
        1
      );
      for (const alias of ["q-2", "q-5", "q-6", "q-7", "q-8"]) {
        expect(drawnText(rowNamed(alias))).not.toMatch(/cleared on this computer/i);
        expect(nameOf(rowNamed(alias)).match(/cleared on this computer/gi)).toHaveLength(1);
      }
    });

    it("keeps the dialog's first focus on the question list, not on clearing it", async () => {
      listQuestions.mockResolvedValue(marked());
      open();
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
    });
  });

  describe("with nothing waiting on the person (#18022)", () => {
    const SET_ASIDE = {
      ...item("question-5", 5, OPEN, {
        reference: reference("question-5", { terminalId: "t5" }),
        askedAt: "2026-11-01T09:00:00.000Z",
      }),
      inbox: { ask: null, seen: true, cleared: true },
    };
    /** A cleared question and one that closed: nothing there needs the person. */
    const PASSIVE: DecisionQuestionList = {
      revision: 1,
      questions: [LIST.questions[0]!, SET_ASIDE],
    };

    beforeEach(() => {
      CONTENT["question-5"] = content("question-5", 5, {
        status: "open",
        reference: SET_ASIDE.reference,
      });
    });

    afterEach(() => {
      delete CONTENT["question-5"];
    });

    it("says so above the list and opens on nothing, with the keyboard on the list", async () => {
      listQuestions.mockResolvedValue(PASSIVE);
      open();
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(rows().map(aliasOf)).toEqual(["q-5", "q-1"]);
      const line = await screen.findByTestId("decisions-inbox-waiting");
      expect(line.textContent).toBe("No questions waiting on you");
      // At the top of the list, before any group.
      expect(screen.getByTestId("decisions-inbox-groups").querySelector("p, section")).toBe(line);
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-5")));
      // Nothing chosen, nothing read: the pane says how to open one.
      for (const row of rows()) expect(row.getAttribute("aria-current")).toBeNull();
      expect(getQuestionContentByReference).not.toHaveBeenCalled();
      expect(screen.queryByTestId("decisions-inbox-detail-title")).toBeNull();
      expect(screen.getByTestId("decisions-inbox-detail-empty").textContent).toMatch(
        /Choose a question/
      );
      expect(screen.getByTestId("decisions-inbox-detail").getAttribute("aria-label")).toBe(
        "Question details"
      );
      // Nothing to clear, so no button and no divider for it.
      expect(screen.queryByTestId("decisions-inbox-clear-all")).toBeNull();

      // Picked, it opens, by its own reference.
      fireEvent.click(rowNamed("q-5"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 5"));
      expect(getQuestionContentByReference).toHaveBeenCalledWith({
        reference: SET_ASIDE.reference,
      });
      expect(rowNamed("q-5").getAttribute("aria-current")).toBe("true");
      expect(screen.queryByTestId("decisions-inbox-detail-empty")).toBeNull();
    });

    it("lets what still needs something lead under the line, and opens on it", async () => {
      listQuestions.mockResolvedValue({
        revision: 1,
        questions: [...PASSIVE.questions, LIST.questions[2]!],
      });
      open();
      await waitFor(() => expect(rows()).toHaveLength(3));
      const groups = Array.from(
        screen.getByTestId("decisions-inbox-groups").querySelectorAll("section")
      ).map((section) => section.getAttribute("data-testid"));
      expect(groups[0]).toBe("decisions-inbox-group-delivering");
      expect(screen.getByTestId("decisions-inbox-waiting").textContent).toBe(
        "No questions waiting on you"
      );
      await waitFor(() => expect(shownBody()).toContain("Body of question 3"));
      expect(rowNamed("q-3").getAttribute("aria-current")).toBe("true");
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-3")));
    });

    it("still opens on the question of the pane that opened it, whatever its group", async () => {
      listQuestions.mockResolvedValue(PASSIVE);
      // Pane t1's question closed and sits under History, behind a cleared one from another pane.
      open({ terminalId: "t1" });
      await waitFor(() => expect(rowNamed("q-1").getAttribute("aria-current")).toBe("true"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 1"));
      expect(rowNamed("q-5").getAttribute("aria-current")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-1")));
    });

    it("opens a question that comes to need the person while nothing is chosen, leaving the keyboard where it is", async () => {
      listQuestions.mockResolvedValue(PASSIVE);
      open();
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-5")));
      expect(screen.getByTestId("decisions-inbox-detail-empty")).toBeTruthy();
      for (const row of rows()) expect(row.getAttribute("aria-current")).toBeNull();
      expect(getQuestionContentByReference).not.toHaveBeenCalled();
      useAnnouncerStore.setState({ polite: null });
      push({ revision: 2, questions: [...PASSIVE.questions, LIST.questions[1]!] });
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true");
      expect(document.activeElement).toBe(rowNamed("q-5"));
      expect(screen.queryByTestId("decisions-inbox-waiting")).toBeNull();
      // Shown with the keyboard elsewhere: a screen reader hears which (#18038).
      await waitFor(() =>
        expect(useAnnouncerStore.getState().polite?.msg).toBe("Showing q-2: Line of question-2")
      );
    });

    it("keeps a question the person picked as one comes to need them", async () => {
      listQuestions.mockResolvedValue(PASSIVE);
      open();
      await waitFor(() => expect(rows()).toHaveLength(2));
      fireEvent.click(rowNamed("q-1"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 1"));
      push({ revision: 2, questions: [...PASSIVE.questions, LIST.questions[1]!] });
      await waitFor(() => expect(rows()).toHaveLength(3));
      expect(rowNamed("q-1").getAttribute("aria-current")).toBe("true");
      expect(shownBody()).toContain("Body of question 1");
    });

    it("never moves onto a History neighbour once the question it opened on by itself goes", async () => {
      listQuestions.mockResolvedValue({
        revision: 1,
        questions: [LIST.questions[1]!, ...PASSIVE.questions],
      });
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      push({ revision: 2, questions: PASSIVE.questions });
      await waitFor(() => expect(rows()).toHaveLength(2));
      await waitFor(() => expect(screen.queryByTestId("decisions-inbox-detail-title")).toBeNull());
      for (const row of rows()) expect(row.getAttribute("aria-current")).toBeNull();
      expect(screen.getByTestId("decisions-inbox-detail-empty")).toBeTruthy();

      // Back, closed: the person never picked it, so it stays a row in History.
      const reads = readsOf("question-2");
      const closed = {
        ...LIST.questions[1]!,
        standing: { kind: "settled", outcome: "withdrawn" } as const,
        settledAt: "2026-11-02T12:00:00Z",
      };
      push({ revision: 3, questions: [...PASSIVE.questions, closed] });
      await waitFor(() => expect(rows()).toHaveLength(3));
      await act(async () => {});
      expect(rowNamed("q-2").getAttribute("aria-current")).toBeNull();
      expect(screen.getByTestId("decisions-inbox-detail-empty")).toBeTruthy();
      expect(readsOf("question-2")).toBe(reads);
    });

    it("moves the keyboard from Clear Needs you to the list once a deadline empties the group", async () => {
      const expiresAt = new Date(Date.now() + 1500).toISOString();
      const timed = item("question-2", 2, OPEN, { askedAt: "2026-11-02T09:00:00.000Z", expiresAt });
      listQuestions.mockResolvedValue({ revision: 1, questions: [LIST.questions[0]!, timed] });
      open();
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
      const clearAll = screen.getByTestId("decisions-inbox-clear-all");
      act(() => clearAll.focus());
      expect(document.activeElement).toBe(clearAll);
      expect(screen.getByTestId("decisions-inbox-group-needs-you").textContent).toContain("q-2");
      await waitFor(() =>
        expect(screen.getByTestId("decisions-inbox-group-awaiting").textContent).toContain("q-2")
      );
      expect(clearAll.isConnected).toBe(false);
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
    });

    it("moves the keyboard to the list itself when Clear Needs you goes with every row", async () => {
      listQuestions.mockResolvedValue({ revision: 1, questions: [LIST.questions[1]!] });
      open();
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
      const clearAll = screen.getByTestId("decisions-inbox-clear-all");
      act(() => clearAll.focus());
      push({ revision: 2, questions: [] });
      await waitFor(() => expect(rows()).toHaveLength(0));
      expect(clearAll.isConnected).toBe(false);
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("decisions-inbox-groups"))
      );
    });

    it("takes the first arrow from an empty list to its first row once rows arrive", async () => {
      listQuestions.mockResolvedValue({ revision: 1, questions: [] });
      getStatus.mockResolvedValue({ state: "not-connected", revision: 1 });
      open();
      const list = await screen.findByTestId("decisions-inbox-groups");
      await waitFor(() => expect(document.activeElement).toBe(list));
      push({ ...PASSIVE, revision: 2 });
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(document.activeElement).toBe(list);
      fireEvent.keyDown(list, { key: "ArrowDown" });
      expect(document.activeElement).toBe(rowNamed("q-5"));
      // And shows it once the keyboard has rested there, as any arrow does (#18038).
      await waitFor(() => expect(shownBody()).toContain("Body of question 5"));
      expect(rowNamed("q-5").getAttribute("aria-current")).toBe("true");
    });

    it("leaves the keyboard where it went when Clear Needs you goes later", async () => {
      listQuestions.mockResolvedValue(LIST);
      open();
      const clearAll = await screen.findByTestId("decisions-inbox-clear-all");
      act(() => clearAll.focus());
      act(() => screen.getByTestId("decisions-inbox-detail").focus());
      push({ revision: 2, questions: [LIST.questions[0]!, LIST.questions[2]!] });
      await waitFor(() => expect(screen.queryByTestId("decisions-inbox-clear-all")).toBeNull());
      await act(async () => {});
      expect(document.activeElement).toBe(screen.getByTestId("decisions-inbox-detail"));
    });

    it("says only what the list holds while not connected, and starts the keyboard on an empty list", async () => {
      listQuestions.mockResolvedValue({ revision: 1, questions: [] });
      getStatus.mockResolvedValue({
        state: "reconnecting",
        relayOrigin: "https://relay.example",
        revision: 1,
      });
      open();
      await screen.findByTestId("decisions-inbox-connection");
      await waitFor(() =>
        expect(screen.getByTestId("decisions-inbox-waiting").textContent).toBe(
          "No questions on this computer"
        )
      );
      const list = screen.getByTestId("decisions-inbox-groups");
      await waitFor(() => expect(document.activeElement).toBe(list));
      expect(screen.getByTestId("decisions-inbox-detail-empty").textContent).toMatch(
        /Question details appear here/
      );

      // Connected with nothing asked: the canvas, in the same list, which keeps the keyboard.
      pushStatus({ state: "connected", relayOrigin: "https://relay.example", revision: 2 });
      await screen.findByTestId("decisions-inbox-empty");
      expect(screen.getByTestId("decisions-inbox-groups")).toBe(list);
      expect(document.activeElement).toBe(list);
      expect(screen.queryByTestId("decisions-inbox-detail")).toBeNull();
    });

    it("starts the keyboard on the list when nothing was ever asked", async () => {
      listQuestions.mockResolvedValue({ revision: 1, questions: [] });
      open();
      await screen.findByTestId("decisions-inbox-empty");
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("decisions-inbox-groups"))
      );
    });

    it("names a Remote Host that's away rather than calling the list clear", async () => {
      const away = item(
        "question-9",
        9,
        { kind: "settled", outcome: "answered", handled: false },
        {
          reference: reference("question-9", { hostId: "qhost_studio_0001" }),
          remoteHost: { hostId: "studio", name: "Studio", connected: false },
          settledAt: "2026-11-02T11:00:00Z",
        }
      );
      listQuestions.mockResolvedValue({ revision: 1, questions: [...PASSIVE.questions, away] });
      open();
      await waitFor(() =>
        expect(screen.getByTestId("decisions-inbox-waiting").textContent).toMatch(
          /^None of the questions here wait on you\. Studio is away/
        )
      );
    });

    it("names a Remote Host the list says is away even with nothing of it listed, rather than calling the inbox new", async () => {
      listQuestions.mockResolvedValue({ revision: 1, questions: [], hostsAway: ["Studio"] });
      open();
      await waitFor(() =>
        expect(screen.getByTestId("decisions-inbox-waiting").textContent).toBe(
          "No questions on this computer. Studio is away, so its questions are as last reported."
        )
      );
      expect(screen.queryByTestId("decisions-inbox-empty")).toBeNull();
      // Back: nothing was ever asked.
      push({ revision: 2, questions: [] });
      await screen.findByTestId("decisions-inbox-empty");
      expect(screen.queryByTestId("decisions-inbox-waiting")).toBeNull();
    });
  });

  describe("narrowed to the window's project (#18051)", () => {
    const waitingFor = (ask: string) => ({ ask, seen: false, cleared: false });
    /** Beta's question, asked before this project's, so it heads Needs you. */
    const BETA_WAITING = item("question-6", 6, OPEN, {
      reference: reference("question-6", { projectId: "project-b", terminalId: "t6" }),
      projectLabel: "Beta",
      askedAt: "2026-11-02T08:30:00.000Z",
      inbox: waitingFor("note-b"),
    });
    const ALPHA_WAITING = { ...LIST.questions[1]!, inbox: waitingFor("note-a") };
    /** Alpha's project id again, on a Remote Host: another computer's project from a local window. */
    const STUDIO_WAITING = item("question-7", 7, OPEN, {
      reference: reference("question-7", {
        hostId: "qhost_studio_0001",
        projectId: "project-a",
        terminalId: "t7",
      }),
      remoteHost: { hostId: "studio", name: "Studio", connected: true },
      projectLabel: "Alpha on Studio",
      inbox: waitingFor("note-s"),
    });
    /** Needs you: Beta, Alpha, Studio; then Beta's delivery and Alpha's History. */
    const MIXED: DecisionQuestionList = {
      revision: 1,
      questions: [
        BETA_WAITING,
        LIST.questions[0]!,
        ALPHA_WAITING,
        LIST.questions[2]!,
        STUDIO_WAITING,
      ],
    };
    /** Alpha's question set aside on this computer, and one whose deadline passed: neither in Needs you. */
    const ALPHA_CLEARED = item("question-8", 8, OPEN, {
      reference: reference("question-8", { terminalId: "t8" }),
      inbox: { ask: "note-c", seen: true, cleared: true },
    });
    const ALPHA_ELAPSED = item("question-9", 9, OPEN, {
      reference: reference("question-9", { terminalId: "t9a" }),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      inbox: waitingFor("note-e"),
    });
    const scopeGroup = () => screen.getByRole("radiogroup", { name: "Questions shown" });
    const scopeSegment = (scope: "all" | "project") =>
      within(scopeGroup()).getByRole("radio", {
        name: scope === "all" ? "All projects" : "This project",
      });
    const clearCalls = () =>
      markQuestions.mock.calls.filter(([payload]) => payload.action === "clear");

    beforeEach(() => {
      CONTENT["question-6"] = content("question-6", 6, {
        status: "open",
        reference: BETA_WAITING.reference,
      });
      CONTENT["question-7"] = content("question-7", 7, {
        status: "open",
        reference: STUDIO_WAITING.reference,
      });
      listQuestions.mockResolvedValue(MIXED);
    });

    afterEach(() => {
      delete CONTENT["question-6"];
      delete CONTENT["question-7"];
    });

    it("opens on every project, as the toolbar counts, on this project's question that needs the person", async () => {
      open();
      await waitFor(() => expect(rows()).toHaveLength(5));
      expect(rows().map(aliasOf)).toEqual(["q-6", "q-2", "q-7", "q-3", "q-1"]);
      expect(scopeSegment("all").getAttribute("aria-checked")).toBe("true");
      expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true");
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      expect(screen.getByTestId("decisions-inbox-clear-all").textContent).toBe(
        "Clear Needs you in all projects"
      );
    });

    it("narrows to this project and back, choosing afresh when the question shown isn't this project's", async () => {
      open();
      await waitFor(() => expect(rows()).toHaveLength(5));
      // Beta's delivery, picked from the fourth row: nothing in this project's list takes its place.
      fireEvent.click(rowNamed("q-3"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 3"));
      act(() => scopeSegment("all").focus());
      fireEvent.keyDown(scopeSegment("all"), { key: "ArrowRight" });
      await waitFor(() => expect(rows().map(aliasOf)).toEqual(["q-2", "q-1"]));
      expect(scopeSegment("project").getAttribute("aria-checked")).toBe("true");
      expect(document.activeElement).toBe(scopeSegment("project"));
      expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true");
      expect(rows().filter((row) => row.tabIndex === 0)).toEqual([rowNamed("q-2")]);
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      expect(screen.getByTestId("decisions-inbox-clear-all").textContent).toBe(
        "Clear Needs you in this project"
      );

      // The inbox chose it, not the person: once it goes, History's row doesn't take its place.
      push({
        ...MIXED,
        revision: 2,
        questions: MIXED.questions.filter((q) => q !== ALPHA_WAITING),
      });
      await waitFor(() => expect(rows().map(aliasOf)).toEqual(["q-1"]));
      expect(rowNamed("q-1").getAttribute("aria-current")).toBeNull();
      expect(screen.getByTestId("decisions-inbox-detail-empty")).toBeTruthy();

      // This project's questions go: the list says so, and the switch stays under the keyboard.
      push({
        revision: 3,
        questions: [BETA_WAITING, LIST.questions[2]!, STUDIO_WAITING],
      });
      await waitFor(() => expect(rows()).toHaveLength(0));
      expect(screen.getByTestId("decisions-inbox-waiting").textContent).toBe(
        "No questions in this project"
      );
      expect(screen.queryByTestId("decisions-inbox-empty")).toBeNull();
      expect(screen.queryByTestId("decisions-inbox-clear-all")).toBeNull();
      expect(scopeSegment("project").getAttribute("aria-checked")).toBe("true");
      expect(document.activeElement).toBe(scopeSegment("project"));

      // Back, and still narrowed.
      push({ ...MIXED, revision: 4 });
      await waitFor(() => expect(rows().map(aliasOf)).toEqual(["q-2", "q-1"]));
      expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true");

      // One the person picks stays theirs across the switch.
      fireEvent.click(rowNamed("q-1"));
      await waitFor(() => expect(rowNamed("q-1").getAttribute("aria-current")).toBe("true"));
      fireEvent.click(scopeSegment("all"));
      await waitFor(() => expect(rows()).toHaveLength(5));
      expect(rowNamed("q-1").getAttribute("aria-current")).toBe("true");

      // A later opening starts on every project again.
      fireEvent.click(scopeSegment("project"));
      await waitFor(() => expect(rows()).toHaveLength(2));
      act(() => useDecisionsInboxStore.getState().close());
      open();
      await waitFor(() => expect(rows()).toHaveLength(5));
      expect(scopeSegment("all").getAttribute("aria-checked")).toBe("true");
    });

    it("keeps the switch for the opening once offered, and offers it afresh each opening", async () => {
      const alphaOnly = { revision: 2, questions: [LIST.questions[0]!, ALPHA_WAITING] };
      open();
      await waitFor(() => expect(rows()).toHaveLength(5));
      expect(scopeSegment("all").getAttribute("aria-checked")).toBe("true");
      // Only this project's questions left, never narrowed: the switch stays, on All projects.
      push(alphaOnly);
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(scopeSegment("all").getAttribute("aria-checked")).toBe("true");
      expect(screen.getByTestId("decisions-inbox-clear-all").textContent).toBe(
        "Clear Needs you in all projects"
      );

      act(() => useDecisionsInboxStore.getState().close());
      listQuestions.mockResolvedValue(alphaOnly);
      open();
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(screen.queryByRole("radiogroup", { name: "Questions shown" })).toBeNull();
      expect(screen.getByTestId("decisions-inbox-clear-all").textContent).toBe("Clear Needs you");
    });

    it("clears what the list shows, each question at the ask shown", async () => {
      listQuestions.mockResolvedValue({
        ...MIXED,
        questions: [...MIXED.questions, ALPHA_CLEARED, ALPHA_ELAPSED],
      });
      open();
      await waitFor(() => expect(rows()).toHaveLength(7));
      expect(screen.getByTestId("decisions-inbox-group-cleared").textContent).toContain("q-8");
      expect(screen.getByTestId("decisions-inbox-group-awaiting").textContent).toContain("q-9");
      fireEvent.click(screen.getByTestId("decisions-inbox-clear-all"));
      await waitFor(() => expect(clearCalls()).toHaveLength(1));
      expect(clearCalls()[0]![0].questions).toEqual([
        { reference: BETA_WAITING.reference, ask: "note-b" },
        { reference: ALPHA_WAITING.reference, ask: "note-a" },
        { reference: STUDIO_WAITING.reference, ask: "note-s" },
      ]);

      fireEvent.click(scopeSegment("project"));
      await waitFor(() => expect(rows()).toHaveLength(4));
      const clearHere = screen.getByTestId("decisions-inbox-clear-all");
      expect(clearHere.textContent).toBe("Clear Needs you in this project");
      act(() => clearHere.focus());
      fireEvent.click(clearHere);
      await waitFor(() => expect(clearCalls()).toHaveLength(2));
      expect(clearCalls()[1]![0].questions).toEqual([
        { reference: ALPHA_WAITING.reference, ask: "note-a" },
      ]);
      expect(document.activeElement).toBe(clearHere);

      // Alpha's is cleared while Beta's and Studio's still wait: the button goes with this
      // project's Needs you, the switch stays, and the keyboard on the button moves to the list.
      push({
        revision: 2,
        questions: [
          ...MIXED.questions.map((question) =>
            question === ALPHA_WAITING
              ? { ...question, inbox: { ...waitingFor("note-a"), cleared: true } }
              : question
          ),
          ALPHA_CLEARED,
          ALPHA_ELAPSED,
        ],
      });
      await waitFor(() => expect(screen.queryByTestId("decisions-inbox-clear-all")).toBeNull());
      expect(scopeSegment("project").getAttribute("aria-checked")).toBe("true");
      await waitFor(() => expect(document.activeElement).toBe(rowNamed("q-2")));
    });

    it("keeps the plain list while this project alone has questions, and names the reach when it has none", async () => {
      listQuestions.mockResolvedValue({
        revision: 1,
        questions: [LIST.questions[0]!, ALPHA_WAITING],
      });
      open();
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(screen.queryByRole("radiogroup", { name: "Questions shown" })).toBeNull();
      const clearAll = screen.getByTestId("decisions-inbox-clear-all");
      expect(clearAll.textContent).toBe("Clear Needs you");
      const footer = clearAll.parentElement!;

      // Nothing waits and nothing to narrow to: no strip is left beneath the list.
      push({ revision: 2, questions: [LIST.questions[0]!] });
      await waitFor(() => expect(screen.queryByTestId("decisions-inbox-clear-all")).toBeNull());
      expect(footer.isConnected).toBe(false);

      // Only Beta's: nothing to narrow to, and Clear says it reaches past this project.
      push({ revision: 3, questions: [BETA_WAITING] });
      await waitFor(() => expect(rows().map(aliasOf)).toEqual(["q-6"]));
      expect(screen.queryByRole("radiogroup", { name: "Questions shown" })).toBeNull();
      expect(screen.getByTestId("decisions-inbox-clear-all").textContent).toBe(
        "Clear Needs you in all projects"
      );
    });

    it("takes a Remote Host window's project to be that Host's", async () => {
      remote = true;
      open();
      await waitFor(() => expect(rows()).toHaveLength(5));
      expect(rowNamed("q-7").getAttribute("aria-current")).toBe("true");
      fireEvent.click(scopeSegment("project"));
      await waitFor(() => expect(rows().map(aliasOf)).toEqual(["q-7"]));
    });
  });

  it("closes as soon as Decisions turns off", async () => {
    open();
    await screen.findByTestId("decision-question-content");
    act(() => {
      decisionsOn = false;
      for (const listener of [...onListeners]) listener();
    });
    expect(useDecisionsInboxStore.getState().isOpen).toBe(false);
  });

  describe("a question waiting on a reply (#18040)", () => {
    const REPLY: DecisionQuestionStanding = { kind: "waiting", reason: "reply" };

    function agentSaid(messageId: string, text: string, expectsReply: boolean) {
      return {
        type: "message" as const,
        messageId,
        from: "agent" as const,
        text,
        images: [],
        expectsReply,
        sentAt: "2026-11-02T10:05:00.000Z",
        deliveryStatus: null,
        unreadable: false,
      };
    }

    /** `LIST` with question-5 answered and back in Needs you, its agent asking `ask` for a reply. */
    function withReply(
      ask: string | null,
      revision = 1,
      over: Partial<DecisionQuestionListItem> = {}
    ): DecisionQuestionList {
      return {
        revision,
        questions: [
          ...LIST.questions,
          item("question-5", 5, ask === null ? { kind: "to-type" } : REPLY, {
            replyRequest: ask,
            ...over,
          }),
        ],
      };
    }

    function answeredWith(...thread: ReturnType<typeof agentSaid>[]) {
      return content("question-5", 5, { status: "human-answered", thread });
    }

    function line(alias: string) {
      return within(rowNamed(alias)).getByTestId("decisions-inbox-row-line").textContent;
    }

    function summariesOf(questionId: string) {
      return getQuestionSummariesByReference.mock.calls.filter(([payload]) =>
        payload.references.some((ref) => ref.questionId === questionId)
      ).length;
    }

    /** What the question pane scrolled to, as it was scrolled: the list scrolls its own rows. */
    let scrolled: Element[];
    let scrollSpy: { mockRestore: () => void };

    beforeEach(() => {
      scrolled = [];
      scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
        this: Element
      ) {
        const detail = document.querySelector('[data-testid="decisions-inbox-detail"]');
        if (detail?.contains(this)) scrolled.push(this);
      });
      CONTENT["question-5"] = answeredWith(agentSaid("ask-1", "Which region?", true));
    });

    afterEach(() => {
      scrollSpy.mockRestore();
      delete CONTENT["question-5"];
    });

    it("names its row by its request's opening line, read again for each new one, whatever an older read brings late", async () => {
      listQuestions.mockResolvedValue(withReply("ask-1"));
      open();
      await waitFor(() => expect(line("q-5")).toBe("Which region?"));
      // The question's own line still comes from main; only the reply's is read from the thread.
      expect(summariesOf("question-5")).toBe(1);

      const held: Array<(question: DecisionQuestionContent) => void> = [];
      getQuestionContentByReference.mockImplementation(async ({ reference: ref }) => {
        if (ref.questionId !== "question-5") {
          return { result: "read", question: CONTENT[ref.questionId]! };
        }
        const question = await new Promise<DecisionQuestionContent>((land) => held.push(land));
        return { result: "read", question };
      });
      push(withReply("ask-2", 2));
      await waitFor(() => expect(held).toHaveLength(1));
      // Until the new request is read, the question's own line.
      expect(line("q-5")).toBe("Line of question-5");
      push(withReply("ask-3", 3));
      await waitFor(() => expect(held).toHaveLength(2));

      // The newest request's read lands first, its first line with words once controls are gone.
      await act(async () =>
        held[1]!(
          answeredWith(
            agentSaid("ask-2", "Which datacenter?", true),
            agentSaid("ask-3", "\u001b[0m\n  Which \u001b[1mzone\u001b[0m?\nOr both.", true)
          )
        )
      );
      await waitFor(() => expect(line("q-5")).toBe("Which zone?"));
      // The one it replaced lands late, and names only its own request.
      await act(async () => held[0]!(answeredWith(agentSaid("ask-2", "Which datacenter?", true))));
      await act(async () => {});
      expect(line("q-5")).toBe("Which zone?");

      // Replied to: the question's own line again, and back to the same request reads nothing.
      push(withReply(null, 4));
      await waitFor(() => expect(line("q-5")).toBe("Line of question-5"));
      push(withReply("ask-3", 5, { inbox: { ask: "ask-3", seen: true, cleared: false } }));
      await waitFor(() => expect(line("q-5")).toBe("Which zone?"));
      await act(async () => {});
      expect(held).toHaveLength(2);
      expect(summariesOf("question-5")).toBe(1);
    });

    it("keeps the question's line for a row whose delivery stopped, whatever it asks, and reads no thread for it", async () => {
      listQuestions.mockResolvedValue(
        withReply("ask-1", 1, {
          standing: { kind: "needs-attention", deliveryStatus: "needs-attention" },
          stall: { answerRevision: 1, followUpIds: [], reason: "pane_gone" },
        })
      );
      open();
      await waitFor(() => expect(line("q-5")).toBe("Line of question-5"));
      await act(async () => {});
      expect(readsOf("question-5")).toBe(0);
    });

    it("opens at the request once per choice, and a read again keeps the person's place", async () => {
      listQuestions.mockResolvedValue(withReply("ask-1"));
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      // An open question opens at its top.
      expect(scrolled).toHaveLength(0);

      act(() => rowNamed("q-5").focus());
      fireEvent.click(rowNamed("q-5"));
      await waitFor(() => expect(scrolled).toHaveLength(1));
      expect(scrolled[0]!.getAttribute("data-message-id")).toBe("ask-1");
      // Choosing it never takes the keyboard from the list.
      expect(document.activeElement).toBe(rowNamed("q-5"));

      // The list moves and the question is read again, still asking the same.
      CONTENT["question-5"] = answeredWith(
        agentSaid("note-0", "An earlier note.", false),
        agentSaid("ask-1", "Which region?", true)
      );
      push(withReply("ask-1", 2));
      await waitFor(() => expect(shownBody()).toContain("An earlier note."));
      expect(scrolled).toHaveLength(1);

      // Chosen again, it opens at the request again.
      fireEvent.click(rowNamed("q-2"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      fireEvent.click(rowNamed("q-5"));
      await waitFor(() => expect(scrolled).toHaveLength(2));
      expect(scrolled[1]!.getAttribute("data-message-id")).toBe("ask-1");
    });

    it("shows the thread when the read for this choice doesn't hold the request yet", async () => {
      CONTENT["question-5"] = answeredWith(agentSaid("note-0", "Working on it.", false));
      listQuestions.mockResolvedValue(withReply("ask-1"));
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));

      fireEvent.click(rowNamed("q-5"));
      await waitFor(() => expect(scrolled).toHaveLength(1));
      expect(scrolled[0]!.getAttribute("data-testid")).toBe("decision-question-thread");

      // Read again, still without it: the person's place is left alone.
      CONTENT["question-5"] = answeredWith(
        agentSaid("note-0", "Working on it.", false),
        agentSaid("note-1", "Nearly there.", false)
      );
      push(withReply("ask-1", 2));
      await waitFor(() => expect(shownBody()).toContain("Nearly there."));
      expect(scrolled).toHaveLength(1);
    });

    it("leaves a request the read shows replied to at its top, whatever the list still says", async () => {
      const asked = answeredWith(agentSaid("ask-1", "Which region?", true));
      const reply = { ...agentSaid("reply-1", "EU.", false), from: "person" as const };
      CONTENT["question-5"] = { ...asked, thread: [...asked.thread, reply] };
      listQuestions.mockResolvedValue(withReply("ask-1"));
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));

      fireEvent.click(rowNamed("q-5"));
      await waitFor(() => expect(shownBody()).toContain("EU."));
      await act(async () => {});
      expect(scrolled).toHaveLength(0);
    });

    it("asks each failing row again once per list, so rows that keep failing never keep each other going", async () => {
      const held: Array<{ id: string; land: (read: DecisionQuestionContentResult) => void }> = [];
      getQuestionContentByReference.mockImplementation(async ({ reference: ref }) => {
        if (ref.questionId !== "question-5" && ref.questionId !== "question-6") {
          return { result: "read", question: CONTENT[ref.questionId]! };
        }
        return new Promise<DecisionQuestionContentResult>((land) =>
          held.push({ id: ref.questionId, land })
        );
      });
      const twoAsking = (revision: number): DecisionQuestionList => {
        const list = withReply("ask-1", revision);
        return {
          revision,
          questions: [...list.questions, item("question-6", 6, REPLY, { replyRequest: "ask-6" })],
        };
      };
      listQuestions.mockResolvedValue(twoAsking(1));
      open();
      await waitFor(() => expect(held).toHaveLength(2));
      push(twoAsking(2));
      await act(async () => {});

      // A Host away: each read fails, one after the other, and so does each retry.
      for (let round = 0; round < 3; round += 1) {
        for (const { land } of held.splice(0)) {
          await act(async () => land({ result: "host-not-connected" }));
        }
        await act(async () => {});
      }
      // One retry each for the list that came while they were out, then nothing more.
      expect(held).toHaveLength(0);
      expect(readsOf("question-5")).toBe(2);
      expect(readsOf("question-6")).toBe(2);
    });

    it("asks for a row's line again at once when its read fails after the list moved under it", async () => {
      const held: Array<(read: DecisionQuestionContentResult) => void> = [];
      getQuestionContentByReference.mockImplementation(async ({ reference: ref }) => {
        if (ref.questionId !== "question-5") {
          return { result: "read", question: CONTENT[ref.questionId]! };
        }
        return new Promise<DecisionQuestionContentResult>((land) => held.push(land));
      });
      listQuestions.mockResolvedValue(withReply("ask-1"));
      open();
      await waitFor(() => expect(held).toHaveLength(1));
      // The list moves while the read is out, still asking the same.
      push(withReply("ask-1", 2));
      await act(async () => {});
      expect(held).toHaveLength(1);

      await act(async () => held[0]!({ result: "not-running" }));
      await waitFor(() => expect(held).toHaveLength(2));
      await act(async () =>
        held[1]!({
          result: "read",
          question: answeredWith(agentSaid("ask-1", "Which region?", true)),
        })
      );
      await waitFor(() => expect(line("q-5")).toBe("Which region?"));
    });

    it("opens at the request a read made before the list named a newer one still shows, then at the newer one once read", async () => {
      listQuestions.mockResolvedValue(withReply("ask-1"));
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      const held: Array<(question: DecisionQuestionContent) => void> = [];
      getQuestionContentByReference.mockImplementation(async ({ reference: ref }) => {
        if (ref.questionId !== "question-5") {
          return { result: "read", question: CONTENT[ref.questionId]! };
        }
        const question = await new Promise<DecisionQuestionContent>((land) => held.push(land));
        return { result: "read", question };
      });

      fireEvent.click(rowNamed("q-5"));
      await waitFor(() => expect(held.length).toBeGreaterThan(0));
      // A newer request comes while the first read is out.
      push(withReply("ask-2", 2));
      const earlier = agentSaid("note-0", "An earlier note.", false);
      await act(async () => {
        for (const land of held.splice(0)) {
          land(answeredWith(earlier, agentSaid("ask-1", "Which region?", true)));
        }
      });
      await waitFor(() => expect(scrolled).toHaveLength(1));
      expect(scrolled[0]!.getAttribute("data-message-id")).toBe("ask-1");

      // The read that holds the newer request opens at it, once.
      const both = answeredWith(
        earlier,
        agentSaid("ask-1", "Which region?", true),
        agentSaid("ask-2", "Which zone?", true)
      );
      await waitFor(() => expect(held.length).toBeGreaterThan(0));
      await act(async () => {
        for (const land of held.splice(0)) land(both);
      });
      await waitFor(() => expect(scrolled).toHaveLength(2));
      expect(scrolled[1]!.getAttribute("data-message-id")).toBe("ask-2");
      push(withReply("ask-2", 3));
      await waitFor(() => expect(held.length).toBeGreaterThan(0));
      await act(async () => {
        for (const land of held.splice(0)) land(both);
      });
      await act(async () => {});
      expect(scrolled).toHaveLength(2);
    });

    it("opens one whose delivery stopped at its top, where that's said, whatever it asks", async () => {
      listQuestions.mockResolvedValue(
        withReply("ask-1", 1, {
          standing: { kind: "needs-attention", deliveryStatus: "needs-attention" },
          stall: { answerRevision: 1, followUpIds: [], reason: "pane_gone" },
        })
      );
      open();
      await waitFor(() => expect(rows()).toHaveLength(4));
      fireEvent.click(rowNamed("q-5"));
      await waitFor(() => expect(shownBody()).toContain("Which region?"));
      await act(async () => {});
      expect(scrolled).toHaveLength(0);
    });

    it("folds an open question's follow-up again for the next question, whichever was opened", async () => {
      listQuestions.mockResolvedValue({
        revision: 1,
        questions: [...LIST.questions, item("question-4", 4, OPEN)],
      });
      open();
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
      fireEvent.click(screen.getByTestId("decision-follow-up-open"));
      expect(screen.getByTestId("decision-follow-up-text")).toBeTruthy();

      fireEvent.click(rowNamed("q-4"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 4"));
      expect(screen.queryByTestId("decision-follow-up-text")).toBeNull();
      expect(screen.getByTestId("decision-follow-up-open")).toBeTruthy();
    });
  });
});

describe("DecisionsInboxDialog: the run that asked (#18029)", () => {
  const CLOSED_NO_SESSION = {
    target: "closed",
    directory: "present",
    resume: "no-session",
  } as const;
  const CLOSED_RESUMABLE = { target: "closed", directory: "present", resume: "resumable" } as const;
  const RUNNING = { target: "running", directory: "present", resume: "resumable" } as const;
  const UNDETECTED = {
    target: "agent-undetected",
    directory: "present",
    resume: "resumable",
  } as const;

  function asking(
    questionId: string,
    alias: number,
    asker: DecisionQuestionListItem["asker"],
    over: Partial<DecisionQuestionListItem> = {}
  ): DecisionQuestionListItem {
    return {
      ...item(questionId, alias, OPEN, {
        askedAt: `2026-11-02T09:0${alias}:00.000Z`,
        inbox: { ask: null, seen: false, cleared: false },
        ...over,
      }),
      ...(asker !== undefined ? { asker } : {}),
    };
  }

  it("says on the row and in its pane that the terminal that asked closed and can't be resumed, and warns before an answer is written", async () => {
    // A pane under the same id is open here, but it isn't the run that asked.
    panels = { t1: { location: "grid" } };
    listQuestions.mockResolvedValue({
      revision: 2,
      questions: [asking("question-2", 2, CLOSED_NO_SESSION)],
    });
    open();
    await waitFor(() =>
      expect(drawnText(rowNamed("q-2"))).toContain("Terminal ended · Can't resume")
    );
    expect(nameOf(rowNamed("q-2"))).toContain("terminal ended · can't resume");

    await waitFor(() =>
      expect(screen.getByTestId("decisions-inbox-asker").textContent).toBe(
        "The terminal that asked is no longer running. No session id was recorded when it asked, so its session can't be resumed."
      )
    );
    const warning = await screen.findByTestId("decision-answer-delivery");
    expect(warning.textContent).toContain("Nothing observed can take this answer now.");
    // Before the choices, so it is read before anything is chosen.
    const firstChoice = screen.getAllByTestId("decision-answer-option")[0]!;
    expect(
      warning.compareDocumentPosition(firstChoice) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
    // Observed, never acted on: nothing is dismissed or withdrawn.
    expect(declineQuestion).not.toHaveBeenCalled();
    expect(cancelQuestionByReference).not.toHaveBeenCalled();
  });

  it("names a session that can be resumed, without a warning in the answer", async () => {
    listQuestions.mockResolvedValue({
      revision: 2,
      questions: [asking("question-2", 2, CLOSED_RESUMABLE)],
    });
    open();
    await waitFor(() =>
      expect(drawnText(rowNamed("q-2"))).toContain("Terminal ended · Resume possible")
    );
    await waitFor(() =>
      expect(screen.getByTestId("decisions-inbox-asker").textContent).toContain(
        "Daintree can try to resume its Claude session in a new terminal"
      )
    );
    await screen.findByTestId("decision-answer-composer");
    expect(screen.queryByTestId("decision-answer-delivery")).toBeNull();
  });

  it("says nothing of an asker still running, or of one not yet observed", async () => {
    listQuestions.mockResolvedValue({
      revision: 2,
      questions: [asking("question-2", 2, RUNNING), asking("question-4", 4, undefined)],
    });
    open();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryAllByTestId("decisions-inbox-row-asker")).toHaveLength(0);
    expect(screen.queryByTestId("decisions-inbox-asker")).toBeNull();
    expect(screen.queryByTestId("decisions-inbox-clear-gone")).toBeNull();
  });

  it("says a Host's terminal is unknown while the Host is away, rather than guessing", async () => {
    getQuestionContentByReference.mockResolvedValue({ result: "host-not-connected" });
    listQuestions.mockResolvedValue({
      revision: 2,
      questions: [
        asking("question-9", 9, undefined, {
          reference: reference("question-9", { hostId: "qhost_studio_0001" }),
          remoteHost: { hostId: "studio", name: "Studio", connected: false },
        }),
      ],
    });
    open();
    await waitFor(() => expect(drawnText(rowNamed("q-9"))).toContain("Terminal status unknown"));
    expect(screen.getByTestId("decisions-inbox-asker").textContent).toBe(
      "Studio isn't connected, so whether the terminal that asked is still open is unknown."
    );
    expect(screen.queryByTestId("decisions-inbox-clear-gone")).toBeNull();
  });

  it("clears every ask with no agent from Needs you in one press, leaving the live ones", async () => {
    const live = asking("question-4", 4, RUNNING, {
      inbox: { ask: "note-4", seen: false, cleared: false },
    });
    const undetected = {
      ...asking("question-5", 5, UNDETECTED),
      inbox: { ask: "note-5", seen: true, cleared: false },
    };
    listQuestions.mockResolvedValue({
      revision: 2,
      questions: [asking("question-2", 2, CLOSED_NO_SESSION), live, undetected],
    });
    open();
    const button = await screen.findByTestId("decisions-inbox-clear-gone");
    expect(button.textContent).toBe("Clear 2 questions with no agent detected");
    fireEvent.click(button);
    const clears = () => markQuestions.mock.calls.filter(([payload]) => payload.action === "clear");
    await waitFor(() => expect(clears()).toHaveLength(1));
    // One request, for the asks with no agent detected; the live one stays.
    expect(clears()).toEqual([
      [
        {
          action: "clear",
          questions: [
            { reference: reference("question-2"), ask: null },
            { reference: reference("question-5"), ask: "note-5" },
          ],
        },
      ],
    ]);
    expect(declineQuestion).not.toHaveBeenCalled();
    expect(cancelQuestionByReference).not.toHaveBeenCalled();

    // Once they are set aside the button goes, and the keyboard on it goes to the list.
    act(() => screen.getByTestId("decisions-inbox-clear-gone").focus());
    push({
      revision: 3,
      questions: [
        {
          ...asking("question-2", 2, CLOSED_NO_SESSION),
          inbox: { ask: null, seen: false, cleared: true },
        },
        live,
        { ...undetected, inbox: { ask: "note-5", seen: true, cleared: true } },
      ],
    });
    await waitFor(() => expect(screen.queryByTestId("decisions-inbox-clear-gone")).toBeNull());
    await waitFor(() =>
      expect(screen.getByTestId("decisions-inbox-groups").contains(document.activeElement)).toBe(
        true
      )
    );
  });

  it("never offers Go to terminal for a terminal seen in the Trash or restarted, though a pane holds its id", async () => {
    panels = { t1: { location: "grid" } };
    for (const target of ["trashed", "replaced"] as const) {
      listQuestions.mockResolvedValue({
        revision: 2,
        questions: [asking("question-2", 2, { ...CLOSED_RESUMABLE, target })],
      });
      open();
      await waitFor(() => expect(screen.getByTestId("decisions-inbox-asker")).toBeTruthy());
      expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
      act(() => useDecisionsInboxStore.getState().close());
      await waitFor(() => expect(screen.queryByTestId("decisions-inbox-dialog")).toBeNull());
    }
    // Still offered while its agent is only no longer detected: that terminal is the one that asked.
    listQuestions.mockResolvedValue({
      revision: 3,
      questions: [asking("question-2", 2, UNDETECTED)],
    });
    open();
    expect(await screen.findByTestId("decisions-inbox-go-to-terminal")).toBeTruthy();
  });

  it("drops a look before going elsewhere once its terminal is seen to restart meanwhile", async () => {
    const elsewhere = asking("question-3", 3, undefined, {
      reference: reference("question-3", { projectId: "project-b", terminalId: "t9" }),
    });
    listQuestions.mockResolvedValue({ revision: 2, questions: [elsewhere] });
    getAllTerminals.mockResolvedValue([
      terminal({ id: "t9", projectId: "project-b", hasPty: true }),
    ]);
    open({ terminalId: "t9" });
    const go = await screen.findByTestId("decisions-inbox-go-to-terminal");
    let resolveLook!: (terminals: BackendTerminalInfo[]) => void;
    getAllTerminals.mockImplementationOnce(
      () => new Promise<BackendTerminalInfo[]>((resolve) => (resolveLook = resolve))
    );
    fireEvent.click(go);
    push({
      revision: 3,
      questions: [{ ...elsewhere, asker: { ...CLOSED_RESUMABLE, target: "replaced" } }],
    });
    await waitFor(() => expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull());
    await act(async () =>
      resolveLook([terminal({ id: "t9", projectId: "project-b", hasPty: true })])
    );
    expect(useDecisionsInboxStore.getState().isOpen).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
