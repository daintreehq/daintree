// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRegistry } from "../../actionTypes";
import type { DecisionsSwitch } from "@/hooks/useDecisionsOn";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionStanding,
} from "@shared/types/decisionsQuestion";
import type { DecisionsHost, DecisionsHostsResult } from "@shared/types/decisionsHosts";

const env = vi.hoisted(() => ({
  switch: "on" as DecisionsSwitch,
  remote: false,
}));

const REMOTE_HOST = "studio";

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
const listHosts = vi.hoisted(() => vi.fn<() => Promise<DecisionsHostsResult>>());
const notify = vi.hoisted(() => vi.fn());

vi.mock("@/clients/decisionsClient", () => ({
  decisionsClient: { ...writes, listQuestions, listHosts },
}));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/hooks/useDecisionsOn", () => ({ readDecisionsSwitch: () => env.switch }));
vi.mock("@/hooks/useHostPlatform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useHostPlatform")>();
  return {
    ...actual,
    isRemoteWindow: () => env.remote,
    currentHostId: () => (env.remote ? REMOTE_HOST : "local"),
    getHostPlatformInfo: () => ({ ...actual.getHostPlatformInfo(), hostName: "Studio" }),
  };
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

function hostRow(enrollment: DecisionsHost["enrollment"]): DecisionsHost {
  return { hostId: REMOTE_HOST, name: "Studio", connected: true, enrollment, canEnroll: false };
}

/** Main's answer about the Hosts, held until the test gives it. */
function deferredHosts(): { resolve: (read: DecisionsHostsResult) => void } {
  let resolve!: (read: DecisionsHostsResult) => void;
  listHosts.mockReturnValue(new Promise<DecisionsHostsResult>((settle) => (resolve = settle)));
  return { resolve: (read) => resolve(read) };
}

/** Main's Hosts: `inbox` the host-list ids whose questions its inbox lists. */
function hostsListed(inbox: string[], ...hosts: DecisionsHost[]): void {
  listHosts.mockResolvedValue({ result: "listed", autoEnroll: true, hosts, inboxHostIds: inbox });
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
    listHosts.mockReset();
    notify.mockReset();
    for (const fn of Object.values(writes)) fn.mockReset();
  });

  afterEach(() => {
    useDecisionsInboxStore.setState({ isOpen: false, request: { terminalId: null, seq: 0 } });
    useDecisionsQuestionViewStore.setState({ isOpen: false, request: null });
  });

  const definition = (id: string) => registry.get(id)!();

  async function dispatch(
    id: DecisionsActionId,
    source: "user" | "keybinding" | "agent" = "user",
    callerReportsFailure = false
  ) {
    const { ActionService } = await import("@/services/ActionService");
    const service = new ActionService();
    for (const factory of registry.values()) service.register(factory());
    return service.dispatch(id, undefined, { source, callerReportsFailure });
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

    it("runs in a Remote Host's window whose Host's questions the inbox lists, opening its Host's question (#18049)", async () => {
      env.remote = true;
      hostsListed([REMOTE_HOST], hostRow({ state: "enrolled", deviceId: "d1" }));
      const theirs = {
        ...question("q-studio", { kind: "waiting", reason: "open" }),
        reference: {
          hostId: "qhost_studio",
          projectId: "p1",
          terminalId: "t-studio",
          questionId: "q-studio",
        },
        remoteHost: { hostId: REMOTE_HOST, name: "Studio", connected: true },
      };
      listed(theirs);
      expect(definition(id).isVisible?.({})).toBe(true);
      expect(definition(id).isEnabled?.({})).toBe(true);
      expect(definition(id).disabledReason?.({})).toBeUndefined();
      expect((await dispatch(id)).ok).toBe(true);
      expect(listHosts).toHaveBeenCalledTimes(1);
      expect(notify).not.toHaveBeenCalled();
      expect(opened()).toBe("inbox");
      if (id === "decisions.openNextQuestion") {
        // At its Host's question, in the inbox (#18047).
        expect(useDecisionsInboxStore.getState().request.question?.reference).toEqual(
          theirs.reference
        );
      }
    });

    it("runs for a Host whose report the inbox took, though it holds no question and its link is down", async () => {
      env.remote = true;
      listHosts.mockResolvedValue({
        result: "listed",
        autoEnroll: true,
        hosts: [{ ...hostRow({ state: "enrolled", deviceId: "d1" }), connected: false }],
        inboxHostIds: ["other", REMOTE_HOST],
      });
      listed(question("q1", { kind: "waiting", reason: "open" }));
      expect((await dispatch(id)).ok).toBe(true);
      expect(listHosts).toHaveBeenCalledTimes(1);
      expect(opened()).toBe("inbox");
      expect(notify).not.toHaveBeenCalled();
    });

    it.each([
      [{ state: "not-enrolled" }, /^Studio isn't enrolled in Decisions/],
      [{ state: "own-setup" }, /^Studio has its own Decisions setup/],
      [{ state: "other-setup" }, /^Studio is enrolled with another relay or owner/],
      [{ state: "revoked" }, /^Studio's Decisions device was revoked/],
      [{ state: "stale" }, /^Studio holds Decisions keys this computer's relay no longer lists/],
      [{ state: "needs-update" }, /^Studio needs a newer Daintree/],
      [
        { state: "failed", failure: { reason: "relay-unreachable", at: 1 } },
        /^Studio's last Decisions enrollment didn't finish/,
      ],
      [{ state: "enrolled", deviceId: "d1" }, /^This computer's inbox doesn't list Studio's/],
      [{ state: "checking" }, /^This computer's inbox doesn't list Studio's/],
    ] as const)(
      "says plainly, once, that a Host whose questions the inbox doesn't list (%o) isn't in it, opening nothing",
      async (enrollment, reason) => {
        env.remote = true;
        // Another Host the inbox does list comes first: only this window's Host counts.
        hostsListed(
          ["lab"],
          { ...hostRow({ state: "enrolled", deviceId: "d2" }), hostId: "lab", name: "Lab" },
          hostRow(enrollment)
        );
        listed(question("q1", { kind: "waiting", reason: "open" }));
        const result = await dispatch(id);
        expect(result.ok).toBe(false);
        expect(result.ok ? null : result.error.message).toMatch(reason);
        expect(opened()).toBe("none");
        expect(notify).toHaveBeenCalledTimes(1);
        const shown = notify.mock.calls[0]![0];
        expect(shown.message).toMatch(reason);
        expect(shown.urgent).toBe(true);
        expect(shown.action).toMatchObject({
          label: "Open Decisions settings",
          actionId: "app.settings.openTab",
          actionArgs: { tab: "decisions", sectionId: "decisions-hosts" },
        });
      }
    );

    it("names the window's Host for one the host list doesn't have", async () => {
      env.remote = true;
      hostsListed(["lab"]);
      const result = await dispatch(id);
      expect(result.ok ? null : result.error.message).toMatch(
        /^This computer's inbox doesn't list Studio's/
      );
    });

    it("checks the Host's questions are listed before it says this computer can't enroll Hosts", async () => {
      env.remote = true;
      listed(question("q1", { kind: "waiting", reason: "open" }));
      listHosts.mockResolvedValue({ result: "not-set-up", inboxHostIds: [REMOTE_HOST] });
      expect((await dispatch(id)).ok).toBe(true);
      expect(notify).not.toHaveBeenCalled();
    });

    it("says this computer can't enroll Hosts, or that it couldn't tell, once each", async () => {
      env.remote = true;
      listed(question("q1", { kind: "waiting", reason: "open" }));
      listHosts.mockResolvedValue({ result: "not-set-up", inboxHostIds: [] });
      const unset = await dispatch(id);
      expect(unset.ok ? null : unset.error.message).toMatch(/no Decisions relay identity/);
      expect(notify).toHaveBeenCalledTimes(1);

      listHosts.mockRejectedValue(new Error("link closed"));
      const unread = await dispatch(id);
      expect(unread.ok ? null : unread.error.message).toMatch(/couldn't tell.*link closed/);
      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify.mock.calls[1]![0].action.label).toBe("Try again");
      expect(opened()).toBe("none");
    });

    it.each([
      ["an agent", "agent", false],
      ["a caller that shows the failure itself", "user", true],
    ] as const)("tells %s through the dispatch's result alone", async (_who, source, reports) => {
      env.remote = true;
      hostsListed([], hostRow({ state: "not-enrolled" }));
      listed(question("q1", { kind: "waiting", reason: "open" }));
      const result = await dispatch(id, source, reports);
      expect(result.ok ? null : result.error.message).toMatch(/isn't enrolled/);
      expect(opened()).toBe("none");
      expect(notify).not.toHaveBeenCalled();
    });

    it("never asks main about Hosts in this computer's own windows", async () => {
      listed(question("q1", { kind: "waiting", reason: "open" }));
      await dispatch(id);
      expect(listHosts).not.toHaveBeenCalled();
    });

    it.each(["user", "keybinding", "agent"] as const)(
      "only opens its view when dispatched by %s, answering, declining and cancelling nothing",
      async (source) => {
        listed(question("q1", { kind: "waiting", reason: "open" }));
        expect((await dispatch(id, source)).ok).toBe(true);
        expect(opened()).toBe("inbox");
        for (const [name, write] of Object.entries(writes)) {
          expect(write, name).not.toHaveBeenCalled();
        }
      }
    );
  });

  describe("decisions.openInbox", () => {
    it("opens nothing in a Remote Host's window when Decisions is switched off while main is asked", async () => {
      env.remote = true;
      const answer = deferredHosts();
      const dispatched = dispatch("decisions.openInbox");
      await vi.waitFor(() => expect(listHosts).toHaveBeenCalledTimes(1));
      expect(opened()).toBe("none");
      env.switch = "off";
      answer.resolve({
        result: "listed",
        autoEnroll: true,
        hosts: [],
        inboxHostIds: [REMOTE_HOST],
      });
      expect((await dispatched).ok).toBe(true);
      expect(opened()).toBe("none");
      expect(notify).not.toHaveBeenCalled();
    });

    it("opens the inbox at no pane's question, and again while it is open", async () => {
      await dispatch("decisions.openInbox");
      const first = useDecisionsInboxStore.getState();
      expect(first.request.terminalId).toBeNull();

      await dispatch("decisions.openInbox");
      expect(useDecisionsInboxStore.getState().request.seq).toBeGreaterThan(first.request.seq);
    });
  });

  describe("decisions.openNextQuestion", () => {
    it("opens the inbox at the oldest question waiting on the person (#18047)", async () => {
      listed(
        question("settled", { kind: "settled", outcome: "answered", handled: false }),
        question("q1", { kind: "queued" }),
        question("typing", { kind: "to-type" }),
        question("q2", { kind: "waiting", reason: "open" }),
        question("stalled", { kind: "needs-attention", deliveryStatus: "needs-attention" })
      );
      expect((await dispatch("decisions.openNextQuestion")).ok).toBe(true);

      expect(opened()).toBe("inbox");
      const { request } = useDecisionsInboxStore.getState();
      expect(request.terminalId).toBeNull();
      expect(request.question).toEqual({
        terminalId: "t-q1",
        questionId: "q1",
        reference: { hostId: "local", projectId: "p1", terminalId: "t-q1", questionId: "q1" },
      });
    });

    it("shows its question in the inbox already open, in the same opening", async () => {
      useDecisionsInboxStore.getState().open();
      const opening = useDecisionsInboxStore.getState().request.seq;
      listed(question("q1", { kind: "waiting", reason: "open" }));
      await dispatch("decisions.openNextQuestion");
      expect(opened()).toBe("inbox");
      expect(useDecisionsInboxStore.getState().request).toMatchObject({
        seq: opening,
        question: { questionId: "q1" },
      });
    });

    it("starts at the oldest question not yet seen, never a cleared one (#17895)", async () => {
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
      expect(useDecisionsInboxStore.getState().request.question?.questionId).toBe("new");
    });

    it("opens a question seen and left when nothing new waits (#17895)", async () => {
      listed({
        ...question("seen", { kind: "waiting", reason: "open" }),
        inbox: { ask: null, seen: true, cleared: false },
      });
      await dispatch("decisions.openNextQuestion");
      expect(opened()).toBe("inbox");
      expect(useDecisionsInboxStore.getState().request.question?.questionId).toBe("seen");
    });

    it("opens an answered question at the follow-up asking for a reply", async () => {
      listed(question("q1", { kind: "waiting", reason: "reply" }, "m-7"));
      await dispatch("decisions.openNextQuestion");
      expect(useDecisionsInboxStore.getState().request.question?.threadMessageId).toBe("m-7");
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

    it("fails, opening nothing, when the list can't be read, and says so itself", async () => {
      listQuestions.mockRejectedValue(new Error("store closed"));
      expect((await dispatch("decisions.openNextQuestion")).ok).toBe(false);
      expect(opened()).toBe("none");
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]![0].message).toMatch(/store closed/);
      expect(notify.mock.calls[0]![0].action).toMatchObject({
        label: "Try again",
        actionId: "decisions.openNextQuestion",
      });
      expect(definition("decisions.openNextQuestion").selfNotifiesOnExecutionError).toBe(true);

      expect((await dispatch("decisions.openNextQuestion", "agent")).ok).toBe(false);
      expect((await dispatch("decisions.openNextQuestion", "user", true)).ok).toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("fails, saying so itself, when the bridge throws before it answers", async () => {
      listQuestions.mockImplementation(() => {
        throw new Error("bridge gone");
      });
      expect((await dispatch("decisions.openNextQuestion")).ok).toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]![0].message).toMatch(/bridge gone/);
    });

    it("asks whether the Host's questions are listed after reading the list, so a Host gone meanwhile opens nothing", async () => {
      env.remote = true;
      listed(question("q1", { kind: "waiting", reason: "open" }));
      hostsListed([], hostRow({ state: "revoked" }));
      expect((await dispatch("decisions.openNextQuestion")).ok).toBe(false);
      expect(listQuestions.mock.invocationCallOrder[0]!).toBeLessThan(
        listHosts.mock.invocationCallOrder[0]!
      );
      expect(opened()).toBe("none");
    });

    it("says a Host isn't in the inbox even when nothing waits", async () => {
      env.remote = true;
      listed();
      hostsListed([], hostRow({ state: "not-enrolled" }));
      expect((await dispatch("decisions.openNextQuestion")).ok).toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("opens nothing in a Remote Host's window when Decisions is switched off while main is asked", async () => {
      env.remote = true;
      listed(question("q1", { kind: "queued" }));
      const answer = deferredHosts();
      const dispatched = dispatch("decisions.openNextQuestion");
      await vi.waitFor(() => expect(listHosts).toHaveBeenCalledTimes(1));
      env.switch = "off";
      answer.resolve({
        result: "listed",
        autoEnroll: true,
        hosts: [],
        inboxHostIds: [REMOTE_HOST],
      });
      expect((await dispatched).ok).toBe(true);
      expect(opened()).toBe("none");
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
