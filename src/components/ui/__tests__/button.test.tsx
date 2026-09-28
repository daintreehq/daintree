// @vitest-environment jsdom
import { render, fireEvent } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, vi } from "vitest";

import { Button, buttonVariants } from "../button";

describe("buttonVariants", () => {
  it("uses specific transition instead of transition-all", () => {
    const classes = buttonVariants();
    expect(classes).not.toContain("transition-all");
    // Should contain the base "transition" utility (word boundary check)
    expect(classes).toMatch(/(?:^|\s)transition(?:\s|$)/);
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
    expect(content.className).not.toContain("opacity-0");
  });

  // Regression: #8843 — the content wrapper must be transparent to layout when
  // not loading, so caller patterns like `w-full justify-between` + `truncate`
  // reach the actual text/chevron row. `display: contents` is what makes the
  // wrapper's children behave as direct flex items of the <button>.
  it("renders the content wrapper as display:contents when not loading", () => {
    const { container } = render(
      <Button className="w-full justify-between">
        <span className="truncate">label</span>
        <svg data-testid="chevron" />
      </Button>
    );
    const content = container.querySelector('[data-slot="button-content"]')!;
    expect(content.className).toBe("contents");
    expect(content.className).not.toContain("inline-flex");
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
    // Hidden, not removed: the label keeps the button's width and its name.
    expect(content.className).toContain("opacity-0");
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
    // Spinner sizes its rotating wrapper; the glyph fills it.
    expect(
      sm.container.querySelector('[data-slot="button-spinner"] svg')!.parentElement!.className
    ).toContain("w-3.5");

    const xs = render(
      <Button loading size="xs">
        Save
      </Button>
    );
    expect(
      xs.container.querySelector('[data-slot="button-spinner"] svg')!.parentElement!.className
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
    const content = container.querySelector('[data-slot="button-content"]')!;
    expect(content.className).not.toContain("opacity-0");
    // Wrapper must return to display:contents so caller layout (truncate,
    // justify-between) keeps working after loading resolves.
    expect(content.className).toBe("contents");
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

describe("link variant", () => {
  const classesOf = (element: HTMLElement) => new Set(element.className.split(/\s+/));

  it("is underlined at rest, not only on hover", () => {
    const { container } = render(<Button variant="link">Retry</Button>);
    const classes = classesOf(container.querySelector("button")!);
    expect(classes.has("underline")).toBe(true);
  });

  // A link sits inside a sentence: without an explicit size it must not take
  // the default button frame, and must not force a type size of its own.
  it("takes no box and no font size unless a size is asked for", () => {
    const { container } = render(<Button variant="link">Retry</Button>);
    const classes = [...classesOf(container.querySelector("button")!)];
    const frame = buttonVariants({ size: "default" }).split(/\s+/);
    const fontSizes = classes.filter((c) => /^text-(xs|sm|base|lg|[0-9]xs)$/.test(c));
    expect(classes.filter((c) => /^(h|px|py)-/.test(c) && frame.includes(c))).toEqual([]);
    expect(fontSizes).toEqual([]);
  });

  it("still honours an explicit size", () => {
    const { container } = render(
      <Button variant="link" size="sm">
        Retry
      </Button>
    );
    expect(classesOf(container.querySelector("button")!).has("h-7")).toBe(true);
  });

  it("keeps a type size on every boxed size, so moving it off the base changed nothing", () => {
    for (const size of ["default", "sm", "xs", "lg", "icon", "icon-sm", "icon-xs"] as const) {
      expect(buttonVariants({ size }), size).toMatch(/(?:^|\s)text-(sm|xs|3xs)(?:\s|$)/);
    }
  });

  // Both high-contrast blocks frame every button; a link's underline is its
  // affordance there, so each block must exempt it independently.
  it("is exempt from the high-contrast button frame in both media blocks", () => {
    const css = readFileSync(resolve(__dirname, "../../../index.css"), "utf-8");
    for (const marker of ["@media (forced-colors: active)", "@media (prefers-contrast: more)"]) {
      const start = css.indexOf(marker);
      expect(start, `${marker} block is missing`).toBeGreaterThan(-1);
      let depth = 0;
      let end = css.indexOf("{", start);
      for (let i = end; i < css.length; i++) {
        if (css[i] === "{") depth++;
        if (css[i] === "}" && --depth === 0) {
          end = i;
          break;
        }
      }
      expect(css.slice(start, end), marker).toContain('[data-variant="link"]');
    }
  });
});
