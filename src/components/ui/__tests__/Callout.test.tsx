// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KeyRound } from "lucide-react";

import { Callout, CALLOUT_ICON, type CalloutSeverity } from "../Callout";
import { InlineError } from "../field";
import { InlineStatusBanner, SEVERITY_ICON } from "@/components/Terminal/InlineStatusBanner";
import { InsetSurface } from "../insetSurface";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";

const SEVERITIES: CalloutSeverity[] = ["error", "warning", "danger", "success", "info", "neutral"];

describe("Callout", () => {
  it("draws each shared severity with the glyph the pane banners and toasts use for it", () => {
    for (const level of ["error", "warning", "success", "info"] as const) {
      expect(CALLOUT_ICON[level]).toBe(SEVERITY_GLYPH[level]);
      expect(CALLOUT_ICON[level]).toBe(SEVERITY_ICON[level]);
    }
    expect(CALLOUT_ICON.neutral).toBe(SEVERITY_ICON.neutral);
  });

  it("gives every tone with a severity a shape of its own", () => {
    // Under forced colours the ink is gone and the shape is all that separates
    // "this failed" from "this will destroy something" from "watch out". Only
    // neutral, which has no severity, shares info's mark.
    const graded = SEVERITIES.filter((s) => s !== "neutral").map((s) => CALLOUT_ICON[s]);
    expect(new Set(graded).size).toBe(graded.length);
  });

  it("lets a neutral callout carry a domain glyph and ignores one on any other tone", () => {
    const { container: neutral } = render(
      <Callout severity="neutral" icon={KeyRound}>
        Sign-in not detected
      </Callout>
    );
    expect(neutral.querySelector("svg.lucide-key-round")).not.toBeNull();

    const { container: error } = render(
      <Callout severity="error" icon={KeyRound}>
        Failed
      </Callout>
    );
    expect(error.querySelector("svg.lucide-key-round")).toBeNull();
    expect(error.querySelector("svg.lucide-circle-x")).not.toBeNull();
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

  it("sets the action beside the message in one row, apart from the root", () => {
    // jsdom draws nothing, so this pins the topology the wrap depends on: the
    // action is the message's sibling in a row of its own, not a third column
    // of the root that keeps its width while the words collapse.
    const { container, getByRole, getByText } = render(
      <Callout
        severity="warning"
        title="Folder isn't empty"
        action={<button type="button">Use suggested folder</button>}
      >
        /Users/someone/Projects/a-very-long-folder-name/that-keeps-going
      </Callout>
    );
    const body = getByText(/a-very-long-folder-name/);
    const title = getByText("Folder isn't empty");
    const slot = getByRole("button", { name: "Use suggested folder" }).parentElement;
    const row = body.parentElement;

    expect(title.parentElement).toBe(body);
    expect(slot?.parentElement).toBe(row);
    expect(body.contains(slot ?? null)).toBe(false);
    expect(row?.parentElement).toBe(container.firstElementChild);
  });

  it("holds a dismiss control outside the row an action wraps in", () => {
    const { container, getByRole, getByText } = render(
      <Callout
        severity="info"
        action={<button type="button">Retry</button>}
        dismiss={<button type="button">Dismiss</button>}
      >
        Saved
      </Callout>
    );
    const row = getByText("Saved").parentElement;
    const dismissSlot = getByRole("button", { name: "Dismiss" }).parentElement;

    expect(getByRole("button", { name: "Retry" }).parentElement?.parentElement).toBe(row);
    expect(dismissSlot?.parentElement).toBe(container.firstElementChild);
    expect(row?.contains(dismissSlot ?? null)).toBe(false);
  });

  it("keeps the message mounted when an action comes or goes", () => {
    const typed = "typed before the retry appeared";
    const body = (action?: ReactNode) => (
      <Callout severity="error" action={action}>
        <input aria-label="Note" defaultValue="" />
      </Callout>
    );
    const { getByRole, rerender } = render(body());
    const input = getByRole("textbox", { name: "Note" }) as HTMLInputElement;
    input.value = typed;

    for (const action of [<button type="button">Retry</button>, undefined]) {
      rerender(body(action));
      const current = getByRole("textbox", { name: "Note" }) as HTMLInputElement;
      expect(current).toBe(input);
      expect(current.value).toBe(typed);
    }
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
