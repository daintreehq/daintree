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
  cancelSetupCheck: vi.fn<() => Promise<DecisionsSetupCheckRun | null>>(),
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

function Check({ status, active = true }: { status: DecisionsStatus; active?: boolean }) {
  const check = useSetupCheck(active);
  return <DecisionsSetupCheck check={check} status={status} disabled={false} />;
}

function renderCheck(status: DecisionsStatus = { state: "connected", relayOrigin: ORIGIN }) {
  return render(
    <TooltipProvider>
      <Check status={status} />
    </TooltipProvider>
  );
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
    expect(screen.getByText(/Reading the relay's \/health/)).toBeTruthy();
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
    expect(screen.getByText(/lists this computer as its owner/)).toBeTruthy();
    expect(screen.getByText(/Opening a socket with a new ticket/)).toBeTruthy();
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

  it("cancels the run when asked, and a run it started when Settings closes", async () => {
    const started = run({ steps: steps({ relay: { state: "running" } }) });
    bridge.startSetupCheck.mockResolvedValue({ result: "started", run: started });
    const { unmount } = renderCheck();
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel check" }));
    });
    expect(bridge.cancelSetupCheck).toHaveBeenCalledOnce();

    unmount();
    expect(bridge.cancelSetupCheck).toHaveBeenCalledTimes(2);
  });

  it("leaves a run another window started running when this one closes", async () => {
    bridge.getSetupCheck.mockResolvedValue(run({ runId: "run-elsewhere" }));
    const { unmount } = renderCheck();
    await settle();

    unmount();

    expect(bridge.cancelSetupCheck).not.toHaveBeenCalled();
  });

  it("reads nothing while no relay is set up", async () => {
    render(
      <TooltipProvider>
        <Check status={{ state: "not-connected" }} active={false} />
      </TooltipProvider>
    );
    await settle();

    expect(bridge.getSetupCheck).not.toHaveBeenCalled();
    expect(pushes.size).toBe(0);
  });

  it("says when the last recorded check passed or where it stopped, before any run this session", async () => {
    renderCheck({
      state: "connected",
      relayOrigin: ORIGIN,
      setupCheck: { checkedAt: Date.UTC(2026, 10, 1, 9, 30), failedStep: "push" },
    });
    await settle();

    expect(screen.getByText(/stopped at push configuration/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
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
