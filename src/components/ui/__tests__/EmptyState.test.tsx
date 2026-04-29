// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { EmptyState } from "../EmptyState";

describe("EmptyState", () => {
  describe("zero-data variant", () => {
    it("renders title", () => {
      render(<EmptyState variant="zero-data" title="No recipes yet" />);
      expect(screen.getByText("No recipes yet")).toBeTruthy();
    });

    it("renders description when provided", () => {
      render(
        <EmptyState
          variant="zero-data"
          title="No recipes yet"
          description="Add a recipe to get started"
        />
      );
      expect(screen.getByText("Add a recipe to get started")).toBeTruthy();
    });

    it("renders icon when provided", () => {
      render(
        <EmptyState variant="zero-data" title="No recipes yet" icon={<svg data-testid="icon" />} />
      );
      expect(screen.getByTestId("icon")).toBeTruthy();
    });

    it("renders action when provided", () => {
      render(
        <EmptyState
          variant="zero-data"
          title="No recipes yet"
          action={<button data-testid="cta">Add</button>}
        />
      );
      expect(screen.getByTestId("cta")).toBeTruthy();
    });
  });

  describe("filtered-empty variant", () => {
    it("renders title", () => {
      render(<EmptyState variant="filtered-empty" title='No matches for "foo"' />);
      expect(screen.getByText('No matches for "foo"')).toBeTruthy();
    });

    it("renders action when provided", () => {
      render(
        <EmptyState
          variant="filtered-empty"
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
        title: "No matches",
        icon: <svg data-testid="icon" />,
      } as unknown as React.ComponentProps<typeof EmptyState>;
      render(<EmptyState {...props} />);
      expect(screen.queryByTestId("icon")).toBeNull();
    });
  });

  describe("user-cleared variant", () => {
    it("renders title", () => {
      render(<EmptyState variant="user-cleared" title="You're all caught up" />);
      expect(screen.getByText("You're all caught up")).toBeTruthy();
    });

    it("renders icon when provided", () => {
      render(
        <EmptyState
          variant="user-cleared"
          title="You're all caught up"
          icon={<svg data-testid="icon" />}
        />
      );
      expect(screen.getByTestId("icon")).toBeTruthy();
    });

    it("does not render an action even if one is passed via type cast", () => {
      const props = {
        variant: "user-cleared",
        title: "You're all caught up",
        action: <button data-testid="cta">Should not appear</button>,
      } as unknown as React.ComponentProps<typeof EmptyState>;
      render(<EmptyState {...props} />);
      expect(screen.queryByTestId("cta")).toBeNull();
    });
  });

  describe("accessibility", () => {
    it('uses role="status" on the container', () => {
      render(<EmptyState variant="zero-data" title="No items" />);
      expect(screen.getByRole("status")).toBeTruthy();
    });

    it('sets aria-live="polite"', () => {
      render(<EmptyState variant="zero-data" title="No items" />);
      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-live")).toBe("polite");
    });

    it("hides icon decoration from assistive tech", () => {
      const { container } = render(
        <EmptyState variant="zero-data" title="No items" icon={<svg data-testid="icon" />} />
      );
      const wrapper = container.querySelector('[aria-hidden="true"]');
      expect(wrapper).toBeTruthy();
      expect(wrapper?.querySelector('[data-testid="icon"]')).toBeTruthy();
    });

    it("wires aria-describedby to the description when one is present", () => {
      render(
        <EmptyState variant="zero-data" title="No items" description="Add one to get started" />
      );
      const status = screen.getByRole("status");
      const describedById = status.getAttribute("aria-describedby");
      expect(describedById).toBeTruthy();
      const description = document.getElementById(describedById!);
      expect(description?.textContent).toBe("Add one to get started");
    });

    it("does not set aria-describedby when no description is present", () => {
      render(<EmptyState variant="zero-data" title="No items" />);
      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-describedby")).toBeNull();
    });
  });

  describe("animation", () => {
    it("applies motion-safe entry animation classes on inner content", () => {
      const { container } = render(<EmptyState variant="zero-data" title="No items" />);
      const inner = container.querySelector(".motion-safe\\:animate-in");
      expect(inner).toBeTruthy();
      expect(inner?.className).toContain("motion-safe:fade-in");
      expect(inner?.className).toContain("motion-safe:duration-150");
    });

    it("does not use transition-all", () => {
      const { container } = render(<EmptyState variant="zero-data" title="No items" />);
      expect(container.innerHTML).not.toContain("transition-all");
    });
  });

  describe("className passthrough", () => {
    it("merges custom className on the container", () => {
      render(<EmptyState variant="zero-data" title="No items" className="my-custom-class" />);
      const status = screen.getByRole("status");
      expect(status.className).toContain("my-custom-class");
    });
  });

  describe("falsy description handling", () => {
    it("does not render an empty paragraph when description is false", () => {
      const { container } = render(
        <EmptyState variant="zero-data" title="No items" description={false as unknown as string} />
      );
      const paragraphs = container.querySelectorAll("p");
      // Only the title paragraph should render; no empty description paragraph.
      expect(paragraphs.length).toBe(1);
      expect(paragraphs[0]?.textContent).toBe("No items");
    });

    it("does not render an empty paragraph when description is null", () => {
      const { container } = render(
        <EmptyState variant="zero-data" title="No items" description={null} />
      );
      expect(container.querySelectorAll("p").length).toBe(1);
    });
  });
});
