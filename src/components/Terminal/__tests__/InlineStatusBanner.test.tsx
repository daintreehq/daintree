// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AlertTriangle, CheckCircle2, FileEdit, Info, XCircle } from "lucide-react";
import { InlineStatusBanner } from "../InlineStatusBanner";
import { WindowControlsInsetProvider } from "@/components/ui/WindowControlsInset";

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
      />
    );
    const region = screen.getByRole("alert");
    expect(region.hasAttribute("aria-live")).toBe(false);
    expect(region.hasAttribute("aria-atomic")).toBe(false);
  });

  it("caps an error banner at a single inline action; secondary affordances go in trailingSlot", () => {
    render(
      <InlineStatusBanner
        icon={XCircle}
        title="Couldn't start terminal"
        severity="error"
        animated={false}
        action={{ id: "retry", label: "Retry", onClick: () => {} }}
        trailingSlot={<button type="button">More options</button>}
      />
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    // The single `action` renders one inline button; the rest live behind the slot.
    expect(screen.getByRole("button", { name: "More options" })).toBeTruthy();

    const _rejectsActionsOnError = (
      // @ts-expect-error error banners forbid the multi-action `actions` prop.
      <InlineStatusBanner
        icon={XCircle}
        title="Nope"
        severity="error"
        actions={[{ id: "a", label: "A", onClick: () => {} }]}
      />
    );
    void _rejectsActionsOnError;
  });

  it.each([
    ["error", XCircle, "--color-status-error"],
    ["warning", AlertTriangle, "--color-status-warning"],
    ["info", Info, "--color-status-info"],
    ["success", CheckCircle2, "--color-status-success"],
  ] as const)("renders %s severity using its status token", (severity, icon, token) => {
    render(
      <InlineStatusBanner icon={icon} title={severity} severity={severity} animated={false} />
    );
    const region = screen.getByRole("alert");
    expect(region.style.backgroundColor).toContain(token);
    expect(region.style.borderBottom).toContain(token);
  });

  it("allows non-error banners to render multiple actions", () => {
    render(
      <InlineStatusBanner
        icon={FileEdit}
        title="3 files changed"
        severity="neutral"
        animated={false}
        role="status"
        actions={[
          { id: "review", label: "Review", onClick: () => {} },
          { id: "send", label: "Send to assistant", onClick: () => {} },
        ]}
      />
    );
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to assistant" })).toBeTruthy();
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

  it("scopes the entrance transition to the properties it animates", () => {
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
    // Assert the RULE, not the number. The old form asserted the literal
    // `duration-250` copied straight from the component, so retiming the
    // banner forced the identical edit here and the test proved nothing —
    // exactly the tautological shape the repo's testing rules ban. What
    // actually matters is that the entry transition exists and is scoped to
    // the properties it animates: a bare `transition` would sweep in every
    // animatable property, so an unrelated colour or size change would
    // silently inherit entry timing.
    expect(root.className).toMatch(/transition-\[[^\]]+\]/);
    expect(root.className).not.toMatch(/(?:^|\s)transition(?:\s|$)/);
    expect(root.className).not.toContain("transition-all");
  });

  it("suppresses the entrance transition when data-reduce-animations is true", () => {
    document.body.setAttribute("data-reduce-animations", "true");
    try {
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
      expect(root.className).not.toContain("duration-250");
    } finally {
      document.body.removeAttribute("data-reduce-animations");
    }
  });

  it("suppresses the 250ms entrance class when data-performance-mode is true", () => {
    document.body.setAttribute("data-performance-mode", "true");
    try {
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
      expect(root.className).not.toContain("duration-250");
    } finally {
      document.body.removeAttribute("data-performance-mode");
    }
  });
});

/**
 * Issue #11766. In the global banner host this component owns the window's
 * title-bar band: the toolbar that normally supplies the drag region and
 * top-edge resize strip has been pushed below the caption buttons, and the
 * native caption strip needs to know which severity is painted beneath it.
 * None of that may leak into the far more common inline usage — a banner
 * inside a terminal must never become a window drag handle.
 */
describe("InlineStatusBanner as the window title-bar surface", () => {
  function renderGlobal(
    props: Partial<React.ComponentProps<typeof InlineStatusBanner>> = {},
    onSeverityChange = vi.fn()
  ) {
    const result = render(
      <WindowControlsInsetProvider onSeverityChange={onSeverityChange}>
        <InlineStatusBanner
          icon={AlertTriangle}
          title="Project in a synced folder"
          severity="warning"
          animated={false}
          {...props}
        />
      </WindowControlsInsetProvider>
    );
    return { ...result, onSeverityChange };
  }

  function root(): HTMLElement {
    return screen.getByRole("alert");
  }

  function withNavigator(platform: string, userAgent: string, body: () => void) {
    const original = {
      platform: Object.getOwnPropertyDescriptor(window.navigator, "platform"),
      userAgent: Object.getOwnPropertyDescriptor(window.navigator, "userAgent"),
    };
    Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
    Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true });
    try {
      body();
    } finally {
      if (original.platform) {
        Object.defineProperty(window.navigator, "platform", original.platform);
      }
      if (original.userAgent) {
        Object.defineProperty(window.navigator, "userAgent", original.userAgent);
      }
    }
  }

  it("becomes draggable and fills the caption band's height", () => {
    renderGlobal();
    // A banner shorter than the 48px native strip would let the tint applied to
    // that strip bleed over the toolbar below it.
    expect(root().className).toContain("app-drag-region");
    expect(root().className).toContain("min-h-12");
  });

  it("leaves an inline banner undraggable and unconstrained", () => {
    render(
      <InlineStatusBanner icon={AlertTriangle} title="Inline" severity="warning" animated={false} />
    );
    expect(root().className).not.toContain("app-drag-region");
    expect(root().className).not.toContain("min-h-12");
    expect(root().querySelector(".window-resize-strip")).toBeNull();
  });

  it.each([
    ["Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
    ["MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],
  ])(
    "carries the top-edge resize strip the displaced toolbar can no longer provide (%s)",
    (platform, userAgent) => {
      // isLinux() reads navigator.userAgent, so pin it rather than relying on
      // whatever jsdom's default happens to be — Ubuntu CI would otherwise
      // never establish which branch it is exercising.
      withNavigator(platform, userAgent, () => {
        renderGlobal();
        expect(root().querySelector(".window-resize-strip")).not.toBeNull();
      });
    }
  );

  it("omits the resize strip on Linux, whose WM owns the window edges", () => {
    withNavigator("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)", () => {
      renderGlobal();
      expect(root().querySelector(".window-resize-strip")).toBeNull();
      // The drag region is still wanted — only the resize strip is skipped.
      expect(root().className).toContain("app-drag-region");
    });
  });

  it("keeps every interactive control out of the drag region", () => {
    renderGlobal({
      description: "This project is in a synced folder.",
      onClose: vi.fn(),
      actions: [
        { id: "dismiss", label: "Don't warn for this project", onClick: vi.fn() },
        { id: "more", label: "Learn more", onClick: vi.fn() },
      ],
      descriptionExtras: <a href="#extra">Details</a>,
    });

    // A control swallowed by the drag region becomes unclickable, which is
    // exactly what the issue calls out for "Don't warn for this project".
    for (const name of ["Don't warn for this project", "Learn more", "Dismiss"]) {
      expect(screen.getByRole("button", { name }).closest(".app-no-drag")).not.toBeNull();
    }
    expect(screen.getByRole("link", { name: "Details" }).closest(".app-no-drag")).not.toBeNull();
  });

  it("still fires the dismiss action while inside the drag region", () => {
    const onClick = vi.fn();
    renderGlobal({
      description: "This project is in a synced folder.",
      actions: [{ id: "dismiss", label: "Don't warn for this project", onClick }],
    });

    fireEvent.click(screen.getByRole("button", { name: "Don't warn for this project" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("reports its severity on mount so the caption strip can match it", () => {
    const { onSeverityChange } = renderGlobal({ severity: "error" });
    expect(onSeverityChange).toHaveBeenCalledWith("error");
  });

  it("re-reports when the severity changes", () => {
    const onSeverityChange = vi.fn();
    const { rerender } = renderGlobal({ severity: "warning" }, onSeverityChange);
    onSeverityChange.mockClear();

    rerender(
      <WindowControlsInsetProvider onSeverityChange={onSeverityChange}>
        <InlineStatusBanner icon={AlertTriangle} title="t" severity="info" animated={false} />
      </WindowControlsInsetProvider>
    );

    expect(onSeverityChange).toHaveBeenLastCalledWith("info");
  });

  it("clears the report on unmount so the strip returns to the canvas", () => {
    const { onSeverityChange, unmount } = renderGlobal();
    onSeverityChange.mockClear();

    unmount();

    expect(onSeverityChange).toHaveBeenCalledWith(null);
  });

  it("does not report through a provider that supplies no reporter", () => {
    // The bare provider is used for its inset alone; only the global banner
    // host opts a banner into reporting.
    const onSeverityChange = vi.fn();
    render(
      <WindowControlsInsetProvider>
        <InlineStatusBanner
          icon={AlertTriangle}
          title="Inset only"
          severity="warning"
          animated={false}
        />
      </WindowControlsInsetProvider>
    );
    expect(onSeverityChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").className).not.toContain("app-drag-region");
  });
});
