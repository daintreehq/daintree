/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import type { PluginContextMenuItemEntry } from "@/hooks/usePluginContextMenuItems";

// Typed rather than bare `vi.fn()`: the destructuring below reads positional
// args off `mock.calls`, and an untyped double makes those `unknown[]` — which
// is exactly how a wrong-shaped call slips past a test that looks strict.
type DispatchResult = { ok: true; result: unknown } | { ok: false; error: { message: string } };
const dispatchMock = vi.fn<(id: string, args?: unknown, opts?: unknown) => Promise<DispatchResult>>(
  () => Promise.resolve({ ok: true, result: undefined })
);
vi.mock("@/services/ActionService", () => ({
  actionService: (() => ({
    dispatch: (id: string, args?: unknown, opts?: unknown) => dispatchMock(id, args, opts),
  }))(),
}));

interface NotifyPayload {
  type: string;
  title?: string;
  message?: string;
  action?: { label: string; onClick: () => void };
}
const notifyMock = vi.fn<(payload: NotifyPayload) => string>(() => "toast-1");
vi.mock("@/lib/notify", () => ({ notify: (payload: NotifyPayload) => notifyMock(payload) }));

interface CopyContextOptions {
  modified?: boolean;
  includePaths?: string[];
  scopePaths?: string[];
  scopeKind?: "file" | "folder";
}
const copyContextMock = vi.fn<
  (
    worktreeId: string,
    source: string,
    options?: CopyContextOptions,
    runSource?: string
  ) => Promise<void>
>(() => Promise.resolve());
vi.mock("@/hooks/useWorktreeActions", () => ({
  copyContextWithFeedback: (
    worktreeId: string,
    source: string,
    options?: CopyContextOptions,
    runSource?: string
  ) => copyContextMock(worktreeId, source, options, runSource),
}));

const { itemsRef, insertRef } = vi.hoisted(() => ({
  itemsRef: { current: [] as PluginContextMenuItemEntry[] },
  insertRef: { current: { canInsert: true, insert: vi.fn(() => true) } },
}));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({
  usePluginContextMenuItems: () => itemsRef.current,
}));
vi.mock("@/hooks/useInsertFileReference", () => ({
  useInsertFileReference: () => insertRef.current,
}));

// The platform decides the reveal wording; pin it so the assertions name one
// label instead of a three-way alternation.
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
  isWindows: () => false,
}));

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { primeRadix } from "@/components/ui/radix-loader";
import {
  isFileRowMenuKey,
  useFileRowMenuItems,
  type FileRowMenuItemOptions,
  type FileRowMenuSurface,
  type FileRowMenuTarget,
} from "../useFileRowMenuItems";

const WORKTREE = "/repo";

function target(overrides: Partial<FileRowMenuTarget> = {}): FileRowMenuTarget {
  return {
    absolutePath: "/repo/src/index.ts",
    relativePath: "src/index.ts",
    name: "index.ts",
    isDirectory: false,
    status: "modified",
    ...overrides,
  };
}

function Harness({
  surface,
  row,
  options,
}: {
  surface?: Partial<FileRowMenuSurface>;
  row?: Partial<FileRowMenuTarget>;
  options?: FileRowMenuItemOptions;
}) {
  const { renderItems } = useFileRowMenuItems({
    worktreePath: WORKTREE,
    worktreeId: "wt-1",
    copyTreeRunSource: "file-browser",
    ...surface,
  });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div role="button" tabIndex={0} aria-label="row">
          row
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>{renderItems(target(row), options)}</ContextMenuContent>
    </ContextMenu>
  );
}

async function openMenu(props: React.ComponentProps<typeof Harness> = {}): Promise<HTMLElement> {
  render(<Harness {...props} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "row" }));
  return screen.findByRole("menu");
}

function labels(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  // Reset the implementation, not just the calls: the reveal-failure test swaps
  // it, and restoring inline leaves the next test running against a rejecting
  // dispatch the moment an assertion before the restore fails.
  dispatchMock.mockReset();
  dispatchMock.mockImplementation(() => Promise.resolve({ ok: true, result: undefined }));
  notifyMock.mockClear();
  copyContextMock.mockClear();
  itemsRef.current = [];
  insertRef.current = { canInsert: true, insert: vi.fn(() => true) };
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(() => Promise.resolve()) },
  });
});

afterEach(() => cleanup());

describe("useFileRowMenuItems — canonical order", () => {
  it("renders the core in the documented order for a changed file", async () => {
    const menu = await openMenu();

    expect(labels(menu)).toEqual([
      "Open diff",
      "Open file",
      "Open in editor",
      expect.stringContaining("Insert file reference"),
      "Copy context",
      "Copy path",
      "Copy relative path",
      "Copy file name",
      "Reveal in Finder",
    ]);
  });

  it("appends plugin items after the core rather than replacing it", async () => {
    itemsRef.current = [
      { pluginId: "acme", item: { label: "Acme thing", actionId: "acme.do", location: "file" } },
    ];
    const menu = await openMenu();
    const rendered = labels(menu);

    expect(rendered.indexOf("Acme thing")).toBe(rendered.length - 1);
    expect(rendered.indexOf("Acme thing")).toBeGreaterThan(rendered.indexOf("Reveal in Finder"));
  });
});

describe("useFileRowMenuItems — conditional items", () => {
  it("drops Open diff for a file with no changes", async () => {
    const menu = await openMenu({ row: { status: null } });
    expect(labels(menu)).not.toContain("Open diff");
    expect(labels(menu)).toContain("Open file");
  });

  it("keeps Open diff when the surface says the row has changes despite a null status", async () => {
    const menu = await openMenu({ row: { status: null }, options: { hasChanges: true } });
    expect(labels(menu)).toContain("Open diff");
  });

  it("drops every open item for a directory but keeps the rest of the core", async () => {
    const menu = await openMenu({
      row: { isDirectory: true, relativePath: "src", name: "src", status: null },
    });
    const rendered = labels(menu);

    expect(rendered).not.toContain("Open diff");
    expect(rendered).not.toContain("Open file");
    expect(rendered).not.toContain("Open in editor");
    expect(rendered).toContain("Copy path");
    expect(rendered).toContain("Copy context");
    expect(rendered).toContain("Reveal in Finder");
  });

  it("drops the current-content items for a deleted file but keeps its diff", async () => {
    // The file is still listed — the change set would be a lie without it — but
    // nothing is on disk, so opening it would resolve to a file-not-found.
    const menu = await openMenu({ row: { status: "deleted" } });
    const rendered = labels(menu);

    expect(rendered).toContain("Open diff");
    expect(rendered).not.toContain("Open file");
    expect(rendered).not.toContain("Open in editor");
    expect(rendered).toContain("Copy path");
  });

  it("drops Copy context on a surface with no worktree behind it", async () => {
    const menu = await openMenu({ surface: { worktreeId: null } });
    expect(labels(menu)).not.toContain("Copy context");
    // The rest of the core is unaffected — a file must not lose Copy path by
    // which panel lists it.
    expect(labels(menu)).toContain("Copy path");
  });

  it("disables Insert file reference when no agent resolves", async () => {
    insertRef.current = { canInsert: false, insert: vi.fn(() => false) };
    const menu = await openMenu();

    const item = within(menu).getByRole("menuitem", { name: /Insert file reference/ });
    expect(item.getAttribute("data-disabled")).not.toBeNull();
  });
});

describe("useFileRowMenuItems — Open diff routing", () => {
  it("calls the surface's own opener when one is injected", async () => {
    const onOpenDiff = vi.fn();
    const menu = await openMenu({ options: { onOpenDiff } });

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open diff" }));

    expect(onOpenDiff).toHaveBeenCalledTimes(1);
    // The injected opener replaces the action entirely — dispatching as well
    // would open a second, changeset-less diff.
    expect(dispatchMock.mock.calls.some(([id]) => id === "file.openDiff")).toBe(false);
  });

  it("falls back to file.openDiff with the row's real subject", async () => {
    const menu = await openMenu();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open diff" }));

    await waitFor(() => {
      const call = dispatchMock.mock.calls.find(([id]) => id === "file.openDiff");
      expect(call).toBeDefined();
      expect(call![1]).toMatchObject({
        path: "/repo/src/index.ts",
        worktreePath: WORKTREE,
        status: "modified",
      });
    });
  });
});

describe("useFileRowMenuItems — path semantics", () => {
  it("copies the absolute path, the relative path and the name it was handed", async () => {
    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;

    for (const [label, expected] of [
      ["Copy path", "/repo/src/index.ts"],
      ["Copy relative path", "src/index.ts"],
      ["Copy file name", "index.ts"],
    ] as const) {
      const menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: label }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
      writeText.mockClear();
      cleanup();
    }
  });

  it("does not re-derive the relative path from the absolute one", async () => {
    // The file browser's row path stays relative to the true worktree root even
    // when the tree is re-rooted, so a derived value would be wrong there.
    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    const menu = await openMenu({
      row: { absolutePath: "/elsewhere/pkg/a.ts", relativePath: "pkg/a.ts" },
    });

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy relative path" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("pkg/a.ts"));
  });

  it("raises a retryable toast when the clipboard rejects, and Retry rewrites the same path", async () => {
    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    writeText.mockRejectedValueOnce(new Error("nope"));
    const menu = await openMenu();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy path" }));

    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    const [payload] = notifyMock.mock.calls[0]!;
    expect(payload.type).toBe("error");
    expect(payload.action?.label).toBe("Retry");

    // A Retry that re-enters nothing would satisfy a label-only assertion, so
    // fire it and prove the same path goes back to the clipboard.
    writeText.mockClear();
    payload.action!.onClick();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/repo/src/index.ts"));
  });
});

describe("useFileRowMenuItems — Copy context", () => {
  it("scopes CopyTree to the row's relative path and names the scope kind", async () => {
    const menu = await openMenu();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy context" }));

    await waitFor(() => expect(copyContextMock).toHaveBeenCalledTimes(1));
    const [worktreeId, source, options, runSource] = copyContextMock.mock.calls[0]!;
    expect(worktreeId).toBe("wt-1");
    expect(source).toBe("context-menu");
    expect(options).toMatchObject({ scopePaths: ["src/index.ts"], scopeKind: "file" });
    expect(runSource).toBe("file-browser");
  });

  it("reports a directory scope as a folder", async () => {
    const menu = await openMenu({
      row: { isDirectory: true, relativePath: "src", name: "src", status: null },
    });

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy context" }));

    await waitFor(() => expect(copyContextMock).toHaveBeenCalledTimes(1));
    const [, , options] = copyContextMock.mock.calls[0]!;
    expect(options?.scopeKind).toBe("folder");
  });
});

describe("useFileRowMenuItems — reveal", () => {
  it("toasts with a Retry when the dispatch fails, and Retry reruns the same reveal", async () => {
    dispatchMock.mockImplementation((actionId: string) =>
      actionId === "file.showItemInFolder"
        ? Promise.resolve({ ok: false, error: { message: "gone" } })
        : Promise.resolve({ ok: true, result: undefined })
    );
    const menu = await openMenu();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Reveal in Finder" }));

    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    const [payload] = notifyMock.mock.calls[0]!;
    expect(payload.type).toBe("error");
    expect(payload.message).toBe("gone");
    expect(payload.action?.label).toBe("Retry");

    dispatchMock.mockClear();
    payload.action!.onClick();
    await waitFor(() =>
      expect(dispatchMock).toHaveBeenCalledWith(
        "file.showItemInFolder",
        { path: "/repo/src/index.ts" },
        { source: "context-menu" }
      )
    );
  });

  it("stays quiet on success", async () => {
    const menu = await openMenu();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Reveal in Finder" }));

    await waitFor(() =>
      expect(dispatchMock.mock.calls.some(([id]) => id === "file.showItemInFolder")).toBe(true)
    );
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("isFileRowMenuKey", () => {
  const base = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };

  it("accepts the dedicated menu key and Shift+F10", () => {
    expect(isFileRowMenuKey({ ...base, key: "ContextMenu" })).toBe(true);
    expect(isFileRowMenuKey({ ...base, key: "F10", shiftKey: true })).toBe(true);
  });

  it("rejects F10 without Shift and Shift+F10 with another modifier", () => {
    expect(isFileRowMenuKey({ ...base, key: "F10" })).toBe(false);
    expect(isFileRowMenuKey({ ...base, key: "F10", shiftKey: true, altKey: true })).toBe(false);
    expect(isFileRowMenuKey({ ...base, key: "F10", shiftKey: true, metaKey: true })).toBe(false);
    expect(isFileRowMenuKey({ ...base, key: "F10", shiftKey: true, ctrlKey: true })).toBe(false);
  });

  it("rejects unrelated keys", () => {
    expect(isFileRowMenuKey({ ...base, key: "Enter" })).toBe(false);
  });
});
