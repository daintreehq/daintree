// @vitest-environment jsdom
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button, buttonVariants } from "../button";

describe("buttonVariants", () => {
  it("includes cursor-pointer in the base classes", () => {
    const classes = buttonVariants();
    expect(classes).toContain("cursor-pointer");
  });

  it("uses specific transition instead of transition-all", () => {
    const classes = buttonVariants();
    expect(classes).not.toContain("transition-all");
    // Should contain the base "transition" utility (word boundary check)
    expect(classes).toMatch(/(?:^|\s)transition(?:\s|$)/);
  });

  it("uses asymmetric press timing (1ms down, base duration on release)", () => {
    // Defends against Chromium bug 41304139 where transition-duration: 0s is
    // sometimes ignored. 1ms is imperceptible but unambiguously non-zero.
    const classes = buttonVariants();
    expect(classes).toContain("active:scale-[0.98]");
    expect(classes).toContain("active:duration-[1ms]");
    expect(classes).toContain("duration-150");
  });

  it("positions relative so the loading overlay can absolutely center", () => {
    expect(buttonVariants()).toContain("relative");
  });

  it("includes cursor-pointer across all variants", () => {
    const variants = [
      "default",
      "destructive",
      "outline",
      "secondary",
      "ghost",
      "link",
      "subtle",
      "pill",
      "ghost-danger",
      "ghost-success",
      "ghost-info",
      "info",
      "glow",
      "vibrant",
    ] as const;

    for (const variant of variants) {
      expect(buttonVariants({ variant })).toContain("cursor-pointer");
    }
  });
});

describe("Button loading state", () => {
  it("does not render the spinner overlay or dim content when not loading", () => {
    const { container } = render(<Button>Save</Button>);
    const button = container.querySelector("button")!;
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.hasAttribute("data-loading")).toBe(false);
    expect(container.querySelector('[data-slot="button-spinner"]')).toBeNull();
    const content = container.querySelector('[data-slot="button-content"]')!;
    expect(content.className).not.toContain("opacity-30");
  });

  it("renders an aria-hidden spinner overlay and sets ARIA state when loading", () => {
    const { container } = render(<Button loading>Save</Button>);
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("data-loading")).toBe("true");
    // Native disabled must NOT be set — it would drop focus.
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.className).toContain("pointer-events-none");

    const spinner = container.querySelector('[data-slot="button-spinner"]')!;
    expect(spinner).toBeTruthy();
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    expect(spinner.className).toContain("pointer-events-none");
    expect(spinner.querySelector("svg")).toBeTruthy();

    const content = container.querySelector('[data-slot="button-content"]')!;
    expect(content.className).toContain("opacity-30");
    expect(content.textContent).toBe("Save");
  });

  it("blocks onClick while loading and fires it otherwise", () => {
    const onClick = vi.fn();
    const { container, rerender } = render(
      <Button loading onClick={onClick}>
        Save
      </Button>
    );
    const button = container.querySelector("button")!;
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    rerender(<Button onClick={onClick}>Save</Button>);
    fireEvent.click(container.querySelector("button")!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("still honors an explicit disabled prop alongside aria-disabled", () => {
    const { container } = render(<Button disabled>Save</Button>);
    const button = container.querySelector("button")!;
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });

  it("scales the spinner with the button size variant", () => {
    const sm = render(
      <Button loading size="sm">
        Save
      </Button>
    );
    expect(
      sm.container.querySelector('[data-slot="button-spinner"] svg')!.getAttribute("class")
    ).toContain("w-3.5");

    const xs = render(
      <Button loading size="xs">
        Save
      </Button>
    );
    expect(
      xs.container.querySelector('[data-slot="button-spinner"] svg')!.getAttribute("class")
    ).toContain("w-3");
  });

  it("merges into the slotted child when asChild without breaking", () => {
    const { container } = render(
      <Button asChild loading>
        <a href="/x">Link</a>
      </Button>
    );
    const anchor = container.querySelector("a")!;
    expect(anchor).toBeTruthy();
    expect(anchor.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[data-slot="button-spinner"]')).toBeTruthy();
  });

  it("does not let a consumer override the loading ARIA state", () => {
    const { container } = render(
      <Button loading aria-busy={false} aria-disabled={false}>
        Save
      </Button>
    );
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });

  it("preserves consumer aria-disabled when not loading", () => {
    const { container } = render(<Button aria-disabled="true">Save</Button>);
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("clears all loading affordances when rerendered to not loading", () => {
    const { container, rerender } = render(<Button loading>Save</Button>);
    expect(container.querySelector('[data-slot="button-spinner"]')).toBeTruthy();

    rerender(<Button>Save</Button>);
    const button = container.querySelector("button")!;
    expect(container.querySelector('[data-slot="button-spinner"]')).toBeNull();
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.hasAttribute("data-loading")).toBe(false);
    expect(container.querySelector('[data-slot="button-content"]')!.className).not.toContain(
      "opacity-30"
    );
  });

  it("preserves the accessible name on an icon-only loading button", () => {
    const { getByRole } = render(
      <Button loading size="icon" aria-label="Delete">
        <svg />
      </Button>
    );
    expect(getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("does not submit a form while loading via click or keyboard", () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    const { container } = render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Save
        </Button>
      </form>
    );
    const button = container.querySelector("button")!;
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders a spinner for every size variant", () => {
    const sizes = ["default", "sm", "xs", "lg", "icon", "icon-sm", "icon-xs"] as const;
    for (const size of sizes) {
      const { container } = render(
        <Button loading size={size}>
          Go
        </Button>
      );
      const spinner = container.querySelector('[data-slot="button-spinner"]')!;
      expect(spinner).toBeTruthy();
      expect(spinner.querySelector("svg")).toBeTruthy();
    }
  });
});
