/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import type { RefObject } from "react";
import type { StagingFileEntry } from "@shared/types";

vi.mock("@/components/ui/TruncatedTooltip", () => ({
  TruncatedTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { FileStageRow, type FileStageRowSection } from "../FileStageRow";

const OUTER_SENTINEL = "Enclosing menu sentinel";

const FILE: StagingFileEntry = {
  path: "src/index.ts",
  status: "modified",
  insertions: 3,
  deletions: 1,
};

function renderRow(
  renderRowMenu?: (
    file: StagingFileEntry,
    section: FileStageRowSection,
    triggerRef: RefObject<HTMLElement | null>
  ) => React.ReactNode
) {
  return render(
    <TooltipProvider>
      {/* The hub's own chrome could own a menu; a file row must claim its
          right-click before anything enclosing it does. */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <FileStageRow
              file={FILE}
              section="unstaged"
              isStaged={false}
              isSelected={false}
              rowIndex={0}
              onToggle={vi.fn()}
              onRowClick={vi.fn()}
              {...(renderRowMenu ? { renderRowMenu } : {})}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>{OUTER_SENTINEL}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </TooltipProvider>
  );
}

beforeAll(async () => {
  await primeRadix();
});

afterEach(() => cleanup());

describe("FileStageRow — row context menu", () => {
  it("renders the supplied menu and keeps the event off any enclosing trigger", async () => {
    renderRow(() => <ContextMenuItem>Row item</ContextMenuItem>);

    fireEvent.contextMenu(screen.getByTestId(`file-stage-row-${FILE.path}`));

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Row item" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: OUTER_SENTINEL })).toBeNull();
  });

  it("marks the row while its menu is open", async () => {
    renderRow(() => <ContextMenuItem>Row item</ContextMenuItem>);

    const row = screen.getByTestId(`file-stage-row-${FILE.path}`);
    fireEvent.contextMenu(row);
    await screen.findByRole("menu");

    expect(row.getAttribute("data-state")).toBe("open");
  });

  it("hands the menu builder this row's file, section and own node", async () => {
    const seen: {
      file?: StagingFileEntry;
      section?: FileStageRowSection;
      ref?: RefObject<HTMLElement | null>;
    } = {};
    renderRow((file, section, triggerRef) => {
      seen.file = file;
      seen.section = section;
      seen.ref = triggerRef;
      return <ContextMenuItem>Row item</ContextMenuItem>;
    });

    fireEvent.contextMenu(screen.getByTestId(`file-stage-row-${FILE.path}`));
    await screen.findByRole("menu");

    expect(seen.file).toBe(FILE);
    expect(seen.section).toBe("unstaged");
    // The ref resolves to the row itself, which is what `Open diff` hands focus
    // back to after the diff overlay closes.
    expect(seen.ref?.current).toBe(screen.getByTestId(`file-stage-row-${FILE.path}`));
  });

  it("falls through to the enclosing menu when no row menu is supplied", async () => {
    renderRow();

    fireEvent.contextMenu(screen.getByTestId(`file-stage-row-${FILE.path}`));

    expect(await screen.findByRole("menuitem", { name: OUTER_SENTINEL })).toBeTruthy();
  });
});
