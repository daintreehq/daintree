// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRegistry } from "../../actionTypes";
import type { DecisionsSwitch } from "@/hooks/useDecisionsOn";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionStanding,
} from "@shared/types/decisionsQuestion";

const env = vi.hoisted(() => ({
  switch: "on" as DecisionsSwitch,
  remote: false,
}));

/** Every way the client can change a question or an answer: none may run. */
const writes = vi.hoisted(() => ({
  answerQuestion: vi.fn(),
  declineQuestion: vi.fn(),
  cancelQuestion: vi.fn(),
  cancelQuestionByReference: vi.fn(),
  resumeAnswer: vi.fn(),
  reassignAnswer: vi.fn(),
  markAnswerHandled: vi.fn(),
}));

const listQuestions = vi.hoisted(() => vi.fn<() => Promise<DecisionQuestionList>>());

vi.mock("@/clients/decisionsClient", () => ({
  decisionsClient: { ...writes, listQuestions },
}));
vi.mock("@/hooks/useDecisionsOn", () => ({ readDecisionsSwitch: () => env.switch }));
vi.mock("@/hooks/useHostPlatform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useHostPlatform")>();
  return { ...actual, isRemoteWindow: () => env.remote };
});

import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";

const IDS = ["decisions.openInbox", "decisions.openNextQuestion"] as const;
type DecisionsActionId = (typeof IDS)[number];

function question(
  id: string,
  standing: DecisionQuestionStanding,
  replyRequest: string | null = null
): DecisionQuestionListItem {
  return {
    reference: { hostId: "local", projectId: "p1", terminalId: `t-${id}`, questionId: id },
    alias: 1,
    agentKind: "claude",
    projectLabel: "Project",
    worktreeId: "wt",
    worktreeRoot: "/repo",
    requirement: "human-required",
    askedAt: "2026-11-18T00:00:00.000Z",
    expiresAt: null,
    settledAt: null,
    standing,
    replyRequest,
    stall: null,
  };
}

function listed(...questions: DecisionQuestionListItem[]): void {
  listQuestions.mockResolvedValue({ revision: 1, questions });
}

/** Which view is open: the inbox, the question view, or none. */
function opened(): "inbox" | "question" | "none" | "both" {
  const inbox = useDecisionsInboxStore.getState().isOpen;
  const view = useDecisionsQuestionViewStore.getState().isOpen;
  return inbox && view ? "both" : inbox ? "inbox" : view ? "question" : "none";
}

describe("Decisions actions", () => {
  const registry: ActionRegistry = new Map();

  beforeAll(async () => {
    const { registerDecisionsActions } = await import("../decisionsActions");
    registerDecisionsActions(registry);
  });

  beforeEach(() => {
    env.switch = "on";
    env.remote = false;
    listQuestions.mockReset();
    for (const fn of Object.values(writes)) fn.mockReset();
  });

  afterEach(() => {
    useDecisionsInboxStore.setState({ isOpen: false, request: { terminalId: null, seq: 0 } });
    useDecisionsQuestionViewStore.setState({ isOpen: false, request: null });
  });

  const definition = (id: string) => registry.get(id)!();

  async function dispatch(id: DecisionsActionId, source: "user" | "keybinding" | "agent" = "user") {
    const { ActionService } = await import("@/services/ActionService");
    const service = new ActionService();
    for (const factory of registry.values()) service.register(factory());
    return service.dispatch(id, undefined, { source });
  }

  describe.each(IDS)("%s", (id) => {
    it("runs in this computer's windows once Decisions says it is on", () => {
      expect(definition(id).isVisible?.({})).toBe(true);
      expect(definition(id).isEnabled?.({})).toBe(true);
      expect(definition(id).disabledReason?.({})).toBeUndefined();
    });

    it("is listed but waits while Decisions hasn't said whether it is on", async () => {
      env.switch = "unknown";
      expect(definition(id).isVisible?.({})).toBe(true);
      expect(definition(id).isEnabled?.({})).toBe(false);
      expect(definition(id).disabledReason?.({})).toMatch(/hasn't said/);
      expect((await dispatch(id)).ok).toBe(false);
      expect(opened()).toBe("none");
      expect(listQuestions).not.toHaveBeenCalled();
    });

    it("is gone while Decisions is off, and a dispatch opens nothing", async () => {
      env.switch = "off";
      expect(definition(id).isVisible?.({})).toBe(false);
      expect(definition(id).isEnabled?.({})).toBe(false);
      expect(definition(id).disabledReason?.({})).toMatch(/Decisions is off/);
      expect((await dispatch(id)).ok).toBe(false);
      expect(opened()).toBe("none");
    });

    it("is gone from a Remote Host's window, whose panes never asked this computer's questions", () => {
      env.remote = true;
      expect(definition(id).isVisible?.({})).toBe(false);
      expect(definition(id).isEnabled?.({})).toBe(false);
      expect(definition(id).disabledReason?.({})).toMatch(/Remote Host/);
    });

    it.each(["user", "keybinding", "agent"] as const)(
      "only opens its view when dispatched by %s, answering, declining and cancelling nothing",
      async (source) => {
        listed(question("q1", { kind: "waiting", reason: "open" }));
        expect((await dispatch(id, source)).ok).toBe(true);
        expect(opened()).toBe(id === "decisions.openInbox" ? "inbox" : "question");
        for (const [name, write] of Object.entries(writes)) {
          expect(write, name).not.toHaveBeenCalled();
        }
      }
    );
  });

  describe("decisions.openInbox", () => {
    it("opens the inbox at no pane's question, and again while it is open", async () => {
      await dispatch("decisions.openInbox");
      const first = useDecisionsInboxStore.getState();
      expect(first.request.terminalId).toBeNull();

      await dispatch("decisions.openInbox");
      expect(useDecisionsInboxStore.getState().request.seq).toBeGreaterThan(first.request.seq);
    });
  });

  describe("decisions.openNextQuestion", () => {
    it("opens the oldest question waiting on the person, stepping through the others waiting in order", async () => {
      listed(
        question("settled", { kind: "settled", outcome: "answered", handled: false }),
        question("q1", { kind: "queued" }),
        question("typing", { kind: "to-type" }),
        question("q2", { kind: "waiting", reason: "open" }),
        question("stalled", { kind: "needs-attention", deliveryStatus: "needs-attention" })
      );
      expect((await dispatch("decisions.openNextQuestion")).ok).toBe(true);

      expect(opened()).toBe("question");
      const request = useDecisionsQuestionViewStore.getState().request!;
      expect(request.index).toBe(0);
      expect(request.threadMessageId).toBeUndefined();
      expect(
        request.questions.map((target) =>
          target.scope === "reference" ? target.reference.questionId : null
        )
      ).toEqual(["q1", "q2"]);
    });

    it("starts at the oldest question not yet seen, stepping through seen ones too, never cleared ones (#17895)", async () => {
      const open: DecisionQuestionStanding = { kind: "waiting", reason: "open" };
      const marked = (id: string, seen: boolean, cleared: boolean) => ({
        ...question(id, open),
        inbox: { ask: null, seen, cleared },
      });
      listed(
        marked("seen", true, false),
        marked("cleared", false, true),
        marked("new", false, false)
      );
      await dispatch("decisions.openNextQuestion");
      const request = useDecisionsQuestionViewStore.getState().request!;
      expect(
        request.questions.map((target) =>
          target.scope === "reference" ? target.reference.questionId : null
        )
      ).toEqual(["seen", "new"]);
      expect(request.index).toBe(1);
    });

    it("opens a question seen and left when nothing new waits (#17895)", async () => {
      listed({
        ...question("seen", { kind: "waiting", reason: "open" }),
        inbox: { ask: null, seen: true, cleared: false },
      });
      await dispatch("decisions.openNextQuestion");
      expect(opened()).toBe("question");
      expect(useDecisionsQuestionViewStore.getState().request!.index).toBe(0);
    });

    it("opens an answered question at the follow-up asking for a reply", async () => {
      listed(question("q1", { kind: "waiting", reason: "reply" }, "m-7"));
      await dispatch("decisions.openNextQuestion");
      expect(useDecisionsQuestionViewStore.getState().request!.threadMessageId).toBe("m-7");
    });

    it("opens nothing when no question waits on the person", async () => {
      listed(
        question("done", { kind: "settled", outcome: "declined" }),
        question("typing", { kind: "to-type" })
      );
      expect((await dispatch("decisions.openNextQuestion")).ok).toBe(true);
      expect(opened()).toBe("none");
    });

    it("opens nothing when Decisions is switched off while the list is read", async () => {
      listQuestions.mockImplementation(async () => {
        env.switch = "off";
        return { revision: 1, questions: [question("q1", { kind: "queued" })] };
      });
      await dispatch("decisions.openNextQuestion");
      expect(opened()).toBe("none");
    });

    it("fails, opening nothing, when the list can't be read", async () => {
      listQuestions.mockRejectedValue(new Error("store closed"));
      expect((await dispatch("decisions.openNextQuestion")).ok).toBe(false);
      expect(opened()).toBe("none");
    });
  });
});
