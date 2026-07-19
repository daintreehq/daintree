/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import type { FileChangeDetail } from "../../../types";
import type { PluginContextMenuItemEntry } from "@/hooks/usePluginContextMenuItems";

const dispatchMock = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

// The diff modal is irrelevant to the context-menu wiring under test.

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// Stub the Radix context-menu so items render without an open portal — render
// the trigger inline and surface each item as a button whose click fires the
// section's onSelect → dispatch path.
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect: () => void;
  }) => (
    <button type="button" data-plugin-item onClick={onSelect}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr data-testid="separator" />,
}));

const { itemsRef } = vi.hoisted(() => ({
  itemsRef: { current: [] as PluginContextMenuItemEntry[] },
}));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({
  usePluginContextMenuItems: () => itemsRef.current,
}));

import { FileChangeList } from "../FileChangeList";

const ROOT = "/repo";

function file(path: string, status: FileChangeDetail["status"] = "modified"): FileChangeDetail {
  return { path, status, insertions: 1, deletions: 0 };
}

function fileItem(actionId: string): PluginContextMenuItemEntry {
  return {
    pluginId: "acme",
    item: { pluginId: "acme", label: "Open with Acme", actionId, location: "file" } as never,
  };
}

beforeEach(() => {
  dispatchMock.mockClear();
  itemsRef.current = [];
});

afterEach(() => cleanup());

describe("FileChangeList — file context menu", () => {
  it("adds no plugin menu DOM when no plugin contributes file items", () => {
    itemsRef.current = [];
    const { container } = render(<FileChangeList changes={[file("src/a.ts")]} rootPath={ROOT} />);
    expect(container.querySelector("[data-plugin-item]")).toBeNull();
  });

  it("dispatches the clicked file's real absolute path, not undefined", () => {
    itemsRef.current = [fileItem("file.openDiff")];
    const { container } = render(
      <FileChangeList changes={[file("src/index.ts", "modified")]} rootPath={ROOT} />
    );

    const item = container.querySelector<HTMLButtonElement>("[data-plugin-item]");
    expect(item).not.toBeNull();
    fireEvent.click(item!);

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [actionId, args] = dispatchMock.mock.calls[0]!;
    expect(actionId).toBe("file.openDiff");
    expect(args).not.toBeUndefined();
    expect(args).toMatchObject({
      path: "/repo/src/index.ts",
      worktreePath: ROOT,
      status: "modified",
    });
  });

  it("keeps an already-absolute change path absolute in the dispatched args", () => {
    itemsRef.current = [fileItem("file.openDiff")];
    const { container } = render(
      <FileChangeList changes={[file("/repo/src/abs.ts", "added")]} rootPath={ROOT} />
    );

    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-plugin-item]")!);
    const [, args] = dispatchMock.mock.calls[0]!;
    expect((args as { path: string }).path).toBe("/repo/src/abs.ts");
    expect((args as { status: string }).status).toBe("added");
  });
});
