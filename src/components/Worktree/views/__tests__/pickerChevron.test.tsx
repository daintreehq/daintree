// @vitest-environment jsdom
/**
 * Every picker on the New worktree form draws one chevron (#15357). The Host
 * row is a `Select` and the rest are popover comboboxes; side by side on one
 * label rail, two glyphs read as two kinds of control.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { ReactElement } from "react";
import { PickerChevron } from "@/components/ui/PickerChevron";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BaseBranchCombobox } from "../BaseBranchCombobox";
import { ExistingBranchPicker } from "../ExistingBranchPicker";
import { RecipePickerPopover } from "../RecipePickerPopover";
import { AgentPickerPopover } from "../AgentPickerPopover";
import { optionRow, stubController } from "./branchPickerFixtures";
import type { TerminalRecipe } from "@/types";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(cleanup);

const RECIPE = {
  id: "recipe-1",
  name: "Work",
  terminals: [{ type: "terminal", env: {} }],
  createdAt: 0,
} as TerminalRecipe;

const PICKERS: Record<string, (open: boolean) => ReactElement> = {
  Host: (open) => (
    <Select value="local" open={open} onOpenChange={() => {}}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="local">This Mac</SelectItem>
      </SelectContent>
    </Select>
  ),
  Base: (open) => (
    <BaseBranchCombobox
      baseBranch="main"
      controller={stubController([optionRow("main")], { open })}
    />
  ),
  Branch: (open) => (
    <ExistingBranchPicker
      selectedBranch="main"
      controller={stubController([optionRow("main")], { open })}
    />
  ),
  Recipe: (open) => (
    <RecipePickerPopover
      recipes={[RECIPE]}
      selectedRecipeId={RECIPE.id}
      selectedRecipe={RECIPE}
      open={open}
      onOpenChange={vi.fn()}
      onSelectRecipe={vi.fn()}
      onMarkTouched={vi.fn()}
      listId="recipe-list"
    />
  ),
  Agent: (open) => (
    <AgentPickerPopover
      agents={[{ id: "claude", name: "Claude", iconId: "claude" }]}
      selectedAgentId="claude"
      open={open}
      onOpenChange={vi.fn()}
      onSelectAgent={vi.fn()}
      listId="agent-list"
    />
  ),
};

function sharedChevronClass(): string {
  const { container, unmount } = render(<PickerChevron />);
  const className = container.querySelector("svg")!.getAttribute("class")!;
  unmount();
  return className;
}

/** The trigger's trailing glyph: leading icons sit inside its label span. */
function chevronOf(trigger: HTMLElement): SVGElement {
  const svgs = trigger.querySelectorAll("svg");
  return svgs[svgs.length - 1]!;
}

/** First in document order: an open panel portals in after it, search field and all. */
function trigger(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="combobox"]')!;
}

describe("New worktree pickers", () => {
  it.each(Object.keys(PICKERS))("%s draws the shared picker chevron", (name) => {
    const expected = sharedChevronClass();
    render(PICKERS[name]!(false));

    const chevron = chevronOf(trigger());
    expect(chevron.getAttribute("class")).toBe(expected);
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
    // The global reduced-motion rule reaches the rotation through this hook.
    expect(chevron.hasAttribute("data-animated-chevron")).toBe(true);
  });

  it.each(Object.keys(PICKERS))("%s turns its chevron on its own trigger's state", (name) => {
    const classes = sharedChevronClass().split(/\s+/);
    // Never an ancestor's: `in-data-[state=open]` matched any open element
    // above the trigger, so a Select inside an open popover sat upside down.
    expect(classes.filter((c) => c.startsWith("in-"))).toEqual([]);
    const turn = classes
      .map((c) => /^group-data-\[state=open\]\/([\w-]+):rotate-180$/.exec(c)?.[1])
      .find(Boolean);
    expect(turn).toBeDefined();

    const { rerender } = render(PICKERS[name]!(false));
    expect(trigger().classList.contains(`group/${turn}`)).toBe(true);
    expect(trigger().getAttribute("data-state")).toBe("closed");

    rerender(PICKERS[name]!(true));
    expect(trigger().getAttribute("data-state")).toBe("open");
  });
});
