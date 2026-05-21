// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { AlertTriangle, CheckCircle2, FileEdit, Info, XCircle } from "lucide-react";
import { InlineStatusBanner } from "../InlineStatusBanner";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("InlineStatusBanner", () => {
  it("defaults to role='alert' and emits no aria-live attribute", () => {
    render(
      <InlineStatusBanner
        icon={XCircle}
        title="Something broke"
        severity="error"
        animated={false}
        actions={[]}
      />
    );
    const region = screen.getByRole("alert");
    expect(region.hasAttribute("aria-live")).toBe(false);
    expect(region.hasAttribute("aria-atomic")).toBe(false);
  });

  it.each([
    ["error", XCircle, "--color-status-error"],
    ["warning", AlertTriangle, "--color-status-warning"],
    ["info", Info, "--color-status-info"],
    ["success", CheckCircle2, "--color-status-success"],
  ] as const)("renders %s severity using its status token", (severity, icon, token) => {
    render(
      <InlineStatusBanner
        icon={icon}
        title={severity}
        severity={severity}
        animated={false}
        actions={[]}
      />
    );
    const region = screen.getByRole("alert");
    expect(region.style.backgroundColor).toContain(token);
    expect(region.style.borderBottom).toContain(token);
  });

  it("emits aria-live='off' without aria-atomic", () => {
    render(
      <InlineStatusBanner
        icon={Info}
        title="Quiet"
        severity="info"
        animated={false}
        ariaLive="off"
        actions={[]}
      />
    );
    const region = screen.getByRole("alert");
    expect(region.getAttribute("aria-live")).toBe("off");
    expect(region.hasAttribute("aria-atomic")).toBe(false);
  });

  it("applies aria-live and aria-atomic when ariaLive is provided", () => {
    render(
      <InlineStatusBanner
        icon={Info}
        title="Working"
        severity="info"
        animated={false}
        role="status"
        ariaLive="polite"
        actions={[]}
      />
    );
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
  });

  it("supports role='status' override", () => {
    render(
      <InlineStatusBanner
        icon={Info}
        title="Status"
        severity="info"
        animated={false}
        role="status"
        actions={[]}
      />
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders neutral severity without leaking a status-color var into inline styles", () => {
    const { container } = render(
      <InlineStatusBanner
        icon={FileEdit}
        title="Files changed"
        severity="neutral"
        animated={false}
        role="status"
        actions={[]}
      />
    );
    const root = container.firstElementChild as HTMLElement;
    // No inline color-mix surface: neutral uses the overlay-subtle token class.
    expect(root.style.backgroundColor).toBe("");
    expect(root.style.borderBottom).toBe("");
    expect(root.className).toContain("bg-overlay-subtle");
    expect(root.outerHTML).not.toContain("var(undefined)");
  });

  it("renders trailingSlot before the dismiss button in DOM order", () => {
    const onClose = vi.fn();
    render(
      <InlineStatusBanner
        icon={Info}
        title="With slot"
        severity="info"
        animated={false}
        trailingSlot={<button type="button">Show details</button>}
        actions={[]}
        onClose={onClose}
      />
    );
    const slot = screen.getByRole("button", { name: "Show details" });
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(slot).toBeTruthy();
    expect(slot.compareDocumentPosition(dismiss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders descriptionExtras as a sibling, never inside the description paragraph", () => {
    const { container } = render(
      <InlineStatusBanner
        icon={AlertTriangle}
        title="Lots open"
        description="Consider closing idle panels."
        descriptionExtras={
          <button type="button" className="extras-btn">
            Close completed
          </button>
        }
        severity="warning"
        animated={false}
        actions={[]}
      />
    );
    const extras = container.querySelector(".extras-btn") as HTMLElement;
    expect(extras).toBeTruthy();
    expect(extras.closest("p")).toBeNull();
  });

  it("still renders descriptionExtras when no description or contextLine is set", () => {
    const { container } = render(
      <InlineStatusBanner
        icon={AlertTriangle}
        title="Title only"
        descriptionExtras={
          <button type="button" className="extras-only-btn">
            Extra
          </button>
        }
        severity="warning"
        animated={false}
        actions={[]}
      />
    );
    const extras = container.querySelector(".extras-only-btn") as HTMLElement;
    expect(extras).toBeTruthy();
    expect(extras.closest("p")).toBeNull();
  });

  it("does not reset the auto-dismiss timer when onClose is an unstable reference", () => {
    vi.useFakeTimers();
    try {
      const spy = vi.fn();
      function Wrapper() {
        const [, setTick] = useState(0);
        useEffect(() => {
          const id = setInterval(() => setTick((t) => t + 1), 100);
          return () => clearInterval(id);
        }, []);
        return (
          <InlineStatusBanner
            icon={Info}
            title="Unstable onClose"
            severity="info"
            animated={false}
            actions={[]}
            onClose={() => spy()}
            autoDismissAfter={1_000}
          />
        );
      }
      render(<Wrapper />);
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a custom closeAriaLabel for the dismiss button", () => {
    render(
      <InlineStatusBanner
        icon={Info}
        title="Custom"
        severity="info"
        animated={false}
        actions={[]}
        onClose={() => {}}
        closeAriaLabel="Dismiss recovery confirmation"
      />
    );
    expect(screen.getByRole("button", { name: "Dismiss recovery confirmation" })).toBeTruthy();
  });

  it("fires onClose after autoDismissAfter elapses and clears the timer on unmount", () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const { unmount, rerender } = render(
        <InlineStatusBanner
          icon={Info}
          title="Auto"
          severity="info"
          animated={false}
          actions={[]}
          onClose={onClose}
          autoDismissAfter={10_000}
        />
      );
      act(() => {
        vi.advanceTimersByTime(9_999);
      });
      expect(onClose).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onClose).toHaveBeenCalledTimes(1);

      // Re-mounting then unmounting must not fire onClose again.
      rerender(
        <InlineStatusBanner
          icon={Info}
          title="Auto"
          severity="info"
          animated={false}
          actions={[]}
          onClose={onClose}
          autoDismissAfter={10_000}
        />
      );
      unmount();
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule an auto-dismiss when onClose is absent", () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      render(
        <InlineStatusBanner
          icon={Info}
          title="No close"
          severity="info"
          animated={false}
          actions={[]}
          autoDismissAfter={5_000}
        />
      );
      const scheduledAutoDismiss = setTimeoutSpy.mock.calls.some(([, delay]) => delay === 5_000);
      expect(scheduledAutoDismiss).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("dismiss button layout", () => {
    it("renders dismiss in the title row when hasDescription is true and actions is empty", () => {
      const onClose = vi.fn();
      render(
        <InlineStatusBanner
          icon={AlertTriangle}
          title="25 panels open"
          description="Consider closing idle panels."
          severity="warning"
          animated={false}
          actions={[]}
          onClose={onClose}
        />
      );
      const title = screen.getByText("25 panels open");
      const dismiss = screen.getByRole("button", { name: "Dismiss" });
      // Dismiss shares a parent with the title text (the flex justify-between wrapper)
      const titleParent = title.closest('[class*="flex"]');
      const dismissParent = dismiss.closest('[class*="flex"]');
      expect(titleParent).toBe(dismissParent);
      // The parent is the justify-between wrapper, not the controls row
      expect(titleParent?.className).toContain("justify-between");
    });

    it("fires onClose when the title-row dismiss is clicked", () => {
      const onClose = vi.fn();
      render(
        <InlineStatusBanner
          icon={AlertTriangle}
          title="25 panels open"
          description="Consider closing idle panels."
          severity="warning"
          animated={false}
          actions={[]}
          onClose={onClose}
        />
      );
      screen.getByRole("button", { name: "Dismiss" }).click();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("moves dismiss out of the controls row when hasDescription is true", () => {
      const { container } = render(
        <InlineStatusBanner
          icon={AlertTriangle}
          title="Title"
          description="Description"
          severity="warning"
          animated={false}
          actions={[{ id: "retry", label: "Retry", onClick: () => {} }]}
          onClose={() => {}}
        />
      );
      const controlsRow = container.querySelector(".ml-6");
      expect(controlsRow).toBeTruthy();
      // Dismiss button is NOT inside the ml-6 controls row
      expect(controlsRow?.querySelector('[aria-label="Dismiss"]')).toBeNull();
    });

    it("keeps dismiss in the controls row for single-line banners", () => {
      const { container } = render(
        <InlineStatusBanner
          icon={Info}
          title="Single line"
          severity="info"
          animated={false}
          actions={[]}
          onClose={() => {}}
        />
      );
      // Single-line: no ml-6 wrapper, X is in the controls row (gap-1)
      const controlsRow = container.querySelector('[class*="gap-1"]');
      expect(controlsRow).toBeTruthy();
      expect(controlsRow?.querySelector('[aria-label="Dismiss"]')).toBeTruthy();
    });

    it("renders dismiss in title row with descriptionExtras and no description prop", () => {
      const onClose = vi.fn();
      render(
        <InlineStatusBanner
          icon={AlertTriangle}
          title="25 panels open"
          descriptionExtras={<button type="button">Close completed</button>}
          severity="warning"
          animated={false}
          actions={[]}
          onClose={onClose}
        />
      );
      const title = screen.getByText("25 panels open");
      const dismiss = screen.getByRole("button", { name: "Dismiss" });
      const titleParent = title.closest('[class*="justify-between"]');
      expect(titleParent).toBeTruthy();
      expect(titleParent!.contains(dismiss)).toBe(true);
    });

    it("does not render an empty controls row when hasDescription, no actions, and onClose is present", () => {
      const { container } = render(
        <InlineStatusBanner
          icon={AlertTriangle}
          title="25 panels open"
          description="Consider closing idle panels."
          severity="warning"
          animated={false}
          actions={[]}
          onClose={() => {}}
        />
      );
      // No ml-6 or gap-1 controls row should exist — dismiss is in the title row
      const controlsRow = container.querySelector('[class*="ml-6"]');
      expect(controlsRow).toBeNull();
    });

    it("does not render a controls row when hasDescription is true with no trailingSlot, no actions, and no onClose", () => {
      const { container } = render(
        <InlineStatusBanner
          icon={AlertTriangle}
          title="Recovering"
          description="The host is restarting."
          severity="warning"
          animated={false}
          actions={[]}
        />
      );
      // HostCrashBanner case — no controls row at all
      const controlsRow = container.querySelector('[class*="ml-6"]');
      expect(controlsRow).toBeNull();
    });
  });

  it("uses the 250ms entrance duration class when animated", () => {
    const { container } = render(
      <InlineStatusBanner
        icon={Info}
        title="Animated"
        severity="info"
        animated={true}
        actions={[]}
      />
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("duration-250");
    expect(root.className).not.toContain("duration-150");
  });
});
