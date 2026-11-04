// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type {
  DecisionsPolicy,
  DecisionsStatus,
  SetDecisionsTerminalSnapshotsPayload,
} from "@shared/types/decisions";
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

const setTerminalSnapshots =
  vi.fn<(payload: SetDecisionsTerminalSnapshotsPayload) => Promise<DecisionsStatus>>();
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

function snapshotsSwitch(): HTMLButtonElement {
  return screen.getByRole("switch", {
    name: /Show agent status and recent terminal lines on my phone/,
  }) as HTMLButtonElement;
}

const on = () => snapshotsSwitch().getAttribute("aria-checked");

/** Longer than a dialog's exit animation, so one that closed has left the DOM by then. */
const EXIT_ALLOWANCE_MS = 300;

/** A dialog plays its exit before it leaves the DOM. */
async function gone() {
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

beforeEach(() => {
  setTerminalSnapshots.mockReset();
  getStatus.mockReset();
  Object.defineProperty(window, "electron", {
    value: {
      decisions: {
        setTerminalSnapshots,
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

describe("Decisions terminal snapshots switch", () => {
  it("is off until turned on, and says what it sends before anything turns it on", async () => {
    setTerminalSnapshots.mockResolvedValue({
      state: "connected",
      terminalSnapshots: true,
      revision: 1,
    });
    await renderSection({ state: "connected", consentedAt: 5 });
    expect(on()).toBe("false");

    fireEvent.click(snapshotsSwitch());
    const dialog = screen.getByRole("dialog");
    for (const promise of [
      "the title of the pane that asked it",
      "the agent state Daintree observed there",
      "its last terminal lines",
      "While a question is open",
      "redacted on a best-effort basis",
      "end-to-end encrypted",
      "your relay",
      "Only the latest snapshot is kept, never a history",
    ]) {
      expect(dialog.textContent, promise).toContain(promise);
    }
    expect(setTerminalSnapshots).not.toHaveBeenCalled();
    expect(on()).toBe("false");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await gone();
    expect(setTerminalSnapshots).not.toHaveBeenCalled();
    expect(on()).toBe("false");

    fireEvent.click(snapshotsSwitch());
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: "Turn on snapshots" })
      );
    });
    expect(setTerminalSnapshots).toHaveBeenCalledExactlyOnceWith({ enabled: true, consent: true });
    expect(on()).toBe("true");
  });

  it("turns off without asking, and asks again the next time it turns on", async () => {
    setTerminalSnapshots.mockResolvedValue({ state: "connected", revision: 1 });
    await renderSection({ state: "connected", terminalSnapshots: true });
    expect(on()).toBe("true");

    await act(async () => {
      fireEvent.click(snapshotsSwitch());
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setTerminalSnapshots).toHaveBeenCalledExactlyOnceWith({ enabled: false });
    expect(on()).toBe("false");

    fireEvent.click(snapshotsSwitch());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(setTerminalSnapshots).toHaveBeenCalledTimes(1);
  });

  it("shows the change being saved and takes no other until main answers", async () => {
    const saving = deferred<DecisionsStatus>();
    setTerminalSnapshots.mockReturnValue(saving.promise);
    await renderSection({ state: "connected", terminalSnapshots: true });

    await act(async () => {
      fireEvent.click(snapshotsSwitch());
    });
    expect(on()).toBe("false");
    expect(snapshotsSwitch().disabled).toBe(true);
    fireEvent.click(snapshotsSwitch());
    expect(setTerminalSnapshots).toHaveBeenCalledTimes(1);

    await act(async () => saving.resolve({ state: "connected", revision: 1 }));
    expect(snapshotsSwitch().disabled).toBe(false);
    expect(on()).toBe("false");
  });

  it("keeps the agreement open and locked until main answers, then hands focus back to the switch", async () => {
    const saving = deferred<DecisionsStatus>();
    setTerminalSnapshots.mockReturnValue(saving.promise);
    await renderSection({ state: "connected" });

    snapshotsSwitch().focus();
    fireEvent.click(snapshotsSwitch());
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: "Turn on snapshots" })
      );
    });
    expect(setTerminalSnapshots).toHaveBeenCalledExactlyOnceWith({ enabled: true, consent: true });
    // Still open while main saves, past any exit animation, and Cancel can't
    // take back what's being saved.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXIT_ALLOWANCE_MS));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, EXIT_ALLOWANCE_MS));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(snapshotsSwitch().disabled).toBe(true);

    await act(async () =>
      saving.resolve({ state: "connected", terminalSnapshots: true, revision: 1 })
    );
    await gone();
    expect(on()).toBe("true");
    expect(snapshotsSwitch().disabled).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(snapshotsSwitch()));
  });

  it("can't change while the Decisions switch is changing", async () => {
    await renderSection({ state: "connected" }, { locked: true });
    expect(snapshotsSwitch().disabled).toBe(true);
    fireEvent.click(snapshotsSwitch());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setTerminalSnapshots).not.toHaveBeenCalled();
  });

  it("shows what main holds after a failed change, and retries the same change", async () => {
    setTerminalSnapshots.mockRejectedValueOnce(new Error("The settings file is read-only"));
    // The off was saved before main's queue even though the change failed.
    getStatus.mockResolvedValue({ state: "connected", revision: 2 });
    await renderSection({ state: "connected", terminalSnapshots: true });

    await act(async () => {
      fireEvent.click(snapshotsSwitch());
    });
    expect(screen.getByText("Couldn't turn off terminal snapshots")).toBeTruthy();
    expect(document.body.textContent).toContain("The settings file is read-only");
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(on()).toBe("false");

    setTerminalSnapshots.mockResolvedValue({ state: "connected", revision: 3 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(setTerminalSnapshots).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.queryByText("Couldn't turn off terminal snapshots")).toBeNull();
  });

  it("retries nothing while the Decisions switch is changing", async () => {
    setTerminalSnapshots.mockRejectedValueOnce(new Error("The settings file is read-only"));
    getStatus.mockResolvedValue({ state: "connected", terminalSnapshots: true, revision: 2 });
    const view = render(<Section initial={{ state: "connected", terminalSnapshots: true }} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(snapshotsSwitch());
    });
    expect(screen.getByText("Couldn't turn off terminal snapshots")).toBeTruthy();

    view.rerender(<Section initial={{ state: "connected", terminalSnapshots: true }} locked />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(setTerminalSnapshots).toHaveBeenCalledTimes(1);
  });
});
