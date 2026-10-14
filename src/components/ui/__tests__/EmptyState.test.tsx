// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { EmptyState } from "../EmptyState";

describe("EmptyState", () => {
  describe("filtered-empty variant", () => {
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
      expect(container.querySelectorAll(".animate-out").length).toBe(0);
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
      expect(container.querySelectorAll(".animate-out").length).toBe(1);
    });

    it("safety-timeout clears outgoing cell when animationend never fires", () => {
      const { rerender, container } = render(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "fo"' />
      );
      rerender(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "foo"' />
      );
      expect(container.querySelectorAll(".animate-out").length).toBe(1);
      act(() => {
        vi.advanceTimersByTime(260);
      });
      expect(container.querySelectorAll(".animate-out").length).toBe(0);
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
      expect(container.querySelectorAll(".animate-out").length).toBe(1);
    });

    it("marks the outgoing cell as aria-hidden", () => {
      const { rerender, container } = render(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "fo"' />
      );
      rerender(
        <EmptyState variant="filtered-empty" scale="sidebar" title='No matches for "foo"' />
      );
      const outgoing = container.querySelector(".animate-out");
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
      const outgoing = container.querySelector(".animate-out");
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
      expect(container.querySelectorAll(".animate-out").length).toBe(0);
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
  });

  describe("scale sizing (issue #9813)", () => {
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
      const outgoing = container.querySelector<HTMLElement>(".animate-out");
      const incoming = container.querySelector<HTMLElement>(".animate-in");
      // Outgoing is the previous (sidebar) state — no canvas gap-3.
      expect(outgoing?.className).not.toContain("gap-3");
      // Incoming is the new (canvas) state — carries the canvas gap-3.
      expect(incoming?.className).toContain("gap-3");
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
