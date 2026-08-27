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

  it("keeps the trigger's accessible name bounded, not an error-message dump", () => {
    // An error message is an arbitrary-length string. Enumerating the hidden
    // ones would make focusing this button read a paragraph before its state,
    // and the popover exposes the rows themselves once opened.
    const errors = makeErrors(4).map((e) => ({ ...e, message: "x".repeat(400) }));
    render(<CompactErrorList errors={errors} maxInline={1} onDismiss={vi.fn()} />);

    const label = screen.getByTestId("compact-error-overflow").getAttribute("aria-label") ?? "";
    expect(label).toContain("3");
    expect(label.length).toBeLessThan(80);
  });

  it("puts everything behind the disclosure when nothing may render inline", () => {
    render(<CompactErrorList errors={makeErrors(3)} maxInline={0} onDismiss={vi.fn()} />);
    expect(screen.queryByText("Failure 0")).toBeNull();

    openOverflow();
    expect(screen.getByText("Failure 0")).toBeTruthy();
  });

  it("partitions the list without dropping or duplicating an error", () => {
    const errors = makeErrors(9);
    render(<CompactErrorList errors={errors} maxInline={4} onDismiss={vi.fn()} />);

    const visible = () =>
      errors.filter((e) => screen.queryByText(e.message) !== null).map((e) => e.message);
    const inline = visible();
    openOverflow();
    const all = visible();

    expect(inline.length).toBeGreaterThan(0);
    expect(all).toHaveLength(errors.length);
    expect(new Set(all).size).toBe(errors.length);
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
    expect(screen.queryByTestId("compact-error-overflow")).toBeNull();
    expect(screen.queryByText("Failure 4")).toBeNull();
  });

  it("comes back closed after the tail empties and refills", () => {
    // The open flag has to die with the tail. Held a level up it would survive
    // it, and a later error would remount the disclosure already open — taking
    // focus from whatever the user moved on to.
    const { rerender } = render(
      <CompactErrorList errors={makeErrors(5)} maxInline={2} onDismiss={vi.fn()} />
    );
    openOverflow();
    expect(screen.getByText("Failure 4")).toBeTruthy();

    rerender(<CompactErrorList errors={makeErrors(2)} maxInline={2} onDismiss={vi.fn()} />);
    rerender(<CompactErrorList errors={makeErrors(5)} maxInline={2} onDismiss={vi.fn()} />);

    expect(screen.getByTestId("compact-error-overflow")).toBeTruthy();
    expect(screen.queryByText("Failure 4")).toBeNull();
  });

  it("keeps a click on the trigger out of an enclosing click handler", () => {
    // These banners live inside a click-to-select worktree card; from the
    // overview modal that selection unmounts the card, so an unstopped click
    // would open the disclosure and destroy it in the same gesture.
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <CompactErrorList errors={makeErrors(5)} maxInline={2} onDismiss={vi.fn()} />
      </div>
    );

    openOverflow();
    expect(onParentClick).not.toHaveBeenCalled();
    expect(screen.getByText("Failure 4")).toBeTruthy();
  });

  it("keeps a hidden row's own action out of an enclosing click handler", () => {
    // A portal moves the DOM but not the React tree, so the row's buttons still
    // bubble to the card without a boundary on the content itself.
    const onParentClick = vi.fn();
    const onDismiss = vi.fn();
    render(
      <div onClick={onParentClick}>
        <CompactErrorList errors={makeErrors(5)} maxInline={2} onDismiss={onDismiss} />
      </div>
    );

    openOverflow();
    const row = screen.getByText("Failure 4").closest("div")!;
    fireEvent.click(within(row.parentElement ?? row).getAllByLabelText(/dismiss/i)[0]!);

    expect(onDismiss).toHaveBeenCalledWith("err-4");
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
