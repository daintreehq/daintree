// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  DecisionsSetupCheckRun,
  DecisionsSetupCheckStartResult,
  DecisionsSetupCheckSteps,
  DecisionsStatus,
} from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsSetupCheck } from "../DecisionsSetupCheck";
import { useSetupCheck } from "../useSetupCheck";

const ORIGIN = "https://decisions.example.workers.dev";

const bridge = {
  getSetupCheck: vi.fn<() => Promise<DecisionsSetupCheckRun | null>>(),
  startSetupCheck: vi.fn<() => Promise<DecisionsSetupCheckStartResult>>(),
  cancelSetupCheck: vi.fn<(payload: { runId: string }) => Promise<DecisionsSetupCheckRun | null>>(),
};
const pushes = new Set<(run: DecisionsSetupCheckRun) => void>();

function steps(overrides: Partial<DecisionsSetupCheckSteps> = {}): DecisionsSetupCheckSteps {
  return {
    relay: { state: "waiting" },
    claim: { state: "waiting" },
    socket: { state: "waiting" },
    push: { state: "waiting" },
    attachment: { state: "waiting" },
    question: { state: "waiting" },
    ...overrides,
  };
}

function run(over: Partial<DecisionsSetupCheckRun> = {}): DecisionsSetupCheckRun {
  return {
    runId: "run-1",
    revision: 1,
    state: "running",
    startedAt: 1,
    steps: steps(),
    diagnostic: null,
    ...over,
  };
}

function push(next: DecisionsSetupCheckRun): void {
  act(() => {
    for (const listener of pushes) listener(next);
  });
}

function Check({ status }: { status: DecisionsStatus }) {
  const check = useSetupCheck(status.relayOrigin);
  return <DecisionsSetupCheck check={check} status={status} disabled={false} />;
}

function renderCheck(status: DecisionsStatus = { state: "connected", relayOrigin: ORIGIN }) {
  return render(
    <TooltipProvider>
      <Check status={status} />
    </TooltipProvider>
  );
}

/** What one step's row says. */
function stepRow(step: string): string {
  return document.getElementById(`decisions-setup-check-${step}`)?.textContent ?? "";
}

async function settle(): Promise<void> {
  await act(async () => {});
}

describe("DecisionsSetupCheck", () => {
  beforeEach(() => {
    pushes.clear();
    bridge.getSetupCheck.mockReset().mockResolvedValue(null);
    bridge.startSetupCheck.mockReset();
    bridge.cancelSetupCheck.mockReset().mockResolvedValue(null);
    Object.defineProperty(window, "electron", {
      value: {
        decisions: bridge,
        events: {
          on: (name: string, listener: (run: DecisionsSetupCheckRun) => void) => {
            if (name !== "decisions:setup-check-changed") return () => {};
            pushes.add(listener);
            return () => pushes.delete(listener);
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

  it("starts a check when asked, and shows each step as main reports it", async () => {
    const started = run({ steps: steps({ relay: { state: "running" } }) });
    bridge.startSetupCheck.mockResolvedValue({ result: "started", run: started });
    renderCheck();
    await settle();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    });

    expect(bridge.startSetupCheck).toHaveBeenCalledOnce();
    expect(stepRow("relay")).toMatch(/Reading the relay's \/health/);
    expect(screen.getByRole("button", { name: "Cancel check" })).toBeTruthy();

    push(
      run({
        revision: 2,
        steps: steps({
          relay: { state: "passed", observation: { result: "unexpected" } },
          claim: { state: "passed", observation: { result: "recognised" } },
          socket: { state: "running" },
        }),
      })
    );
    expect(stepRow("claim")).toMatch(/lists this computer as its owner/);
    expect(stepRow("socket")).toMatch(/Opening a socket with a new ticket/);
  });

  it("shows the diagnostic terminal while the run holds it open, and what was typed into it", async () => {
    bridge.getSetupCheck.mockResolvedValue(
      run({
        steps: steps({ question: { state: "running" } }),
        diagnostic: { title: "Decisions setup check · runs no agent", screen: "" },
      })
    );
    renderCheck();
    await settle();

    const log = screen.getByRole("log");
    expect(log.textContent).toBe("Waiting for an answer from your phone…");
    expect(screen.getByText("Decisions setup check · runs no agent")).toBeTruthy();

    push(
      run({
        revision: 5,
        steps: steps({ question: { state: "running" } }),
        diagnostic: {
          title: "Decisions setup check · runs no agent",
          screen: "[DAINTREE DECISION ANSWER]\nchoice_label: Received",
        },
      })
    );
    expect(screen.getByRole("log").textContent).toContain("choice_label: Received");

    // The run ended: the terminal closes with it.
    push(
      run({
        revision: 6,
        state: "passed",
        steps: steps({
          question: { state: "passed", observation: { result: "typed", text: "typed" } },
        }),
        diagnostic: null,
      })
    );
    expect(screen.queryByRole("log")).toBeNull();
    expect(screen.getByText(/was typed into the diagnostic terminal/)).toBeTruthy();
  });

  it("keeps the newest run when a read lands after a push", async () => {
    let answer!: (value: DecisionsSetupCheckRun | null) => void;
    bridge.getSetupCheck.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    renderCheck();

    push(run({ revision: 4, state: "failed" }));
    await act(async () => {
      answer(run({ revision: 3, state: "running" }));
    });

    expect(screen.queryByRole("button", { name: "Cancel check" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("cancels the run it shows by its id, and nothing more once it has ended", async () => {
    const started = run({ steps: steps({ relay: { state: "running" } }) });
    bridge.startSetupCheck.mockResolvedValue({ result: "started", run: started });
    bridge.cancelSetupCheck.mockResolvedValue(run({ revision: 2, state: "cancelled" }));
    const { unmount } = renderCheck();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel check" }));
    });
    expect(bridge.cancelSetupCheck).toHaveBeenCalledExactlyOnceWith({ runId: "run-1" });
    expect(screen.getByText(/was cancelled, so it recorded nothing/)).toBeTruthy();

    unmount();
    expect(bridge.cancelSetupCheck).toHaveBeenCalledOnce();
  });

  it("calls off a run it started when Settings closes", async () => {
    bridge.startSetupCheck.mockResolvedValue({ result: "started", run: run() });
    const { unmount } = renderCheck();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    });

    unmount();

    expect(bridge.cancelSetupCheck).toHaveBeenCalledExactlyOnceWith({ runId: "run-1" });
  });

  it("calls off a run whose start was still on its way when Settings closed", async () => {
    let answer!: (result: DecisionsSetupCheckStartResult) => void;
    bridge.startSetupCheck.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const { unmount } = renderCheck();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    });

    unmount();
    expect(bridge.cancelSetupCheck).not.toHaveBeenCalled();
    await act(async () => {
      answer({ result: "started", run: run({ runId: "run-late" }) });
    });

    expect(bridge.cancelSetupCheck).toHaveBeenCalledExactlyOnceWith({ runId: "run-late" });
  });

  it("only shows a run another window started, and leaves it running when this one closes", async () => {
    bridge.startSetupCheck.mockResolvedValue({
      result: "running",
      run: run({ runId: "run-elsewhere" }),
    });
    const { unmount } = renderCheck();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    });
    expect(screen.getByRole("button", { name: "Cancel check" })).toBeTruthy();

    unmount();

    expect(bridge.cancelSetupCheck).not.toHaveBeenCalled();
  });

  it("drops what a relay's read said once another relay is set up", async () => {
    let answer!: (value: DecisionsSetupCheckRun | null) => void;
    bridge.getSetupCheck.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const { rerender } = renderCheck();
    rerender(
      <TooltipProvider>
        <Check status={{ state: "connected", relayOrigin: "https://other.example.workers.dev" }} />
      </TooltipProvider>
    );
    await settle();

    await act(async () => {
      answer(run({ revision: 9, state: "failed" }));
    });

    expect(screen.getByRole("button", { name: "Check setup" })).toBeTruthy();
    expect(screen.queryByText(/Not run yet/)).toBeNull();
  });

  it("forgets a run when its relay goes and the same relay is set up again with none running", async () => {
    bridge.getSetupCheck.mockResolvedValueOnce(run({ revision: 2 }));
    const { rerender } = renderCheck();
    await settle();
    expect(screen.getByRole("button", { name: "Cancel check" })).toBeTruthy();

    const at = (status: DecisionsStatus) =>
      rerender(
        <TooltipProvider>
          <Check status={status} />
        </TooltipProvider>
      );
    at({ state: "not-connected" });
    await settle();
    bridge.getSetupCheck.mockResolvedValueOnce(null);
    at({ state: "connected", relayOrigin: ORIGIN });
    await settle();

    expect(screen.queryByRole("button", { name: "Cancel check" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check setup" })).toBeTruthy();
  });

  it("clears a run main no longer has when cancelling it", async () => {
    bridge.getSetupCheck.mockResolvedValue(run());
    bridge.cancelSetupCheck.mockResolvedValue(null);
    renderCheck();
    await settle();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel check" }));
    });

    expect(screen.getByRole("button", { name: "Check setup" })).toBeTruthy();
  });

  it("reads nothing while no relay is set up", async () => {
    render(
      <TooltipProvider>
        <Check status={{ state: "not-connected" }} />
      </TooltipProvider>
    );
    await settle();

    expect(bridge.getSetupCheck).not.toHaveBeenCalled();
    expect(pushes.size).toBe(0);
  });

  it("announces the step under way, and how the run ended", async () => {
    bridge.getSetupCheck.mockResolvedValue(
      run({
        steps: steps({
          relay: { state: "passed", observation: { result: "unexpected" } },
          claim: { state: "running" },
        }),
      })
    );
    renderCheck();
    await settle();

    const status = () =>
      screen
        .getAllByRole("status")
        .map((region) => region.textContent ?? "")
        .join(" | ");
    expect(status()).toContain("Claim. Asking the relay which devices it accepts…");

    push(
      run({
        revision: 3,
        state: "failed",
        steps: steps({ push: { state: "failed", observation: { result: "no-phone" } } }),
      })
    );
    expect(status()).toContain("Setup check stopped at push configuration. No phone is paired.");
  });

  it("says when the last recorded check passed or where it stopped, before any run this session", async () => {
    const checkedAt = Date.UTC(2026, 10, 1, 9, 30);
    const when = new Date(checkedAt).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const { unmount } = renderCheck({
      state: "connected",
      relayOrigin: ORIGIN,
      setupCheck: { checkedAt, failedStep: "push" },
    });
    await settle();

    expect(screen.getByText(`The check on ${when} stopped at push configuration`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    unmount();

    renderCheck({
      state: "connected",
      relayOrigin: ORIGIN,
      setupCheck: { checkedAt, failedStep: null },
    });
    await settle();
    expect(screen.getByText(`Every step passed on ${when}`)).toBeTruthy();
  });

  it("says why a check couldn't start", async () => {
    bridge.startSetupCheck.mockResolvedValue({ result: "revoked" });
    renderCheck();
    await settle();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    });

    expect(screen.getByText(/revoked this computer/)).toBeTruthy();
  });
});
