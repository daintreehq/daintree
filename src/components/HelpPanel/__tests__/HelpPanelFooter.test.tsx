// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_FOOTER_DENSITY, formatPinnedBinding, useFooterDensity } from "../HelpPanelFooter";

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("formatPinnedBinding", () => {
  it("says a worktree named after its branch once", () => {
    for (const name of ["main", "design/artifact-overlay", "  feature/x  "]) {
      const label = formatPinnedBinding({
        worktreeId: "wt",
        worktreeName: name,
        worktreeBranch: name,
        terminalId: null,
      });
      expect(occurrences(label, name.trim())).toBe(1);
    }
  });

  it("keeps both values when the worktree and branch differ", () => {
    const label = formatPinnedBinding({
      worktreeId: "wt",
      worktreeName: "daintree",
      worktreeBranch: "feature/footer",
      terminalId: null,
    });
    expect(label).toContain("daintree");
    expect(label).toContain("feature/footer");
  });

  it("falls back to whichever value exists, and never renders empty", () => {
    const only = (worktreeName: string | null, worktreeBranch: string | null) =>
      formatPinnedBinding({ worktreeId: null, worktreeName, worktreeBranch, terminalId: null });
    expect(only("daintree", null)).toBe("daintree");
    expect(only(null, "develop")).toBe("develop");
    expect(only(null, null).length).toBeGreaterThan(0);
    expect(only("", "  ").length).toBeGreaterThan(0);
  });
});

describe("useFooterDensity", () => {
  // jsdom has no layout, so the row reports the width its content would need:
  // each density step frees STEP_PX, and the row is ROW_PX wide. The spacer
  // reports whatever room is left over.
  const ROW_PX = 100;
  const STEP_PX = 10;
  const SETTLE_MS = 20;
  let needed = ROW_PX;
  // A truncated sibling taking up freed space, so the spacer stays at zero.
  let absorbing = false;

  const contentWidth = (row: HTMLElement) => needed - Number(row.dataset.density) * STEP_PX;
  const geometry = {
    clientWidth(this: HTMLElement) {
      return this.dataset.testid === "row" ? ROW_PX : 0;
    },
    scrollWidth(this: HTMLElement) {
      return this.dataset.testid === "row" ? Math.max(ROW_PX, contentWidth(this)) : 0;
    },
    offsetWidth(this: HTMLElement) {
      const row = this.parentElement!;
      if (this.dataset.testid === "content") return Math.min(ROW_PX, contentWidth(row));
      if (this.dataset.testid === "slack") {
        return absorbing ? 0 : Math.max(0, ROW_PX - contentWidth(row));
      }
      return 0;
    },
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();

  beforeAll(() => {
    for (const [name, get] of Object.entries(geometry)) {
      originals.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
    }
  });

  afterAll(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
  });

  function Row({ contentKey, wrapped = false }: { contentKey: string; wrapped?: boolean }) {
    const { rowRef, density } = useFooterDensity(contentKey);
    const row = (
      <div ref={rowRef} data-density={density} data-testid="row">
        <span data-testid="content" />
        <span data-testid="slack" />
      </div>
    );
    // Stands in for a provider above the row that changes element type once it
    // loads, which replaces the row's DOM node without re-rendering the hook.
    return wrapped ? <section>{row}</section> : row;
  }

  const density = () => Number(screen.getByTestId("row").dataset.density);

  it("steps up only as far as it takes to fit", () => {
    needed = ROW_PX + 2 * STEP_PX;
    render(<Row contentKey="a" />);
    expect(density()).toBe(2);
  });

  it("never goes past the last step, even when nothing fits", () => {
    needed = ROW_PX + 100 * STEP_PX;
    render(<Row contentKey="a" />);
    expect(density()).toBe(MAX_FOOTER_DENSITY);
  });

  it("gives detail back when a child shrinks without any prop changing", async () => {
    needed = ROW_PX + 3 * STEP_PX;
    render(<Row contentKey="a" />);
    expect(density()).toBe(3);

    // The watch chip unmounting, say: content changes, props do not.
    needed = ROW_PX;
    await act(async () => {
      screen.getByTestId("content").textContent = "changed";
      await Promise.resolve();
    });
    expect(density()).toBe(0);
  });

  it("gives detail back when the freed space goes to a truncated sibling", async () => {
    needed = ROW_PX + 3 * STEP_PX;
    render(<Row contentKey="a" />);
    expect(density()).toBe(3);

    absorbing = true;
    needed = ROW_PX;
    await act(async () => {
      screen.getByTestId("content").textContent = "changed";
      await Promise.resolve();
    });
    expect(density()).toBe(0);
    absorbing = false;
  });

  it("measures again when the row's node is replaced", () => {
    needed = ROW_PX + 2 * STEP_PX;
    const { rerender } = render(<Row contentKey="a" />);
    expect(density()).toBe(2);

    needed = ROW_PX + 4 * STEP_PX;
    rerender(<Row contentKey="a" wrapped />);
    expect(density()).toBe(4);
  });

  it("does not loop on its own compaction", async () => {
    needed = ROW_PX + 2 * STEP_PX;
    const onRender = vi.fn();
    render(
      <Profiler id="row" onRender={onRender}>
        <Row contentKey="a" />
      </Profiler>
    );
    const settled = onRender.mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    });
    expect(density()).toBe(2);
    expect(onRender.mock.calls.length).toBe(settled);
  });
});
