// @vitest-environment jsdom
import { render, fireEvent } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, vi } from "vitest";
import { getOverlayContrastWarnings } from "@shared/theme/colorValidator";
import { BUILT_IN_APP_SCHEMES } from "@shared/theme/themes";
import type { AppColorScheme } from "@shared/theme/types";

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

  // Busy outranks unavailable: a caller that also passes `disabled`, or its own
  // disabled dimming, must neither drop focus nor fade the spinner.
  it("stays focusable and undimmed when loading and disabled together", () => {
    const { container } = render(
      <Button loading disabled className="aria-disabled:opacity-50 disabled:opacity-40">
        Save
      </Button>
    );
    const button = container.querySelector("button")!;
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const dimming = button.className
      .split(/\s+/)
      .filter((c) => /^(aria-)?disabled:opacity-/.test(c));
    expect(dimming.every((c) => c.endsWith("opacity-100"))).toBe(true);
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

  it("passes a consumer's aria-busy through when not loading", () => {
    const { container } = render(<Button aria-busy>Refresh</Button>);
    expect(container.querySelector("button")!.getAttribute("aria-busy")).toBe("true");
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

describe("ghost hover fill", () => {
  const hoverToken = () => {
    const match = /(?:^|\s)hover:bg-([a-z-]+)(?:\s|$)/.exec(buttonVariants({ variant: "ghost" }));
    expect(match, "ghost has no hover fill").toBeTruthy();
    return match![1] ?? "";
  };

  // The ghost hover is the most-used interactive fill in the app, so it has to
  // be a token the theme validator holds to a perceptible floor. A weak value
  // for that token must be reported; if the ghost moves to a token the
  // validator does not read, the weak value goes unreported and this fails.
  it("uses the overlay token the theme validator floors", () => {
    const token = hoverToken();
    const base = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "light")!;
    const scheme = (value: string): AppColorScheme => ({
      ...base,
      tokens: { ...base.tokens, [token]: value },
    });
    expect(getOverlayContrastWarnings(scheme("rgba(0, 0, 0, 0.01)"))).toHaveLength(1);
    expect(getOverlayContrastWarnings(scheme("rgba(0, 0, 0, 0.3)"))).toHaveLength(0);
  });
  // Ghost Buttons double as pressed toggles (aria-pressed) that mark the
  // pressed state with `overlay-active`. That fill has to stay heavier than
  // the ghost hover in every theme, or hovering an unpressed toggle reads as
  // pressing it.
  it("stays lighter than a pressed ghost toggle in every built-in theme", () => {
    const alpha = (value: string) => Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(value)?.[1] ?? NaN);
    for (const theme of BUILT_IN_APP_SCHEMES) {
      const hover = alpha(theme.tokens[hoverToken() as keyof typeof theme.tokens]);
      const pressed = alpha(theme.tokens["overlay-active"]);
      expect(pressed, theme.id).toBeGreaterThan(hover);
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
      expect(buttonVariants({ size }), size).toMatch(/(?:^|\s)text-(sm|xs|2xs|3xs)(?:\s|$)/);
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
