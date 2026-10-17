// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitStatus } from "@shared/types/git";
import type { WorkingTreeFileChange } from "@/lib/workingTreeDiff";
import { FileBrowserChangeSummary } from "../FileBrowserChangeSummary";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

// The app root supplies the TooltipProvider. Triggers render inline; the
// content is left out so a disclosed label is not counted twice.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  // Forwards its props like the real `asChild` trigger: a row's context-menu
  // trigger wraps this one and hands its handlers through it to the row.
  TooltipTrigger: ({
    children,
    asChild: _asChild,
    ...props
  }: {
    children: ReactElement;
    asChild?: boolean;
  }) => cloneElement(children, props),
}));

function change(
  relativePath: string,
  status: GitStatus,
  churn: { insertions?: number; deletions?: number } = {}
): WorkingTreeFileChange {
  return {
    path: `/repo/${relativePath}`,
    relativePath,
    status,
    insertions: churn.insertions ?? null,
    deletions: churn.deletions ?? null,
  };
}

function renderSummary(changes: WorkingTreeFileChange[], onSelect = vi.fn()) {
  render(<FileBrowserChangeSummary changes={changes} onSelect={onSelect} />);
  return onSelect;
}

describe("FileBrowserChangeSummary", () => {
  it("renders the changes in the order it is given", () => {
    renderSummary([
      change("src/big.ts", "modified"),
      change("src/small.ts", "modified"),
      change("docs/notes.md", "added"),
    ]);

    const rendered = screen
      .getAllByRole("button")
      .map((button) => /^Read (.+),/.exec(button.getAttribute("aria-label") ?? "")?.[1]);

    expect(rendered).toEqual(["src/big.ts", "src/small.ts", "docs/notes.md"]);
  });

  it("hands the worktree-relative path to the selection callback", () => {
    const onSelect = renderSummary([change("src/app.ts", "modified")]);

    screen.getByRole("button", { name: /src\/app\.ts/ }).click();

    expect(onSelect).toHaveBeenCalledWith("src/app.ts");
  });

  it("names each row by what activating it does, plus the status", () => {
    renderSummary([change("src/app.ts", "modified")]);

    expect(screen.getByRole("button", { name: "Read src/app.ts, Modified" })).toBeTruthy();
  });

  it("distinguishes statuses in the accessible name, not by colour alone", () => {
    renderSummary([change("src/new.ts", "added"), change("src/old.ts", "modified")]);

    expect(screen.getByRole("button", { name: /Added/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Modified/ })).toBeTruthy();
  });

  it("lists a deleted file but refuses to open it", () => {
    const onSelect = renderSummary([change("src/gone.ts", "deleted")]);
    const row = screen.getByRole("button", { name: /src\/gone\.ts/ });

    expect(row.getAttribute("aria-disabled")).toBe("true");

    row.click();

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps a deleted row reachable by keyboard so its reason is discoverable", () => {
    renderSummary([change("src/gone.ts", "deleted")]);
    const row = screen.getByRole("button", { name: /deleted file isn't available to read/i });

    // aria-disabled, not `disabled` — a disabled button drops out of the tab
    // order and the explanation becomes unreachable.
    expect(row.hasAttribute("disabled")).toBe(false);
  });

  it("still opens readable siblings of a deleted file", () => {
    const onSelect = renderSummary([
      change("src/gone.ts", "deleted"),
      change("src/kept.ts", "modified"),
    ]);

    screen.getByRole("button", { name: /Read src\/kept\.ts/ }).click();

    expect(onSelect).toHaveBeenCalledWith("src/kept.ts");
  });

  it("shows churn only for the sides that actually moved", () => {
    renderSummary([
      change("src/grew.ts", "modified", { insertions: 12, deletions: 0 }),
      change("src/shrank.ts", "modified", { insertions: 0, deletions: 7 }),
    ]);

    expect(screen.getByText("+12")).toBeTruthy();
    expect(screen.getByText("-7")).toBeTruthy();
    expect(screen.queryByText("+0")).toBeNull();
    expect(screen.queryByText("-0")).toBeNull();
  });

  it("splits a nested path so the filename stays readable beside its folder", () => {
    renderSummary([change("src/panels/app.ts", "modified")]);

    expect(screen.getByText("src/panels/")).toBeTruthy();
    expect(screen.getByText("app.ts")).toBeTruthy();
  });

  it("renders a root-level file without an empty directory fragment", () => {
    renderSummary([change("README.md", "modified")]);

    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.queryByText("/")).toBeNull();
  });

  it("keeps rows distinct when one path appears under two statuses", () => {
    // Staged and unstaged are separate rows for the same file; a path-only key
    // would collapse them and React would warn about duplicates.
    renderSummary([change("src/app.ts", "modified"), change("src/app.ts", "added")]);

    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});

describe("FileBrowserChangeSummary row menu", () => {
  function renderWithMenu(changes: WorkingTreeFileChange[]) {
    const menuFor = vi.fn((c: WorkingTreeFileChange) => (
      <ContextMenuItem>{`Menu for ${c.relativePath} (${c.status})`}</ContextMenuItem>
    ));
    // Inside a stand-in for the panel menu, which a row's own must outrank.
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <FileBrowserChangeSummary
              changes={changes}
              onSelect={vi.fn()}
              changeContextMenu={menuFor}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Panel item</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
    return menuFor;
  }

  it("opens the row's file menu instead of the panel's", async () => {
    renderWithMenu([change("src/app.ts", "modified")]);

    fireEvent.contextMenu(screen.getByRole("button", { name: /src\/app\.ts/ }));

    expect(await screen.findByText("Menu for src/app.ts (modified)")).toBeTruthy();
    expect(screen.queryByText("Panel item")).toBeNull();
  });

  it("gives a deleted row a menu too", async () => {
    renderWithMenu([change("src/gone.ts", "deleted")]);

    fireEvent.contextMenu(screen.getByRole("button", { name: /src\/gone\.ts/ }));

    expect(await screen.findByText("Menu for src/gone.ts (deleted)")).toBeTruthy();
  });

  it("describes the row that was clicked when a path is listed twice", async () => {
    renderWithMenu([change("src/app.ts", "modified"), change("src/app.ts", "added")]);

    fireEvent.contextMenu(screen.getAllByRole("button")[1]!);

    expect(await screen.findByText("Menu for src/app.ts (added)")).toBeTruthy();
    expect(screen.queryByText("Menu for src/app.ts (modified)")).toBeNull();
  });

  it("opens from the keyboard with Shift+F10", async () => {
    renderWithMenu([change("src/app.ts", "modified")]);
    const row = screen.getByRole("button", { name: /src\/app\.ts/ });

    expect(row.hasAttribute("data-row-menu")).toBe(true);
    act(() => {
      fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    });

    expect(await screen.findByText("Menu for src/app.ts (modified)")).toBeTruthy();
  });

  it("leaves the right-click to the panel when no menu is supplied", async () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <FileBrowserChangeSummary
              changes={[change("src/app.ts", "modified")]}
              onSelect={vi.fn()}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Panel item</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );

    const row = screen.getByRole("button", { name: /src\/app\.ts/ });
    expect(row.hasAttribute("data-row-menu")).toBe(false);

    fireEvent.contextMenu(row);

    expect(await screen.findByText("Panel item")).toBeTruthy();
  });
});
