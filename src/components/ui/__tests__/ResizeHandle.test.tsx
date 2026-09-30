// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResizeHandle, type ResizeHandleEdge } from "../ResizeHandle";
import type { SplitterGrowKey } from "@/hooks/useSplitterKeys";
import { BUILT_IN_APP_SCHEMES, blendOverBackground, contrastRatio, parseRgba } from "@shared/theme";

const PLACEMENTS: Array<{ edge: ResizeHandleEdge; growKey: SplitterGrowKey }> = [
  { edge: "left", growKey: "ArrowLeft" },
  { edge: "left-inset", growKey: "ArrowLeft" },
  { edge: "right", growKey: "ArrowRight" },
  { edge: "top", growKey: "ArrowUp" },
  { edge: "inline", growKey: "ArrowUp" },
  { edge: "inline", growKey: "ArrowRight" },
];

function renderHandle(
  placement: (typeof PLACEMENTS)[number],
  overrides: Partial<Parameters<typeof ResizeHandle>[0]> = {}
) {
  const onReset = vi.fn();
  render(
    <ResizeHandle
      {...placement}
      label="Resize thing"
      value={300}
      min={100}
      max={600}
      isResizing={false}
      onReset={onReset}
      {...overrides}
    />
  );
  const handle = screen.getByRole("separator");
  const grip = handle.firstElementChild;
  if (!grip) throw new Error("handle rendered no grip");
  return { handle, grip, onReset };
}

const tokens = (el: Element) => el.className.split(/\s+/).filter(Boolean);
const vertical = (growKey: SplitterGrowKey) => growKey === "ArrowLeft" || growKey === "ArrowRight";
const cases = PLACEMENTS.map((p) => [`${p.edge}/${p.growKey}`, p] as const);

describe("ResizeHandle", () => {
  afterEach(cleanup);

  it.each(cases)("names the reset gesture in its label (%s)", (_, placement) => {
    const { handle } = renderHandle(placement);
    expect(handle.getAttribute("aria-label")).toMatch(/^Resize .+ \(double-click to reset\)$/);
  });

  it.each(cases)("resets on double-click (%s)", (_, placement) => {
    const { handle, onReset } = renderHandle(placement);
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it.each(cases)("is a keyboard-reachable separator on the right axis (%s)", (_, placement) => {
    const { handle } = renderHandle(placement);
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-orientation")).toBe(
      vertical(placement.growKey) ? "vertical" : "horizontal"
    );
    expect(tokens(handle)).toContain(
      vertical(placement.growKey) ? "cursor-col-resize" : "cursor-row-resize"
    );
    for (const attr of ["aria-valuenow", "aria-valuemin", "aria-valuemax", "aria-keyshortcuts"]) {
      expect(handle.getAttribute(attr)).toBeTruthy();
    }
  });

  // 12px along the drag axis: the track itself, or a 6px track whose hit area
  // reaches 3px past each side.
  it.each(cases)("offers a 12px target across the drag axis (%s)", (_, placement) => {
    const { handle } = renderHandle(placement);
    const t = tokens(handle);
    const axis = vertical(placement.growKey) ? "w" : "h";
    const direct = t.includes(`${axis}-3`);
    const extended =
      t.includes(`${axis}-1.5`) && t.some((x) => /^before:-inset-[xy]-0\.75$/.test(x));
    expect(direct || extended).toBe(true);
  });

  it.each(cases)("paints a visible accent outline on keyboard focus (%s)", (_, placement) => {
    const { handle } = renderHandle(placement);
    const t = tokens(handle);
    expect(t).toContain("focus-visible:outline-solid");
    expect(t).toContain("focus-visible:outline-2");
    expect(t).toContain("focus-visible:outline-accent-primary");
  });

  it.each(cases)("keeps the accent off everything but the focus outline (%s)", (_, placement) => {
    for (const isResizing of [false, true]) {
      const { handle, grip } = renderHandle(placement, { isResizing });
      for (const token of tokens(handle).filter((x) => x.includes("accent"))) {
        expect(token).toMatch(/^focus-visible:outline-/);
      }
      expect(tokens(grip).some((x) => x.includes("accent"))).toBe(false);
      cleanup();
    }
  });

  // A grip is a UI component under WCAG 1.4.11: at rest it owes 3:1 against every
  // surface a splitter sits on, in the dark and the light reference theme, and each
  // state after rest has to read as a step up from it. Measured on the themes'
  // real values so a retuned token trips this rather than the eye.
  const GRIP_THEMES = ["daintree", "svalbard"] as const;
  const SPLITTER_SURFACES = [
    "surface-canvas",
    "surface-sidebar",
    "surface-grid",
    "surface-panel",
    "surface-panel-elevated",
  ] as const;
  const gripInk = (grip: Element, prefix: string) => {
    const token = tokens(grip).find(
      (x) => x.startsWith(`${prefix}bg-`) && !x.slice(prefix.length).includes(":")
    );
    if (!token) throw new Error(`no ${prefix || "rest"} ink`);
    return token.slice(prefix.length + "bg-".length);
  };
  const worstContrast = (schemeId: string, ink: string) => {
    const scheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === schemeId)!;
    const value = (scheme.tokens as Record<string, string>)[ink];
    if (!value) throw new Error(`${ink} is not a ${schemeId} theme token`);
    return Math.min(
      ...SPLITTER_SURFACES.map((surface) => {
        const bg = scheme.tokens[surface];
        const alpha = parseRgba(value);
        return contrastRatio(alpha ? blendOverBackground(alpha.hex, bg, alpha.opacity) : value, bg);
      })
    );
  };

  it.each(cases)("draws the grip in theme tokens, never slash-alpha ink (%s)", (_, placement) => {
    for (const isResizing of [false, true]) {
      const { grip } = renderHandle(placement, { isResizing });
      const inks = tokens(grip).filter((x) => /(^|:)bg-/.test(x));
      expect(inks.length).toBeGreaterThan(0);
      for (const ink of inks) expect(ink).not.toMatch(/\/\d+$/);
      expect(tokens(grip).some((x) => x.startsWith("[.light_&]"))).toBe(false);
      cleanup();
    }
  });

  it.each(cases)("rests at 3:1 and steps up to hover then focus (%s)", (_, placement) => {
    const { grip } = renderHandle(placement);
    const rest = gripInk(grip, "");
    const hover = gripInk(grip, "group-hover/resize:");
    const focus = gripInk(grip, "group-focus-visible/resize:");
    cleanup();
    const drag = gripInk(renderHandle(placement, { isResizing: true }).grip, "");
    for (const theme of GRIP_THEMES) {
      const r = worstContrast(theme, rest);
      const h = worstContrast(theme, hover);
      const f = worstContrast(theme, focus);
      const d = worstContrast(theme, drag);
      expect(r, `${theme} resting grip ${rest}`).toBeGreaterThanOrEqual(3);
      expect(h, `${theme} hover ${hover} over rest ${rest}`).toBeGreaterThan(r);
      expect(f, `${theme} focus ${focus} over hover ${hover}`).toBeGreaterThan(h);
      expect(d, `${theme} drag ${drag} over rest ${rest}`).toBeGreaterThan(r);
    }
  });

  it.each(cases)("lets nothing hover-driven outrank the drag state (%s)", (_, placement) => {
    const { handle, grip } = renderHandle(placement, { isResizing: true });
    const hoverDriven = [...tokens(handle), ...tokens(grip)].filter((x) =>
      /(^|:)(group-)?hover/.test(x)
    );
    expect(hoverDriven).toEqual([]);
  });

  it("keeps every grip the same length", () => {
    const lengths = new Set<string>();
    for (const placement of PLACEMENTS) {
      const { grip } = renderHandle(placement);
      const axis = vertical(placement.growKey) ? "h" : "w";
      lengths.add(
        tokens(grip)
          .find((x) => x.startsWith(`${axis}-`) && !x.includes("px"))!
          .slice(2)
      );
      cleanup();
    }
    expect([...lengths]).toHaveLength(1);
  });
});
