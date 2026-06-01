// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { useContext, useState } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FixedDropdown, FixedDropdownVisibleContext } from "../fixed-dropdown";
import { _resetForTests } from "@/lib/escapeStack";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";

const GRACE_MS = 300;

let mockOverlayStack: string[] = [];

function setOverlayStackLength(size: number) {
  const next: string[] = [];
  for (let i = 0; i < size; i++) {
    next.push(`claim-${i}`);
  }
  mockOverlayStack = next;
}

vi.mock("@/store/uiStore", () => ({
  useUIStore: (selector: (state: { overlayStack: string[] }) => unknown) =>
    selector({ overlayStack: mockOverlayStack }),
}));

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

function Dispatcher() {
  useGlobalEscapeDispatcher();
  return null;
}

function createAnchor() {
  const el = document.createElement("button");
  el.getBoundingClientRect = () =>
    ({ top: 0, right: 100, bottom: 40, left: 0, width: 100, height: 40 }) as DOMRect;
  document.body.appendChild(el);
  return { current: el };
}

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

function advancePastGrace() {
  act(() => {
    vi.advanceTimersByTime(GRACE_MS + 1);
  });
}

describe("FixedDropdown overlay-claims dismiss behavior", () => {
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  let anchorRef: React.RefObject<HTMLElement | null>;

  beforeEach(() => {
    _resetForTests();
    setOverlayStackLength(0);
    onOpenChange = vi.fn();
    anchorRef = createAnchor();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetForTests();
    vi.useRealTimers();
  });

  it("closes when overlay-claims size increases (default behavior)", () => {
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // Wait for the cold-start grace window to expire so that subsequent
    // overlay rises are treated as user-initiated dismiss triggers.
    advancePastGrace();

    setOverlayStackLength(1);
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does NOT close when overlay-claims size rises during the grace window (issue #5084)", () => {
    // Dropdown opens with no overlays present.
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // An in-flight modal (e.g. cold-start AgentSetupWizard) mounts shortly
    // after and pushes the overlay count. Still inside the grace window, so
    // the dropdown should not be auto-closed.
    setOverlayStackLength(1);
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).not.toHaveBeenCalled();

    // Even after the grace window expires, the baseline absorbed the rise
    // so a steady overlay count must not trigger a close.
    advancePastGrace();
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).not.toHaveBeenCalled();
    // Also verify the dropdown is still actually rendered — guards against
    // a silent render-suppression regression.
    expect(document.body.textContent).toContain("Content");
  });

  it("closes when a new overlay opens at the same level after the absorbed one disappeared", () => {
    // Regression: baseline must decay when overlay-claims size drops, otherwise a
    // user-initiated modal at the same numeric level as an absorbed
    // in-flight modal fails to dismiss the dropdown.
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // In-flight modal mounts during grace, absorbed into baseline=1.
    setOverlayStackLength(1);
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    advancePastGrace();

    // In-flight modal closes — baseline must decay back to 0.
    setOverlayStackLength(0);
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );
    expect(onOpenChange).not.toHaveBeenCalled();

    // User now opens a genuine modal at the same numeric level — must dismiss.
    setOverlayStackLength(1);
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("seeds baseline from a nonzero overlay-claims size when the dropdown opens mid-wizard", () => {
    // Cold-start variant: a wizard is already open when the user clicks the
    // toolbar. The grace-setup effect must seed baseline=1 so that the
    // dropdown does not immediately self-close.
    setOverlayStackLength(1);
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );
    expect(onOpenChange).not.toHaveBeenCalled();

    advancePastGrace();

    // Steady count should not trigger a close.
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );
    expect(onOpenChange).not.toHaveBeenCalled();

    // A second modal on top of the first should dismiss the dropdown.
    setOverlayStackLength(2);
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes when an additional overlay opens after the grace window absorbed an in-flight one", () => {
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // In-flight modal arrives during grace; absorbed into baseline.
    setOverlayStackLength(1);
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    advancePastGrace();

    // User now opens a genuinely new modal — this must dismiss the dropdown.
    setOverlayStackLength(2);
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("restarts the grace window on reopen", () => {
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );
    advancePastGrace();

    // Close, then reopen while a modal is already visible.
    rerender(
      <FixedDropdown open={false} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    setOverlayStackLength(2);
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // Within the new grace window, any further in-flight rise is absorbed.
    setOverlayStackLength(3);
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );
    expect(onOpenChange).not.toHaveBeenCalled();

    // After the new grace window expires, a further rise closes.
    advancePastGrace();
    setOverlayStackLength(4);
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does NOT close when overlay-claims size increases with persistThroughChildOverlays", () => {
    const { rerender } = render(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    advancePastGrace();

    setOverlayStackLength(1);
    rerender(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("suppresses Escape dismiss while child overlay is active", () => {
    setOverlayStackLength(1);
    render(
      <>
        <Dispatcher />
        <FixedDropdown
          open={true}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          persistThroughChildOverlays
        >
          <div>Content</div>
        </FixedDropdown>
      </>
    );

    pressEscape();

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("suppresses outside pointer dismiss while child overlay is active", () => {
    setOverlayStackLength(1);
    render(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("resumes Escape dismiss after child overlay closes", () => {
    setOverlayStackLength(1);
    const { rerender } = render(
      <>
        <Dispatcher />
        <FixedDropdown
          open={true}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          persistThroughChildOverlays
        >
          <div>Content</div>
        </FixedDropdown>
      </>
    );

    setOverlayStackLength(0);
    rerender(
      <>
        <Dispatcher />
        <FixedDropdown
          open={true}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          persistThroughChildOverlays
        >
          <div>Content</div>
        </FixedDropdown>
      </>
    );

    pressEscape();

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays suppressed through multiple overlay transitions (1→2→1)", () => {
    setOverlayStackLength(1);
    const { rerender } = render(
      <>
        <Dispatcher />
        <FixedDropdown
          open={true}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          persistThroughChildOverlays
        >
          <div>Content</div>
        </FixedDropdown>
      </>
    );

    setOverlayStackLength(2);
    rerender(
      <>
        <Dispatcher />
        <FixedDropdown
          open={true}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          persistThroughChildOverlays
        >
          <div>Content</div>
        </FixedDropdown>
      </>
    );

    expect(onOpenChange).not.toHaveBeenCalled();

    setOverlayStackLength(1);
    rerender(
      <>
        <Dispatcher />
        <FixedDropdown
          open={true}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          persistThroughChildOverlays
        >
          <div>Content</div>
        </FixedDropdown>
      </>
    );

    pressEscape();

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("can be explicitly closed by parent while child overlay is active", () => {
    setOverlayStackLength(1);
    const { rerender } = render(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    rerender(
      <FixedDropdown
        open={false}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    expect(document.querySelector("[class*='fixed']")).toBeNull();
  });
});

describe("FixedDropdown keepMounted behavior", () => {
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  let anchorRef: React.RefObject<HTMLElement | null>;

  beforeEach(() => {
    _resetForTests();
    setOverlayStackLength(0);
    onOpenChange = vi.fn();
    anchorRef = createAnchor();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetForTests();
    vi.useRealTimers();
  });

  it("does NOT render the portal before the first open with keepMounted", () => {
    render(
      <FixedDropdown open={false} onOpenChange={onOpenChange} anchorRef={anchorRef} keepMounted>
        <div>Body content</div>
      </FixedDropdown>
    );
    expect(document.body.textContent).not.toContain("Body content");
  });

  it("keeps the body in the DOM and preserves state across hide/reveal", () => {
    // Activity's actual guarantee: state is preserved across hidden/visible
    // transitions while the DOM node stays put. (Effects are intentionally
    // re-fired on each reveal — that's how SWR revalidate gets triggered on
    // reopen, which is desirable.) This test pins down the state-preservation
    // contract: useState(() => randomId) runs once per real mount, so reading
    // it back after a hide/reveal cycle proves the same instance was reused.
    function StatePreserver() {
      const [id] = useState(() => Math.random().toString(36).slice(2));
      return (
        <div data-testid="body" data-id={id}>
          preserved
        </div>
      );
    }

    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef} keepMounted>
        <StatePreserver />
      </FixedDropdown>
    );

    const idAtMount = document.querySelector('[data-testid="body"]')?.getAttribute("data-id");
    expect(idAtMount).toBeTruthy();

    rerender(
      <FixedDropdown open={false} onOpenChange={onOpenChange} anchorRef={anchorRef} keepMounted>
        <StatePreserver />
      </FixedDropdown>
    );
    // Body remains in the DOM after close — Activity hides via display:none.
    expect(document.querySelector('[data-testid="body"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="body"]')?.getAttribute("data-id")).toBe(idAtMount);

    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef} keepMounted>
        <StatePreserver />
      </FixedDropdown>
    );
    // Same id after reveal — state was preserved, instance was reused.
    expect(document.querySelector('[data-testid="body"]')?.getAttribute("data-id")).toBe(idAtMount);
  });

  it("default behavior (no keepMounted) still unmounts the body on close", () => {
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div data-testid="body">Body content</div>
      </FixedDropdown>
    );

    expect(document.querySelector('[data-testid="body"]')).not.toBeNull();

    rerender(
      <FixedDropdown open={false} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div data-testid="body">Body content</div>
      </FixedDropdown>
    );

    expect(document.querySelector('[data-testid="body"]')).toBeNull();
  });
});

describe("FixedDropdownVisibleContext tooltip strand gate (issue #8001)", () => {
  // Regression coverage for the strand-in-top-left ghost: when a keepMounted
  // FixedDropdown transitions to Activity-hidden, the shared `Tooltip`
  // wrapper consumes this context to force `open={false}` on any Radix
  // Tooltip whose dismiss path was skipped by the synchronous `display:none`.
  // Portaled overlay content otherwise escapes Activity and falls back to
  // (0,0) on document.body. These tests assert the context contract.
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  let anchorRef: React.RefObject<HTMLElement | null>;

  beforeEach(() => {
    _resetForTests();
    setOverlayStackLength(0);
    onOpenChange = vi.fn();
    anchorRef = createAnchor();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetForTests();
    vi.useRealTimers();
  });

  function ContextProbe({ id }: { id: string }) {
    const visible = useContext(FixedDropdownVisibleContext);
    return <span data-testid={id} data-visible={String(visible)} />;
  }

  it("provides context value `true` while a keepMounted dropdown is visible", () => {
    render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef} keepMounted>
        <ContextProbe id="probe-open" />
      </FixedDropdown>
    );

    const probe = document.querySelector('[data-testid="probe-open"]');
    expect(probe?.getAttribute("data-visible")).toBe("true");
  });

  it("flips context value to `false` once the keepMounted dropdown closes", () => {
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef} keepMounted>
        <ContextProbe id="probe" />
      </FixedDropdown>
    );

    expect(document.querySelector('[data-testid="probe"]')?.getAttribute("data-visible")).toBe(
      "true"
    );

    rerender(
      <FixedDropdown open={false} onOpenChange={onOpenChange} anchorRef={anchorRef} keepMounted>
        <ContextProbe id="probe" />
      </FixedDropdown>
    );

    // Body stays mounted (Activity hidden), but context value must flip so
    // that descendant `Tooltip` wrappers force-close before any portaled
    // overlay content can strand at (0,0).
    expect(document.querySelector('[data-testid="probe"]')?.getAttribute("data-visible")).toBe(
      "false"
    );
  });

  it("restores context value to `true` when the keepMounted dropdown reopens", () => {
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef} keepMounted>
        <ContextProbe id="probe" />
      </FixedDropdown>
    );

    rerender(
      <FixedDropdown open={false} onOpenChange={onOpenChange} anchorRef={anchorRef} keepMounted>
        <ContextProbe id="probe" />
      </FixedDropdown>
    );
    expect(document.querySelector('[data-testid="probe"]')?.getAttribute("data-visible")).toBe(
      "false"
    );

    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef} keepMounted>
        <ContextProbe id="probe" />
      </FixedDropdown>
    );
    expect(document.querySelector('[data-testid="probe"]')?.getAttribute("data-visible")).toBe(
      "true"
    );
  });

  it("defaults to `true` outside any FixedDropdown so standalone tooltips are unaffected", () => {
    render(<ContextProbe id="probe-standalone" />);
    expect(
      document.querySelector('[data-testid="probe-standalone"]')?.getAttribute("data-visible")
    ).toBe("true");
  });

  it("does not wrap non-keepMounted dropdowns in the provider (default `true` flows through)", () => {
    // Non-keepMounted dropdowns unmount their body on close, so they don't
    // need the gate. The provider must be scoped to the keepMounted branch
    // only — otherwise the gate would fire during normal open/close cycles
    // and pre-emptively close tooltips that are still in their fade-out.
    render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <ContextProbe id="probe-non-keep" />
      </FixedDropdown>
    );

    // The default context value is `true`, so without an inner provider this
    // probe reads `true`. Confirms the provider is correctly scoped to the
    // keepMounted branch.
    expect(
      document.querySelector('[data-testid="probe-non-keep"]')?.getAttribute("data-visible")
    ).toBe("true");
  });
});

describe("FixedDropdown right-edge anchor (issue #6800)", () => {
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  let anchorRef: React.RefObject<HTMLElement | null>;

  beforeEach(() => {
    _resetForTests();
    setOverlayStackLength(0);
    onOpenChange = vi.fn();
    anchorRef = createAnchor();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    _resetForTests();
    document.documentElement.style.removeProperty("--portal-right-offset");
    document.documentElement.style.removeProperty("--right-obstruction-offset");
  });

  it("anchors right edge to --portal-right-offset, not --right-obstruction-offset", () => {
    // Toolbar dropdowns sit above the main flex row. The Assistant is a flex
    // sibling of <main>, not an overlay — it doesn't cover the toolbar. Only
    // the body-portaled Portal (web chat) needs to push toolbar dropdowns
    // left. Using --right-obstruction-offset would shift dropdowns left by
    // Assistant width too, which is the bug from #6800.
    render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div data-testid="dropdown-body">Content</div>
      </FixedDropdown>
    );

    const portal = document.querySelector('[data-testid="dropdown-body"]')?.parentElement;
    expect(portal).not.toBeNull();
    const rightStyle = portal?.style.right ?? "";
    expect(rightStyle).toContain("var(--portal-right-offset");
    expect(rightStyle).not.toContain("--right-obstruction-offset");
  });

  it("ignores --right-obstruction-offset when only the Assistant is open", () => {
    // The actual #6800 scenario: Portal closed (--portal-right-offset = 0),
    // Assistant open (--right-obstruction-offset = 320). The toolbar dropdown
    // must NOT pick up the 320px shift, because only the Portal body-portals
    // over the toolbar.
    document.documentElement.style.setProperty("--portal-right-offset", "0px");
    document.documentElement.style.setProperty("--right-obstruction-offset", "320px");

    render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div data-testid="dropdown-body">Content</div>
      </FixedDropdown>
    );

    const portal = document.querySelector('[data-testid="dropdown-body"]')?.parentElement;
    const rightStyle = portal?.style.right ?? "";
    expect(rightStyle).toContain("var(--portal-right-offset");
    expect(rightStyle).not.toContain("--right-obstruction-offset");
    expect(rightStyle).not.toContain("320");
  });
});

describe("FixedDropdown source-level guards (issue #6800)", () => {
  // Cheap permanent regression scan: the toolbar-dropdown component must
  // never reach for the obstruction var, even via a nested helper, since
  // that would silently revert the #6800 fix.
  let source: string;

  beforeEach(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    source = await fs.readFile(path.resolve(__dirname, "../fixed-dropdown.tsx"), "utf-8");
  });

  it("references --portal-right-offset", () => {
    expect(source).toContain("--portal-right-offset");
  });

  it("does not reference --right-obstruction-offset", () => {
    // If a future refactor wires the obstruction var into FixedDropdown,
    // toolbar dropdowns will start dodging the Assistant again — exactly
    // the #6800 regression.
    expect(source).not.toContain("--right-obstruction-offset");
  });
});

describe("FixedDropdown rAF re-position throttle (issue #9580)", () => {
  // A controllable rAF queue so we can assert coalescing: a burst of scroll
  // events must schedule exactly one frame. Real timers (not fake) so the
  // existing fake-timer suites stay isolated — Vitest fake timers don't fake
  // requestAnimationFrame unless explicitly told to.
  let rafQueue: Map<number, FrameRequestCallback>;
  let nextRafId: number;
  let rafSpy: ReturnType<typeof vi.spyOn>;
  let cancelSpy: ReturnType<typeof vi.spyOn>;
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;

  function flushFrames() {
    const pending = [...rafQueue.values()];
    rafQueue.clear();
    act(() => {
      for (const cb of pending) cb(0);
    });
  }

  function createMutableAnchor(bottom: number, right: number) {
    const rect = { top: 0, right, bottom, left: 0, width: right, height: bottom };
    const el = document.createElement("button");
    el.getBoundingClientRect = () => rect as DOMRect;
    document.body.appendChild(el);
    return {
      ref: { current: el } as React.RefObject<HTMLElement | null>,
      setRect: (next: { bottom?: number; right?: number }) => Object.assign(rect, next),
    };
  }

  function fireScroll() {
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
  }

  function fireResize() {
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  function portalTop() {
    const body = document.querySelector('[data-testid="dropdown-body"]');
    return body?.parentElement?.style.top ?? "";
  }

  beforeEach(() => {
    _resetForTests();
    setOverlayStackLength(0);
    onOpenChange = vi.fn();
    rafQueue = new Map();
    nextRafId = 0;
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const id = ++nextRafId;
      rafQueue.set(id, cb);
      return id;
    });
    cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      rafQueue.delete(id as number);
    });
  });

  afterEach(() => {
    _resetForTests();
    vi.restoreAllMocks();
  });

  it("positions synchronously on open without waiting for a frame", () => {
    const { ref } = createMutableAnchor(40, 100);
    render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={ref}>
        <div data-testid="dropdown-body">Content</div>
      </FixedDropdown>
    );
    // bottom(40) + sideOffset(8) = 48 — set before any rAF is flushed.
    expect(portalTop()).toBe("48px");
    expect(rafQueue.size).toBe(0);
  });

  it("coalesces a burst of scroll events into a single frame", () => {
    const { ref } = createMutableAnchor(40, 100);
    render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={ref}>
        <div data-testid="dropdown-body">Content</div>
      </FixedDropdown>
    );
    rafSpy.mockClear();

    fireScroll();
    fireScroll();
    fireScroll();

    // Single in-flight frame for the whole burst.
    expect(rafSpy).toHaveBeenCalledTimes(1);
    expect(rafQueue.size).toBe(1);
  });

  it("applies the latest measurement when the frame flushes", () => {
    const { ref, setRect } = createMutableAnchor(40, 100);
    render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={ref}>
        <div data-testid="dropdown-body">Content</div>
      </FixedDropdown>
    );
    expect(portalTop()).toBe("48px");

    setRect({ bottom: 60 });
    fireScroll();
    flushFrames();
    expect(portalTop()).toBe("68px");
  });

  it("re-arms scheduling after a frame flushes", () => {
    const { ref, setRect } = createMutableAnchor(40, 100);
    render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={ref}>
        <div data-testid="dropdown-body">Content</div>
      </FixedDropdown>
    );

    setRect({ bottom: 60 });
    fireScroll();
    flushFrames();
    expect(portalTop()).toBe("68px");

    rafSpy.mockClear();
    setRect({ bottom: 80 });
    fireScroll();
    expect(rafSpy).toHaveBeenCalledTimes(1);
    flushFrames();
    expect(portalTop()).toBe("88px");
  });

  it("does not regress position when the anchor rect is unchanged across frames", () => {
    const { ref } = createMutableAnchor(40, 100);
    render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={ref}>
        <div data-testid="dropdown-body">Content</div>
      </FixedDropdown>
    );

    fireScroll();
    flushFrames();
    expect(portalTop()).toBe("48px");
    fireScroll();
    flushFrames();
    expect(portalTop()).toBe("48px");
  });

  it("coalesces resize events through the same throttle", () => {
    const { ref } = createMutableAnchor(40, 100);
    render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={ref}>
        <div data-testid="dropdown-body">Content</div>
      </FixedDropdown>
    );
    rafSpy.mockClear();

    fireResize();
    fireResize();

    expect(rafSpy).toHaveBeenCalledTimes(1);
    expect(rafQueue.size).toBe(1);
  });

  it("applies the rect from the last event in a coalesced burst", () => {
    const { ref, setRect } = createMutableAnchor(40, 100);
    render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={ref}>
        <div data-testid="dropdown-body">Content</div>
      </FixedDropdown>
    );

    setRect({ bottom: 60 });
    fireScroll();
    // Anchor moves again before the single in-flight frame flushes — latest wins.
    setRect({ bottom: 90 });
    fireScroll();
    flushFrames();
    expect(portalTop()).toBe("98px");
  });

  it("cancels a pending re-position frame on unmount", () => {
    const { ref } = createMutableAnchor(40, 100);
    const { unmount } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={ref}>
        <div data-testid="dropdown-body">Content</div>
      </FixedDropdown>
    );

    fireScroll();
    expect(rafQueue.size).toBe(1);
    cancelSpy.mockClear();
    act(() => {
      unmount();
    });
    expect(cancelSpy).toHaveBeenCalled();
    expect(rafQueue.size).toBe(0);
  });

  it("cancels a pending re-position frame and stops re-scheduling when closed", () => {
    const { ref } = createMutableAnchor(40, 100);
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={ref}>
        <div data-testid="dropdown-body">Content</div>
      </FixedDropdown>
    );

    fireScroll();
    expect(rafQueue.size).toBe(1);
    cancelSpy.mockClear();

    rerender(
      <FixedDropdown open={false} onOpenChange={onOpenChange} anchorRef={ref}>
        <div data-testid="dropdown-body">Content</div>
      </FixedDropdown>
    );
    expect(cancelSpy).toHaveBeenCalled();
    expect(rafQueue.size).toBe(0);

    // Listeners are gone, so a scroll after close schedules nothing.
    rafSpy.mockClear();
    fireScroll();
    expect(rafSpy).not.toHaveBeenCalled();
  });
});
