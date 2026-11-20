// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { DecisionsPolicy, DecisionsWorkflowGate } from "@shared/types/decisions";
import { DEFAULT_QUESTION_EXPIRY_MS } from "@shared/config/decisionsQuestionExpiry";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsPolicySection } from "../DecisionsPolicySection";
import { DecisionsQuestionsSection } from "../DecisionsQuestionsSection";
import { useDecisionsPolicy } from "../useDecisionsPolicy";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import {
  UNGATED_QUESTION_TEXT,
  gateDescription,
  questionExpiryText,
  questionWaitText,
} from "../policyCopy";

const DAY = 24 * 60 * 60_000;

const REVIEW: DecisionsWorkflowGate = {
  id: "design-review/final",
  requirement: "human-required",
  choices: [
    { id: "approve", label: "Approve" },
    { id: "reject", label: "Reject" },
  ],
  allowsText: false,
  bindsAttachments: true,
};

const RELEASE: DecisionsWorkflowGate = {
  id: "release/ship",
  requirement: "human-required",
  choices: [],
  allowsText: true,
  bindsAttachments: false,
};

function policy(overrides: Partial<DecisionsPolicy> = {}): DecisionsPolicy {
  return {
    gates: [REVIEW],
    defaultQuestionExpiryMs: 2 * DAY,
    maxQuestionExpiryMs: 20 * DAY,
    askHumanAgents: [],
    revision: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const getPolicy = vi.fn<() => Promise<DecisionsPolicy>>();
const setDefaultQuestionExpiry = vi.fn<(ms: number | null) => Promise<DecisionsPolicy>>();
const setAgentAskHuman =
  vi.fn<(payload: { agentId: string; enabled: boolean }) => Promise<DecisionsPolicy>>();
const statusListeners = new Set<() => void>();

/** Main's status push, which another window's policy change sends. */
async function statusPushed() {
  await act(async () => {
    for (const listener of [...statusListeners]) listener();
  });
}

/** What the Decisions tab renders behind its switch: one read feeding both sections. */
function Sections({ active = true, onClose }: { active?: boolean; onClose?: SettingsTabClose }) {
  const read = useDecisionsPolicy(active);
  return (
    <TooltipProvider>
      <DecisionsQuestionsSection
        policy={read}
        status={{ state: "connected" }}
        locked={false}
        onChanged={() => {}}
        onClose={onClose}
      />
      <DecisionsPolicySection policy={read} />
    </TooltipProvider>
  );
}

async function renderSections(active = true) {
  const view = render(<Sections active={active} />);
  await act(async () => {});
  return view;
}

function ungatedRow(): string {
  return document.querySelector("#decisions-policy-ungated")?.textContent ?? "";
}

function expiryRow(): string {
  return document.querySelector("#decisions-questions-expiry")?.textContent ?? "";
}

function expirySelect(): HTMLButtonElement {
  return screen.getByRole("combobox", { name: "Default expiry" }) as HTMLButtonElement;
}

async function pickExpiry(label: string) {
  fireEvent.keyDown(expirySelect(), { key: "ArrowDown" });
  const option = await screen.findByRole("option", { name: label });
  await act(async () => {
    fireEvent.click(option);
  });
}

const resetExpiry = () => screen.queryByRole("button", { name: "Reset default expiry" });

beforeEach(() => {
  getPolicy.mockReset();
  setDefaultQuestionExpiry.mockReset();
  setAgentAskHuman.mockReset();
  statusListeners.clear();
  Object.defineProperty(window, "electron", {
    value: {
      decisions: { getPolicy, setDefaultQuestionExpiry, setAgentAskHuman },
      events: {
        on: (name: string, listener: () => void) => {
          if (name !== "decisions:status-changed") return () => {};
          statusListeners.add(listener);
          return () => statusListeners.delete(listener);
        },
      },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("Decisions policy and questions sections", () => {
  it("lists every registered gate read-only, with nothing to change one", async () => {
    getPolicy.mockResolvedValue(policy({ gates: [REVIEW, RELEASE] }));
    await renderSections();

    const group = screen.getByRole("group", { name: "Workflow gates" });
    for (const gate of [REVIEW, RELEASE]) {
      expect(group.textContent).toContain(gate.id);
      expect(group.textContent).toContain(gateDescription(gate));
    }
    expect(group.querySelectorAll("button, input, [role='switch']")).toHaveLength(0);
  });

  it("reads nothing while Decisions is off", async () => {
    await renderSections(false);
    expect(getPolicy).not.toHaveBeenCalled();
    expect(statusListeners.size).toBe(0);
    expect(ungatedRow()).toContain(UNGATED_QUESTION_TEXT);
  });

  // #18062: answering automatically is one choice, the decision model's, so
  // Policy offers no second switch for questions without a gate.
  it("offers no switch for questions without a gate, and says where answering automatically is chosen", async () => {
    getPolicy.mockResolvedValue(policy());
    await renderSections();

    const section = document.getElementById("decisions-policy")!;
    expect(
      section.querySelectorAll("button, [role='switch'], [role='combobox'], input")
    ).toHaveLength(0);
    expect(ungatedRow()).toContain(UNGATED_QUESTION_TEXT);
    expect(ungatedRow()).toContain("Decision model");
    expect(ungatedRow()).not.toContain("Allow proxy answers");
  });

  it("keeps Questions to what's always true until main says", async () => {
    const read = deferred<DecisionsPolicy>();
    getPolicy.mockReturnValue(read.promise);
    await renderSections();
    expect(expiryRow()).toContain("authorises nothing");
    expect(expiryRow()).not.toContain("waits");

    await act(async () => read.resolve(policy()));
    expect(expiryRow()).toContain("waits 2 days");
    expect(expiryRow()).toContain("at most 20 days");
  });

  it("follows another window's change when main pushes, and never goes back to an older read", async () => {
    getPolicy.mockResolvedValueOnce(policy({ revision: 2 }));
    await renderSections();
    expect(expiryRow()).toContain("waits 2 days");

    getPolicy.mockResolvedValueOnce(policy({ defaultQuestionExpiryMs: 60 * 60_000, revision: 3 }));
    await statusPushed();
    expect(expiryRow()).toContain("waits 1 hour");

    // A push whose read answers with an older revision changes nothing.
    getPolicy.mockResolvedValueOnce(policy({ revision: 1 }));
    await statusPushed();
    expect(expiryRow()).toContain("waits 1 hour");
  });

  it("saves a default expiry of never in main, shows it while saving, then what main saved", async () => {
    getPolicy.mockResolvedValue(
      policy({ defaultQuestionExpiryMs: DEFAULT_QUESTION_EXPIRY_MS, maxQuestionExpiryMs: 30 * DAY })
    );
    const save = deferred<DecisionsPolicy>();
    setDefaultQuestionExpiry.mockReturnValue(save.promise);
    await renderSections();
    expect(expirySelect().textContent).toBe("7 days");
    expect(resetExpiry()).toBeNull();

    await pickExpiry("Never");
    expect(setDefaultQuestionExpiry).toHaveBeenCalledExactlyOnceWith(null);
    expect(expirySelect().textContent).toBe("Never");
    expect(expirySelect().disabled).toBe(true);
    // The description stays on what main holds until it has saved the change.
    expect(expiryRow()).toContain("waits 7 days");

    await act(async () =>
      save.resolve(
        policy({ defaultQuestionExpiryMs: null, maxQuestionExpiryMs: null, revision: 1 })
      )
    );
    expect(expirySelect().textContent).toBe("Never");
    expect(expirySelect().disabled).toBe(false);
    expect(expiryRow()).toContain("until it's answered or cancelled");
    expect(expiryRow()).not.toContain("at most");
    expect(resetExpiry()).not.toBeNull();
  });

  it("puts the default expiry back to the library's default with Reset", async () => {
    getPolicy.mockResolvedValue(
      policy({ defaultQuestionExpiryMs: null, maxQuestionExpiryMs: null })
    );
    setDefaultQuestionExpiry.mockResolvedValue(
      policy({
        defaultQuestionExpiryMs: DEFAULT_QUESTION_EXPIRY_MS,
        maxQuestionExpiryMs: 30 * DAY,
        revision: 1,
      })
    );
    await renderSections();

    await act(async () => {
      fireEvent.click(resetExpiry()!);
    });
    expect(setDefaultQuestionExpiry).toHaveBeenCalledExactlyOnceWith(DEFAULT_QUESTION_EXPIRY_MS);
    expect(expirySelect().textContent).toBe("7 days");
    expect(resetExpiry()).toBeNull();
  });

  it("shows what main holds after a failed expiry change, and Retry asks for the same one", async () => {
    getPolicy.mockResolvedValueOnce(policy({ defaultQuestionExpiryMs: 3 * DAY }));
    const recovered = deferred<DecisionsPolicy>();
    getPolicy.mockReturnValueOnce(recovered.promise);
    setDefaultQuestionExpiry.mockRejectedValueOnce(new Error("Decisions has stopped"));
    await renderSections();

    await pickExpiry("90 days");
    expect(screen.getByText("Couldn't change the default expiry")).toBeTruthy();
    expect(expirySelect().disabled).toBe(false);
    expect(expirySelect().textContent).toBe("3 days");
    // Another window chose 30 days meanwhile: the recovery read shows that.
    await act(async () =>
      recovered.resolve(policy({ defaultQuestionExpiryMs: 30 * DAY, revision: 2 }))
    );
    expect(expirySelect().textContent).toBe("30 days");

    setDefaultQuestionExpiry.mockResolvedValueOnce(
      policy({ defaultQuestionExpiryMs: 90 * DAY, revision: 3 })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(setDefaultQuestionExpiry).toHaveBeenLastCalledWith(90 * DAY);
    expect(screen.queryByText("Couldn't change the default expiry")).toBeNull();
    expect(expirySelect().textContent).toBe("90 days");
  });

  it("says when the policy couldn't be read, in both sections, and one Retry recovers both", async () => {
    getPolicy.mockRejectedValueOnce(new Error("Turn on Decisions to read its policy"));
    await renderSections();
    expect(screen.getByText("Couldn't read who may answer")).toBeTruthy();
    expect(screen.getByText("Couldn't read how long questions wait")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Workflow gates" })).toBeNull();

    getPolicy.mockResolvedValueOnce(policy());
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);
    });
    expect(getPolicy).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Couldn't read who may answer")).toBeNull();
    expect(screen.queryByText("Couldn't read how long questions wait")).toBeNull();
    expect(screen.getByRole("group", { name: "Workflow gates" })).toBeTruthy();
    expect(expiryRow()).toContain("waits 2 days");
  });
});

describe("Questions → Inbox (#17231)", () => {
  beforeEach(() => {
    getPolicy.mockResolvedValue(policy());
  });

  afterEach(() => {
    useDecisionsInboxStore.setState({ isOpen: false });
  });

  it("opens the inbox, from Settings shown outside its dialog", async () => {
    render(<Sections />);
    await act(async () => {});
    const button = screen.getByRole("button", { name: "Open inbox" });
    // The row's description reaches the button, so it isn't read out alone.
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(described?.closest("#decisions-questions-inbox")).not.toBeNull();
    // The explanation, not the row's own label.
    expect(described?.textContent).not.toBe("Inbox");
    expect(described?.textContent).toMatch(/question/i);
    fireEvent.click(button);
    expect(useDecisionsInboxStore.getState().isOpen).toBe(true);
    expect(useDecisionsInboxStore.getState().request.terminalId).toBeNull();
  });

  it("closes Settings first, and opens nothing when Settings stays", async () => {
    const afterCloses: Array<(closed: boolean) => void> = [];
    const onClose = vi.fn<SettingsTabClose>(async (afterClose) => {
      if (afterClose) afterCloses.push(afterClose);
      return true;
    });
    render(<Sections onClose={onClose} />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("decisions-inbox-open"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(useDecisionsInboxStore.getState().isOpen).toBe(false);

    act(() => afterCloses[0]!(false));
    expect(useDecisionsInboxStore.getState().isOpen).toBe(false);

    fireEvent.click(screen.getByTestId("decisions-inbox-open"));
    act(() => afterCloses[1]!(true));
    expect(useDecisionsInboxStore.getState().isOpen).toBe(true);
  });
});

describe("useDecisionsPolicy", () => {
  it("keeps a save's answer over a read that main answered before the save landed", async () => {
    getPolicy.mockResolvedValueOnce(policy({ revision: 5 }));
    const { result } = renderHook(() => useDecisionsPolicy(true));
    await act(async () => {});

    const save = deferred<DecisionsPolicy>();
    setDefaultQuestionExpiry.mockReturnValueOnce(save.promise);
    const stale = deferred<DecisionsPolicy>();
    getPolicy.mockReturnValueOnce(stale.promise);
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.setDefaultQuestionExpiry(60 * 60_000);
    });
    let reloading!: Promise<void>;
    act(() => {
      reloading = result.current.reload();
    });
    await act(async () => {
      save.resolve(policy({ defaultQuestionExpiryMs: 60 * 60_000, revision: 6 }));
      await saving;
    });
    await act(async () => {
      stale.resolve(policy({ revision: 5 }));
      await reloading;
    });

    expect(result.current.policy?.defaultQuestionExpiryMs).toBe(60 * 60_000);
    expect(result.current.pendingExpiry).toBeNull();
  });

  it("lets go of a failed save even when the read after it fails too", async () => {
    getPolicy.mockResolvedValueOnce(policy());
    const { result } = renderHook(() => useDecisionsPolicy(true));
    await act(async () => {});

    setDefaultQuestionExpiry.mockRejectedValueOnce(new Error("busy"));
    getPolicy.mockRejectedValueOnce(new Error("gone"));
    await act(async () => {
      await result.current.setDefaultQuestionExpiry(60 * 60_000);
    });
    expect(result.current.pendingExpiry).toBeNull();
    expect(result.current.expirySaveFailure?.ms).toBe(60 * 60_000);
    // What it showed before stays: the read failed, nothing newer arrived.
    expect(result.current.policy?.defaultQuestionExpiryMs).toBe(2 * DAY);

    setDefaultQuestionExpiry.mockResolvedValueOnce(
      policy({ defaultQuestionExpiryMs: 60 * 60_000, revision: 1 })
    );
    await act(async () => {
      await result.current.setDefaultQuestionExpiry(60 * 60_000);
    });
    expect(result.current.policy?.defaultQuestionExpiryMs).toBe(60 * 60_000);
    expect(result.current.expirySaveFailure).toBeNull();
  });

  it("forgets what it read on turning off, and starts again from main on turning on", async () => {
    getPolicy.mockResolvedValueOnce(policy({ defaultQuestionExpiryMs: 30 * DAY, revision: 4 }));
    const { result, rerender } = renderHook(({ active }) => useDecisionsPolicy(active), {
      initialProps: { active: true },
    });
    await act(async () => {});
    expect(result.current.policy?.defaultQuestionExpiryMs).toBe(30 * DAY);

    // A save asked for just before turning off answers after it.
    const late = deferred<DecisionsPolicy>();
    setDefaultQuestionExpiry.mockReturnValueOnce(late.promise);
    act(() => {
      void result.current.setDefaultQuestionExpiry(60 * 60_000);
    });
    rerender({ active: false });
    expect(result.current.policy).toBeNull();

    getPolicy.mockRejectedValueOnce(new Error("Decisions has stopped"));
    rerender({ active: true });
    await act(async () =>
      late.resolve(policy({ defaultQuestionExpiryMs: 60 * 60_000, revision: 5 }))
    );
    expect(result.current.policy).toBeNull();
    expect(result.current.loadError).toContain("Decisions has stopped");
    // The late save still lets go, so the next one is asked.
    expect(result.current.pendingExpiry).toBeNull();
    // Main counts revisions again from its own start, below the 4 and 5 seen before.
    setDefaultQuestionExpiry.mockResolvedValueOnce(policy({ revision: 0 }));
    await act(async () => {
      await result.current.setDefaultQuestionExpiry(2 * DAY);
    });
    expect(result.current.policy?.defaultQuestionExpiryMs).toBe(2 * DAY);
    expect(setDefaultQuestionExpiry).toHaveBeenCalledTimes(2);

    // Main's answer after turning on is shown, though its revision is lower than anything seen before.
    getPolicy.mockResolvedValueOnce(policy({ defaultQuestionExpiryMs: 30 * DAY, revision: 0 }));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.policy?.defaultQuestionExpiryMs).toBe(30 * DAY);
    expect(result.current.loadError).toBeNull();
  });

  it("saves the expiry and an agent's switch side by side, and keeps both once main has", async () => {
    getPolicy.mockResolvedValueOnce(
      policy({ defaultQuestionExpiryMs: DEFAULT_QUESTION_EXPIRY_MS })
    );
    const { result } = renderHook(() => useDecisionsPolicy(true));
    await act(async () => {});

    const agentSave = deferred<DecisionsPolicy>();
    const expirySave = deferred<DecisionsPolicy>();
    setAgentAskHuman.mockReturnValueOnce(agentSave.promise);
    setDefaultQuestionExpiry.mockReturnValueOnce(expirySave.promise);
    act(() => {
      void result.current.setAgentAskHuman("claude", true);
      // A save of one field never holds up the other.
      void result.current.setDefaultQuestionExpiry(60 * 60_000);
    });
    expect(setAgentAskHuman).toHaveBeenCalledExactlyOnceWith({ agentId: "claude", enabled: true });
    expect(setDefaultQuestionExpiry).toHaveBeenCalledExactlyOnceWith(60 * 60_000);

    // Main applied the agent first, then the expiry over it, but the answers
    // land the other way round: the later revision holds both.
    await act(async () =>
      expirySave.resolve(
        policy({ askHumanAgents: ["claude"], defaultQuestionExpiryMs: 60 * 60_000, revision: 2 })
      )
    );
    expect(result.current.pendingExpiry).toBeNull();
    expect(result.current.pendingAgents.get("claude")).toBe(true);

    await act(async () =>
      agentSave.resolve(
        policy({
          askHumanAgents: ["claude"],
          defaultQuestionExpiryMs: DEFAULT_QUESTION_EXPIRY_MS,
          revision: 1,
        })
      )
    );
    expect(result.current.pendingAgents.size).toBe(0);
    // The older answer doesn't take the expiry back.
    expect(result.current.policy?.defaultQuestionExpiryMs).toBe(60 * 60_000);
    expect(result.current.policy?.askHumanAgents).toEqual(["claude"]);
  });

  it("drops an expiry save that answers after a turn off, and lets the next one go ahead", async () => {
    getPolicy.mockResolvedValueOnce(policy({ defaultQuestionExpiryMs: null, revision: 4 }));
    const { result, rerender } = renderHook(({ active }) => useDecisionsPolicy(active), {
      initialProps: { active: true },
    });
    await act(async () => {});

    const failing = deferred<DecisionsPolicy>();
    setDefaultQuestionExpiry.mockReturnValueOnce(failing.promise);
    act(() => {
      void result.current.setDefaultQuestionExpiry(60 * 60_000);
    });
    expect(result.current.pendingExpiry).toEqual({ ms: 60 * 60_000 });
    rerender({ active: false });

    getPolicy.mockResolvedValueOnce(policy({ defaultQuestionExpiryMs: 30 * DAY, revision: 0 }));
    rerender({ active: true });
    await act(async () => {});
    await act(async () => failing.reject(new Error("Decisions has stopped")));
    // From before the turn off: no failure shown, no read asked, and what main said since stays.
    expect(result.current.expirySaveFailure).toBeNull();
    expect(getPolicy).toHaveBeenCalledTimes(2);
    expect(result.current.policy?.defaultQuestionExpiryMs).toBe(30 * DAY);
    expect(result.current.pendingExpiry).toBeNull();

    const late = deferred<DecisionsPolicy>();
    setDefaultQuestionExpiry.mockReturnValueOnce(late.promise);
    act(() => {
      void result.current.setDefaultQuestionExpiry(90 * DAY);
    });
    rerender({ active: false });
    getPolicy.mockResolvedValueOnce(policy({ defaultQuestionExpiryMs: 30 * DAY, revision: 0 }));
    rerender({ active: true });
    await act(async () => {});
    await act(async () => late.resolve(policy({ defaultQuestionExpiryMs: 90 * DAY, revision: 9 })));
    expect(result.current.policy?.defaultQuestionExpiryMs).toBe(30 * DAY);
    expect(result.current.pendingExpiry).toBeNull();

    setDefaultQuestionExpiry.mockResolvedValueOnce(
      policy({ defaultQuestionExpiryMs: null, revision: 1 })
    );
    await act(async () => {
      await result.current.setDefaultQuestionExpiry(null);
    });
    expect(setDefaultQuestionExpiry).toHaveBeenCalledTimes(3);
    expect(result.current.policy?.defaultQuestionExpiryMs).toBeNull();
  });

  it("stops listening once off or unmounted", async () => {
    getPolicy.mockResolvedValue(policy());
    const { rerender, unmount } = renderHook(({ active }) => useDecisionsPolicy(active), {
      initialProps: { active: true },
    });
    await act(async () => {});
    expect(statusListeners.size).toBe(1);
    rerender({ active: false });
    expect(statusListeners.size).toBe(0);
    rerender({ active: true });
    expect(statusListeners.size).toBe(1);
    unmount();
    expect(statusListeners.size).toBe(0);
  });
});

describe("policy copy", () => {
  it("names a span by the largest unit it fills", () => {
    expect(questionWaitText(7 * DAY)).toBe("7 days");
    expect(questionWaitText(DAY)).toBe("1 day");
    expect(questionWaitText(36 * 60 * 60_000)).toBe("36 hours");
    expect(questionWaitText(90 * 60_000)).toBe("90 minutes");
    expect(questionWaitText(10_000)).toBe("1 minute");
  });

  it("says how long a question waits and how long its agent can make it, as main reports", () => {
    expect(
      questionExpiryText({ defaultQuestionExpiryMs: 2 * DAY, maxQuestionExpiryMs: 20 * DAY })
    ).toBe(
      "A question waits 2 days for your answer, unless the agent that asked sets another time, at most 20 days. Questions asked on a Remote Host still wait 7 days by default. An expired question authorises nothing, and the agent is told so."
    );
    const unbounded = questionExpiryText({
      defaultQuestionExpiryMs: null,
      maxQuestionExpiryMs: null,
    });
    expect(unbounded).toContain("until it's answered or cancelled");
    expect(unbounded).not.toContain("at most");
  });

  it("describes a gate from what it registers", () => {
    expect(gateDescription(REVIEW)).toMatch(
      /^Only you can answer: Approve or Reject, and nothing else\. /
    );
    expect(gateDescription(REVIEW)).toContain("your phone showed you exactly the ones attached");
    const lenient: DecisionsWorkflowGate = {
      id: "x/y",
      requirement: "proxy-ok",
      choices: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      allowsText: true,
      bindsAttachments: false,
    };
    expect(gateDescription(lenient)).toBe("A proxy may answer: A, B or C, with a note if you like");
    expect(gateDescription({ ...lenient, choices: [] })).toBe("A proxy may answer");
  });
});
