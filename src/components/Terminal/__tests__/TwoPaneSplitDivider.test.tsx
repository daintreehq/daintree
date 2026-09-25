// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { TwoPaneSplitDivider } from "../TwoPaneSplitDivider";

const MIN = 0.3;
const MAX = 0.7;

function renderDivider(ratio = 0.5) {
  const onRatioChange = vi.fn<(ratio: number) => void>();
  const onRatioCommit = vi.fn<(ratio?: number) => void>();
  const onDoubleClick = vi.fn<() => void>();
  const container = document.createElement("div");
  container.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 600 });
  const utils = render(
    <TwoPaneSplitDivider
      containerRef={{ current: container }}
      ratio={ratio}
      onRatioChange={onRatioChange}
      onRatioCommit={onRatioCommit}
      onDoubleClick={onDoubleClick}
      minRatio={MIN}
      maxRatio={MAX}
    />
  );
  const separator = utils.getByRole("separator");
  const grip = separator.firstElementChild;
  if (!grip) throw new Error("divider rendered no grip");
  return { separator, grip, onRatioChange, onRatioCommit, onDoubleClick };
}

function classTokens(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

function committedAfter(key: string, init: { shiftKey?: boolean } = {}, ratio = 0.5): number {
  const { separator, onRatioCommit } = renderDivider(ratio);
  fireEvent.keyDown(separator, { key, ...init });
  const value = onRatioCommit.mock.calls.at(-1)?.[0];
  cleanup();
  if (value === undefined) throw new Error(`${key} committed nothing`);
  return value;
}

describe("TwoPaneSplitDivider keyboard contract", () => {
  afterEach(cleanup);

  it("sends Home and End to the primary pane's limits, not to a reset", () => {
    const { separator, onDoubleClick } = renderDivider();
    fireEvent.keyDown(separator, { key: "Home" });
    fireEvent.keyDown(separator, { key: "End" });
    expect(onDoubleClick).not.toHaveBeenCalled();
    cleanup();

    expect(committedAfter("Home")).toBe(MIN);
    expect(committedAfter("End")).toBe(MAX);
  });

  it("takes a coarser step with Shift, in the same direction", () => {
    const fine = committedAfter("ArrowRight") - 0.5;
    const coarse = committedAfter("ArrowRight", { shiftKey: true }) - 0.5;
    expect(fine).toBeGreaterThan(0);
    expect(coarse).toBeGreaterThan(fine);
    expect(committedAfter("ArrowLeft", { shiftKey: true })).toBeLessThan(
      committedAfter("ArrowLeft")
    );
  });

  it("never commits a ratio outside the limits", () => {
    expect(committedAfter("ArrowRight", { shiftKey: true }, MAX - 0.01)).toBe(MAX);
    expect(committedAfter("ArrowLeft", { shiftKey: true }, MIN + 0.01)).toBe(MIN);
  });

  it("resets on Enter and Space without moving the ratio itself", () => {
    for (const key of ["Enter", " "]) {
      const { separator, onDoubleClick, onRatioCommit } = renderDivider();
      fireEvent.keyDown(separator, { key });
      expect(onDoubleClick).toHaveBeenCalledTimes(1);
      expect(onRatioCommit).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("describes both panes' shares, and they account for the whole width", () => {
    const { separator } = renderDivider(0.35);
    const text = separator.getAttribute("aria-valuetext") ?? "";
    const shares = [...text.matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
    expect(shares).toHaveLength(2);
    expect(shares[0]).toBe(Number(separator.getAttribute("aria-valuenow")));
    expect(shares[0]! + shares[1]!).toBe(100);
  });
});

describe("TwoPaneSplitDivider click-only resizing", () => {
  afterEach(cleanup);

  async function openMenu(ratio: number) {
    const utils = renderDivider(ratio);
    fireEvent.contextMenu(utils.separator, { clientX: 500, clientY: 300 });
    await screen.findByRole("menu");
    const item = (name: RegExp) => screen.getByRole("menuitem", { name });
    return { ...utils, item };
  }

  it("moves the split each way without a drag, committing the value it lands on", async () => {
    const { item, onRatioCommit } = await openMenu(0.5);
    fireEvent.click(item(/left/i));
    const widenedLeft = onRatioCommit.mock.calls.at(-1)?.[0];
    expect(widenedLeft).toBeGreaterThan(0.5);
    cleanup();

    const again = await openMenu(0.5);
    fireEvent.click(again.item(/right/i));
    expect(again.onRatioCommit.mock.calls.at(-1)?.[0]).toBeLessThan(0.5);
  });

  it("offers no move past a limit", async () => {
    const atMax = await openMenu(MAX);
    expect(atMax.item(/left/i).getAttribute("aria-disabled")).toBe("true");
    expect(atMax.item(/right/i).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("resets through the same path as double-click", async () => {
    const { item, onDoubleClick } = await openMenu(0.4);
    fireEvent.click(item(/reset/i));
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });
});

describe("TwoPaneSplitDivider state styling", () => {
  afterEach(() => {
    cleanup();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  it("lets nothing hover-driven outrank the drag state while a drag is held", () => {
    const { separator, grip } = renderDivider();
    const hoverDriven = (el: Element) =>
      classTokens(el).filter((token) => /(^|:)(group-)?hover:/.test(token));
    // At rest the divider does respond to hover — the check below is not vacuous.
    expect(hoverDriven(separator).length + hoverDriven(grip).length).toBeGreaterThan(0);

    fireEvent.mouseDown(separator, { button: 0, clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 560 });

    expect(hoverDriven(separator)).toEqual([]);
    expect(hoverDriven(grip)).toEqual([]);
    fireEvent.mouseUp(document);
  });

  it("carries accent only as the keyboard focus outline, in every state", () => {
    const { separator, grip } = renderDivider();
    const accentTokens = () =>
      [...classTokens(separator), ...classTokens(grip)].filter((t) => t.includes("accent"));

    const check = () => {
      const tokens = accentTokens();
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) expect(token).toMatch(/^focus-visible:outline-/);
      expect(classTokens(grip).some((t) => t.includes("accent"))).toBe(false);
    };

    check();
    fireEvent.mouseDown(separator, { button: 0, clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 560 });
    check();
    fireEvent.mouseUp(document);
  });
});
