// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { DecisionsPolicy, DecisionsWorkflowGate } from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsPolicySection } from "../DecisionsPolicySection";
import { DecisionsQuestionsSection } from "../DecisionsQuestionsSection";
import { useDecisionsPolicy } from "../useDecisionsPolicy";
import {
  gateDescription,
  proxyAllowlistText,
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
    proxyAllowlisted: false,
    defaultQuestionExpiryMs: 2 * DAY,
    maxQuestionExpiryMs: 20 * DAY,
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
const setProxyAllowlisted = vi.fn<(allowed: boolean) => Promise<DecisionsPolicy>>();
const statusListeners = new Set<() => void>();

/** Main's status push, which another window's policy change sends. */
async function statusPushed() {
  await act(async () => {
    for (const listener of [...statusListeners]) listener();
  });
}

/** What the Decisions tab renders behind its switch: one read feeding both sections. */
function Sections({ active = true }: { active?: boolean }) {
  const read = useDecisionsPolicy(active);
  return (
    <TooltipProvider>
      <DecisionsQuestionsSection policy={read} />
      <DecisionsPolicySection policy={read} />
    </TooltipProvider>
  );
}

async function renderSections(active = true) {
  const view = render(<Sections active={active} />);
  await act(async () => {});
  return view;
}

function proxySwitch(): HTMLButtonElement {
  return screen.getByRole("switch", { name: /Allow proxy answers/ }) as HTMLButtonElement;
}

function checked(): string | null {
  return proxySwitch().getAttribute("aria-checked");
}

function expiryRow(): string {
  return document.querySelector("#decisions-questions-expiry")?.textContent ?? "";
}

beforeEach(() => {
  getPolicy.mockReset();
  setProxyAllowlisted.mockReset();
  statusListeners.clear();
  Object.defineProperty(window, "electron", {
    value: {
      decisions: { getPolicy, setProxyAllowlisted },
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
    expect(checked()).toBe("false");
    expect(proxySwitch().disabled).toBe(true);
  });

  it("keeps the switch off and unusable, and Questions to what's always true, until main says", async () => {
    const read = deferred<DecisionsPolicy>();
    getPolicy.mockReturnValue(read.promise);
    await renderSections();
    expect(checked()).toBe("false");
    expect(proxySwitch().disabled).toBe(true);
    expect(expiryRow()).toContain("authorises nothing");
    expect(expiryRow()).not.toContain("waits");

    await act(async () => read.resolve(policy({ proxyAllowlisted: true })));
    expect(checked()).toBe("true");
    expect(proxySwitch().disabled).toBe(false);
    expect(expiryRow()).toContain("waits 2 days");
    expect(expiryRow()).toContain("at most 20 days");
  });

  it("saves the allowlist in main, shows what was asked meanwhile, then what main saved", async () => {
    getPolicy.mockResolvedValue(policy());
    const save = deferred<DecisionsPolicy>();
    setProxyAllowlisted.mockReturnValue(save.promise);
    await renderSections();

    fireEvent.click(proxySwitch());
    expect(setProxyAllowlisted).toHaveBeenCalledExactlyOnceWith(true);
    expect(checked()).toBe("true");
    expect(proxySwitch().disabled).toBe(true);
    // A second press while the first is saving asks for nothing more.
    fireEvent.click(proxySwitch());
    expect(setProxyAllowlisted).toHaveBeenCalledOnce();

    await act(async () => save.resolve(policy({ proxyAllowlisted: true, revision: 1 })));
    expect(checked()).toBe("true");
    expect(proxySwitch().disabled).toBe(false);
  });

  it("puts the allowlist back to off with Reset, and shows it unmodified after", async () => {
    getPolicy.mockResolvedValue(policy({ proxyAllowlisted: true }));
    setProxyAllowlisted.mockResolvedValue(policy({ proxyAllowlisted: false, revision: 1 }));
    await renderSections();

    const reset = screen.getByRole("button", { name: /Reset Allow proxy answers/ });
    await act(async () => {
      fireEvent.click(reset);
    });
    expect(setProxyAllowlisted).toHaveBeenCalledExactlyOnceWith(false);
    expect(checked()).toBe("false");
    expect(screen.queryByRole("button", { name: /Reset Allow proxy answers/ })).toBeNull();
  });

  it("shows what main holds after a failed change, and Retry asks again", async () => {
    getPolicy.mockResolvedValueOnce(policy());
    const recovered = deferred<DecisionsPolicy>();
    getPolicy.mockReturnValueOnce(recovered.promise);
    setProxyAllowlisted.mockRejectedValueOnce(new Error("Decisions has stopped"));
    await renderSections();

    await act(async () => {
      fireEvent.click(proxySwitch());
    });
    expect(screen.getByText("Couldn't allow proxy answers")).toBeTruthy();
    expect(proxySwitch().disabled).toBe(false);
    // Main had it on all along (another window): the recovery read shows that.
    await act(async () => recovered.resolve(policy({ proxyAllowlisted: true, revision: 3 })));
    expect(checked()).toBe("true");

    setProxyAllowlisted.mockResolvedValueOnce(policy({ proxyAllowlisted: true, revision: 4 }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(setProxyAllowlisted).toHaveBeenLastCalledWith(true);
    expect(screen.queryByText("Couldn't allow proxy answers")).toBeNull();
  });

  it("follows another window's change when main pushes, and never goes back to an older read", async () => {
    getPolicy.mockResolvedValueOnce(policy({ revision: 2 }));
    await renderSections();
    expect(checked()).toBe("false");

    getPolicy.mockResolvedValueOnce(policy({ proxyAllowlisted: true, revision: 3 }));
    await statusPushed();
    expect(checked()).toBe("true");

    // A push whose read answers with an older revision changes nothing.
    getPolicy.mockResolvedValueOnce(policy({ proxyAllowlisted: false, revision: 1 }));
    await statusPushed();
    expect(checked()).toBe("true");
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

describe("useDecisionsPolicy", () => {
  it("keeps a save's answer over a read that main answered before the save landed", async () => {
    getPolicy.mockResolvedValueOnce(policy({ revision: 5 }));
    const { result } = renderHook(() => useDecisionsPolicy(true));
    await act(async () => {});

    const save = deferred<DecisionsPolicy>();
    setProxyAllowlisted.mockReturnValueOnce(save.promise);
    const stale = deferred<DecisionsPolicy>();
    getPolicy.mockReturnValueOnce(stale.promise);
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.setProxyAllowlisted(true);
    });
    let reloading!: Promise<void>;
    act(() => {
      reloading = result.current.reload();
    });
    await act(async () => {
      save.resolve(policy({ proxyAllowlisted: true, revision: 6 }));
      await saving;
    });
    await act(async () => {
      stale.resolve(policy({ proxyAllowlisted: false, revision: 5 }));
      await reloading;
    });

    expect(result.current.policy?.proxyAllowlisted).toBe(true);
    expect(result.current.pending).toBeNull();
  });

  it("lets go of a failed save even when the read after it fails too", async () => {
    getPolicy.mockResolvedValueOnce(policy());
    const { result } = renderHook(() => useDecisionsPolicy(true));
    await act(async () => {});

    setProxyAllowlisted.mockRejectedValueOnce(new Error("busy"));
    getPolicy.mockRejectedValueOnce(new Error("gone"));
    await act(async () => {
      await result.current.setProxyAllowlisted(true);
    });
    expect(result.current.pending).toBeNull();
    expect(result.current.saveFailure?.allowed).toBe(true);
    // What it showed before stays: the read failed, nothing newer arrived.
    expect(result.current.policy?.proxyAllowlisted).toBe(false);

    setProxyAllowlisted.mockResolvedValueOnce(policy({ proxyAllowlisted: true, revision: 1 }));
    await act(async () => {
      await result.current.setProxyAllowlisted(true);
    });
    expect(result.current.policy?.proxyAllowlisted).toBe(true);
    expect(result.current.saveFailure).toBeNull();
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
      "A question waits 2 days for your answer, unless the agent that asked sets another time, at most 20 days. An expired question authorises nothing, and the agent is told so."
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
    expect(gateDescription(lenient)).toBe(
      "A proxy may answer: A, B or C, with a note if you like."
    );
    expect(gateDescription({ ...lenient, choices: [] })).toBe("A proxy may answer.");
  });

  it("names the gates that still need the person, and only those", () => {
    const lenient = { ...RELEASE, id: "x/y", requirement: "proxy-ok" as const };
    expect(proxyAllowlistText([REVIEW])).toContain(
      "(design-review/final) still needs your own answer"
    );
    expect(proxyAllowlistText([REVIEW, lenient])).toContain(
      "under design-review/final still needs your own answer"
    );
    expect(proxyAllowlistText([REVIEW, lenient])).not.toContain("x/y");
    expect(proxyAllowlistText([lenient])).toContain("follows that gate's rule");
    for (const gates of [[], [REVIEW]]) {
      expect(proxyAllowlistText(gates)).toContain("No decision model is connected yet");
    }
  });
});
