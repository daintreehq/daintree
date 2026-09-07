/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CollapsedAlarmPill } from "../CollapsedAlarmPill";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AlarmDescriptor } from "@/lib/worktreeAlarmTier";

/**
 * Rendered against the REAL overlay primitives — `vitest.setup.ts` primes the
 * deferred chunk before any suite runs, so there is nothing to stub. That
 * matters more than the convenience: a fake trigger renders whatever it is
 * told to, and the two things most worth proving here are that the badge stays
 * the whole trigger under `asChild` (no button wrapped around it to steal the
 * row's click) and that hover still opens the tooltip now the label lives
 * behind one.
 */

afterEach(cleanup);

const none: AlarmDescriptor = { tier: 0, kind: "none", label: "", tone: "none" };
const behind: AlarmDescriptor = { tier: 1, kind: "behind", label: "Behind", tone: "warning" };
const authFailed: AlarmDescriptor = {
  tier: 2,
  kind: "auth-failed",
  label: "Auth failed",
  tone: "warning",
};
const ciFailed: AlarmDescriptor = {
  tier: 3,
  kind: "ci-failed",
  label: "CI failed",
  tone: "error",
};

const KINDS = [behind, authFailed, ciFailed];

function renderPill(alarm: AlarmDescriptor, detail?: string) {
  const { container } = render(
    <TooltipProvider delayDuration={0}>
      <CollapsedAlarmPill alarm={alarm} detail={detail} />
    </TooltipProvider>
  );
  return { pill: screen.getByTestId("collapsed-alarm-pill"), container };
}

describe("CollapsedAlarmPill", () => {
  it("renders nothing for tier 0", () => {
    const { container } = render(
      <TooltipProvider delayDuration={0}>
        <CollapsedAlarmPill alarm={none} />
      </TooltipProvider>
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders CI failed chip with error tone", () => {
    const { pill } = renderPill(ciFailed);
    expect(pill.getAttribute("data-tone")).toBe("error");
    expect(pill.getAttribute("data-alarm-kind")).toBe("ci-failed");
  });

  it("renders auth-failed chip with warning tone", () => {
    const { pill } = renderPill(authFailed);
    expect(pill.getAttribute("data-tone")).toBe("warning");
    expect(pill.getAttribute("data-alarm-kind")).toBe("auth-failed");
  });

  it("renders behind chip with warning tone", () => {
    const { pill } = renderPill(behind);
    expect(pill.getAttribute("data-tone")).toBe("warning");
    expect(pill.getAttribute("data-alarm-kind")).toBe("behind");
  });

  it("carries no words of its own — that is the whole point of the change", () => {
    // The label used to sit inline and out-shout the branch name beside it.
    for (const alarm of KINDS) {
      const { pill } = renderPill(alarm);
      expect(pill.textContent, `${alarm.kind} still renders text`).toBe("");
      expect(pill.querySelectorAll("svg").length, `${alarm.kind} glyph count`).toBe(1);
      cleanup();
    }
  });

  it("gives every kind its own glyph, so forced colors has a shape to tell them apart", () => {
    // With the label gone, tone is the only other channel — and forced colors
    // repaints all three the same. If these silhouettes collapsed into one, a
    // high-contrast reader could not tell a stale branch from a broken build.
    const glyphs = KINDS.map((alarm) => {
      const { pill } = renderPill(alarm);
      const svg = pill.querySelector("svg")?.innerHTML;
      cleanup();
      return svg;
    });
    expect(glyphs.every(Boolean), "a kind renders no glyph at all").toBe(true);
    expect(new Set(glyphs).size, "two alarm kinds share a glyph").toBe(glyphs.length);
  });

  it("speaks the label and the detail through its accessible name", () => {
    // The trigger is deliberately not focusable, so the tooltip is a
    // pointer-only surface and the name is the only place a screen-reader
    // user hears the rest of it.
    const { pill } = renderPill(behind, "Upstream: 3 commits behind");
    expect(pill.getAttribute("role")).toBe("img");
    expect(pill.getAttribute("aria-label")).toBe("Behind — Upstream: 3 commits behind");
  });

  it("names the alarm without a detail line when there is nothing to add", () => {
    const { pill } = renderPill(behind);
    expect(pill.getAttribute("aria-label")).toBe("Behind");
  });

  it("opens on hover and puts the label and the detail in the tooltip", async () => {
    // The regression this guards is the one the issue names: the pill was
    // `pointer-events-none`, and Radix opens from pointer events on the
    // trigger, so the words it now hides behind a hover would be unreachable.
    const { pill } = renderPill(ciFailed, "2 of 7 checks failing");
    expect(screen.queryByRole("tooltip"), "the tooltip is open before any hover").toBeNull();

    fireEvent.pointerEnter(pill, { pointerType: "mouse" });
    fireEvent.pointerMove(pill, { pointerType: "mouse" });

    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("CI failed");
    expect(tip.textContent).toContain("2 of 7 checks failing");
  });

  it("does not use accent classes", () => {
    const { pill } = renderPill(ciFailed);
    expect(pill.className).not.toContain("accent");
  });

  it("stays a non-interactive marker", () => {
    const { pill } = renderPill(ciFailed);
    expect(pill.tagName).toBe("SPAN");
    expect(pill.hasAttribute("tabindex")).toBe(false);
    expect(pill.getAttribute("role")).not.toBe("button");
    expect(pill.hasAttribute("type")).toBe(false);
  });

  it("puts no interactive element around itself either", () => {
    // `asChild` is what keeps the badge as the whole trigger. Drop it and
    // Radix renders its own <button> around this span — a control inside a row
    // that is already the click target, swallowing the click that should
    // select the worktree. An assertion on the badge alone would not see it.
    const { pill } = renderPill(ciFailed, "2 of 7 checks failing");
    expect(
      pill.closest("button, a, [role='button'], [tabindex]"),
      "something interactive wraps the alarm mark"
    ).toBeNull();
  });

  it("takes pointer events, which is what the tooltip runs on", () => {
    // It was `pointer-events-none`, and Radix opens a tooltip from pointer
    // events on the trigger — so putting that class back silently removes the
    // hover the label now lives behind. jsdom does not honour the CSS, so this
    // is the assertion that catches it.
    const { pill } = renderPill(ciFailed);
    expect(pill.className).not.toContain("pointer-events-none");
  });

  it("does not use transition-all", () => {
    const { pill } = renderPill(ciFailed);
    expect(pill.className).not.toContain("transition-all");
  });
});
