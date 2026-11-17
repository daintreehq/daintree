// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DecisionsStatus } from "@shared/types/decisions";
import type {
  DecisionQuestionCancelResult,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionReference,
  DecisionQuestionStanding,
  DecisionQuestionSummariesResult,
} from "@shared/types/decisionsQuestion";
import type { BackendTerminalInfo } from "@shared/types/ipc/terminal";
import { TooltipProvider } from "@/components/ui/tooltip";
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
let listListeners: Array<(list: DecisionQuestionList) => void> = [];
let statusListeners: Array<(status: DecisionsStatus) => void> = [];

function reference(questionId: string, over: Partial<DecisionQuestionReference> = {}) {
  return { hostId: "host_1", projectId: "project-a", terminalId: "t1", questionId, ...over };
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
    ...over,
  };
}

const OPEN: DecisionQuestionStanding = { kind: "waiting", reason: "open" };

/** Project A's open question, project B's answer being delivered, and A's expired one. */
const LIST: DecisionQuestionList = {
  revision: 1,
  questions: [
    item("q1", 1, { kind: "settled", outcome: "expired" }, { settledAt: "2026-11-02T11:00:00Z" }),
    item("q2", 2, OPEN),
    item(
      "q3",
      3,
      { kind: "to-type" },
      {
        reference: reference("q3", { projectId: "project-b", terminalId: "t9" }),
        projectLabel: "Beta",
        agentKind: "codex",
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
    deliveryStatus: "terminal-delivered",
    attachments: [],
    thread: [],
    ...over,
  };
  return question;
}

const CONTENT: Record<string, DecisionQuestionContent> = {
  q1: content("q1", 1),
  q2: content("q2", 2, { status: "open" }),
  q3: content("q3", 3, {
    status: "human-answered",
    reference: reference("q3", { projectId: "project-b", terminalId: "t9" }),
  }),
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

function rowNamed(alias: string) {
  const row = rows().find((candidate) => candidate.textContent?.startsWith(alias));
  if (!row) throw new Error(`no row ${alias}`);
  return row;
}

function open(options?: { terminalId?: string }) {
  act(() => useDecisionsInboxStore.getState().open(options));
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
  getAllTerminals.mockReset().mockResolvedValue([]);
  dispatch.mockReset().mockResolvedValue({ ok: true });
  Reflect.set(window, "electron", {
    decisions: {
      listQuestions,
      getStatus,
      getQuestionContentByReference,
      getQuestionSummariesByReference,
      cancelQuestionByReference,
    },
    events: {
      on: (name: string, callback: (payload: never) => void) => {
        if (name === "decisions:questions-changed") {
          listListeners.push(callback as (list: DecisionQuestionList) => void);
          return () => {
            listListeners = listListeners.filter((listener) => listener !== callback);
          };
        }
        if (name === "decisions:status-changed") {
          statusListeners.push(callback as (status: DecisionsStatus) => void);
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
    expect(screen.queryByTestId("decisions-inbox-group-attention")).toBeNull();

    await waitFor(() => expect(rowNamed("q-2").textContent).toContain("Line of q2"));
    const own = rowNamed("q-2").textContent!;
    // This view's project by its current name, a worktree by its folder elsewhere.
    expect(own).toContain("Alpha");
    expect(own).not.toContain("Alpha (as asked)");
    expect(own).toContain("feature-x");
    expect(own).toContain("Waiting for an answer");
    expect(rowNamed("q-2").querySelector("time")).not.toBeNull();
    // Another project keeps the name it was asked under.
    expect(rowNamed("q-3").textContent).toContain("Beta");
    // One read of the lines, by reference, for every row.
    expect(getQuestionSummariesByReference).toHaveBeenCalledOnce();
    expect(getQuestionSummariesByReference.mock.calls[0]![0].references).toHaveLength(3);
  });

  it("shows the first question beside the list, read by reference", async () => {
    open();
    const body = await screen.findByTestId("decision-question-content");
    expect(body.textContent).toContain("Body of question 2");
    expect(getQuestionContentByReference).toHaveBeenCalledWith({ reference: reference("q2") });
    expect(rowNamed("q-2").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("decisions-inbox-detail-title").textContent).toContain("q-2");
  });

  it("starts at the question of the pane that opened it", async () => {
    open({ terminalId: "t9" });
    await waitFor(() => expect(rowNamed("q-3").getAttribute("aria-current")).toBe("true"));
    await waitFor(() =>
      expect(screen.getByTestId("decision-question-content").textContent).toContain(
        "Body of question 3"
      )
    );
  });

  it("keeps the chosen question as the list regroups, and takes its place's when it goes", async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(rowNamed("q-3"));
    await waitFor(() =>
      expect(screen.getByTestId("decision-question-content").textContent).toContain(
        "Body of question 3"
      )
    );

    // q-3 settles: it moves to history and stays shown, with no new read of the lines.
    push({
      revision: 2,
      questions: [
        LIST.questions[0]!,
        LIST.questions[1]!,
        {
          ...LIST.questions[2]!,
          standing: { kind: "settled", outcome: "answered", handled: false },
          settledAt: "2026-11-02T12:00:00Z",
        },
      ],
    });
    await waitFor(() =>
      expect(screen.getByTestId("decisions-inbox-group-history").textContent).toContain("q-3")
    );
    expect(rowNamed("q-3").getAttribute("aria-current")).toBe("true");
    expect(getQuestionSummariesByReference).toHaveBeenCalledOnce();

    // Gone from the list: the question now in its place is shown instead.
    push({ revision: 3, questions: [LIST.questions[0]!, LIST.questions[1]!] });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows().filter((row) => row.getAttribute("aria-current") === "true")).toHaveLength(1);
  });

  it("moves through the list from the keyboard with one tab stop, opening a row on Enter", async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().filter((row) => row.tabIndex === 0)).toHaveLength(1);
    const first = rows()[0]!;
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[1]);
    fireEvent.keyDown(rows()[1]!, { key: "End" });
    expect(document.activeElement).toBe(rows()[2]);
    // Moving the focus reads nothing; choosing does.
    expect(rows()[2]!.getAttribute("aria-current")).toBeNull();
    fireEvent.click(rows()[2]!);
    await waitFor(() => expect(rows()[2]!.getAttribute("aria-current")).toBe("true"));
    expect(rows().filter((row) => row.tabIndex === 0)).toEqual([rows()[2]]);
  });

  it("says when no relay is connected, and nothing once one is", async () => {
    getStatus.mockResolvedValue({ state: "not-connected", revision: 1 });
    open();
    const notice = await screen.findByTestId("decisions-inbox-connection");
    expect(notice.textContent).toContain("Settings → Decisions");

    pushStatus({ state: "reconnecting", relayOrigin: "https://relay.example", revision: 2 });
    await waitFor(() =>
      expect(screen.getByTestId("decisions-inbox-connection").textContent).toContain(
        "Not connected to the relay"
      )
    );
    pushStatus({ state: "connected", relayOrigin: "https://relay.example", revision: 3 });
    await waitFor(() => expect(screen.queryByTestId("decisions-inbox-connection")).toBeNull());
    // The questions this computer holds stay listed throughout.
    expect(rows()).toHaveLength(3);
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

  it("reads lines in batches the IPC takes, and leaves a row it couldn't read named by alias", async () => {
    const many = Array.from({ length: 65 }, (_, index) =>
      item(`m${index}`, 100 + index, OPEN, { askedAt: "2026-11-02T10:00:00.000Z" })
    );
    listQuestions.mockResolvedValue({ revision: 1, questions: many });
    getQuestionSummariesByReference.mockImplementation(async ({ references }) => ({
      result: "read",
      summaries: references.map((ref) =>
        ref.questionId === "m0"
          ? { questionId: ref.questionId, result: "unreadable" as const }
          : { questionId: ref.questionId, result: "read" as const, line: `Line ${ref.questionId}` }
      ),
    }));
    open();
    await waitFor(() => expect(getQuestionSummariesByReference).toHaveBeenCalledTimes(2));
    expect(
      getQuestionSummariesByReference.mock.calls.map(([payload]) => payload.references.length)
    ).toEqual([64, 1]);
    await waitFor(() => expect(rowNamed("q-164").textContent).toContain("Line m64"));
    expect(within(rowNamed("q-100")).getByTestId("decisions-inbox-row-line").textContent).toBe("");
  });

  it("withdraws the question shown, after the confirmation naming it", async () => {
    open();
    const cancel = await screen.findByTestId("decisions-inbox-cancel");
    fireEvent.click(cancel);
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("q-2");
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Cancel question" }));
    });
    await waitFor(() =>
      expect(cancelQuestionByReference).toHaveBeenCalledWith({ reference: reference("q2") })
    );
  });

  it("offers no cancel for a question that has stopped waiting", async () => {
    open();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(rowNamed("q-1"));
    await waitFor(() =>
      expect(screen.getByTestId("decision-question-content").textContent).toContain(
        "Body of question 1"
      )
    );
    expect(screen.queryByTestId("decisions-inbox-cancel")).toBeNull();
  });

  describe("going to the terminal that asked", () => {
    it("focuses a panel of this view once the inbox has closed", async () => {
      panels = { t1: { location: "grid" } };
      open();
      const go = await screen.findByTestId("decisions-inbox-go-to-terminal");
      fireEvent.click(go);
      expect(useDecisionsInboxStore.getState().isOpen).toBe(false);
      await waitFor(() => expect(dispatch).toHaveBeenCalledWith("panel.focus", { panelId: "t1" }));
    });

    it("offers nothing for a panel that's gone or in the trash", async () => {
      panels = { t1: { location: "trash" } };
      open();
      await screen.findByTestId("decision-question-content");
      expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
    });

    it("switches to another project whose terminal still runs here", async () => {
      getAllTerminals.mockResolvedValue([
        { id: "t9", projectId: "project-b", hasPty: true } as BackendTerminalInfo,
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

    it("never matches the same terminal id in another project, nor a trashed one", async () => {
      getAllTerminals.mockResolvedValue([
        { id: "t9", projectId: "project-c", hasPty: true } as BackendTerminalInfo,
        { id: "t9", projectId: "project-b", isTrashed: true } as BackendTerminalInfo,
      ]);
      open({ terminalId: "t9" });
      await waitFor(() => expect(getAllTerminals).toHaveBeenCalled());
      await screen.findByTestId("decision-question-content");
      expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
    });

    it("offers nothing from a Remote Host's window, whose terminals are another computer's", async () => {
      remote = true;
      panels = { t1: { location: "grid" } };
      open();
      await screen.findByTestId("decision-question-content");
      expect(screen.queryByTestId("decisions-inbox-go-to-terminal")).toBeNull();
      expect(getAllTerminals).not.toHaveBeenCalled();
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
