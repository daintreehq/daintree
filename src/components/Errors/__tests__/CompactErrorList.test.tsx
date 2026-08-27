// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { primeRadix } from "@/components/ui/radix-loader";
import { CompactErrorList } from "../CompactErrorList";
import type { ErrorRecord } from "@/store/errorStore";

const mockDispatch = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => mockDispatch(...args) },
}));

class StubResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeErrors(count: number): ErrorRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `err-${i}`,
    timestamp: 1_700_000_000_000 + i,
    type: "unknown",
    message: `Failure ${i}`,
    retryability: "none",
    dismissed: false,
  }));
}

const openOverflow = () => fireEvent.click(screen.getByTestId("compact-error-overflow"));

describe("CompactErrorList", () => {
  it("renders every error inline when the list fits under the cap", () => {
    render(<CompactErrorList errors={makeErrors(3)} maxInline={3} onDismiss={vi.fn()} />);
    expect(screen.getByText("Failure 0")).toBeTruthy();
    expect(screen.getByText("Failure 2")).toBeTruthy();
    expect(screen.queryByTestId("compact-error-overflow")).toBeNull();
  });

  it("splits at the cap, leaving the tail out of the DOM until it is opened", () => {
    render(<CompactErrorList errors={makeErrors(6)} maxInline={2} onDismiss={vi.fn()} />);
    expect(screen.getByText("Failure 1")).toBeTruthy();
    expect(screen.queryByText("Failure 2")).toBeNull();
    expect(screen.getByTestId("compact-error-overflow")).toBeTruthy();
  });

  it("opens the tail so every hidden error is readable (#12001)", () => {
    render(<CompactErrorList errors={makeErrors(6)} maxInline={2} onDismiss={vi.fn()} />);
    openOverflow();
    for (const i of [2, 3, 4, 5]) {
      expect(screen.getByText(`Failure ${i}`)).toBeTruthy();
    }
  });

  it("counts only the hidden errors on the trigger, not the whole list", () => {
    render(<CompactErrorList errors={makeErrors(6)} maxInline={2} onDismiss={vi.fn()} />);
    const trigger = screen.getByTestId("compact-error-overflow");
    expect(trigger.textContent).toContain("4");
    expect(trigger.textContent).not.toContain("6");
  });

  it("pluralizes the trigger against the hidden count", () => {
    const { rerender } = render(
      <CompactErrorList errors={makeErrors(3)} maxInline={2} onDismiss={vi.fn()} />
    );
    expect(screen.getByTestId("compact-error-overflow").textContent).toMatch(/1 more error(?!s)/);

    rerender(<CompactErrorList errors={makeErrors(4)} maxInline={2} onDismiss={vi.fn()} />);
    expect(screen.getByTestId("compact-error-overflow").textContent).toMatch(/2 more errors/);
  });

  it("names the hidden messages on the trigger so AT can judge before opening", () => {
    render(<CompactErrorList errors={makeErrors(5)} maxInline={3} onDismiss={vi.fn()} />);
    const label = screen.getByTestId("compact-error-overflow").getAttribute("aria-label") ?? "";
    expect(label).toContain("Failure 3");
    expect(label).toContain("Failure 4");
    // The inline ones are already on screen; repeating them would double the
    // announcement.
    expect(label).not.toContain("Failure 0");
  });

  it("keeps dismiss wired for a hidden error, forwarding its own id", () => {
    const onDismiss = vi.fn();
    render(<CompactErrorList errors={makeErrors(5)} maxInline={2} onDismiss={onDismiss} />);
    openOverflow();

    const row = screen.getByText("Failure 4").closest("div")!;
    fireEvent.click(within(row.parentElement ?? row).getAllByLabelText(/dismiss/i)[0]!);
    expect(onDismiss).toHaveBeenCalledWith("err-4");
  });

  it("keeps retry wired for a hidden error, forwarding its retry action", () => {
    const onRetry = vi.fn();
    const errors = makeErrors(5);
    errors[4] = {
      ...errors[4]!,
      retryability: "auto",
      retryAction: "git:status" as ErrorRecord["retryAction"],
    };
    render(
      <CompactErrorList errors={errors} maxInline={2} onDismiss={vi.fn()} onRetry={onRetry} />
    );
    openOverflow();

    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(onRetry).toHaveBeenCalledWith("err-4", "git:status", undefined);
  });

  it("renders nothing at all for an empty list", () => {
    const { container } = render(
      <CompactErrorList errors={[]} maxInline={3} onDismiss={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("drops the trigger once the tail shrinks back under the cap", () => {
    const { rerender } = render(
      <CompactErrorList errors={makeErrors(5)} maxInline={2} onDismiss={vi.fn()} />
    );
    openOverflow();
    expect(screen.getByText("Failure 4")).toBeTruthy();

    rerender(<CompactErrorList errors={makeErrors(2)} maxInline={2} onDismiss={vi.fn()} />);
    // Unmounting the disclosure with the tail is what stops a reopened popover
    // from anchoring to a trigger that no longer has anything behind it.
    expect(screen.queryByTestId("compact-error-overflow")).toBeNull();
    expect(screen.queryByText("Failure 4")).toBeNull();
  });
});
