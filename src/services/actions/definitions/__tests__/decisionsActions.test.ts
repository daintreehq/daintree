// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRegistry } from "../../actionTypes";
import type { DecisionsSwitch } from "@/hooks/useDecisionsOn";
import type { DecisionsStatus } from "@shared/types/decisions";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionStanding,
} from "@shared/types/decisionsQuestion";

const env = vi.hoisted(() => ({
  switch: "on" as DecisionsSwitch,
  remote: false,
}));

const client = vi.hoisted(() => ({
  getStatus: vi.fn<() => Promise<DecisionsStatus>>(),
  listQuestions: vi.fn<() => Promise<DecisionQuestionList>>(),
  answerQuestion: vi.fn(),
  cancelQuestion: vi.fn(),
  declineQuestion: vi.fn(),
  resumeAnswer: vi.fn(),
  markAnswerHandled: vi.fn(),
}));

vi.mock("@/clients/decisionsClient", () => ({ decisionsClient: client }));
vi.mock("@/hooks/useDecisionsOn", () => ({ readDecisionsSwitch: () => env.switch }));
vi.mock("@/hooks/useHostPlatform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useHostPlatform")>();
  return { ...actual, isRemoteWindow: () => env.remote };
});

import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";

const IDS = ["decisions.openInbox", "decisions.openNextQuestion"] as const;

function question(
  id: string,
  standing: DecisionQuestionStanding,
  replyRequest: string | null = null
): DecisionQuestionListItem {
  return {
    reference: { hostId: "local", projectId: "p1", terminalId: `t-${id}`, questionId: id },
    standing,
    replyRequest,
  } as DecisionQuestionListItem;
}

function listed(...questions: DecisionQuestionListItem[]): void {
  client.listQuestions.mockResolvedValue({ revision: 1, questions });
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
    for (const fn of Object.values(client)) fn.mockReset();
  });

  afterEach(() => {
    useDecisionsInboxStore.setState({ isOpen: false, request: { terminalId: null, seq: 0 } });
    useDecisionsQuestionViewStore.setState({ isOpen: false, request: null });
  });

  const definition = (id: string) => registry.get(id)!();

  async function dispatch(id: (typeof IDS)[number], source: "user" | "agent" = "user") {
    const { ActionService } = await import("@/services/ActionService");
    const service = new ActionService();
    for (const factory of registry.values()) service.register(factory());
    return service.dispatch(id, undefined, { source });
  }

  describe.each(IDS)("%s", (id) => {
    it("is offered in this computer's windows unless Decisions is known to be off", () => {
      for (const known of ["on", "unknown"] as const) {
        env.switch = known;
        expect(definition(id).isVisible?.({})).toBe(true);
        expect(definition(id).isEnabled?.({})).toBe(true);
        expect(definition(id).disabledReason?.({})).toBeUndefined();
      }
      env.switch = "off";
      expect(definition(id).isVisible?.({})).toBe(false);
      expect(definition(id).isEnabled?.({})).toBe(false);
      expect(definition(id).disabledReason?.({})).toMatch(/Decisions is off/);
    });

    it("is not offered in a Remote Host's window, whose panes never asked this computer's questions", () => {
      env.remote = true;
      expect(definition(id).isVisible?.({})).toBe(false);
      expect(definition(id).isEnabled?.({})).toBe(false);
      expect(definition(id).disabledReason?.({})).toMatch(/Remote Host/);
    });

    it("refuses a dispatch while Decisions is off, opening nothing", async () => {
      env.switch = "off";
      const result = await dispatch(id);
      expect(result.ok).toBe(false);
      expect(useDecisionsInboxStore.getState().isOpen).toBe(false);
      expect(useDecisionsQuestionViewStore.getState().isOpen).toBe(false);
    });

    it("only opens a view when an agent dispatches it, answering, declining and cancelling nothing", async () => {
      listed(question("q1", { kind: "waiting", reason: "open" }));
      const result = await dispatch(id, "agent");
      expect(result.ok).toBe(true);
      expect(
        useDecisionsInboxStore.getState().isOpen || useDecisionsQuestionViewStore.getState().isOpen
      ).toBe(true);
      for (const write of [
        client.answerQuestion,
        client.cancelQuestion,
        client.declineQuestion,
        client.resumeAnswer,
        client.markAnswerHandled,
      ]) {
        expect(write).not.toHaveBeenCalled();
      }
    });
  });

  describe("decisions.openInbox", () => {
    it("opens the inbox at no pane's question, and again while it is open", async () => {
      expect((await dispatch("decisions.openInbox")).ok).toBe(true);
      const first = useDecisionsInboxStore.getState();
      expect(first.isOpen).toBe(true);
      expect(first.request.terminalId).toBeNull();

      await dispatch("decisions.openInbox");
      expect(useDecisionsInboxStore.getState().request.seq).toBeGreaterThan(first.request.seq);
    });

    it("asks main before the view has heard, and opens only if Decisions is on", async () => {
      env.switch = "unknown";
      client.getStatus.mockResolvedValue({ state: "off" } as DecisionsStatus);
      expect((await dispatch("decisions.openInbox")).ok).toBe(false);
      expect(useDecisionsInboxStore.getState().isOpen).toBe(false);

      client.getStatus.mockResolvedValue({ state: "connecting" } as DecisionsStatus);
      expect((await dispatch("decisions.openInbox")).ok).toBe(true);
      expect(useDecisionsInboxStore.getState().isOpen).toBe(true);
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

      const view = useDecisionsQuestionViewStore.getState();
      expect(view.isOpen).toBe(true);
      expect(view.request!.index).toBe(0);
      expect(view.request!.threadMessageId).toBeUndefined();
      expect(
        view.request!.questions.map((target) =>
          target.scope === "reference" ? target.reference.questionId : null
        )
      ).toEqual(["q1", "q2"]);
      expect(useDecisionsInboxStore.getState().isOpen).toBe(false);
    });

    it("opens an answered question at the follow-up asking for a reply", async () => {
      listed(question("q1", { kind: "waiting", reason: "reply" }, "m-7"));
      await dispatch("decisions.openNextQuestion");
      expect(useDecisionsQuestionViewStore.getState().request!.threadMessageId).toBe("m-7");
    });

    it("opens nothing when no question waits on the person", async () => {
      listed(question("done", { kind: "settled", outcome: "declined" }));
      expect((await dispatch("decisions.openNextQuestion")).ok).toBe(true);
      expect(useDecisionsQuestionViewStore.getState().isOpen).toBe(false);
    });

    it("opens nothing when Decisions is switched off while the list is read", async () => {
      client.listQuestions.mockImplementation(async () => {
        env.switch = "off";
        return { revision: 1, questions: [question("q1", { kind: "queued" })] };
      });
      await dispatch("decisions.openNextQuestion");
      expect(useDecisionsQuestionViewStore.getState().isOpen).toBe(false);
    });

    it("fails, opening nothing, when the list can't be read", async () => {
      client.listQuestions.mockRejectedValue(new Error("store closed"));
      expect((await dispatch("decisions.openNextQuestion")).ok).toBe(false);
      expect(useDecisionsQuestionViewStore.getState().isOpen).toBe(false);
    });
  });
});
