/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { CollapsedAlarmPill, collapsedAlarmDescriptionId } from "../CollapsedAlarmPill";
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

describe("CollapsedAlarmPill keyboard reach", () => {
  // The mark is not focusable, so a keyboard user meets it through the card's
  // select button: that button is described by `descriptionId`, and it passes
  // `revealed` while it shows :focus-visible. These pin both halves at the
  // mark's end; WorktreeCardInteraction pins the button's end.

  function renderWith(
    alarm: AlarmDescriptor,
    props: { detail?: string; descriptionId?: string; revealed?: boolean } = {}
  ) {
    const ui = (revealed: boolean | undefined) => (
      <TooltipProvider delayDuration={0}>
        <CollapsedAlarmPill alarm={alarm} {...props} revealed={revealed} />
      </TooltipProvider>
    );
    const result = render(ui(props.revealed));
    return { ...result, setRevealed: (next: boolean) => result.rerender(ui(next)) };
  }

  it("describes the row with the same words the mark's own name speaks", () => {
    const id = "worktree-alarm-test";
    renderWith(ciFailed, { detail: "2 of 7 checks failing", descriptionId: id });
    const pill = screen.getByTestId("collapsed-alarm-pill");
    const description = document.getElementById(id);
    expect(description, "the describedby target never rendered").not.toBeNull();
    expect(description!.textContent).toBe(pill.getAttribute("aria-label"));
  });

  it("keeps the description out of the reading order and off the badge", () => {
    // Hidden, so a virtual cursor does not read the alarm twice; outside the
    // badge, so the mark still carries no words of its own.
    const id = "worktree-alarm-test";
    renderWith(behind, { detail: "Upstream: 3 commits behind", descriptionId: id });
    const description = document.getElementById(id)!;
    expect(description.hidden).toBe(true);
    expect(screen.getByTestId("collapsed-alarm-pill").contains(description)).toBe(false);
    expect(screen.getByTestId("collapsed-alarm-pill").textContent).toBe("");
  });

  it("leaves the reference resolvable when there is no alarm", () => {
    // The card points aria-describedby at this id whenever it is collapsed,
    // without knowing the tier; a dangling IDREF is an invalid attribute.
    const id = "worktree-alarm-test";
    renderWith(none, { descriptionId: id });
    const description = document.getElementById(id);
    expect(description, "no node for a quiet row's reference").not.toBeNull();
    expect(description!.textContent).toBe("");
    expect(screen.queryByTestId("collapsed-alarm-pill")).toBeNull();
  });

  it("opens the tooltip from keyboard focus on the row, with no hover", async () => {
    renderWith(ciFailed, { detail: "2 of 7 checks failing", revealed: true });
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("CI failed");
    expect(tip.textContent).toContain("2 of 7 checks failing");
  });

  it("stays closed until the row is focused", async () => {
    const { setRevealed } = renderWith(ciFailed, { revealed: false });
    const pill = screen.getByTestId("collapsed-alarm-pill");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pill.getAttribute("data-state")).toBe("closed");
    // The same render then opens on focus, so the closed read above is not an
    // artefact of a trigger that never opens at all.
    setRevealed(true);
    await waitFor(() => expect(pill.getAttribute("data-state")).not.toBe("closed"));
  });

  it("lets a revealed tooltip be dismissed, and reveals again on the next visit", async () => {
    // Without the latch, `revealed` would re-assert the open straight after
    // Escape and the tooltip could never be put away while the row is focused.
    // Read off the trigger's `data-state`, which Radix keeps in step with the
    // root: the role query stops matching the content after its first paint
    // here, so it cannot see a close.
    const { setRevealed } = renderWith(authFailed, { detail: "Expand the card", revealed: true });
    const pill = screen.getByTestId("collapsed-alarm-pill");
    const isOpen = () => pill.getAttribute("data-state") !== "closed";
    await waitFor(() => expect(isOpen(), "never revealed").toBe(true));

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(isOpen(), "Escape did not close the reveal").toBe(false));

    setRevealed(true);
    expect(isOpen(), "re-opened while the row is still focused").toBe(false);

    setRevealed(false);
    setRevealed(true);
    await waitFor(() => expect(isOpen(), "the next visit did not reveal").toBe(true));
  });
});

describe("collapsedAlarmDescriptionId", () => {
  it("makes one IDREF of a worktree path, spaces and all", () => {
    // aria-describedby is a space-separated list, so a raw path with a space
    // would point at two ids, neither of them this one.
    const id = collapsedAlarmDescriptionId("/Users/dev/My Projects/helios");
    expect(id).not.toMatch(/\s/);
  });

  it("gives two worktrees two ids", () => {
    expect(collapsedAlarmDescriptionId("/a/b c")).not.toBe(collapsedAlarmDescriptionId("/a/b-c"));
  });
});
