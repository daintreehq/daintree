// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBanner } from "../ErrorBanner";
import type { ErrorRecord } from "@/store/errorStore";
import { useErrorStore } from "@/store/errorStore";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";

const mockDispatch = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => mockDispatch(...args),
  },
}));

function makeError(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    id: "err-1",
    timestamp: Date.now(),
    type: "unknown",
    message: "Something failed",
    retryability: "none",
    dismissed: false,
    ...overrides,
  };
}

const retryable = { retryability: "auto", retryAction: "git" } as const;

describe("ErrorBanner", () => {
  const onDismiss = vi.fn();

  afterEach(() => {
    useDiagnosticsStore.getState().reset();
    onDismiss.mockClear();
  });

  describe("what the row says", () => {
    it("leads with the message and puts the hint beneath it", () => {
      render(
        <ErrorBanner
          error={makeError({ message: "Git push failed", recoveryHint: "Try pulling first" })}
          onDismiss={onDismiss}
        />
      );
      const message = screen.getByText("Git push failed");
      const hint = screen.getByText("Try pulling first");
      expect(message.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    // Severity is carried by the band and the glyph. Type coloured by severity,
    // or faded with a slash alpha, fell under 4.5:1 on every theme sampled.
    it("colours no text by severity and fades none with an alpha", () => {
      const { container } = render(
        <ErrorBanner
          error={makeError({ ...retryable, recoveryHint: "Check your network" })}
          onDismiss={onDismiss}
          onRetry={vi.fn()}
        />
      );
      for (const el of container.querySelectorAll<HTMLElement>("*")) {
        const cls = el.getAttribute("class") ?? "";
        expect(cls, el.outerHTML.slice(0, 120)).not.toMatch(/(^|\s)text-status-/);
        expect(cls, el.outerHTML.slice(0, 120)).not.toMatch(/(^|\s)text-[a-z-]+\/\d+/);
      }
    });

    // The glyph says "error", not "which subsystem" — a folder for git and a
    // triangle for config read as a file and a warning.
    it("draws the same severity glyph whatever the error type", () => {
      const glyphs = (["git", "process", "filesystem", "network", "config", "unknown"] as const).map(
        (type) => {
          const { container, unmount } = render(
            <ErrorBanner error={makeError({ type })} onDismiss={onDismiss} />
          );
          const svg = container.querySelector("svg")!.outerHTML;
          unmount();
          return svg;
        }
      );
      expect(new Set(glyphs).size).toBe(1);
    });

    it("keeps the complete message available when a long one is shortened", () => {
      const long = `${"a".repeat(400)} tail`;
      render(<ErrorBanner error={makeError({ message: long })} onDismiss={onDismiss} />);
      expect(screen.getByTitle(long)).toBeTruthy();
    });

    it("strips terminal escapes from the message", () => {
      render(
        <ErrorBanner error={makeError({ message: "\x1b[31mboom\x1b[0m" })} onDismiss={onDismiss} />
      );
      expect(screen.getByText("boom")).toBeTruthy();
    });
  });

  describe("dismiss", () => {
    it("names the dismiss control and forwards the error's id", () => {
      render(<ErrorBanner error={makeError({ id: "e-7" })} onDismiss={onDismiss} />);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
      expect(onDismiss).toHaveBeenCalledWith("e-7");
    });
  });

  // The rows live inside click-to-select cards and panes; acting on an error
  // must never also select, or unmount, the surface around it.
  describe("containment", () => {
    it.each([
      ["Retry", { ...retryable }],
      ["View errors", {}],
      ["Dismiss error", {}],
      [
        "Pull and rebase",
        {
          retryability: "user-gated",
          recoveryAction: { label: "Pull and rebase", actionId: "git.pullRebase" },
        },
      ],
    ] as const)("keeps a click on %s out of the host", (name, overrides) => {
      const hostClick = vi.fn();
      render(
        <div onClick={hostClick}>
          <ErrorBanner
            error={makeError(overrides as Partial<ErrorRecord>)}
            onDismiss={onDismiss}
            onRetry={vi.fn()}
          />
        </div>
      );
      fireEvent.click(screen.getByRole("button", { name }));
      expect(hostClick).not.toHaveBeenCalled();
    });
  });

  describe("retryability-driven action slot", () => {
    it("renders Retry for 'auto' + retryAction + onRetry, and forwards the retry", () => {
      const onRetry = vi.fn();
      render(
        <ErrorBanner
          error={makeError({ ...retryable, retryArgs: { a: 1 } })}
          onDismiss={onDismiss}
          onRetry={onRetry}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRetry).toHaveBeenCalledWith("err-1", "git", { a: 1 });
      expect(screen.queryByRole("button", { name: "View errors" })).toBeNull();
    });

    it("renders 'View errors' when retryability is 'auto' but onRetry is missing", () => {
      render(<ErrorBanner error={makeError({ ...retryable })} onDismiss={onDismiss} />);
      expect(screen.getByRole("button", { name: "View errors" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("renders 'View errors' for 'exhausted' even when retryAction is wired", () => {
      render(
        <ErrorBanner
          error={makeError({ retryability: "exhausted", retryAction: "git" })}
          onDismiss={onDismiss}
          onRetry={vi.fn()}
        />
      );
      expect(screen.getByRole("button", { name: "View errors" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("falls back to 'View errors' for 'user-gated' without recoveryAction", () => {
      render(
        <ErrorBanner error={makeError({ retryability: "user-gated" })} onDismiss={onDismiss} />
      );
      expect(screen.getByRole("button", { name: "View errors" })).toBeTruthy();
    });

    it("does not colour Retry green", () => {
      render(
        <ErrorBanner error={makeError({ ...retryable })} onDismiss={onDismiss} onRetry={vi.fn()} />
      );
      expect(screen.getByRole("button", { name: "Retry" }).className).not.toMatch(
        /status-success/
      );
    });

    it("renders exactly one contextual action beside the dismiss", () => {
      render(
        <ErrorBanner error={makeError({ ...retryable })} onDismiss={onDismiss} onRetry={vi.fn()} />
      );
      expect(screen.getAllByRole("button")).toHaveLength(2);
    });
  });

  describe("retry in flight", () => {
    const inFlight = { ...retryable, retryProgress: { attempt: 2, maxAttempts: 3 } };

    it("shows the attempt and offers Cancel in place of Retry", () => {
      const onCancelRetry = vi.fn();
      render(
        <ErrorBanner
          error={makeError(inFlight)}
          onDismiss={onDismiss}
          onRetry={vi.fn()}
          onCancelRetry={onCancelRetry}
        />
      );
      expect(screen.getByText("Retrying 2 of 3…")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(screen.queryByRole("button", { name: "View errors" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCancelRetry).toHaveBeenCalledWith("err-1");
    });

    // Progress is state the user is owed whether or not the host can stop it.
    it("still shows the attempt when the host cannot cancel", () => {
      render(<ErrorBanner error={makeError(inFlight)} onDismiss={onDismiss} onRetry={vi.fn()} />);
      expect(screen.getByText("Retrying 2 of 3…")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("hides the recovery action while a retry is in progress", () => {
      render(
        <ErrorBanner
          error={makeError({
            retryability: "user-gated",
            recoveryAction: { label: "Pull and rebase", actionId: "git.pullRebase" },
            retryProgress: { attempt: 1, maxAttempts: 3 },
          })}
          onDismiss={onDismiss}
          onCancelRetry={vi.fn()}
        />
      );
      expect(screen.queryByRole("button", { name: "Pull and rebase" })).toBeNull();
    });
  });

  describe("retryExhausted and occurrenceCount gating", () => {
    it("shows 'View errors' not 'Retry' when retryExhausted is true", () => {
      render(
        <ErrorBanner
          error={makeError({ ...retryable, retryExhausted: true })}
          onDismiss={onDismiss}
          onRetry={vi.fn()}
        />
      );
      expect(screen.getByRole("button", { name: "View errors" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("shows 'View errors' not 'Retry' when occurrenceCount reaches threshold 5", () => {
      render(
        <ErrorBanner
          error={makeError({ ...retryable, occurrenceCount: 5 })}
          onDismiss={onDismiss}
          onRetry={vi.fn()}
        />
      );
      expect(screen.getByRole("button", { name: "View errors" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("still shows 'Retry' when occurrenceCount is below threshold 5", () => {
      render(
        <ErrorBanner
          error={makeError({ ...retryable, occurrenceCount: 4 })}
          onDismiss={onDismiss}
          onRetry={vi.fn()}
        />
      );
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });
  });

  describe("promotedToDock", () => {
    beforeEach(() => {
      useErrorStore.getState().reset();
    });

    it("does not show Retry once the error is in the dock", () => {
      render(
        <ErrorBanner
          error={makeError({ ...retryable, promotedToDock: true })}
          onDismiss={onDismiss}
          onRetry={vi.fn()}
        />
      );
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(screen.getByRole("button", { name: "View errors" })).toBeTruthy();
    });

    it("View errors opens the dock to problems and promotes the error", () => {
      const id = useErrorStore.getState().addError({
        type: "git",
        message: "push rejected",
        source: "git",
        retryability: "none",
      });
      render(<ErrorBanner error={makeError({ id })} onDismiss={onDismiss} />);
      fireEvent.click(screen.getByRole("button", { name: "View errors" }));
      expect(useDiagnosticsStore.getState().isOpen).toBe(true);
      expect(useDiagnosticsStore.getState().activeTab).toBe("problems");
      expect(useErrorStore.getState().errors.find((e) => e.id === id)?.promotedToDock).toBe(true);
    });
  });

  describe("recovery action CTA", () => {
    const recoveryAction = { label: "Pull and rebase", actionId: "git.pullRebase" };

    beforeEach(() => {
      mockDispatch.mockClear();
    });

    it("renders the recovery label and hides View errors", () => {
      render(
        <ErrorBanner
          error={makeError({ retryability: "user-gated", recoveryAction })}
          onDismiss={onDismiss}
        />
      );
      expect(screen.getByRole("button", { name: "Pull and rebase" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "View errors" })).toBeNull();
    });

    it("dispatches via actionService with the action's args", async () => {
      const withArgs = {
        label: "Sign in with GitHub",
        actionId: "app.settings.openTab",
        args: { tab: "code-forge", subtab: "github" },
      };
      render(
        <ErrorBanner
          error={makeError({ retryability: "user-gated", recoveryAction: withArgs })}
          onDismiss={onDismiss}
        />
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
      });
      expect(mockDispatch).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "code-forge", subtab: "github" },
        { source: "user" }
      );
    });

    it("dispatches with undefined args when the action has none", async () => {
      render(
        <ErrorBanner
          error={makeError({ retryability: "user-gated", recoveryAction })}
          onDismiss={onDismiss}
        />
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Pull and rebase" }));
      });
      expect(mockDispatch).toHaveBeenCalledWith("git.pullRebase", undefined, { source: "user" });
    });
  });

  // Rows stack; several assertive regions interrupt each other.
  it("is a polite status, never an alert", () => {
    render(<ErrorBanner error={makeError()} onDismiss={onDismiss} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
