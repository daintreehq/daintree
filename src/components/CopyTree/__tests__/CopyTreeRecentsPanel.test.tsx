// @vitest-environment jsdom
/**
 * CopyTreeMenuContent — the copy-context toolbar menu body (#11733).
 *
 * The menu is what turned a silent one-click full copy into a two-stage
 * interaction, so what matters here is that the pinned entry stays reachable
 * at all times, that the recents faithfully reflect the project history they
 * are a shortcut into, and that the entry the menu anchors is never repeated
 * beneath itself.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";

import type { CopyTreeHistoryRecord } from "@shared/types";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { primeRadix } from "@/components/ui/radix-loader";
import {
  CopyTreeMenuContent,
  formatRecentMeta,
  formatRecentTrailing,
} from "../CopyTreeRecentsPanel";
import {
  useCopyTreeHistoryStore,
  _resetCopyTreeHistoryStoreForTest,
} from "@/store/copyTreeHistoryStore";

// Hoisted so the mock factory can reference the spy directly rather than
// through a closure that only resolves at mount time — a later edit to
// `init: initSpy` would otherwise become a TDZ collection failure.
const { initSpy } = vi.hoisted(() => ({ initSpy: vi.fn() }));

vi.mock("@/store/copyTreeHistoryStore", async () => {
  const { create } = await import("zustand");
  const store = create<{
    records: CopyTreeHistoryRecord[];
    loading: boolean;
    init: () => void;
  }>(() => ({
    records: [],
    loading: true,
    init: initSpy,
  }));
  return {
    useCopyTreeHistoryStore: store,
    _resetCopyTreeHistoryStoreForTest: () => store.setState({ records: [], loading: true }),
  };
});

beforeAll(async () => {
  await primeRadix();
});

function makeRecord(overrides: Partial<CopyTreeHistoryRecord> = {}): CopyTreeHistoryRecord {
  const id = overrides.id ?? "r1";
  return {
    id,
    dedupeKey: `key-${id}`,
    name: `Run ${id}`,
    // A recent worth listing is one that differs from the pinned action.
    // A record with no options IS the pinned "Copy full context" run, and the
    // menu drops it rather than listing the entry twice — so a fixture that
    // used `{}` here would be testing the filtered-out case by accident.
    options: { scopePaths: [`scope-${id}`] },
    source: "toolbar",
    worktreeId: "wt-1",
    stats: { fileCount: 3, totalSize: 2048 },
    createdAt: 0,
    lastUsedAt: 1_000,
    runCount: 1,
    ...overrides,
  };
}

function seed(records: CopyTreeHistoryRecord[]) {
  act(() => {
    useCopyTreeHistoryStore.setState({ records, loading: false });
  });
}

const noop = () => {};

/**
 * Mounted open inside a real menu root: the content is a Radix
 * `DropdownMenuContent`, which only exists while its root is open.
 */
function renderMenu(props: Partial<React.ComponentProps<typeof CopyTreeMenuContent>> = {}) {
  return render(
    <DropdownMenu open>
      <DropdownMenuTrigger>trigger</DropdownMenuTrigger>
      <CopyTreeMenuContent
        onCopyFullContext={noop}
        onRunRecent={noop}
        onOpenContextSettings={noop}
        {...props}
      />
    </DropdownMenu>
  );
}

/** The recent entries only — never the pinned entry or the settings entry. */
function listedRecents(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-copy-tree-recent]"));
}

describe("CopyTreeMenuContent", () => {
  beforeEach(() => {
    initSpy.mockClear();
    _resetCopyTreeHistoryStoreForTest();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("initializes the history mirror on mount", () => {
    // The store has no other consumer in the app, so if the menu stops calling
    // init() the recents are permanently empty rather than merely stale.
    seed([]);
    renderMenu();
    expect(initSpy).toHaveBeenCalled();
  });

  it("offers the full copy while history is still hydrating", () => {
    // The pinned entry is the old one-click behavior. Gating it behind the
    // history read would make the menu strictly slower than the button it
    // replaced.
    renderMenu();
    const pinned = screen.getByRole("menuitem", { name: /copy full context/i });
    expect(pinned.getAttribute("data-disabled")).toBeNull();
  });

  it("shows the keybinding beside the pinned entry when one is bound", () => {
    seed([]);
    renderMenu({ shortcut: "⌘⇧C" });
    const pinned = screen.getByRole("menuitem", { name: /copy full context/i });
    expect(pinned.textContent).toContain("⌘⇧C");
  });

  it("renders every entry as a menuitem", () => {
    // The whole reason this is a DropdownMenu and not a panel: the primitive
    // owns arrow-key navigation, typeahead and close-time focus. A regression
    // to a plain button list would silently lose all three.
    seed([makeRecord({ name: "authentication stuff" })]);
    renderMenu();
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Copy full context"),
        expect.stringContaining("authentication stuff"),
        expect.stringContaining("Context settings"),
      ])
    );
  });

  it("names the next action when the project has no history yet", () => {
    seed([]);
    renderMenu();
    // Empty-state convention: point at what to do, not at what is missing —
    // and at an action that can actually populate the list.
    const empty = screen.getByRole("menuitem", { name: /copy a folder to reuse/i });
    expect(empty.getAttribute("data-disabled")).not.toBeNull();
    expect((empty.textContent ?? "").toLowerCase()).not.toContain("no recent");
  });

  it("surfaces only the five newest runs, in the order Main sent them", () => {
    // Main already sorts newest-first and caps the durable list; re-sorting
    // here would fight that, so the contract is "take the first five".
    seed(Array.from({ length: 8 }, (_, i) => makeRecord({ id: `r${i}` })));
    renderMenu();

    const listed = listedRecents().map((el) => el.textContent ?? "");
    expect(listed).toHaveLength(5);
    expect(listed[0]).toContain("Run r0");
    expect(listed[4]).toContain("Run r4");
    expect(screen.queryByText("Run r5")).toBeNull();
  });

  it("does not repeat the pinned action as the first recent", () => {
    // A full-context run records no options, so it is the entry above it,
    // not a separate thing to choose between.
    seed([
      makeRecord({ id: "d", name: "Full context", options: {} }),
      makeRecord({ id: "s", name: "src", options: { scopePaths: ["src"] } }),
    ]);
    renderMenu();

    const listed = listedRecents().map((el) => el.textContent ?? "");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain("src");
  });

  it("keeps a run that only shares the default's NAME", () => {
    // The guard against deduplicating by label: a record called "Full context"
    // that carries a format or a filter is a genuinely different run.
    seed([makeRecord({ id: "m", name: "Full context", options: { modified: true } })]);
    renderMenu();
    expect(listedRecents()).toHaveLength(1);
  });

  it("spends the five-row cap on runs it will actually show", () => {
    // Filtering before the cap rather than after it: a default run among the
    // newest records must not consume a slot and leave the list one short.
    seed([
      makeRecord({ id: "d", options: {} }),
      ...Array.from({ length: 6 }, (_, i) => makeRecord({ id: `s${i}` })),
    ]);
    renderMenu();

    const listed = listedRecents().map((el) => el.textContent ?? "");
    expect(listed).toHaveLength(5);
    expect(listed[0]).toContain("Run s0");
  });

  it("puts the file count in the accessible name, not only the trailing slot", () => {
    // The trailing meta is aria-hidden by the primitive's design, so the
    // count would otherwise be invisible to assistive tech.
    seed([makeRecord({ name: "src", stats: { fileCount: 12, totalSize: 4096 } })]);
    renderMenu();
    const row = listedRecents()[0]!;
    expect(row.getAttribute("aria-label")).toContain("12 files");
  });

  it("hands the clicked record back untouched so its stored options replay intact", () => {
    // The whole point of the recents: whatever was captured — including nested
    // option objects — is what gets replayed. A copy or a re-derivation here
    // would be a silent behaviour change.
    const record = makeRecord({
      name: "scoped",
      options: { scopePaths: ["src", "docs"], format: "markdown", exclude: ["*.log"] },
    });
    const onRunRecent = vi.fn();
    seed([record]);
    renderMenu({ onRunRecent });

    fireEvent.click(listedRecents()[0]!);
    expect(onRunRecent).toHaveBeenCalledTimes(1);
    expect(onRunRecent.mock.calls[0]![0]).toBe(record);
  });

  it("routes the pinned entry to the full-copy callback", () => {
    const onCopyFullContext = vi.fn();
    seed([]);
    renderMenu({ onCopyFullContext });
    fireEvent.click(screen.getByRole("menuitem", { name: /copy full context/i }));
    expect(onCopyFullContext).toHaveBeenCalledTimes(1);
  });

  it("routes the settings entry to the settings callback", () => {
    const onOpenContextSettings = vi.fn();
    seed([]);
    renderMenu({ onOpenContextSettings });
    fireEvent.click(screen.getByRole("menuitem", { name: /context settings/i }));
    expect(onOpenContextSettings).toHaveBeenCalledTimes(1);
  });
});

describe("formatRecentMeta", () => {
  it("drops the size segment when the run recorded none", () => {
    // `totalSize` rides on the result's optional stats, so a run that reported
    // none must read as unknown rather than as zero bytes.
    const withSize = formatRecentMeta(
      makeRecord({ stats: { fileCount: 3, totalSize: 2048 } }),
      1_000
    );
    const withoutSize = formatRecentMeta(makeRecord({ stats: { fileCount: 3 } }), 1_000);

    expect(withSize.split(" · ")).toHaveLength(3);
    expect(withoutSize.split(" · ")).toHaveLength(2);
    expect(withoutSize).not.toMatch(/\d+\s?(B|KB|MB)/);
  });

  it("agrees with the byte formatter the rest of the app uses", async () => {
    const { formatBytes } = await import("@/lib/formatBytes");
    const meta = formatRecentMeta(makeRecord({ stats: { fileCount: 2, totalSize: 5000 } }), 1_000);
    expect(meta).toContain(formatBytes(5000));
  });

  it("singularizes a one-file run", () => {
    const one = formatRecentMeta(makeRecord({ stats: { fileCount: 1 } }), 1_000);
    const many = formatRecentMeta(makeRecord({ stats: { fileCount: 2 } }), 1_000);
    expect(one.startsWith("1 file ")).toBe(true);
    expect(many.startsWith("2 files")).toBe(true);
  });

  it("agrees with the relative-time formatter the rest of the app uses", async () => {
    // Asserting agreement rather than a wording: the row deliberately uses the
    // compact formatter the branch picker uses, and pinning the literal string
    // here would just be a copy of the implementation.
    const { formatTimeAgo } = await import("@/utils/timeAgo");
    const now = 3 * 60 * 60 * 1000;
    const meta = formatRecentMeta(makeRecord({ lastUsedAt: 0 }), now);
    expect(meta.endsWith(formatTimeAgo(0, now))).toBe(true);
  });

  it("names a non-default output format, and stays silent about the default one", async () => {
    const { DEFAULT_COPYTREE_FORMAT } = await import("@/lib/copyTreeFormat");
    const other = formatRecentMeta(makeRecord({ options: { format: "markdown" } }), 1_000);
    const dflt = formatRecentMeta(
      makeRecord({ options: { format: DEFAULT_COPYTREE_FORMAT } }),
      1_000
    );
    expect(other).toContain("markdown");
    expect(dflt).not.toContain(DEFAULT_COPYTREE_FORMAT);
    expect(other.split(" · ")).toHaveLength(dflt.split(" · ").length + 1);
  });

  it("keeps the trailing slot to what fits on one menu line", async () => {
    // The file count belongs to the accessible name; the visible slot carries
    // the size (what changes the decision) and the age (how a run is
    // recognised), and nothing that the full description does not also say.
    const record = makeRecord({
      stats: { fileCount: 3, totalSize: 2048 },
      options: { format: "markdown" },
    });
    const trailing = formatRecentTrailing(record, 1_000);
    const full = formatRecentMeta(record, 1_000);
    const { formatBytes } = await import("@/lib/formatBytes");
    expect(trailing).not.toContain("files");
    expect(trailing).not.toContain("markdown");
    expect(trailing.startsWith(formatBytes(2048))).toBe(true);
    // Everything the slot shows, the full description also says.
    for (const token of trailing.split(" · ")) expect(full).toContain(token);
  });
});
