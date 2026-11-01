// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DecisionsPolicy, DecisionsWorkflowGate } from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsPolicySection } from "../DecisionsPolicySection";
import { DecisionsQuestionsSection } from "../DecisionsQuestionsSection";
import { gateDescription, questionWaitText } from "../policyCopy";

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

function policy(overrides: Partial<DecisionsPolicy> = {}): DecisionsPolicy {
  return {
    gates: [REVIEW],
    proxyAllowlisted: false,
    defaultQuestionExpiryMs: 2 * 24 * 60 * 60_000,
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

function proxySwitch(): HTMLButtonElement {
  return screen.getByRole("switch", { name: /Allow proxy answers/ }) as HTMLButtonElement;
}

async function renderPolicy() {
  render(
    <TooltipProvider>
      <DecisionsPolicySection />
    </TooltipProvider>
  );
  await act(async () => {});
}

beforeEach(() => {
  getPolicy.mockReset();
  setProxyAllowlisted.mockReset();
  Object.defineProperty(window, "electron", {
    value: { decisions: { getPolicy, setProxyAllowlisted } },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("DecisionsPolicySection", () => {
  it("lists each registered gate read-only, with nothing to change it", async () => {
    getPolicy.mockResolvedValue(policy());
    await renderPolicy();

    const group = screen.getByRole("group", { name: "Workflow gates" });
    expect(group.textContent).toContain("design-review/final");
    expect(group.textContent).toContain(gateDescription(REVIEW));
    expect(group.querySelectorAll("button, input, [role='switch']")).toHaveLength(0);
  });

  it("keeps the proxy switch off and unusable until main says how it is set", async () => {
    const read = deferred<DecisionsPolicy>();
    getPolicy.mockReturnValue(read.promise);
    await renderPolicy();
    expect(proxySwitch().getAttribute("aria-checked")).toBe("false");
    expect(proxySwitch().disabled).toBe(true);

    await act(async () => read.resolve(policy({ proxyAllowlisted: true })));
    expect(proxySwitch().getAttribute("aria-checked")).toBe("true");
    expect(proxySwitch().disabled).toBe(false);
  });

  it("saves the allowlist in main and shows what main saved", async () => {
    getPolicy.mockResolvedValue(policy());
    const save = deferred<DecisionsPolicy>();
    setProxyAllowlisted.mockReturnValue(save.promise);
    await renderPolicy();

    fireEvent.click(proxySwitch());
    expect(setProxyAllowlisted).toHaveBeenCalledExactlyOnceWith(true);
    expect(proxySwitch().getAttribute("aria-checked")).toBe("true");
    expect(proxySwitch().disabled).toBe(true);
    // A second press while the first is saving asks for nothing more.
    fireEvent.click(proxySwitch());
    expect(setProxyAllowlisted).toHaveBeenCalledOnce();

    await act(async () => save.resolve(policy({ proxyAllowlisted: true })));
    expect(proxySwitch().getAttribute("aria-checked")).toBe("true");
    expect(proxySwitch().disabled).toBe(false);
  });

  it("shows main's value and a retry when a change fails", async () => {
    getPolicy.mockResolvedValue(policy());
    setProxyAllowlisted.mockRejectedValueOnce(new Error("Decisions is off, so nothing was changed"));
    await renderPolicy();

    await act(async () => {
      fireEvent.click(proxySwitch());
    });
    expect(screen.getByText("Couldn't allow proxy answers")).toBeTruthy();
    expect(proxySwitch().getAttribute("aria-checked")).toBe("false");

    setProxyAllowlisted.mockResolvedValueOnce(policy({ proxyAllowlisted: true }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(setProxyAllowlisted).toHaveBeenLastCalledWith(true);
    expect(proxySwitch().getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Couldn't allow proxy answers")).toBeNull();
  });

  it("drops a read that lands after a change main already answered", async () => {
    const late = deferred<DecisionsPolicy>();
    getPolicy.mockResolvedValueOnce(policy()).mockReturnValueOnce(late.promise);
    setProxyAllowlisted
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(policy({ proxyAllowlisted: true }));
    await renderPolicy();

    // The failure re-reads main; the retry is answered before that read is.
    await act(async () => {
      fireEvent.click(proxySwitch());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await act(async () => late.resolve(policy({ proxyAllowlisted: false })));
    expect(proxySwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("says when the policy couldn't be read, and reads it again on Retry", async () => {
    getPolicy.mockRejectedValueOnce(new Error("Turn on Decisions to read its policy"));
    await renderPolicy();
    expect(screen.getByText("Couldn't read who may answer")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Workflow gates" })).toBeNull();

    getPolicy.mockResolvedValueOnce(policy());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.queryByText("Couldn't read who may answer")).toBeNull();
    expect(screen.getByRole("group", { name: "Workflow gates" })).toBeTruthy();
  });
});

describe("DecisionsQuestionsSection", () => {
  it("says how long a question waits, as main reports it, and that expiry authorises nothing", async () => {
    getPolicy.mockResolvedValue(policy({ defaultQuestionExpiryMs: 36 * 60 * 60_000 }));
    const { container } = render(<DecisionsQuestionsSection />);
    expect(container.textContent).toBe("");
    await act(async () => {});
    const row = container.querySelector("#decisions-questions-expiry");
    expect(row?.textContent).toContain("waits 36 hours");
    expect(row?.textContent).toContain("authorises nothing");
  });
});

describe("policy copy", () => {
  it("names a span by the largest unit it fills", () => {
    expect(questionWaitText(7 * 24 * 60 * 60_000)).toBe("7 days");
    expect(questionWaitText(24 * 60 * 60_000)).toBe("1 day");
    expect(questionWaitText(36 * 60 * 60_000)).toBe("36 hours");
    expect(questionWaitText(90 * 60_000)).toBe("90 minutes");
    expect(questionWaitText(10_000)).toBe("1 minute");
  });

  it("describes a gate from what it registers", () => {
    expect(gateDescription(REVIEW)).toMatch(/^Only you can answer: Approve or Reject, and nothing else\. /);
    expect(gateDescription(REVIEW)).toContain("screenshots");
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
    expect(gateDescription(lenient)).toBe("A proxy may answer: A, B or C, with a note if you like.");
    expect(gateDescription({ ...lenient, choices: [] })).toBe("A proxy may answer.");
  });
});
