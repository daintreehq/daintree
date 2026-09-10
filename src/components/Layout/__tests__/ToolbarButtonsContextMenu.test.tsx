// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { primeRadix } from "@/components/ui/radix-loader";
import { actionService } from "@/services/ActionService";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { ToolbarButtonsContextMenu } from "../ToolbarButtonsContextMenu";
import { TOOLBAR_CUSTOMIZE_LABEL } from "../toolbarMenuStrings";
import type { ToolbarSide, ToolbarVisibilityMenuRows } from "../toolbarVisibilityMenu";

const Glyph = () => <svg aria-hidden="true" />;

const ROWS: ToolbarVisibilityMenuRows = {
  left: [{ id: "terminal", side: "left", label: "Terminal", icon: Glyph, checked: true }],
  right: [
    { id: "forge-stats", side: "right", label: "Repository stats", icon: Glyph, checked: false },
  ],
};

const OWN_MENU_SENTINEL = "Own menu item";

interface HarnessOptions {
  rows?: ToolbarVisibilityMenuRows;
  extra?: ReactNode;
  rootRef?: Ref<HTMLDivElement>;
  onKeyDown?: () => void;
  onFocusCapture?: () => void;
}

function renderToolbar({
  rows = ROWS,
  extra,
  rootRef,
  onKeyDown,
  onFocusCapture,
}: HarnessOptions = {}) {
  const onToggle =
    vi.fn<(buttonId: AnyToolbarButtonId, side: ToolbarSide, onToolbar: boolean) => void>();
  render(
    <ToolbarButtonsContextMenu rows={rows} onToggle={onToggle}>
      <div
        ref={rootRef}
        role="toolbar"
        aria-label="Main toolbar"
        className="app-drag-region"
        onKeyDown={onKeyDown}
        onFocusCapture={onFocusCapture}
      >
        <div data-testid="group">
          <div data-toolbar-button-id="terminal" className="app-no-drag">
            <button type="button" data-toolbar-item="">
              Terminal
            </button>
          </div>
        </div>
        <div className="app-no-drag">
          <button type="button">Toggle sidebar</button>
        </div>
        {extra}
      </div>
    </ToolbarButtonsContextMenu>
  );
  return { onToggle };
}

// Negative assertions need the open path to have had its chance to commit, and
// a raw DOM read so an aria-hidden sibling can't mask a menu that did open.
async function flush() {
  await act(async () => {});
}

beforeAll(async () => {
  await primeRadix();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ToolbarButtonsContextMenu", () => {
  it("opens on empty toolbar space with a checkbox per button and the customize entry", async () => {
    renderToolbar();

    fireEvent.contextMenu(screen.getByTestId("group"));

    const menu = await screen.findByRole("menu", { name: "Toolbar buttons" });
    expect(
      within(menu)
        .getAllByRole("menuitemcheckbox")
        .map((row) => [row.textContent, row.getAttribute("aria-checked")])
    ).toEqual([
      ["Terminal", "true"],
      ["Repository stats", "false"],
    ]);
    expect(
      within(menu)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label"))
    ).toEqual(["Left side", "Right side"]);
    expect(within(menu).getByRole("menuitem", { name: TOOLBAR_CUSTOMIZE_LABEL })).toBeTruthy();
  });

  it("brings a hidden button back with the side it sits on", async () => {
    const { onToggle } = renderToolbar();

    fireEvent.contextMenu(screen.getByRole("toolbar"));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Repository stats" }));

    expect(onToggle).toHaveBeenCalledExactlyOnceWith("forge-stats", "right", true);
  });

  it("hides a shown button", async () => {
    const { onToggle } = renderToolbar();

    fireEvent.contextMenu(screen.getByRole("toolbar"));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Terminal" }));

    expect(onToggle).toHaveBeenCalledExactlyOnceWith("terminal", "left", false);
  });

  it("opens the toolbar editor from the customize entry", async () => {
    const dispatch = vi.spyOn(actionService, "dispatch");
    renderToolbar();

    fireEvent.contextMenu(screen.getByRole("toolbar"));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: TOOLBAR_CUSTOMIZE_LABEL }));

    expect(dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "toolbar" },
      expect.objectContaining({ source: "context-menu" })
    );
  });

  it("stays shut for a right-click on a button slot or on fixed chrome", async () => {
    renderToolbar();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Toggle sidebar" }));
    await flush();

    expect(document.querySelector("[role='menu']")).toBeNull();
  });

  it("lets a control's own menu win over the toolbar's", async () => {
    renderToolbar({
      extra: (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <span data-testid="own-menu">Own menu</span>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>{OWN_MENU_SENTINEL}</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ),
    });

    fireEvent.contextMenu(screen.getByTestId("own-menu"));

    expect(await screen.findByRole("menuitem", { name: OWN_MENU_SENTINEL })).toBeTruthy();
    expect(document.querySelector("[role='menuitemcheckbox']")).toBeNull();
  });

  it("ignores a right-click that bubbles up from content the toolbar portals out", async () => {
    renderToolbar({
      extra: createPortal(<button type="button">Portaled</button>, document.body),
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: "Portaled" }));
    await flush();

    expect(document.querySelector("[role='menu']")).toBeNull();
  });

  it("keeps the toolbar root's own ref and handlers once slotted into the trigger", () => {
    const rootRef = createRef<HTMLDivElement>();
    const onKeyDown = vi.fn();
    const onFocusCapture = vi.fn();
    renderToolbar({ rootRef, onKeyDown, onFocusCapture });

    const toolbar = screen.getByRole("toolbar");
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    act(() => {
      screen.getByRole("button", { name: "Terminal" }).focus();
    });

    expect(rootRef.current).toBe(toolbar);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onFocusCapture).toHaveBeenCalled();
  });

  it("offers only the customize entry, with no stray separators, when no button qualifies", async () => {
    renderToolbar({ rows: { left: [], right: [] } });

    fireEvent.contextMenu(screen.getByRole("toolbar"));
    const menu = await screen.findByRole("menu");

    expect(within(menu).queryAllByRole("menuitemcheckbox")).toHaveLength(0);
    expect(within(menu).queryAllByRole("separator")).toHaveLength(0);
    expect(within(menu).getByRole("menuitem", { name: TOOLBAR_CUSTOMIZE_LABEL })).toBeTruthy();
  });
});
