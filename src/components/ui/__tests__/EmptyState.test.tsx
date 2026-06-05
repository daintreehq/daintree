// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { EmptyState } from "../EmptyState";

describe("EmptyState", () => {
  describe("zero-data variant", () => {
    it("renders title", () => {
      render(<EmptyState variant="zero-data" scale="canvas" title="No recipes yet" />);
      expect(screen.getByText("No recipes yet")).toBeTruthy();
    });

    it("renders description when provided at canvas scale", () => {
      render(
        <EmptyState
          variant="zero-data"
          scale="canvas"
          title="No recipes yet"
          description="Add a recipe to get started"
        />
      );
      expect(screen.getByText("Add a recipe to get started")).toBeTruthy();
    });

    it("renders icon when provided", () => {
      render(
        <EmptyState
          variant="zero-data"
          scale="canvas"
          title="No recipes yet"
          icon={<svg data-testid="icon" />}
        />
      );
      expect(screen.getByTestId("icon")).toBeTruthy();
    });

    it("renders action when provided", () => {
      render(
        <EmptyState
          variant="zero-data"
          scale="canvas"
          title="No recipes yet"
          action={<button data-testid="cta">Add</button>}
        />
      );
      expect(screen.getByTestId("cta")).toBeTruthy();
    });
  });

  describe("filtered-empty variant", () => {
    it("renders title", () => {
      render(<EmptyState variant="filtered-empty" scale="popover" title='No matches for "foo"' />);
      expect(screen.getByText('No matches for "foo"')).toBeTruthy();
    });

    it("renders action when provided", () => {
      render(
        <EmptyState
          variant="filtered-empty"
          scale="sidebar"
          title="No matches"
          action={<button data-testid="clear">Clear filters</button>}
        />
      );
      expect(screen.getByTestId("clear")).toBeTruthy();
    });

    it("does not render an icon even if one is passed via type cast", () => {
      // The discriminated union forbids `icon` on filtered-empty at compile time;
      // this guards against a runtime regression if the gate is removed.
      const props = {
        variant: "filtered-empty",
        scale: "sidebar",
        title: "No matches",
        icon: <svg data-testid="icon" />,
      } as unknown as React.ComponentProps<typeof EmptyState>;
      render(<EmptyState {...props} />);
      expect(screen.queryByTestId("icon")).toBeNull();
    });
  });

  describe("user-cleared variant", () => {
    it("renders title", () => {
      render(<EmptyState variant="user-cleared" scale="canvas" title="You're all caught up" />);
      expect(screen.getByText("You're all caught up")).toBeTruthy();
    });

    it("renders icon when provided", () => {
      render(
        <EmptyState
          variant="user-cleared"
          scale="canvas"
          title="You're all caught up"
          icon={<svg data-testid="icon" />}
        />
      );
      expect(screen.getByTestId("icon")).toBeTruthy();
    });

    it("does not render an action even if one is passed via type cast", () => {
      const props = {
        variant: "user-cleared",
        scale: "canvas",
        title: "You're all caught up",
        action: <button data-testid="cta">Should not appear</button>,
      } as unknown as React.ComponentProps<typeof EmptyState>;
      render(<EmptyState {...props} />);
      expect(screen.queryByTestId("cta")).toBeNull();
    });

    it("does not render a description even if one is passed via type cast", () => {
      const props = {
        variant: "user-cleared",
        scale: "canvas",
        title: "You're all caught up",
        description: "Should not appear",
      } as unknown as React.ComponentProps<typeof EmptyState>;
      render(<EmptyState {...props} />);
      expect(screen.queryByText("Should not appear")).toBeNull();
    });
  });

  describe("scale contract (compile-time enforcement)", () => {
    // These cases assert that the discriminated union rejects content props at
    // narrow scales. The runtime behaviour is incidental — the value of the
    // assertion is the @ts-expect-error directive: removing the directive must
    // produce an "unused @ts-expect-error" diagnostic if the type widens.

    it("rejects description on zero-data at popover scale", () => {
      const element = (
        // @ts-expect-error description is not allowed at popover scale
        <EmptyState
          variant="zero-data"
          scale="popover"
          title="No items"
          description="should not compile"
        />
      );
      expect(element).toBeTruthy();
    });

    it("rejects description on zero-data at sidebar scale", () => {
      const element = (
        // @ts-expect-error description is not allowed at sidebar scale
        <EmptyState
          variant="zero-data"
          scale="sidebar"
          title="No items"
          description="should not compile"
        />
      );
      expect(element).toBeTruthy();
    });

    it("accepts description on zero-data at canvas scale", () => {
      const element = (
        <EmptyState
          variant="zero-data"
          scale="canvas"
          title="No items"
          description="long-form copy"
        />
      );
      expect(element).toBeTruthy();
    });

    it("rejects description on filtered-empty at popover scale", () => {
      const element = (
        // @ts-expect-error description is not allowed at popover scale
        <EmptyState
          variant="filtered-empty"
          scale="popover"
          title="No matches"
          description="should not compile"
        />
      );
      expect(element).toBeTruthy();
    });

    it("rejects description on filtered-empty at sidebar scale", () => {
      const element = (
        // @ts-expect-error description is not allowed at sidebar scale
        <EmptyState
          variant="filtered-empty"
          scale="sidebar"
          title="No matches"
          description="should not compile"
        />
      );
      expect(element).toBeTruthy();
    });

    it("rejects description on user-cleared at every scale", () => {
      const element = (
        // @ts-expect-error user-cleared never carries a description
        <EmptyState
          variant="user-cleared"
          scale="canvas"
          title="You're all caught up"
          description="should not compile"
        />
      );
      expect(element).toBeTruthy();
    });

    it("rejects action on user-cleared at every scale", () => {
      const element = (
        // @ts-expect-error user-cleared never carries an action
        <EmptyState
          variant="user-cleared"
          scale="canvas"
          title="You're all caught up"
          action={<button>Nope</button>}
        />
      );
      expect(element).toBeTruthy();
    });

    it("requires scale to be specified", () => {
      const element = (
        // @ts-expect-error scale is a required discriminant
        <EmptyState variant="zero-data" title="No items" />
      );
      expect(element).toBeTruthy();
    });

    it("rejects icon on filtered-empty at every scale", () => {
      const element = (
        // @ts-expect-error filtered-empty never carries an icon
        <EmptyState variant="filtered-empty" scale="canvas" title="No matches" icon={<svg />} />
      );
      expect(element).toBeTruthy();
    });

    it("rejects popover scale on user-cleared", () => {
      const element = (
        // @ts-expect-error user-cleared does not allow popover scale
        <EmptyState variant="user-cleared" scale="popover" title="You're all caught up" />
      );
      expect(element).toBeTruthy();
    });

    it("accepts sidebar scale on user-cleared", () => {
      const element = (
        <EmptyState variant="user-cleared" scale="sidebar" title="You're all caught up" />
      );
      expect(element).toBeTruthy();
    });
  });

  describe("accessibility", () => {
    it("does not expose role=status on the container (live region is caller-owned)", () => {
      const { container } = render(
        <EmptyState variant="zero-data" scale="canvas" title="No items" />
      );
      expect(container.querySelector('[role="status"]')).toBeNull();
    });

    it("does not set aria-live on the container (live region is caller-owned)", () => {
      const { container } = render(
        <EmptyState variant="zero-data" scale="canvas" title="No items" />
      );
      expect(container.querySelector("[aria-live]")).toBeNull();
    });

    it("hides icon decoration from assistive tech", () => {
      const { container } = render(
        <EmptyState
          variant="zero-data"
          scale="canvas"
          title="No items"
          icon={<svg data-testid="icon" />}
        />
      );
      const wrapper = container.querySelector('[aria-hidden="true"]');
      expect(wrapper).toBeTruthy();
      expect(wrapper?.querySelector('[data-testid="icon"]')).toBeTruthy();
    });

    it("wires aria-describedby to the description when one is present", () => {
      const { container } = render(
        <EmptyState
          variant="zero-data"
          scale="canvas"
          title="No items"
          description="Add one to get started"
        />
      );
      const wrapper = container.querySelector("[aria-describedby]");
      const describedById = wrapper?.getAttribute("aria-describedby");
      expect(describedById).toBeTruthy();
      const description = document.getElementById(describedById!);
      expect(description?.textContent).toBe("Add one to get started");
    });

    it("does not set aria-describedby when no description is present", () => {
      const { container } = render(
        <EmptyState variant="zero-data" scale="canvas" title="No items" />
      );
      const wrapper = container.querySelector<HTMLElement>('[class*="@container"]');
      expect(wrapper?.getAttribute("aria-describedby")).toBeNull();
    });
  });

  describe("animation", () => {
    it("applies motion-safe entry animation classes on the current cell", () => {
      const { container } = render(
        <EmptyState variant="zero-data" scale="canvas" title="No items" />
      );
      const inner = container.querySelector(".motion-safe\\:animate-in");
      expect(inner).toBeTruthy();
    });

    it("does not use transition-all", () => {
      const { container } = render(
        <EmptyState variant="zero-data" scale="canvas" title="No items" />
      );
      expect(container.innerHTML).not.toContain("transition-all");
    });
  });

  describe("fade-through transition", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("renders only the current cell on initial mount", () => {
      const { container } = render(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "fo"' />
      );
      // No outgoing cell — only the current title is rendered.
      expect(screen.getByText('No matches for "fo"')).toBeTruthy();
      expect(container.querySelectorAll(".motion-safe\\:animate-out").length).toBe(0);
    });

    it("renders both outgoing and incoming cells during a variant flip", () => {
      const { rerender, container } = render(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "fo"' />
      );
      rerender(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "foo"' />
      );
      // Outgoing cell mounted with the previous title.
      expect(screen.getByText('No matches for "fo"')).toBeTruthy();
      // Incoming cell mounted with the new title.
      expect(screen.getByText('No matches for "foo"')).toBeTruthy();
      // Exit-animation class is on the outgoing cell.
      expect(container.querySelectorAll(".motion-safe\\:animate-out").length).toBe(1);
    });

    it("wires onAnimationEnd on the outgoing cell to drive cleanup", () => {
      // The keyframe animationend event is the primary cleanup path. We can't
      // reliably trigger React's `onAnimationEnd` from jsdom (it doesn't route
      // synthetic AnimationEvents through React's event delegation), so we
      // verify the handler is bound; the safety-timeout test below covers the
      // fallback path that runs under reduced-motion / performance-mode where
      // the keyframe is suppressed and animationend never fires.
      const { rerender, container } = render(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "fo"' />
      );
      rerender(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "foo"' />
      );
      const outgoing = container.querySelector(".motion-safe\\:animate-out");
      expect(outgoing).toBeTruthy();
      // React stores props on the fiber, not the DOM, so we can't introspect
      // `onAnimationEnd` directly. Instead, assert the structural contract:
      // outgoing cell carries the exit-animation class and is mounted in
      // the same grid cell as the incoming cell.
      expect(outgoing?.className).toContain("[grid-area:1/1]");
      const incoming = container.querySelector(".motion-safe\\:animate-in");
      expect(incoming?.className).toContain("[grid-area:1/1]");
    });

    it("safety-timeout clears outgoing cell when animationend never fires", () => {
      const { rerender, container } = render(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "fo"' />
      );
      rerender(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "foo"' />
      );
      expect(container.querySelectorAll(".motion-safe\\:animate-out").length).toBe(1);
      act(() => {
        vi.advanceTimersByTime(260);
      });
      expect(container.querySelectorAll(".motion-safe\\:animate-out").length).toBe(0);
      expect(screen.queryByText('No matches for "fo"')).toBeNull();
    });

    it("restarts the animation when a new flip arrives mid-transition", () => {
      const { rerender, container } = render(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "fo"' />
      );
      rerender(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "foo"' />
      );
      // Mid-exit, a new flip arrives — the outgoing cell should now show "foo",
      // and the incoming should show "fooz".
      rerender(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "fooz"' />
      );
      expect(screen.getByText('No matches for "foo"')).toBeTruthy();
      expect(screen.getByText('No matches for "fooz"')).toBeTruthy();
      expect(screen.queryByText('No matches for "fo"')).toBeNull();
      expect(container.querySelectorAll(".motion-safe\\:animate-out").length).toBe(1);
    });

    it("marks the outgoing cell as aria-hidden", () => {
      const { rerender, container } = render(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "fo"' />
      );
      rerender(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "foo"' />
      );
      const outgoing = container.querySelector(".motion-safe\\:animate-out");
      expect(outgoing?.getAttribute("aria-hidden")).toBe("true");
    });

    it("marks the outgoing cell as inert so stale actions can't take focus", () => {
      // Regression guard: an `aria-hidden` cell still keeps its descendants
      // in the tab order. `inert` removes both. The stale `action` button in
      // an outgoing filtered-empty cell (e.g. "Clear search") would otherwise
      // be focusable for up to 250ms during the exit animation.
      const { rerender, container } = render(
        <EmptyState
          variant="filtered-empty"
          scale="popover"
          title='No matches for "fo"'
          action={<button data-testid="stale-action">Clear search</button>}
        />
      );
      rerender(
        <EmptyState
          variant="filtered-empty"
          scale="popover"
          title='No matches for "foo"'
          action={<button data-testid="fresh-action">Clear search</button>}
        />
      );
      const outgoing = container.querySelector(".motion-safe\\:animate-out");
      expect(outgoing?.hasAttribute("inert")).toBe(true);
    });
  });

  describe("instant prop", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("suppresses the outgoing cell during a flip", () => {
      const { rerender, container } = render(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "fo"' instant />
      );
      rerender(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "foo"' instant />
      );
      expect(container.querySelectorAll(".motion-safe\\:animate-out").length).toBe(0);
      expect(screen.queryByText('No matches for "fo"')).toBeNull();
      expect(screen.getByText('No matches for "foo"')).toBeTruthy();
    });
  });

  describe("instant prop (compile-time enforcement)", () => {
    it("rejects instant on user-cleared", () => {
      const element = (
        // @ts-expect-error user-cleared never carries instant
        <EmptyState variant="user-cleared" scale="canvas" title="You're all caught up" instant />
      );
      expect(element).toBeTruthy();
    });

    it("accepts instant on filtered-empty", () => {
      const element = (
        <EmptyState variant="filtered-empty" scale="sidebar" title="No matches" instant />
      );
      expect(element).toBeTruthy();
    });

    it("accepts instant on zero-data", () => {
      const element = <EmptyState variant="zero-data" scale="canvas" title="No items" instant />;
      expect(element).toBeTruthy();
    });
  });

  describe("container queries", () => {
    it("establishes a named container on the outer wrapper", () => {
      // The runtime fallback for wrong-scale usage and surface resize: density
      // collapses based on the actual rendered width via Tailwind v4's
      // `@container/empty-state` named-container utility.
      const { container } = render(
        <EmptyState variant="zero-data" scale="canvas" title="No items" />
      );
      const wrapper = container.querySelector<HTMLElement>('[class*="@container"]');
      expect(wrapper?.className).toContain("@container/empty-state");
    });

    it("ships compact-density variants on a descendant of the named container", () => {
      // The `@max-[280px]/empty-state:` prefix triggers when the outer
      // container's inline-size falls below 280px — comfortably above the
      // 200px minimum sidebar floor without affecting the 350px default.
      // Container queries can only style *descendants* of the container, so
      // density variants live on the icon wrapper, not on the container itself.
      // Uses scale="sidebar" so the pre-#9813 narrow-collapse tokens (h-4)
      // are still tested; canvas scale has its own collapse to h-6, covered
      // by the dedicated "scale sizing" suite below.
      const { container } = render(
        <EmptyState
          variant="zero-data"
          scale="sidebar"
          title="No items"
          icon={<svg data-testid="icon" />}
        />
      );
      const wrapper = container.querySelector<HTMLElement>('[class*="@container"]');
      // The container element itself cannot respond to its own queries, so we
      // assert the rule is NOT here — placing it here would be a silent no-op.
      expect(wrapper?.className).not.toContain("@max-[280px]/empty-state:py-");
      const iconWrap = container.querySelector('[aria-hidden="true"]');
      expect(iconWrap?.className).toContain("@max-[280px]/empty-state:[&_svg]:h-4");
      expect(iconWrap?.className).toContain("@max-[280px]/empty-state:[&_svg]:w-4");
    });
  });

  describe("scale sizing (issue #9813)", () => {
    // Canvas scale must carry extra visual weight so a single empty state
    // can hold its own on a full panel-grid canvas. Popover and sidebar
    // scales must remain byte-identical to their pre-#9813 classes — the
    // differential is the test, not the absolute values.

    function getIconWrap(container: HTMLElement) {
      return container.querySelector<HTMLElement>('[aria-hidden="true"]');
    }
    function getTitle(container: HTMLElement) {
      // The title is the first non-description paragraph in the current cell.
      const current = container.querySelector('[class*="motion-safe\\:animate-in"]');
      return current?.querySelector("p") as HTMLElement | null;
    }
    function getDescription(container: HTMLElement) {
      const current = container.querySelector('[class*="motion-safe\\:animate-in"]');
      const paragraphs = current?.querySelectorAll("p") ?? [];
      // The description is the second paragraph (title is the first).
      return (paragraphs[1] ?? null) as HTMLElement | null;
    }

    it("canvas icon wrapper uses a larger size than sidebar", () => {
      const { container: sidebarContainer } = render(
        <EmptyState
          variant="zero-data"
          scale="sidebar"
          title="No items"
          icon={<svg data-testid="icon" />}
        />
      );
      const { container: canvasContainer } = render(
        <EmptyState
          variant="zero-data"
          scale="canvas"
          title="No items"
          icon={<svg data-testid="icon" />}
        />
      );
      const sidebarWrap = getIconWrap(sidebarContainer);
      const canvasWrap = getIconWrap(canvasContainer);
      expect(sidebarWrap).toBeTruthy();
      expect(canvasWrap).toBeTruthy();
      // Canvas icon class is heavier than sidebar; sidebar must NOT carry the
      // canvas-only size token.
      expect(canvasWrap!.className).toContain("[&_svg]:h-10");
      expect(canvasWrap!.className).toContain("[&_svg]:w-10");
      expect(sidebarWrap!.className).not.toContain("[&_svg]:h-10");
      expect(sidebarWrap!.className).not.toContain("[&_svg]:w-10");
    });

    it("canvas title uses a larger, bolder type than sidebar", () => {
      const { container: sidebarContainer } = render(
        <EmptyState variant="zero-data" scale="sidebar" title="No items" />
      );
      const { container: canvasContainer } = render(
        <EmptyState variant="zero-data" scale="canvas" title="No items" />
      );
      const sidebarTitle = getTitle(sidebarContainer);
      const canvasTitle = getTitle(canvasContainer);
      expect(canvasTitle?.className).toContain("text-lg");
      expect(canvasTitle?.className).toContain("font-semibold");
      // Sidebar stays at the pre-#9813 size/weight — assert the differential
      // tokens are absent on the sidebar title.
      expect(sidebarTitle?.className).not.toContain("text-lg");
      expect(sidebarTitle?.className).not.toContain("font-semibold");
    });

    it("canvas description uses a larger default size than the narrow-collapse fallback", () => {
      // The discriminated union forbids description on popover/sidebar
      // (text-xs), so we assert the canvas default directly: the rendered
      // class must carry `text-sm` (the heavier default) and the only place
      // `text-xs` can appear is in the `@max-[280px]/empty-state:` narrow
      // collapse prefix.
      const { container } = render(
        <EmptyState
          variant="zero-data"
          scale="canvas"
          title="No items"
          description="desc"
        />
      );
      const canvasDesc = getDescription(container);
      expect(canvasDesc?.className).toContain("text-sm");
      expect(canvasDesc?.className).toContain(
        "@max-[280px]/empty-state:text-xs"
      );
      // The bare `text-xs` token (without a Tailwind v4 modifier prefix)
      // must NOT be the default — that would be a regression to the
      // pre-#9813 sidebar/popover size.
      const classes = canvasDesc?.className.split(/\s+/) ?? [];
      const bareTextXs = classes.filter((c) => c === "text-xs");
      expect(bareTextXs).toEqual([]);
    });

    it("canvas cell uses a larger gap than sidebar", () => {
      const { container: sidebarContainer } = render(
        <EmptyState variant="zero-data" scale="sidebar" title="No items" />
      );
      const { container: canvasContainer } = render(
        <EmptyState variant="zero-data" scale="canvas" title="No items" />
      );
      const sidebarCell = sidebarContainer.querySelector<HTMLElement>(
        '[class*="motion-safe\\:animate-in"]'
      );
      const canvasCell = canvasContainer.querySelector<HTMLElement>(
        '[class*="motion-safe\\:animate-in"]'
      );
      expect(canvasCell?.className).toContain("gap-3");
      // Sidebar cell keeps the pre-#9813 gap-2 (no gap-3 token).
      expect(sidebarCell?.className).not.toContain("gap-3");
    });

    it("canvas container-query collapse still brings the icon back to the popover size in narrow containers", () => {
      // The narrow-container collapse uses Tailwind v4 named-container
      // queries: `@max-[280px]/empty-state:` brings the canvas h-10 back
      // down to h-6 in a ≤280px container. The collapse class must always
      // be present on the canvas icon wrap so the JIT can compile it; the
      // runtime behavior is the browser's job.
      const { container } = render(
        <EmptyState
          variant="zero-data"
          scale="canvas"
          title="No items"
          icon={<svg data-testid="icon" />}
        />
      );
      const iconWrap = getIconWrap(container);
      expect(iconWrap?.className).toContain("@max-[280px]/empty-state:[&_svg]:h-6");
      expect(iconWrap?.className).toContain("@max-[280px]/empty-state:[&_svg]:w-6");
    });

    it("fade-through outgoing cell preserves the previous scale's gap (sidebar→canvas flip)", () => {
      // The outgoing cell in the fade-through transition uses the previous
      // props' scale, not the new one — otherwise the outgoing cell jumps
      // to the heavier canvas gap before the 100ms exit completes. The
      // outgoing scale must be threaded through (`outgoing.scale`), which
      // is the behavior the new cn() on the outgoing cell guards.
      const { rerender, container } = render(
        <EmptyState variant="zero-data" scale="sidebar" title="A" />
      );
      rerender(<EmptyState variant="zero-data" scale="canvas" title="B" />);
      const outgoing = container.querySelector<HTMLElement>(
        ".motion-safe\\:animate-out"
      );
      const incoming = container.querySelector<HTMLElement>(
        ".motion-safe\\:animate-in"
      );
      // Outgoing is the previous (sidebar) state — no canvas gap-3.
      expect(outgoing?.className).not.toContain("gap-3");
      // Incoming is the new (canvas) state — carries the canvas gap-3.
      expect(incoming?.className).toContain("gap-3");
    });
  });

  describe("className passthrough", () => {
    it("merges custom className on the container", () => {
      const { container } = render(
        <EmptyState
          variant="zero-data"
          scale="canvas"
          title="No items"
          className="my-custom-class"
        />
      );
      const wrapper = container.querySelector<HTMLElement>('[class*="@container"]');
      expect(wrapper?.className).toContain("my-custom-class");
    });
  });

  describe("falsy description handling", () => {
    it("does not render an empty paragraph when description is false", () => {
      const { container } = render(
        <EmptyState
          variant="zero-data"
          scale="canvas"
          title="No items"
          description={false as unknown as string}
        />
      );
      const paragraphs = container.querySelectorAll("p");
      // Only the title paragraph should render; no empty description paragraph.
      expect(paragraphs.length).toBe(1);
      expect(paragraphs[0]?.textContent).toBe("No items");
    });

    it("does not render an empty paragraph when description is null", () => {
      const { container } = render(
        <EmptyState variant="zero-data" scale="canvas" title="No items" description={null} />
      );
      expect(container.querySelectorAll("p").length).toBe(1);
    });
  });
});
