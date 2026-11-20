// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { DecisionsStatus } from "@shared/types/decisions";
import type {
  DecisionDeclineResultRead,
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
import type { BackendTerminalInfo } from "@shared/types/ipc/terminal";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { answerKey, useDecisionsAnswerStore } from "@/store/decisionsAnswerStore";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";

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
vi.mock("@/hooks/useHostPlatform", () => ({ isRemoteWindow: () => remote }));
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
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreOptional: (_select: unknown, fallback: unknown) => fallback,
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
    // The agent is named by its mark; the dot between project and worktree is hidden from assistive technology.
    const dots = Array.from(own.querySelectorAll("span")).filter(
      (span) => span.textContent?.trim() === "·"
    );
    expect(dots).toHaveLength(1);
    for (const dot of dots) expect(dot.getAttribute("aria-hidden")).toBe("true");
    // Another project's question keeps the name it was asked under, and its own agent.
    const other = rowNamed("q-3");
    expect(other.textContent).toContain("Beta");
    expect(other.textContent).toContain(getEffectiveAgentConfig("codex")!.name);
    expect(other.textContent).not.toContain(getEffectiveAgentConfig("claude")!.name);
    // Each row's age is its own question's.
    const ages = ["q-1", "q-2", "q-3"].map(
      (alias) => rowNamed(alias).querySelector("time")?.getAttribute("datetime") ?? null
    );
    expect(ages).toEqual(LIST.questions.map((entry) => new Date(entry.askedAt).toISOString()));
    // One read of the lines, by reference, for every row.
    expect(getQuestionSummariesByReference).toHaveBeenCalledOnce();
    expect(getQuestionSummariesByReference.mock.calls[0]![0].references).toHaveLength(3);
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

  it("moves through native buttons with one tab stop, reading only the row chosen", async () => {
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
    // Moving the focus reads nothing; choosing does.
    expect(readsOf("question-1")).toBe(0);
    expect(rows()[2]!.getAttribute("aria-current")).toBeNull();
    fireEvent.click(rows()[2]!);
    await waitFor(() => expect(readsOf("question-1")).toBe(1));
    expect(rows()[2]!.getAttribute("aria-current")).toBe("true");
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
    await act(async () => rejectStatus(new Error("gone")));
    await screen.findByTestId("decisions-inbox-empty");
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

    pushStatus({ state: "connected", relayOrigin: "https://relay.example", revision: 2 });
    await screen.findByTestId("decisions-inbox-empty");
  });

  it("says when there's nothing yet, and offers Retry when the list can't be read", async () => {
    listQuestions.mockRejectedValueOnce(new Error("gone"));
    open();
    const failed = await screen.findByTestId("decisions-inbox-failed");
    listQuestions.mockResolvedValue({ revision: 4, questions: [] });
    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
    await screen.findByTestId("decisions-inbox-empty");
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

  it("dismisses the question shown only after the confirmation naming it, at the revision read (#17239)", async () => {
    open();
    const dismiss = await screen.findByTestId("decisions-inbox-dismiss");
    fireEvent.click(dismiss);
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Dismiss question q-2?");
    expect(declineQuestion).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss question" }));
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
      expect(screen.getByTestId("decisions-inbox-dismiss-status").textContent).toMatch(/^Dismissed/)
    );
  });

  it("withdraws the question shown only after a second confirmation, once the relay can't take a dismissal", async () => {
    declineQuestion.mockImplementationOnce(async ({ declineId }) => ({
      result: "submitted",
      declineId,
      outcome: { status: "unsupported", by: "relay" },
    }));
    open();
    fireEvent.click(await screen.findByTestId("decisions-inbox-dismiss"));
    const asked = await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(asked).getByRole("button", { name: "Dismiss question" }));
    });
    expect(asked.textContent).toContain("Withdraw question q-2?");
    fireEvent.click(within(asked).getByRole("button", { name: "Keep question" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByTestId("decisions-inbox-dismiss-status").textContent).toContain(
      "Your relay needs an update"
    );
    expect(cancelQuestionByReference).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByTestId("decisions-inbox-withdraw"));
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

  it("offers no dismissal for a question that has stopped waiting", async () => {
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
      fireEvent.click(rowNamed("q-2"));
      await waitFor(() => expect(shownBody()).toContain("Body of question 2"));
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

    it("dismisses it from what was last read of it, and never offers withdrawing in its place", async () => {
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
          /isn't connected.*last read it 1 minute ago, so you can still dismiss it/
        )
      );
      fireEvent.click(await screen.findByTestId("decisions-inbox-dismiss"));
      const confirm = await screen.findByRole("alertdialog");
      expect(confirm.textContent).toContain("Dismiss question q-9?");
      expect(confirm.textContent).toMatch(/dismissed as this computer last read it/);
      await act(async () => {
        fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss question" }));
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

    it("never offers withdrawing for a dismissal signed from the last read once the Host went away under the confirmation", async () => {
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
        fireEvent.click(within(confirm).getByRole("button", { name: "Dismiss question" }));
      });
      await waitFor(() =>
        expect(confirm.textContent).toMatch(/Your relay needs an update.*q-9 wasn't dismissed/)
      );
      expect(declineQuestion).toHaveBeenCalledOnce();
      expect(confirm.textContent).not.toContain("Withdraw question");
      expect(confirm.textContent).not.toMatch(/withdraw it instead/);
      expect(cancelQuestionByReference).not.toHaveBeenCalled();
    });

    it("offers no withdrawal for a dismissal signed from the last read once the Host is back", async () => {
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
          /^Your relay needs an update.*q-9 wasn't dismissed\.$/
        )
      );
      expect(screen.queryByTestId("decisions-inbox-withdraw")).toBeNull();
      // A new Dismiss, from the live read, is its own decision.
      expect(screen.getByTestId("decisions-inbox-dismiss")).toBeTruthy();
    });

    it("says why it can't be dismissed when nothing read here says where it stands, and keeps Clear", async () => {
      getQuestionContentByReference.mockResolvedValue({
        result: "host-not-connected",
        lastRead: { result: "not-read" },
      });
      open();
      await waitFor(() =>
        expect(screen.getByTestId("decision-question-unavailable").textContent).toMatch(
          /isn't connected.*can't be dismissed until the Host is back/
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

    it("offers nothing from a Remote Host's window, and names questions as they were asked", async () => {
      remote = true;
      panels = { t1: { location: "grid" } };
      open();
      await screen.findByTestId("decision-question-content");
      expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
      expect(getAllTerminals).not.toHaveBeenCalled();
      // Its projects are another computer's, whatever their ids.
      expect(rowNamed("q-2").textContent).toContain("Alpha (as asked)");
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
      fireEvent.click(screen.getByTestId("decisions-inbox-clear-all"));
      await waitFor(() =>
        expect(markQuestions).toHaveBeenCalledWith({
          action: "clear",
          questions: [
            { reference: reference("question-2"), ask: null },
            { reference: reference("question-4"), ask: "note-9" },
          ],
        })
      );

      // With Needs you empty the button stays where the keyboard is, and does nothing.
      push(
        marked({ ...unmarked, cleared: true }, 3, [
          { ...second, inbox: { ...second.inbox, cleared: true } },
        ])
      );
      await waitFor(() =>
        expect(screen.queryByTestId("decisions-inbox-group-needs-you")).toBeNull()
      );
      const clearAll = screen.getByTestId("decisions-inbox-clear-all");
      expect(clearAll.getAttribute("aria-disabled")).toBe("true");
      markQuestions.mockClear();
      fireEvent.click(clearAll);
      await act(async () => {});
      expect(markQuestions.mock.calls.filter(([p]) => p.action === "clear")).toHaveLength(0);
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

  it("closes as soon as Decisions turns off", async () => {
    open();
    await screen.findByTestId("decision-question-content");
    act(() => {
      decisionsOn = false;
      for (const listener of [...onListeners]) listener();
    });
    expect(useDecisionsInboxStore.getState().isOpen).toBe(false);
  });
});
