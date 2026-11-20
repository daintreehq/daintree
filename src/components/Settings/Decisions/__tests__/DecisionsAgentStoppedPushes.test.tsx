// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { DecisionsPolicy, DecisionsStatus } from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsQuestionsSection } from "../DecisionsQuestionsSection";
import { useDecisionsPolicy } from "../useDecisionsPolicy";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const setAgentStoppedPushes = vi.fn<(enabled: boolean) => Promise<DecisionsStatus>>();
const setHoldPhonePushes = vi.fn<(enabled: boolean) => Promise<DecisionsStatus>>();
const getStatus = vi.fn<() => Promise<DecisionsStatus>>();

/** The tab's part: the status main last showed, an answer applied, a failure read again. */
function Section({ initial, locked = false }: { initial: DecisionsStatus; locked?: boolean }) {
  const [status, setStatus] = useState(initial);
  const policy = useDecisionsPolicy(true);
  return (
    <TooltipProvider>
      <DecisionsQuestionsSection
        policy={policy}
        status={status}
        locked={locked}
        onChanged={(next) => {
          if (next) setStatus(next);
          else void getStatus().then(setStatus);
        }}
      />
    </TooltipProvider>
  );
}

async function renderSection(initial: DecisionsStatus, options: { locked?: boolean } = {}) {
  render(<Section initial={initial} locked={options.locked} />);
  await act(async () => {});
}

function stoppedSwitch(): HTMLButtonElement {
  return screen.getByRole("switch", {
    name: /Notify my phone when an agent stops/,
  }) as HTMLButtonElement;
}

function holdSwitch(): HTMLButtonElement {
  return screen.getByRole("switch", {
    name: /Hold phone notifications while I'm at this computer/,
  }) as HTMLButtonElement;
}

const on = () => stoppedSwitch().getAttribute("aria-checked");

function resetButton(): HTMLButtonElement | null {
  return screen.queryByRole("button", { name: "Stop notifying my phone when an agent stops" });
}

beforeEach(() => {
  setAgentStoppedPushes.mockReset();
  setHoldPhonePushes.mockReset();
  getStatus.mockReset();
  Object.defineProperty(window, "electron", {
    value: {
      decisions: {
        setAgentStoppedPushes,
        setHoldPhonePushes,
        getStatus,
        // The policy read, which these tests leave unanswered.
        getPolicy: () => new Promise<DecisionsPolicy>(() => {}),
      },
      events: { on: () => () => {} },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("Decisions agent-stopped pushes switch (#17319)", () => {
  it("is off by default, and says what reaches the phone and when", async () => {
    await renderSection({ state: "connected", consentedAt: 5 });
    expect(on()).toBe("false");
    expect(resetButton()).toBeNull();
    const described = (stoppedSwitch().getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    for (const promise of ["While you're away", "outside quiet hours", "never which one"]) {
      expect(described, promise).toContain(promise);
    }
  });

  it("turns on with one click, without a dialog, and off from its reset", async () => {
    setAgentStoppedPushes.mockResolvedValueOnce({
      state: "connected",
      agentStoppedPushes: true,
      revision: 1,
    });
    await renderSection({ state: "connected" });

    await act(async () => {
      fireEvent.click(stoppedSwitch());
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setAgentStoppedPushes).toHaveBeenCalledExactlyOnceWith(true);
    expect(on()).toBe("true");
    // The hold switch is its own setting.
    expect(setHoldPhonePushes).not.toHaveBeenCalled();
    expect(holdSwitch().getAttribute("aria-checked")).toBe("true");

    setAgentStoppedPushes.mockResolvedValueOnce({ state: "connected", revision: 2 });
    const reset = resetButton();
    expect(reset).not.toBeNull();
    await act(async () => {
      fireEvent.click(reset!);
    });
    expect(setAgentStoppedPushes).toHaveBeenLastCalledWith(false);
    expect(on()).toBe("false");
    expect(resetButton()).toBeNull();
  });

  it("saves independently of the hold switch: one saving leaves the other free", async () => {
    const saving = deferred<DecisionsStatus>();
    setAgentStoppedPushes.mockReturnValueOnce(saving.promise);
    setHoldPhonePushes.mockResolvedValueOnce({
      state: "connected",
      holdPhonePushes: false,
      revision: 1,
    });
    await renderSection({ state: "connected" });

    fireEvent.click(stoppedSwitch());
    expect(on()).toBe("true");
    expect(stoppedSwitch().disabled).toBe(true);
    fireEvent.click(stoppedSwitch());
    expect(setAgentStoppedPushes).toHaveBeenCalledTimes(1);
    expect(holdSwitch().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(holdSwitch());
    });
    expect(setHoldPhonePushes).toHaveBeenCalledExactlyOnceWith(false);

    await act(async () => {
      saving.resolve({
        state: "connected",
        holdPhonePushes: false,
        agentStoppedPushes: true,
        revision: 2,
      });
    });
    expect(on()).toBe("true");
  });

  it("shows a failed change with Retry, and reads the status again", async () => {
    setAgentStoppedPushes.mockRejectedValueOnce(new Error("Decisions has stopped"));
    getStatus.mockResolvedValue({ state: "connected", revision: 3 });
    await renderSection({ state: "connected" });

    await act(async () => {
      fireEvent.click(stoppedSwitch());
    });
    expect(
      screen.getByText("Couldn't turn on phone notifications when an agent stops")
    ).toBeTruthy();
    expect(screen.getByText("Decisions has stopped")).toBeTruthy();
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(on()).toBe("false");

    setAgentStoppedPushes.mockResolvedValueOnce({
      state: "connected",
      agentStoppedPushes: true,
      revision: 4,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(setAgentStoppedPushes).toHaveBeenLastCalledWith(true);
    expect(
      screen.queryByText("Couldn't turn on phone notifications when an agent stops")
    ).toBeNull();
    expect(on()).toBe("true");
  });

  it("changes nothing while the Decisions switch is changing", async () => {
    await renderSection({ state: "connected" }, { locked: true });
    fireEvent.click(stoppedSwitch());
    expect(setAgentStoppedPushes).not.toHaveBeenCalled();
    expect(on()).toBe("false");
  });
});
