// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Callout, CALLOUT_ICON, type CalloutSeverity } from "../Callout";
import { InlineError } from "../field";
import { InlineStatusBanner, SEVERITY_ICON } from "@/components/Terminal/InlineStatusBanner";
import { InsetSurface } from "../insetSurface";

const SEVERITIES: CalloutSeverity[] = ["error", "warning", "danger"];

describe("Callout", () => {
  it("draws each severity with the glyph the pane banners use for it", () => {
    expect(CALLOUT_ICON.error).toBe(SEVERITY_ICON.error);
    expect(CALLOUT_ICON.warning).toBe(SEVERITY_ICON.warning);
  });

  it("tells a failure from a caution by shape, not only by ink", () => {
    // `danger` shares the error's ink, so its glyph is the only non-colour
    // channel separating "this failed" from "this will destroy something".
    expect(CALLOUT_ICON.danger).not.toBe(CALLOUT_ICON.error);
  });

  it.each(SEVERITIES)("keeps the %s callout's words on the neutral ramp", (severity) => {
    const { container } = render(
      <Callout severity={severity} title="Couldn't delete worktree">
        <p>fatal: worktree is dirty</p>
      </Callout>
    );
    const root = container.firstElementChild;
    for (const el of root?.querySelectorAll("[class]") ?? []) {
      if (el.tagName.toLowerCase() === "svg") continue;
      expect(el.getAttribute("class"), el.outerHTML).not.toMatch(/\btext-status-/);
    }
    expect(root?.getAttribute("class")).toContain("rounded-[var(--radius-md)]");
  });

  it("announces nothing unless the caller asks it to", () => {
    const { container } = render(<Callout severity="error">Failed</Callout>);
    expect(container.firstElementChild?.getAttribute("role")).toBeNull();
  });
});

describe("InlineError", () => {
  it("is silent by default, so per-keystroke validation never interrupts typing", () => {
    const { container } = render(<InlineError id="e">Name is required</InlineError>);
    const el = container.firstElementChild;
    expect(el?.getAttribute("role")).toBeNull();
    expect(el?.getAttribute("aria-live")).toBeNull();
    expect(el?.getAttribute("class")).not.toMatch(/\btext-status-/);
  });
});

describe("InlineStatusBanner inside inset content", () => {
  it("draws a whole box, not a pane's bottom-edge band", () => {
    const { container } = render(
      <InsetSurface>
        <InlineStatusBanner severity="error" title="Couldn't clone" animated={false} />
      </InsetSurface>
    );
    const root = container.querySelector<HTMLElement>("[data-inline-status-banner]");
    expect(root?.getAttribute("class")).toContain("rounded-[var(--radius-md)]");
    expect(root?.style.borderBottom).toBe("");
    expect(root?.style.border).toContain("20%");
  });

  it("stays an edge-to-edge band at a pane's top", () => {
    const { container } = render(
      <InlineStatusBanner severity="error" title="Session ended" animated={false} />
    );
    const root = container.querySelector<HTMLElement>("[data-inline-status-banner]");
    expect(root?.getAttribute("class")).not.toContain("rounded-");
    expect(root?.style.borderBottom).toContain("20%");
  });
});
