/**
 * @vitest-environment jsdom
 *
 * The sibling suites render the menu through plain-DOM stand-ins, which is the
 * right shape for testing information architecture but supplies some of the
 * behaviour itself — a fake `RadioItem` that sets its own `aria-checked` cannot
 * prove the real one does. This file renders through the ACTUAL Radix
 * primitives, on both surfaces, to pin the two things only real Radix can
 * answer: that each injected primitive map is complete enough to mount the
 * whole menu, and that environment selection carries genuine radio semantics.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ContextMenu, ContextMenuContent } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { primeRadix } from "@/components/ui/radix-loader";
import { DROPDOWN_COMPONENTS } from "../WorktreeCard/WorktreeActionsToolbar";
import { CONTEXT_COMPONENTS, WorktreeMenuItems } from "../WorktreeMenuItems";
import { makeWorktree, zeroCounts } from "./worktreeMenuHarness";

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

beforeAll(async () => {
  await primeRadix();
});

afterEach(cleanup);

const menuProps = {
  worktree: makeWorktree({ worktreeMode: "staging" }),
  launchAgents: [],
  recipes: [],
  runningRecipeId: null,
  counts: zeroCounts,
  onCopyContextFull: vi.fn(),
  onCopyContextModified: vi.fn(),
  onCopyPath: vi.fn(),
  onCopyBranchName: vi.fn(),
  onOpenEditor: vi.fn(),
  onRevealInFinder: vi.fn(),
  onRunRecipe: vi.fn(),
  onDockAll: vi.fn(),
  onMaximizeAll: vi.fn(),
  onResetRenderers: vi.fn(),
  onSelectAllAgents: vi.fn(),
  onSelectWaitingAgents: vi.fn(),
  onSelectWorkingAgents: vi.fn(),
  onCloseAll: vi.fn(),
  onTerminateAll: vi.fn(),
  onClearHistory: vi.fn(),
  hasResourceConfig: true,
  resourceEnvironmentKeys: ["staging", "prod"],
  onSwitchEnvironment: vi.fn(),
  onDeleteWorktree: vi.fn(),
};

const SURFACES = [
  {
    name: "context menu",
    render: () =>
      render(
        <ContextMenu open>
          <ContextMenuContent forceMount>
            <WorktreeMenuItems {...menuProps} components={CONTEXT_COMPONENTS} />
          </ContextMenuContent>
        </ContextMenu>
      ),
  },
  {
    name: "actions dropdown",
    render: () =>
      render(
        <DropdownMenu open>
          <DropdownMenuContent forceMount>
            <WorktreeMenuItems {...menuProps} components={DROPDOWN_COMPONENTS} />
          </DropdownMenuContent>
        </DropdownMenu>
      ),
  },
] as const;

describe("WorktreeMenuItems — real Radix primitives", () => {
  it.each(SURFACES)("$name mounts every root row through its own primitive map", ({ render }) => {
    render();

    // A map missing an entry throws on render, so reaching these at all is most
    // of the assertion. The order is the contract the redesign establishes.
    const rows = screen.getAllByRole("menuitem").map((el) => el.textContent?.trim());
    expect(rows).toEqual(["Launch", "Open", "Sessions", "Runtime", "Copy", "Delete worktree…"]);
  });

  it.each(SURFACES)("$name never leads, trails or doubles a root separator", ({ render }) => {
    const { baseElement } = render();

    // Whichever bands this fixture populates, the rules between them must not
    // lead, trail or double.
    const children = Array.from(baseElement.querySelector('[role="menu"]')?.children ?? []).filter(
      (el) => el.getAttribute("role") !== null
    );
    const kinds = children.map((el) => (el.getAttribute("role") === "separator" ? "sep" : "row"));

    expect(kinds[0]).toBe("row");
    expect(kinds.at(-1)).toBe("row");
    expect(kinds.some((kind, i) => kind === "sep" && kinds[i + 1] === "sep")).toBe(false);
  });
});
