/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import type { PluginContextMenuItemEntry } from "@/hooks/usePluginContextMenuItems";
import type {
  InsertFileReference,
  InsertFileReferenceRefusalReason,
} from "@/hooks/useInsertFileReference";

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
  insertRef: {
    current: {
      canInsert: true,
      refusalReason: null,
      insert: vi.fn(() => true),
    } as InsertFileReference,
  },
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

// Typed at the declaration rather than cast at each use: `navigator.clipboard`
// is `Clipboard`, so reading `.mock` off it needs an assertion that the ratchet
// counts. One typed double serves every assertion here.
const writeTextMock = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

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

function separatorCount(menu: HTMLElement): number {
  return within(menu).queryAllByRole("separator").length;
}

/**
 * A menu's rows in DOM order — items, group labels and rules alike, with rules
 * written as `---`.
 *
 * `labels()` sees only menuitems and `separatorCount()` only counts, so between
 * them a rule moved to the top of a menu, or a group label rendered away from
 * the group it names, reads as correct. Placement is the whole claim in a
 * regrouped menu, so it gets an assertion that can see it. The content's own
 * scroll-shadow overlays are `aria-hidden` and drop out.
 */
function structure(menu: HTMLElement): string[] {
  return [...menu.children]
    .filter((node) => node.getAttribute("aria-hidden") !== "true")
    .map((node) => (node.getAttribute("role") === "separator" ? "---" : (node.textContent ?? "")));
}

/**
 * Opens a nested submenu and hands back its content.
 *
 * `SubContent` is Presence-gated: its items are not in the DOM at all until the
 * trigger fires, so an assertion that skipped this step would look for nothing,
 * find nothing, and pass for the wrong reason. Clicked rather than hovered —
 * Radix opens synchronously on click, while the pointer path arms a 100ms timer
 * this suite would then have to fake. The content is found by name because
 * `SubContent` is labelled by its trigger and lands in a portal outside `menu`.
 */
async function openSubmenu(menu: HTMLElement, name: string): Promise<HTMLElement> {
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
  return screen.findByRole("menu", { name });
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
  insertRef.current = { canInsert: true, refusalReason: null, insert: vi.fn(() => true) };
  writeTextMock.mockReset();
  writeTextMock.mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: writeTextMock } });
});

afterEach(() => cleanup());

describe("useFileRowMenuItems — canonical order", () => {
  it("keeps only the direct actions at the root and nests the copies", async () => {
    const menu = await openMenu();

    // The rule is asserted in place, not counted: it is the one thing here that
    // can end up leading, trailing or doubled as items drop out.
    expect(structure(menu)).toEqual([
      "Open diff",
      "Open file",
      "Open in editor",
      "Reveal in Finder",
      expect.stringContaining("Insert file reference"),
      "---",
      "Copy",
    ]);
  });

  it("renders the copies in the documented order inside the Copy submenu", async () => {
    const menu = await openMenu();
    const copy = await openSubmenu(menu, "Copy");

    // CopyTree is set apart from the clipboard strings, and the rule sits
    // between them rather than merely existing somewhere in the submenu.
    expect(structure(copy)).toEqual([
      "Copy context",
      "---",
      "Copy path",
      "Copy relative path",
      "Copy file name",
      "Copy file contents",
    ]);
  });

  it("nests plugin items under Extensions rather than trailing the root", async () => {
    itemsRef.current = [
      { pluginId: "acme", item: { label: "Acme thing", actionId: "acme.do", location: "file" } },
    ];
    const menu = await openMenu();

    // The whole point of the nesting: the root is the same height whatever is
    // installed, and a third party can no longer render past the core. Pinned
    // as a sequence so the second rule has to sit between Copy and Extensions
    // rather than merely exist.
    expect(structure(menu)).toEqual([
      "Open diff",
      "Open file",
      "Open in editor",
      "Reveal in Finder",
      expect.stringContaining("Insert file reference"),
      "---",
      "Copy",
      "---",
      "Extensions",
    ]);

    const extensions = await openSubmenu(menu, "Extensions");
    // A lone contributor needs no provenance label above its own items, and no
    // rule to divide it from a group that isn't there.
    expect(structure(extensions)).toEqual(["Acme thing"]);
  });

  it("groups the submenu by contributor when more than one plugin adds items", async () => {
    itemsRef.current = [
      { pluginId: "acme", item: { label: "Acme thing", actionId: "acme.do", location: "file" } },
      { pluginId: "beta", item: { label: "Beta thing", actionId: "beta.do", location: "file" } },
      { pluginId: "acme", item: { label: "Acme other", actionId: "acme.other", location: "file" } },
    ];
    const menu = await openMenu();
    const extensions = await openSubmenu(menu, "Extensions");

    // Grouped by contributor in first-seen order — acme's second item joins its
    // first rather than staying where it happened to be contributed. Asserted
    // as one sequence because a label that doesn't sit above its own group is
    // worse than no label: it credits the wrong extension.
    expect(structure(extensions)).toEqual([
      "acme",
      "Acme thing",
      "Acme other",
      "---",
      "beta",
      "Beta thing",
    ]);
  });

  it("opens and closes the Copy submenu from the keyboard", async () => {
    // Nesting is only honest if it is reachable without a mouse. Every other
    // submenu test here opens by click, so a regression that kept the click
    // path and broke ArrowRight — or lost the trigger on the way back out —
    // would leave the whole suite green with the copies unreachable.
    const menu = await openMenu();
    const trigger = within(menu).getByRole("menuitem", { name: "Copy" });

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });

    const copy = await screen.findByRole("menu", { name: "Copy" });
    await waitFor(() => expect(copy.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(copy, { key: "ArrowLeft" });

    await waitFor(() => expect(screen.queryByRole("menu", { name: "Copy" })).toBeNull());
    // Back on the trigger, not stranded on the document — the root menu is
    // still open and still navigable.
    expect(document.activeElement).toBe(trigger);
  });

  it("renders no Extensions trigger, and no rule for one, with nothing installed", async () => {
    const menu = await openMenu();

    expect(labels(menu)).not.toContain("Extensions");
    expect(separatorCount(menu)).toBe(1);
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
    // With every open item gone the direct-action block is Reveal and Insert,
    // so the rule below them still has something above it and never leads.
    expect(structure(menu)).toEqual([
      "Reveal in Finder",
      expect.stringContaining("Insert file reference"),
      "---",
      "Copy",
    ]);

    const copy = await openSubmenu(menu, "Copy");
    expect(labels(copy)).toContain("Copy path");
    expect(labels(copy)).toContain("Copy context");
  });

  it("drops the current-content items for a deleted file but keeps its diff", async () => {
    // The file is still listed — the change set would be a lie without it — but
    // nothing is on disk, so opening it would resolve to a file-not-found.
    const menu = await openMenu({ row: { status: "deleted" } });
    const rendered = labels(menu);

    expect(rendered).toContain("Open diff");
    expect(rendered).not.toContain("Open file");
    expect(rendered).not.toContain("Open in editor");
    // Two of the three opens gone still leaves the rule with items above it.
    expect(structure(menu)).toEqual([
      "Open diff",
      "Reveal in Finder",
      expect.stringContaining("Insert file reference"),
      "---",
      "Copy",
    ]);

    const copy = await openSubmenu(menu, "Copy");
    expect(labels(copy)).toContain("Copy path");
  });

  it("drops Copy context on a surface with no worktree behind it", async () => {
    const menu = await openMenu({ surface: { worktreeId: null } });
    const copy = await openSubmenu(menu, "Copy");

    expect(labels(copy)).not.toContain("Copy context");
    // The rest of the core is unaffected — a file must not lose Copy path by
    // which panel lists it — and the rule that set CopyTree apart goes with it
    // rather than leading the submenu.
    expect(labels(copy)).toContain("Copy path");
    expect(separatorCount(copy)).toBe(0);
  });

  it("disables Insert file reference when no agent resolves", async () => {
    insertRef.current = {
      canInsert: false,
      refusalReason: "no-eligible-agent",
      insert: vi.fn(() => false),
    };
    const menu = await openMenu();

    const item = within(menu).getByRole("menuitem", { name: /Insert file reference/ });
    expect(item.getAttribute("data-disabled")).not.toBeNull();
  });
});

/**
 * #12207: seven different gates used to share one grey item with nothing on the
 * row to tell them apart. Each reason has to reach BOTH registers — the visible
 * meta slot and the accessible name — because `ContextMenuMeta` is `aria-hidden`
 * and a screen reader would otherwise hear the same bare label every time.
 */
describe("useFileRowMenuItems — Insert file reference refusal reasons", () => {
  const CASES: Array<[InsertFileReferenceRefusalReason, string, string]> = [
    ["workspace-unavailable", "No workspace", "Insert file reference, no workspace"],
    ["fleet-broadcast-armed", "Fleet armed", "Insert file reference, the fleet is armed"],
    [
      "hybrid-input-disabled",
      "Input bar off",
      "Insert file reference, the hybrid input bar is off",
    ],
    [
      "backend-unavailable",
      "No terminal service",
      "Insert file reference, the terminal service is unavailable",
    ],
    [
      "recorded-target-unavailable",
      "Agent unavailable",
      "Insert file reference, that agent can't take input",
    ],
    ["no-eligible-agent", "No agent available", "Insert file reference, no agent is available"],
    [
      "multiple-eligible-agents",
      "Type to an agent",
      "Insert file reference, type to an agent first",
    ],
  ];

  async function openDisabled(reason: InsertFileReferenceRefusalReason): Promise<HTMLElement> {
    insertRef.current = { canInsert: false, refusalReason: reason, insert: vi.fn(() => false) };
    const menu = await openMenu();
    return within(menu).getByRole("menuitem", { name: /^Insert file reference/ });
  }

  for (const [reason, meta, ariaLabel] of CASES) {
    it(`says "${meta}" when the refusal is ${reason}`, async () => {
      const item = await openDisabled(reason);

      expect(item.getAttribute("data-disabled")).not.toBeNull();
      expect(item.getAttribute("aria-label")).toBe(ariaLabel);
      // The element, not just the text: the reason has to be in the trailing
      // meta slot, and it has to stay hidden from assistive tech because the
      // accessible name above already carries it. A second announced copy is
      // the failure `ContextMenuMeta` is `aria-hidden` to prevent.
      const metaEl = within(item).getByText(meta);
      expect(metaEl.getAttribute("aria-hidden")).toBe("true");
    });
  }

  it("drops the shortcut hint while disabled — the keybinding would be a lie", async () => {
    const item = await openDisabled("no-eligible-agent");

    expect(item.textContent).not.toContain("⌘I");
    expect(item.hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("shows the shortcut and no reason once a target resolves", async () => {
    const menu = await openMenu();
    const item = within(menu).getByRole("menuitem", { name: /Insert file reference/ });

    expect(item.getAttribute("data-disabled")).toBeNull();
    expect(item.textContent).toContain("⌘I");
    expect(item.getAttribute("aria-keyshortcuts")).toBeTruthy();
    // No `aria-label` override: the label plus the shortcut is the whole name.
    expect(item.hasAttribute("aria-label")).toBe(false);
    for (const [, meta] of CASES) {
      expect(item.textContent).not.toContain(meta);
    }
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
      const copy = await openSubmenu(menu, "Copy");
      fireEvent.click(within(copy).getByRole("menuitem", { name: label }));
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
    const copy = await openSubmenu(menu, "Copy");

    fireEvent.click(within(copy).getByRole("menuitem", { name: "Copy relative path" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("pkg/a.ts"));
  });

  it("raises a retryable toast when the clipboard rejects, and Retry rewrites the same path", async () => {
    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    writeText.mockRejectedValueOnce(new Error("nope"));
    const menu = await openMenu();
    const copy = await openSubmenu(menu, "Copy");

    fireEvent.click(within(copy).getByRole("menuitem", { name: "Copy path" }));

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

describe("useFileRowMenuItems — Copy file contents", () => {
  it("reads through the contained file.read action and writes exactly what came back", async () => {
    dispatchMock.mockImplementation((id) =>
      id === "file.read"
        ? Promise.resolve({ ok: true, result: { content: "raw\nsource\n" } })
        : Promise.resolve({ ok: true, result: undefined })
    );
    const menu = await openMenu();
    const copy = await openSubmenu(menu, "Copy");

    fireEvent.click(within(copy).getByRole("menuitem", { name: "Copy file contents" }));

    await waitFor(() => {
      const call = dispatchMock.mock.calls.find(([id]) => id === "file.read");
      expect(call).toBeDefined();
      // filesClient.read would skip the action's containment check, which is
      // what keeps this off arbitrary paths outside the project.
      expect(call![1]).toEqual({ path: "/repo/src/index.ts" });
      expect(call![2]).toEqual({ source: "context-menu" });
    });
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith("raw\nsource\n"));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("raises a retryable toast when the read fails, and writes nothing", async () => {
    dispatchMock.mockImplementation((id) =>
      id === "file.read"
        ? Promise.resolve({ ok: false, error: { message: "Binary file — cannot display" } })
        : Promise.resolve({ ok: true, result: undefined })
    );
    const menu = await openMenu();
    const copy = await openSubmenu(menu, "Copy");

    fireEvent.click(within(copy).getByRole("menuitem", { name: "Copy file contents" }));

    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    const [payload] = notifyMock.mock.calls[0]!;
    expect(payload.type).toBe("error");
    expect(payload.title).toBe("Couldn't copy file contents");
    // The reason has to survive: extension gating can't see a binary with a
    // text-like name, so this toast is where the user learns why.
    expect(payload.message).toBe("Binary file — cannot display");
    // Clobbering the clipboard with nothing would lose whatever was in it.
    expect(writeTextMock).not.toHaveBeenCalled();

    payload.action!.onClick();
    await waitFor(() =>
      expect(dispatchMock.mock.calls.filter(([id]) => id === "file.read").length).toBe(2)
    );
  });

  it("retries the clipboard write without re-reading the file", async () => {
    writeTextMock.mockRejectedValueOnce(new Error("nope"));
    dispatchMock.mockImplementation((id) =>
      id === "file.read"
        ? Promise.resolve({ ok: true, result: { content: "raw" } })
        : Promise.resolve({ ok: true, result: undefined })
    );
    const menu = await openMenu();
    const copy = await openSubmenu(menu, "Copy");

    fireEvent.click(within(copy).getByRole("menuitem", { name: "Copy file contents" }));

    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    const [payload] = notifyMock.mock.calls[0]!;
    expect(payload.title).toBe("Couldn't copy file contents");

    writeTextMock.mockClear();
    payload.action!.onClick();

    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith("raw"));
    // The bytes are already in hand; a second read would be a wasted IPC round
    // trip against a file that may have changed underneath the first one.
    expect(dispatchMock.mock.calls.filter(([id]) => id === "file.read").length).toBe(1);
  });

  it.each([
    ["a directory", { isDirectory: true, name: "src", relativePath: "src", status: null }],
    ["a deleted file", { status: "deleted" as const }],
    ["an image", { absolutePath: "/repo/logo.png", name: "logo.png" }],
    ["an SVG", { absolutePath: "/repo/icon.svg", name: "icon.svg" }],
    ["a video", { absolutePath: "/repo/clip.mp4", name: "clip.mp4" }],
    ["an unplayable video", { absolutePath: "/repo/clip.mov", name: "clip.mov" }],
    ["audio", { absolutePath: "/repo/track.mp3", name: "track.mp3" }],
    ["a PDF", { absolutePath: "/repo/spec.pdf", name: "spec.pdf" }],
  ])("hides the item for %s", async (_case, row) => {
    const menu = await openMenu({ row });
    // The submenu has to be opened first: its content is Presence-gated, so a
    // check against the closed root would pass whether the item was dropped or
    // not.
    const copy = await openSubmenu(menu, "Copy");
    expect(labels(copy)).not.toContain("Copy file contents");
  });

  it("copies an empty file as the empty string", async () => {
    dispatchMock.mockImplementation((id) =>
      id === "file.read"
        ? Promise.resolve({ ok: true, result: { content: "" } })
        : Promise.resolve({ ok: true, result: undefined })
    );
    const menu = await openMenu();
    const copy = await openSubmenu(menu, "Copy");

    fireEvent.click(within(copy).getByRole("menuitem", { name: "Copy file contents" }));

    // A truthiness gate on the read result would silently write nothing here.
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith(""));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("keeps the item for an extension it doesn't recognise", async () => {
    // Optimistic by design: the read is the real gate, and hiding everything
    // unfamiliar would drop the item for perfectly ordinary text files.
    const menu = await openMenu({ row: { absolutePath: "/repo/Makefile", name: "Makefile" } });
    const copy = await openSubmenu(menu, "Copy");
    expect(labels(copy)).toContain("Copy file contents");
  });
});

describe("useFileRowMenuItems — Copy context", () => {
  it("scopes CopyTree to the row's relative path and names the scope kind", async () => {
    const menu = await openMenu();
    const copy = await openSubmenu(menu, "Copy");

    fireEvent.click(within(copy).getByRole("menuitem", { name: "Copy context" }));

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
    const copy = await openSubmenu(menu, "Copy");

    fireEvent.click(within(copy).getByRole("menuitem", { name: "Copy context" }));

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
