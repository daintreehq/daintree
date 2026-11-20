// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionsAttentionItem,
  DecisionsAttentionList,
} from "@shared/types/decisionsAttention";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionReference,
} from "@shared/types/decisionsQuestion";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { openStoppedAnswers, stoppedQuestion, stoppedReference } from "../openStoppedAnswers";

const decisionsSwitch = vi.hoisted(() => ({ value: "on" as "on" | "off" | "unknown" }));
vi.mock("@/hooks/useDecisionsOn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useDecisionsOn")>()),
  readDecisionsSwitch: () => decisionsSwitch.value,
}));

const listQuestions = vi.fn<() => Promise<DecisionQuestionList>>();
const listAttention = vi.fn<() => Promise<DecisionsAttentionList>>();

/** An answer needing a person as the attention list reads it: only where it was asked matters here. */
function attentionItem(
  questionId: string,
  where: {
    terminalId?: string;
    projectId?: string;
    reference?: DecisionQuestionReference | null;
    otherHost?: { hostId: string; name: string | null } | null;
  } = {}
): DecisionsAttentionItem {
  const terminalId = where.terminalId ?? "t1";
  const projectId = where.projectId ?? "project-1";
  return {
    questionId,
    reference:
      where.reference === undefined
        ? { hostId: "host_studio", projectId, terminalId, questionId }
        : where.reference,
    origin: { paneId: terminalId, projectId, otherHost: where.otherHost ?? null },
  } as DecisionsAttentionItem;
}

function item(
  questionId: string,
  over: Partial<DecisionQuestionListItem> = {},
  where: { terminalId?: string; projectId?: string } = {}
): DecisionQuestionListItem {
  return {
    reference: {
      hostId: "host_studio",
      projectId: where.projectId ?? "project-1",
      terminalId: where.terminalId ?? "t1",
      questionId,
    },
    alias: Number(questionId.slice(1)),
    agentKind: "claude",
    projectLabel: "Project",
    worktreeId: "wt",
    worktreeRoot: "/repo",
    requirement: "human-required",
    askedAt: "2026-11-20T13:00:00.000Z",
    expiresAt: null,
    settledAt: null,
    standing: { kind: "needs-attention", deliveryStatus: "needs-attention" },
    replyRequest: null,
    stall: { answerRevision: 1, followUpIds: [], reason: "pane_gone" },
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  decisionsSwitch.value = "on";
  listQuestions.mockReset();
  listAttention.mockReset().mockResolvedValue({ result: "listed", items: [] });
  Reflect.set(window, "electron", { decisions: { listQuestions, listAttention } });
  useDecisionsInboxStore.setState({ isOpen: false, request: { terminalId: null, seq: 0 } });
  useDecisionsAttentionStore.setState({
    isOpen: false,
    request: { terminalId: null, returnFocusTo: null, seq: 0 },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

describe("stoppedQuestion", () => {
  const waiting = item("q1", { standing: { kind: "waiting", reason: "open" }, stall: null });
  const older = item("q2");
  const newer = item("q3");
  const hosts = item("q4", { remoteHost: { hostId: "atlas", name: "Atlas", connected: true } });
  const elsewhere = item("q5", {}, { terminalId: "t2" });
  const otherProject = item("q6", {}, { projectId: "project-2" });
  const list = [waiting, older, newer, hosts, elsewhere, otherProject];

  it("takes the first of the opener's stalled questions that this computer resolves", () => {
    expect(stoppedQuestion(list, { terminalId: "t1", questionIds: ["q4", "q3", "q2"] })).toBe(
      newer
    );
  });

  it("takes the list's oldest when the opener names none of them", () => {
    expect(stoppedQuestion(list, { terminalId: "t1", projectId: "project-1" })).toBe(older);
    expect(stoppedQuestion(list, { terminalId: "t1", questionIds: ["q9"] })).toBe(older);
  });

  it("keeps to the pane, and to its project when it's named", () => {
    expect(stoppedQuestion(list, { terminalId: "t1", projectId: "project-2" })).toBe(otherProject);
    expect(stoppedQuestion(list, { terminalId: "t2" })).toBe(elsewhere);
    // A Host's stall is its Host's to resolve, and a waiting question has none.
    expect(stoppedQuestion([waiting, hosts], { terminalId: "t1" })).toBeUndefined();
  });
});

describe("stoppedReference", () => {
  it("names the pane's first stopped answer this computer asked from a pane, in the opener's order", () => {
    const first = attentionItem("q2");
    const second = attentionItem("q3");
    const items = [first, second, attentionItem("q4", { terminalId: "t2" })];
    expect(stoppedReference(items, { terminalId: "t1" })).toEqual(first.reference);
    expect(stoppedReference(items, { terminalId: "t1", questionIds: ["q3"] })).toEqual(
      second.reference
    );
    expect(stoppedReference(items, { terminalId: "t1", projectId: "project-2" })).toBeUndefined();
    expect(
      stoppedReference([attentionItem("q5", { reference: null })], { terminalId: "t1" })
    ).toBeUndefined();
  });
});

describe("openStoppedAnswers", () => {
  it("opens the inbox at the stalled question, returning to the pane's chip", async () => {
    const stalled = item("q2");
    listQuestions.mockResolvedValue({ revision: 1, questions: [stalled] });

    await openStoppedAnswers({ terminalId: "t1" }, { fromPane: true });

    expect(useDecisionsInboxStore.getState()).toMatchObject({
      isOpen: true,
      request: {
        terminalId: "t1",
        question: { terminalId: "t1", questionId: "q2", reference: stalled.reference },
        returnFocusTo: null,
      },
    });
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(false);
  });

  it("opens it with no opener pane, returning to the element named, for a Canopy run", async () => {
    const stalled = item("q2");
    listQuestions.mockResolvedValue({ revision: 1, questions: [stalled] });

    await openStoppedAnswers(
      { terminalId: "t1", projectId: "project-1" },
      { returnFocusTo: "canopy-card-t1" }
    );

    expect(useDecisionsInboxStore.getState()).toMatchObject({
      isOpen: true,
      request: {
        terminalId: null,
        question: { reference: stalled.reference },
        returnFocusTo: "canopy-card-t1",
      },
    });
    // Its words weren't read to choose it.
    expect(listAttention).not.toHaveBeenCalled();
  });

  it("opens the inbox at the attention list's reference for a stall not yet listed, or when the list can't be read", async () => {
    const pending = attentionItem("q2");
    listAttention.mockResolvedValue({ result: "listed", items: [pending] });
    listQuestions.mockResolvedValue({ revision: 1, questions: [] });
    await openStoppedAnswers({ terminalId: "t1" }, { fromPane: true });
    expect(useDecisionsInboxStore.getState()).toMatchObject({
      isOpen: true,
      request: { terminalId: "t1", question: { reference: pending.reference } },
    });

    useDecisionsInboxStore.setState({ isOpen: false });
    listQuestions.mockImplementation(() => {
      throw new Error("no bridge");
    });
    await openStoppedAnswers({ terminalId: "t1", projectId: "project-1" });
    expect(useDecisionsInboxStore.getState().isOpen).toBe(true);
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(false);
  });

  it("opens the attention list for a stall the inbox can't list, or when neither read can say", async () => {
    listQuestions.mockResolvedValue({
      revision: 1,
      questions: [item("q2", {}, { terminalId: "t2" })],
    });
    // Asked with no pane to name it by, then by another machine.
    listAttention.mockResolvedValue({
      result: "listed",
      items: [attentionItem("q3", { reference: null })],
    });
    await openStoppedAnswers({ terminalId: "t1" }, { returnFocusTo: "canopy-card-t1" });
    expect(useDecisionsAttentionStore.getState()).toMatchObject({
      isOpen: true,
      request: { terminalId: "t1", returnFocusTo: "canopy-card-t1", seq: 1 },
    });

    listAttention.mockResolvedValue({
      result: "listed",
      items: [attentionItem("q4", { otherHost: { hostId: "atlas", name: "Atlas" } })],
    });
    await openStoppedAnswers({ terminalId: "t1" });
    expect(useDecisionsAttentionStore.getState().request.seq).toBe(2);

    listQuestions.mockRejectedValue(new Error("no list"));
    listAttention.mockImplementation(() => {
      throw new Error("no bridge");
    });
    await openStoppedAnswers({ terminalId: "t3" }, { fromPane: true });
    expect(useDecisionsAttentionStore.getState().request).toEqual({
      terminalId: "t3",
      returnFocusTo: null,
      seq: 3,
    });
    expect(useDecisionsInboxStore.getState().isOpen).toBe(false);
  });

  it("opens nothing for an opener that moved on while the list was read", async () => {
    listQuestions.mockResolvedValue({ revision: 1, questions: [item("q2")] });
    let shown = true;
    const read = openStoppedAnswers({ terminalId: "t1" }, { stillWanted: () => shown });
    shown = false;
    await read;
    expect(useDecisionsInboxStore.getState().isOpen).toBe(false);
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(false);
  });

  it("opens only what the latest press asked for when an earlier read lands last", async () => {
    const first = deferred<DecisionQuestionList>();
    const second = deferred<DecisionQuestionList>();
    listQuestions.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const earlier = openStoppedAnswers({ terminalId: "t1" }, { fromPane: true });
    const later = openStoppedAnswers({ terminalId: "t2" }, { fromPane: true });
    second.resolve({ revision: 2, questions: [item("q5", {}, { terminalId: "t2" })] });
    await later;
    first.resolve({ revision: 1, questions: [item("q2")] });
    await earlier;

    expect(useDecisionsInboxStore.getState().request).toMatchObject({
      terminalId: "t2",
      seq: 1,
      question: { questionId: "q5" },
    });
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(false);
  });

  it("yields to an opening that came while it read, as a notification's click", async () => {
    const read = deferred<DecisionsAttentionList>();
    listQuestions.mockResolvedValue({ revision: 1, questions: [] });
    listAttention.mockReturnValue(read.promise);
    const review = openStoppedAnswers({ terminalId: "t1" }, { fromPane: true });
    await vi.waitFor(() => expect(listAttention).toHaveBeenCalled());
    const notified = item("q7", {}, { terminalId: "t9" });
    useDecisionsInboxStore.getState().open({
      question: { terminalId: "t9", questionId: "q7", reference: notified.reference },
    });
    read.resolve({ result: "listed", items: [attentionItem("q2")] });
    await review;

    expect(useDecisionsInboxStore.getState().request.question?.reference).toEqual(
      notified.reference
    );
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(false);
  });

  it("opens nothing for an opener that moved on while the attention list was read", async () => {
    const read = deferred<DecisionsAttentionList>();
    listQuestions.mockResolvedValue({ revision: 1, questions: [] });
    listAttention.mockReturnValue(read.promise);
    let shown = true;
    const review = openStoppedAnswers({ terminalId: "t1" }, { stillWanted: () => shown });
    await vi.waitFor(() => expect(listAttention).toHaveBeenCalled());
    shown = false;
    read.resolve({ result: "listed", items: [attentionItem("q2")] });
    await review;

    expect(useDecisionsInboxStore.getState().isOpen).toBe(false);
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(false);
  });

  it("opens while main hasn't said whether Decisions is on, as in a window nothing else watches it from", async () => {
    decisionsSwitch.value = "unknown";
    listQuestions.mockResolvedValue({ revision: 1, questions: [item("q2")] });
    await openStoppedAnswers({ terminalId: "t1" });
    expect(useDecisionsInboxStore.getState().isOpen).toBe(true);
  });

  it("opens nothing once Decisions was switched off while the list was read", async () => {
    const read = deferred<DecisionQuestionList>();
    listQuestions.mockReturnValue(read.promise);

    const review = openStoppedAnswers({ terminalId: "t1" }, { fromPane: true });
    decisionsSwitch.value = "off";
    read.resolve({ revision: 1, questions: [item("q2")] });
    await review;

    expect(useDecisionsInboxStore.getState().isOpen).toBe(false);
    expect(useDecisionsAttentionStore.getState().isOpen).toBe(false);
  });
});
