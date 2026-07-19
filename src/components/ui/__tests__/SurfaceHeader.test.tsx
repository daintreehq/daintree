// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SurfaceHeader, SurfaceHeaderTitle, SurfaceHeaderCloseButton } from "../SurfaceHeader";

// Utility-group helpers: assertions target the *relationships* between the
// density variants rather than their literal class strings, so restyling the
// primitive does not force a matching test edit.
function classesOf(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

function matching(el: HTMLElement, pattern: RegExp): string[] {
  return classesOf(el).filter((c) => pattern.test(c));
}

describe("SurfaceHeader default density", () => {
  it("renders an omitted density identically to an explicit comfortable one", () => {
    // AppDialog.Header deliberately omits `density`, so the default is what
    // every dialog in the app actually renders.
    const { unmount } = render(
      <SurfaceHeader data-testid="header">
        <span>Title</span>
      </SurfaceHeader>
    );
    const defaulted = screen.getByTestId("header").className;
    unmount();

    render(
      <SurfaceHeader density="comfortable" data-testid="header">
        <span>Title</span>
      </SurfaceHeader>
    );

    expect(screen.getByTestId("header").className).toBe(defaulted);
  });
});

describe("SurfaceHeader density geometry", () => {
  it("sizes compact by a fixed height with no vertical padding", () => {
    render(
      <SurfaceHeader density="compact" data-testid="header">
        <span>Title</span>
      </SurfaceHeader>
    );
    const header = screen.getByTestId("header");

    // A `py-*` alongside `h-8` would fight the fixed panel-chrome height.
    expect(matching(header, /^py-/)).toHaveLength(0);
    expect(matching(header, /^h-/)).toHaveLength(1);
  });

  it("sizes comfortable by vertical padding with no fixed height", () => {
    render(
      <SurfaceHeader density="comfortable" data-testid="header">
        <span>Title</span>
      </SurfaceHeader>
    );
    const header = screen.getByTestId("header");

    expect(matching(header, /^py-/)).toHaveLength(1);
    expect(matching(header, /^h-/)).toHaveLength(0);
  });

  it("declares exactly one utility per conflicting group in both densities", () => {
    for (const density of ["compact", "comfortable"] as const) {
      const { unmount } = render(
        <SurfaceHeader density={density} data-testid="header">
          <span>Title</span>
        </SurfaceHeader>
      );
      const header = screen.getByTestId("header");

      expect(matching(header, /^px-/), `${density} horizontal padding`).toHaveLength(1);
      expect(matching(header, /^border-b$/), `${density} bottom border`).toHaveLength(1);
      unmount();
    }
  });
});

describe("SurfaceHeader composition", () => {
  it("renders arbitrary children in order", () => {
    render(
      <SurfaceHeader data-testid="header">
        <div>
          <span>Leading</span>
          <span>Badge</span>
        </div>
        <button type="button">Trailing</button>
      </SurfaceHeader>
    );

    expect(screen.getByTestId("header").textContent).toBe("LeadingBadgeTrailing");
  });

  it("forwards a ref to the underlying element", () => {
    const ref = { current: null as HTMLDivElement | null };
    render(
      <SurfaceHeader ref={ref}>
        <span>Title</span>
      </SurfaceHeader>
    );

    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it("forwards arbitrary DOM attributes", () => {
    render(
      <SurfaceHeader data-testid="header" role="group" aria-label="Panel chrome">
        <span>Title</span>
      </SurfaceHeader>
    );

    expect(screen.getByTestId("header").getAttribute("aria-label")).toBe("Panel chrome");
  });
});

describe("SurfaceHeader className merging", () => {
  it("leaves the caller as the sole winner in every group it overrides", () => {
    // Mirrors CrossWorktreeDiff's override shape. Asserting group cardinality
    // (not just presence) is what catches a merge that concatenates instead of
    // replacing, leaving both utilities to fight in CSS source order.
    render(
      <SurfaceHeader data-testid="header" className="px-4 py-3 border-b border-border-subtle">
        <span>Title</span>
      </SurfaceHeader>
    );
    const header = screen.getByTestId("header");

    expect(matching(header, /^px-/)).toEqual(["px-4"]);
    expect(matching(header, /^py-/)).toEqual(["py-3"]);
    expect(matching(header, /^border-border-/)).toEqual(["border-border-subtle"]);
  });

  it("preserves a non-Tailwind class the caller did not override", () => {
    // The background lives on a bare CSS class rather than a Tailwind utility,
    // so twMerge must pass it through untouched for the cascade to reach it.
    render(
      <SurfaceHeader data-testid="header" className="!bg-transparent">
        <span>Title</span>
      </SurfaceHeader>
    );
    const classes = classesOf(screen.getByTestId("header"));

    expect(classes).toContain("dialog-header");
    expect(classes).toContain("!bg-transparent");
  });
});

describe("SurfaceHeaderTitle", () => {
  it("renders an h2 by default", () => {
    render(<SurfaceHeaderTitle>Dialog</SurfaceHeaderTitle>);

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Dialog");
  });

  it("renders an h3 when asked", () => {
    render(<SurfaceHeaderTitle as="h3">Section</SurfaceHeaderTitle>);

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Section");
  });

  it("renders the icon ahead of the children", () => {
    render(
      <SurfaceHeaderTitle icon={<span data-testid="icon">*</span>}>Labelled</SurfaceHeaderTitle>
    );

    expect(screen.getByRole("heading").textContent).toBe("*Labelled");
  });

  it("lets a caller override the default type scale", () => {
    // The file viewers rely on this to shrink the title; a merge that kept both
    // sizes would resolve by stylesheet order rather than by the caller.
    render(<SurfaceHeaderTitle className="text-sm">Compact</SurfaceHeaderTitle>);

    expect(matching(screen.getByRole("heading"), /^text-(xs|sm|base|lg|xl)$/)).toEqual(["text-sm"]);
  });

  it("forwards an id so a dialog can point aria-labelledby at it", () => {
    render(<SurfaceHeaderTitle id="title-1">Titled</SurfaceHeaderTitle>);

    expect(screen.getByRole("heading").getAttribute("id")).toBe("title-1");
  });
});

describe("SurfaceHeaderCloseButton", () => {
  it("renders a non-submitting button carrying the supplied label", () => {
    render(<SurfaceHeaderCloseButton aria-label="Close settings" />);
    const button = screen.getByRole("button", { name: "Close settings" });

    // Defaulting to type="submit" inside a form would submit it on close.
    expect(button.getAttribute("type")).toBe("button");
  });

  it("invokes its click handler", () => {
    const onClick = vi.fn();
    render(<SurfaceHeaderCloseButton aria-label="Close dialog" onClick={onClick} />);

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
