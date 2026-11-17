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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

function holdSwitch(): HTMLButtonElement {
  return screen.getByRole("switch", {
    name: /Hold phone notifications while I'm at this computer/,
  }) as HTMLButtonElement;
}

const on = () => holdSwitch().getAttribute("aria-checked");

function resetButton(): HTMLButtonElement | null {
  return screen.queryByRole("button", { name: "Hold phone notifications again" });
}

beforeEach(() => {
  setHoldPhonePushes.mockReset();
  getStatus.mockReset();
  Object.defineProperty(window, "electron", {
    value: {
      decisions: {
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

describe("Decisions hold phone pushes switch (#17240)", () => {
  it("is on by default, and says what it tells the relay and when", async () => {
    await renderSection({ state: "connected", consentedAt: 5 });
    expect(on()).toBe("true");
    expect(resetButton()).toBeNull();
    const described = (holdSwitch().getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    for (const promise of [
      "While desktop notifications are on",
      "tells your relay whether you're here",
      "up to two minutes",
    ]) {
      expect(described, promise).toContain(promise);
    }
  });

  it("turns off without asking, and back on from the switch or its reset", async () => {
    setHoldPhonePushes.mockResolvedValueOnce({
      state: "connected",
      holdPhonePushes: false,
      revision: 1,
    });
    await renderSection({ state: "connected" });

    await act(async () => {
      fireEvent.click(holdSwitch());
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setHoldPhonePushes).toHaveBeenCalledExactlyOnceWith(false);
    expect(on()).toBe("false");

    setHoldPhonePushes.mockResolvedValueOnce({ state: "connected", revision: 2 });
    const reset = resetButton();
    expect(reset).not.toBeNull();
    await act(async () => {
      fireEvent.click(reset!);
    });
    expect(setHoldPhonePushes).toHaveBeenLastCalledWith(true);
    expect(on()).toBe("true");
    expect(resetButton()).toBeNull();
  });

  it("shows the change being saved and takes no other until main answers", async () => {
    const saving = deferred<DecisionsStatus>();
    setHoldPhonePushes.mockReturnValueOnce(saving.promise);
    await renderSection({ state: "connected" });

    fireEvent.click(holdSwitch());
    expect(on()).toBe("false");
    expect(holdSwitch().disabled).toBe(true);
    fireEvent.click(holdSwitch());
    expect(setHoldPhonePushes).toHaveBeenCalledTimes(1);

    await act(async () => {
      saving.resolve({ state: "connected", holdPhonePushes: false, revision: 1 });
    });
    expect(on()).toBe("false");
  });

  it("shows a failed change with Retry, and reads the status again", async () => {
    setHoldPhonePushes.mockRejectedValueOnce(new Error("The relay connection is busy"));
    getStatus.mockResolvedValue({ state: "connected", holdPhonePushes: false, revision: 3 });
    await renderSection({ state: "connected" });

    await act(async () => {
      fireEvent.click(holdSwitch());
    });
    expect(screen.getByText("Couldn't turn off holding phone notifications")).toBeTruthy();
    expect(screen.getByText("The relay connection is busy")).toBeTruthy();
    expect(getStatus).toHaveBeenCalledTimes(1);
    // The off was saved before main's queue, so the status read again shows it.
    expect(on()).toBe("false");

    setHoldPhonePushes.mockResolvedValueOnce({
      state: "connected",
      holdPhonePushes: false,
      revision: 4,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(setHoldPhonePushes).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText("Couldn't turn off holding phone notifications")).toBeNull();
  });

  it("changes nothing while the Decisions switch is changing", async () => {
    await renderSection({ state: "connected" }, { locked: true });
    fireEvent.click(holdSwitch());
    expect(setHoldPhonePushes).not.toHaveBeenCalled();
    expect(on()).toBe("true");
  });
});
