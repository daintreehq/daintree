// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

const notifySpy = vi.hoisted(() => vi.fn((_payload: unknown) => "toast-1"));
vi.mock("@/lib/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify")>()),
  notify: notifySpy,
}));

import * as kit from "@daintreehq/plugin-ui";
import type { DropdownMenuEntry } from "@daintreehq/plugin-ui";
import { PluginKitOwnerContext } from "@/components/PluginKit/kitScope";
import {
  hotkeyHostBinding,
  hotkeyHostOwnsEvent,
  pluginDisplayName,
} from "@/components/PluginKit/PluginKitHooksFeedback";
import { keybindingService } from "@/services/KeybindingService";
import { useNotificationStore } from "@/store/notificationStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { UNDO_ACTION_LABEL, UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

beforeEach(() => {
  notifySpy.mockClear();
});

afterEach(cleanup);

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

/** The action a notify payload carried, read without trusting its shape. */
function actionOf(sent: Record<string, unknown>): { label: unknown; onClick: () => void } {
  const action: unknown = sent.action;
  if (typeof action !== "object" || action === null) throw new Error("no action");
  const onClick: unknown = Reflect.get(action, "onClick");
  if (typeof onClick !== "function") throw new Error("no onClick");
  return {
    label: Reflect.get(action, "label"),
    onClick: () => Reflect.apply(onClick, undefined, []),
  };
}

function payload(call = 0): Record<string, unknown> {
  const value = notifySpy.mock.calls[call]?.[0];
  if (typeof value !== "object" || value === null) throw new Error("no notify call");
  return { ...value };
}

describe("menu submenus and descriptions", () => {
  const items = (onMove = vi.fn()): DropdownMenuEntry[] => [
    {
      label: "Duplicate",
      description: "Makes a copy beside this one",
      icon: "copy",
      onSelect: () => {},
    },
    {
      type: "submenu",
      label: "Move to",
      icon: "folder",
      items: [
        { label: "Inbox", onSelect: () => onMove("inbox") },
        {
          label: "Archive",
          description: "Out of the list, still searchable",
          onSelect: () => onMove("archive"),
        },
      ],
    },
    { type: "submenu", label: "Empty", items: [] },
    {
      type: "checkbox",
      label: "Pinned",
      description: "Keeps it at the top",
      checked: false,
      onCheckedChange: () => {},
    },
  ];

  it("draws a description line under an item's label", async () => {
    render(
      createElement(kit.DropdownMenu, {
        open: true,
        trigger: createElement(kit.Button, { children: "Actions" }),
        items: items(),
      })
    );
    const duplicate = await screen.findByRole("menuitem", { name: /Duplicate/ });
    expect(duplicate.textContent).toContain("Makes a copy beside this one");
    const line = [...duplicate.querySelectorAll("span")].find(
      (span) => span.textContent === "Makes a copy beside this one"
    );
    expect(line?.className).toContain("text-text-secondary");
    expect(screen.getByRole("menuitemcheckbox", { name: /Pinned/ }).textContent).toContain(
      "Keeps it at the top"
    );
  });

  it("opens a submenu with Right Arrow and closes it with Left Arrow", async () => {
    const onMove = vi.fn();
    render(
      createElement(kit.DropdownMenu, {
        open: true,
        trigger: createElement(kit.Button, { children: "Actions" }),
        items: items(onMove),
      })
    );
    const trigger = await screen.findByRole("menuitem", { name: "Move to" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    // A submenu with no rows is left out.
    expect(screen.queryByRole("menuitem", { name: "Empty" })).toBeNull();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const archive = await screen.findByRole("menuitem", { name: /Archive/ });
    expect(screen.getAllByRole("menu")).toHaveLength(2);
    fireEvent.click(archive);
    expect(onMove).toHaveBeenCalledWith("archive");
  });

  it("nests in a ContextMenu too", async () => {
    render(
      createElement(kit.ContextMenu, {
        items: items(),
        children: createElement("div", { "data-testid": "row" }, "Row"),
      })
    );
    fireEvent.contextMenu(screen.getByTestId("row"), { clientX: 5, clientY: 5 });
    const trigger = await screen.findByRole("menuitem", { name: "Move to" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    expect(await screen.findByRole("menuitem", { name: "Inbox" })).toBeTruthy();
    const sub = screen.getAllByRole("menu")[1]!;
    fireEvent.keyDown(sub, { key: "ArrowLeft" });
    await tick();
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("stops at a submenu that contains itself", async () => {
    const loop: { type: "submenu"; label: string; items: DropdownMenuEntry[] } = {
      type: "submenu",
      label: "Loop",
      items: [],
    };
    loop.items.push(loop, { label: "Leaf", onSelect: () => {} });
    expect(() =>
      render(
        createElement(kit.DropdownMenu, {
          open: true,
          trigger: createElement(kit.Button, { children: "Actions" }),
          items: [loop],
        })
      )
    ).not.toThrow();
    expect(await screen.findByRole("menuitem", { name: "Loop" })).toBeTruthy();
  });
});

describe("ConfirmPopover", () => {
  function confirm(extra: Record<string, unknown> = {}) {
    return createElement(kit.ConfirmPopover, {
      trigger: createElement(kit.Button, { children: "Clear all" }),
      message: "Clear all 12 snippets?",
      description: "You can undo this from the toast.",
      confirmLabel: "Clear snippets",
      onConfirm: vi.fn(),
      ...extra,
    });
  }

  it("opens from its trigger as an alertdialog naming the question", async () => {
    render(confirm());
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Clear all 12 snippets?" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe(
      "You can undo this from the toast."
    );
  });

  it("focuses the confirm by default and Cancel for a danger action", async () => {
    render(confirm({ defaultOpen: true }));
    await screen.findByRole("alertdialog");
    await tick();
    expect(document.activeElement?.textContent).toBe("Clear snippets");
    cleanup();

    render(confirm({ defaultOpen: true, tone: "danger" }));
    await screen.findByRole("alertdialog");
    await tick();
    expect(document.activeElement?.textContent).toBe("Cancel");
    const button = screen.getByRole("button", { name: "Clear snippets" });
    expect(button.className).toContain("bg-destructive");
  });

  it("confirms and closes, or cancels on Cancel and on Escape", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(confirm({ onConfirm, onCancel }));
    const trigger = screen.getByRole("button", { name: "Clear all" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Clear snippets" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await tick();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("follows a controlled open", async () => {
    const onOpenChange = vi.fn();
    render(confirm({ open: true, onOpenChange }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear snippets" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Still open: the parent never closed it.
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("renders nothing without a message or an element trigger", () => {
    const { container } = render(
      createElement(kit.ConfirmPopover, JSON.parse('{"trigger": "x", "message": "Sure?"}'))
    );
    expect(container.textContent).toBe("");
    render(createElement(kit.ConfirmPopover, JSON.parse('{"message": ""}')));
  });
});

describe("useToast", () => {
  const owned = ({ children }: { children: ReactNode }) =>
    createElement(PluginKitOwnerContext.Provider, { value: "acme.snippets" }, children);

  let savedMeta: ReturnType<typeof usePluginRuntimeStore.getState>["pluginMetaById"];
  beforeEach(() => {
    savedMeta = usePluginRuntimeStore.getState().pluginMetaById;
    const meta = new Map(savedMeta);
    meta.set("acme.snippets", { devMode: false, displayName: "Snippets Manager" });
    usePluginRuntimeStore.setState({ pluginMetaById: meta });
  });
  afterEach(() => usePluginRuntimeStore.setState({ pluginMetaById: savedMeta }));

  it("routes through notify with the plugin's name and its own rate-limit bucket", () => {
    const { result } = renderHook(() => kit.useToast(), { wrapper: owned });
    const onClick = vi.fn();
    act(() => {
      result.current.show({
        message: "  Snippet copied  ",
        tone: "success",
        durationMs: 999_999,
        action: { label: "Open", onClick },
      });
    });
    const sent = payload();
    expect(sent.type).toBe("success");
    expect(sent.message).toBe("Snippets Manager: Snippet copied");
    expect(sent.rateLimitKey).toBe("plugin:acme.snippets:success");
    expect(sent.duration).toBe(60_000);
    expect(sent.priority).toBeUndefined();
    const action = actionOf(sent);
    expect(action.label).toBe("Open");
    action.onClick();
    action.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("shows the app's Undo toast and calls back once", () => {
    const { result } = renderHook(() => kit.useToast(), { wrapper: owned });
    const onUndo = vi.fn();
    act(() => void result.current.showUndo({ message: "3 snippets deleted", onUndo }));
    const sent = payload();
    expect(sent.type).toBe("success");
    expect(sent.transient).toBe(true);
    expect(sent.duration).toBe(UNDO_TOAST_DURATION_MS);
    const action = actionOf(sent);
    expect(action.label).toBe(UNDO_ACTION_LABEL);
    action.onClick();
    action.onClick();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("keeps one Undo toast per plugin up, replacing the last", () => {
    const dismiss = vi.spyOn(useNotificationStore.getState(), "dismissNotification");
    notifySpy.mockReturnValueOnce("undo-1").mockReturnValueOnce("undo-2");
    const { result } = renderHook(() => kit.useToast(), { wrapper: owned });
    act(() => {
      result.current.showUndo({ message: "1 snippet deleted", onUndo: () => {} });
      result.current.showUndo({ message: "2 snippets deleted", onUndo: () => {} });
    });
    expect(notifySpy).toHaveBeenCalledTimes(2);
    expect(dismiss).toHaveBeenCalledWith("undo-1");
    expect(dismiss).not.toHaveBeenCalledWith("undo-2");
    dismiss.mockRestore();
  });

  it("dismisses through the handle", () => {
    const dismiss = vi.spyOn(useNotificationStore.getState(), "dismissNotification");
    const { result } = renderHook(() => kit.useToast(), { wrapper: owned });
    let handle: kit.ToastHandle | undefined;
    act(() => {
      handle = result.current.show({ message: "Saved" });
    });
    handle!.dismiss();
    handle!.dismiss();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledWith("toast-1");
    dismiss.mockRestore();
  });

  it("ignores unusable options, and an unknown tone falls back to info", () => {
    const { result } = renderHook(() => kit.useToast(), { wrapper: owned });
    act(() => {
      result.current.show(JSON.parse('{"message": "   "}'));
      result.current.show(JSON.parse("null"));
      result.current.showUndo(JSON.parse('{"message": "Gone"}'));
    });
    expect(notifySpy).not.toHaveBeenCalled();
    act(
      () =>
        void result.current.show(
          JSON.parse('{"message": "Hi", "tone": "loud", "action": {"label": "X"}}')
        )
    );
    expect(payload().type).toBe("info");
    expect(payload().action).toBeUndefined();
  });

  it("never shows a project plugin's instance key", () => {
    expect(pluginDisplayName("project__p123__acme.notes")).toBe("acme.notes");
  });
});

describe("hotkeys and the host's own bindings", () => {
  const id = "test.hooksFeedback.host";
  beforeEach(() => {
    keybindingService.registerBinding({
      actionId: id,
      combo: "Cmd+Alt+Shift+F9",
      scope: "global",
      priority: 0,
    });
  });
  afterEach(() => keybindingService.removeBinding(id));

  const mac = () => navigator.platform.toUpperCase().includes("MAC");
  const shiftY = () =>
    new KeyboardEvent("keydown", {
      key: "F9",
      shiftKey: true,
      altKey: true,
      ...(mac() ? { metaKey: true } : { ctrlKey: true }),
      bubbles: true,
      cancelable: true,
    });

  it("names the host action a combo belongs to", () => {
    expect(hotkeyHostBinding("Shift+Alt+Cmd+F9")).toBe(id);
    expect(hotkeyHostBinding("Cmd+Shift+F13")).toBeNull();
    expect(hotkeyHostOwnsEvent(shiftY())).toBe(true);
    expect(hotkeyHostOwnsEvent(new KeyboardEvent("keydown", { key: "Delete" }))).toBe(false);
  });

  it("gives way to a host binding and warns once in development", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = vi.fn();
    function Pane() {
      kit.useHotkeys([{ combo: "Cmd+Alt+Shift+F9", handler }]);
      return createElement("button", { type: "button" }, "pane");
    }
    const first = render(createElement(Pane));
    await tick();
    first.unmount();
    render(createElement(Pane));
    await tick();
    const event = shiftY();
    screen.getByRole("button", { name: "pane" }).dispatchEvent(event);
    expect(handler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(warn.mock.calls.filter(([line]) => String(line).includes(id))).toHaveLength(1);
    warn.mockRestore();
  });
});

describe("ListRow in a multi-select list", () => {
  function row(props: Record<string, unknown>) {
    return createElement(kit.ListRow, {
      id: "r1",
      role: "option",
      "aria-selected": false,
      title: "Rebase onto develop",
      icon: "star",
      ...props,
    });
  }
  const mark = (root: ParentNode) => root.querySelector('[data-slot="checkbox-glyph"]');

  it("draws the host checkbox glyph for membership, ticked when checked", () => {
    const { container, rerender } = render(row({ checked: false }));
    expect(mark(container)?.getAttribute("data-state")).toBe("unchecked");
    rerender(row({ checked: true }));
    expect(mark(container)?.getAttribute("data-state")).toBe("checked");
    // Outside a multi-select list the row keeps its icon alone.
    rerender(row({}));
    expect(mark(container)).toBeNull();
  });

  it("gives the icon's slot to the checkbox while anything is selected", () => {
    const { container, rerender } = render(row({ checked: false }));
    expect(container.querySelector("svg.lucide-star, svg")).not.toBeNull();
    rerender(row({ checked: false, selecting: true }));
    // Only the glyph's own check path may remain; the row icon is gone.
    const icons = [...container.querySelectorAll("svg")].filter(
      (svg) => !svg.closest('[data-slot="checkbox-glyph"]')
    );
    expect(icons).toHaveLength(0);
  });

  it("toggles from the checkbox without the row's own click", () => {
    const onToggle = vi.fn();
    const onClick = vi.fn();
    const { container } = render(row({ checked: false, onToggle, onClick }));
    fireEvent.click(container.querySelector("[data-kit-row-checkbox]")!);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps the host lists' ring on the row a context menu is open on", async () => {
    const { ROW_MENU_TARGET_CLASS } = await import("@/components/ui/paletteRowStyles");
    const { container } = render(row({ checked: false, "data-state": "open" }));
    const option = container.querySelector('[role="option"]')!;
    expect(option.getAttribute("data-state")).toBe("open");
    for (const token of ROW_MENU_TARGET_CLASS.split(/\s+/).filter(Boolean)) {
      expect(option.classList.contains(token)).toBe(true);
    }
  });
});

describe("two-line menu rows", () => {
  it("sets the key column and the submenu chevron on the label's line", async () => {
    render(
      createElement(kit.DropdownMenu, {
        open: true,
        trigger: createElement(kit.Button, { children: "Actions" }),
        items: [
          {
            label: "Delete",
            description: "Undo from the toast",
            shortcut: "Delete",
            onSelect: () => {},
          },
          { label: "Copy", shortcut: "Cmd+C", onSelect: () => {} },
          {
            type: "submenu",
            label: "Export",
            description: "Pick a format",
            items: [{ label: "As JSON", onSelect: () => {} }],
          },
        ],
      })
    );
    const twoLine = await screen.findByRole("menuitem", { name: /Delete/ });
    const oneLine = screen.getByRole("menuitem", { name: /Copy/ });
    const keyColumn = (item: Element) => item.lastElementChild?.getAttribute("class") ?? "";
    expect(keyColumn(twoLine)).toContain("self-start");
    expect(keyColumn(oneLine)).not.toContain("self-start");
    const trigger = screen.getByRole("menuitem", { name: /Export/ });
    expect(trigger.className).toContain("items-start");
  });
});

describe("row menus in a keyboard list", () => {
  function List({ hasRowMenus, onOpen }: { hasRowMenus: boolean; onOpen: () => void }) {
    const rows = ["Alpha", "Beta", "Gamma"];
    const nav = kit.useListNavigation({ count: rows.length, hasRowMenus });
    return createElement(
      "div",
      { ...nav.containerProps, "aria-label": "Rows" },
      rows.map((title, index) =>
        createElement(kit.ContextMenu, {
          key: title,
          onOpenChange: (open: boolean) => {
            if (open) onOpen();
          },
          items: [{ label: `Rename ${title}`, onSelect: () => {} }],
          children: createElement(kit.ListRow, { ...nav.getRowProps(index), title }),
        })
      )
    );
  }

  it("opens the cursor row's menu on Shift+F10 while the list holds focus", async () => {
    const onOpen = vi.fn();
    render(createElement(List, { hasRowMenus: true, onOpen }));
    const list = screen.getByRole("listbox", { name: "Rows" });
    expect(list.hasAttribute("data-row-menu")).toBe(true);
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menuitem", { name: "Rename Beta" })).toBeTruthy();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("leaves the menu keys to the app when the rows have no menus", async () => {
    const onOpen = vi.fn();
    render(createElement(List, { hasRowMenus: false, onOpen }));
    const list = screen.getByRole("listbox", { name: "Rows" });
    expect(list.hasAttribute("data-row-menu")).toBe(false);
    fireEvent.keyDown(list, { key: "ContextMenu" });
    await tick();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
