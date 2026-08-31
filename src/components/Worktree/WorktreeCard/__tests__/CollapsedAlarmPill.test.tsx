/**
 * @vitest-environment jsdom
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CollapsedAlarmPill } from "../CollapsedAlarmPill";
import type { AlarmDescriptor } from "@/lib/worktreeAlarmTier";

/**
 * The overlay primitives load from a deferred chunk, so an unmocked render
 * settles asynchronously and the tooltip's content is portalled behind an open
 * state no assertion here cares about. This stub is the shape the real Radix
 * trigger has — `asChild` composes onto the child through `Slot`, exactly as
 * `Primitive.button` does — with the Portal and Content rendered inline so the
 * tooltip's copy is readable without driving a hover.
 */
vi.mock("@/components/ui/radix-loader", async () => {
  const { Slot } = await import("@radix-ui/react-slot");
  return {
    primeRadix: vi.fn().mockResolvedValue({}),
    getRadixPrimitives: () => null,
    primeOnEvent: vi.fn(),
    composeHandlers: (a: unknown, b: unknown) => a ?? b,
    useRadixPrimitives: () => ({
      TooltipPrimitive: {
        Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
        Root: ({ children }: { children: React.ReactNode }) => <>{children}</>,
        // Always the Slot half: the pill only ever uses `asChild`, and that is
        // the branch whose prop and ref merging this suite depends on.
        Trigger: ({
          asChild: _asChild,
          children,
          ref,
          ...rest
        }: React.HTMLAttributes<HTMLElement> & {
          asChild?: boolean;
          children: React.ReactNode;
          ref?: React.Ref<HTMLElement>;
        }) => (
          <Slot ref={ref} {...rest}>
            {children}
          </Slot>
        ),
        Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
        Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      },
    }),
  };
});

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
  const { getByTestId, queryByText, container } = render(
    <CollapsedAlarmPill alarm={alarm} detail={detail} />
  );
  return { pill: getByTestId("collapsed-alarm-pill"), queryByText, container };
}

describe("CollapsedAlarmPill", () => {
  it("renders nothing for tier 0", () => {
    const { container } = render(<CollapsedAlarmPill alarm={none} />);
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

  it("puts the label and the detail in the tooltip", () => {
    const { queryByText } = renderPill(ciFailed, "2 of 7 checks failing");
    expect(queryByText("CI failed")).not.toBeNull();
    expect(queryByText("2 of 7 checks failing")).not.toBeNull();
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
