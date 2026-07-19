// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SurfaceHeader,
  SurfaceHeaderTitle,
  SurfaceHeaderCloseButton,
  surfaceHeaderVariants,
} from "../SurfaceHeader";

// Utility-group helpers: assertions target the *relationships* between the
// density variants rather than their literal class strings, so restyling the
// primitive does not force a matching test edit.
function classesOf(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

function matching(el: HTMLElement, pattern: RegExp): string[] {
  return classesOf(el).filter((c) => pattern.test(c));
}

describe("surfaceHeaderVariants", () => {
  it("defaults to the comfortable density", () => {
    expect(surfaceHeaderVariants({})).toBe(surfaceHeaderVariants({ density: "comfortable" }));
  });

  it("emits a distinct class set per density", () => {
    expect(surfaceHeaderVariants({ density: "compact" })).not.toBe(
      surfaceHeaderVariants({ density: "comfortable" })
    );
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
  it("lets a caller replace same-group density utilities", () => {
    // Mirrors CrossWorktreeDiff's override shape.
    render(
      <SurfaceHeader data-testid="header" className="px-4 py-3 border-b border-border-subtle">
        <span>Title</span>
      </SurfaceHeader>
    );
    const classes = classesOf(screen.getByTestId("header"));

    expect(classes).toContain("px-4");
    expect(classes).toContain("py-3");
    expect(classes).not.toContain("px-6");
    expect(classes).not.toContain("py-4");
  });

  it("keeps the plain background class alongside an important override", () => {
    // The background lives on a bare CSS class, not a Tailwind utility, so
    // `!bg-transparent` cascades over it instead of being merged away.
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
    render(
      <SurfaceHeaderTitle className="text-sm">
        Compact
      </SurfaceHeaderTitle>
    );
    const classes = classesOf(screen.getByRole("heading"));

    expect(classes).toContain("text-sm");
    expect(classes).not.toContain("text-lg");
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
