// @vitest-environment jsdom
/**
 * CopyTreeRecentsPanel — the copy-tree toolbar dropdown body (#11733).
 *
 * The panel is what turned a silent one-click full copy into a two-stage
 * interaction, so what matters here is that the primary action stays reachable
 * at all times, that the recents list faithfully reflects the project history
 * it is a shortcut into, and that a hydrating history never flashes chrome the
 * Doherty gate exists to suppress.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

// jsdom ships no ResizeObserver; ScrollShadow's shadow hook constructs one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

import type { CopyTreeHistoryRecord } from "@shared/types";
import { CopyTreeRecentsPanel, formatRecentMeta } from "../CopyTreeRecentsPanel";
import {
  useCopyTreeHistoryStore,
  _resetCopyTreeHistoryStoreForTest,
} from "@/store/copyTreeHistoryStore";

vi.mock("@/store/copyTreeHistoryStore", async () => {
  const { create } = await import("zustand");
  const store = create<{
    records: CopyTreeHistoryRecord[];
    loading: boolean;
    init: () => void;
  }>(() => ({
    records: [],
    loading: true,
    init: () => initSpy(),
  }));
  return {
    useCopyTreeHistoryStore: store,
    _resetCopyTreeHistoryStoreForTest: () => store.setState({ records: [], loading: true }),
  };
});

const initSpy = vi.fn();

function makeRecord(overrides: Partial<CopyTreeHistoryRecord> = {}): CopyTreeHistoryRecord {
  const id = overrides.id ?? "r1";
  return {
    id,
    dedupeKey: `key-${id}`,
    name: `Run ${id}`,
    options: {},
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

describe("CopyTreeRecentsPanel", () => {
  beforeEach(() => {
    initSpy.mockClear();
    _resetCopyTreeHistoryStoreForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes the history mirror on mount", () => {
    // The store has no other consumer in the app, so if the panel stops calling
    // init() the recents list is permanently empty rather than merely stale.
    seed([]);
    render(<CopyTreeRecentsPanel onCopyFullContext={noop} onRunRecent={noop} />);
    expect(initSpy).toHaveBeenCalled();
  });

  it("offers the full copy while history is still hydrating", () => {
    // The primary row is the old one-click behavior. Gating it behind the
    // history pull would make the panel slower than the button it replaced.
    render(<CopyTreeRecentsPanel onCopyFullContext={noop} onRunRecent={noop} />);
    expect(screen.getByRole("button", { name: "Copy full context" })).toBeTruthy();
  });

  it("shows no loading chrome before the Doherty threshold, then skeleton rows", () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <CopyTreeRecentsPanel onCopyFullContext={noop} onRunRecent={noop} />
    );

    // A fast hydration must resolve without ever having painted a placeholder.
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("status")).toBeTruthy();

    // Unmount before restoring real timers so the gate's pending timeout cannot
    // fire against a torn-down tree.
    unmount();
  });

  it("never falls back to a spinner while hydrating", () => {
    // The panel's shape is predictable, so the loading rule is skeleton-or-
    // nothing; a spinner here is the specific thing the issue ruled out.
    vi.useFakeTimers();
    const { container, unmount } = render(
      <CopyTreeRecentsPanel onCopyFullContext={noop} onRunRecent={noop} />
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector('[data-testid="spinner"]')).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    unmount();
  });

  it("names the next action when the project has no history yet", () => {
    seed([]);
    render(<CopyTreeRecentsPanel onCopyFullContext={noop} onRunRecent={noop} />);
    // Empty-state convention: point at what to do, not at what is missing.
    const emptyText = screen.getByText(/copy a context/i).textContent ?? "";
    expect(emptyText.toLowerCase()).not.toContain("no recent");
  });

  it("surfaces only the five newest runs, in the order Main sent them", () => {
    // Main already sorts newest-first and caps the durable list; re-sorting here
    // would fight that, so the contract is "take the first five, unchanged".
    const records = Array.from({ length: 8 }, (_, i) => makeRecord({ id: `r${i}` }));
    seed(records);
    render(<CopyTreeRecentsPanel onCopyFullContext={noop} onRunRecent={noop} />);

    const rendered = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((t) => t.startsWith("Run "));

    expect(rendered).toHaveLength(5);
    expect(rendered[0]).toContain("Run r0");
    expect(rendered[4]).toContain("Run r4");
    expect(screen.queryByText("Run r5")).toBeNull();
  });

  it("hands the clicked record back untouched so its stored options replay intact", () => {
    // The whole point of the recents list: whatever was captured — including
    // fields the flat `worktree.copyTree` schema would strip — comes back out.
    const record = makeRecord({
      id: "curated",
      name: "authentication stuff",
      options: { filter: ["src/auth/**"], format: "markdown", sort: "size", withLineNumbers: true },
    });
    seed([record]);
    const onRunRecent = vi.fn();
    render(<CopyTreeRecentsPanel onCopyFullContext={noop} onRunRecent={onRunRecent} />);

    fireEvent.click(screen.getByRole("button", { name: /authentication stuff/ }));

    expect(onRunRecent).toHaveBeenCalledWith(record);
    expect(onRunRecent.mock.calls[0]![0].options).toBe(record.options);
  });

  it("routes the primary row to the full-copy callback", () => {
    seed([makeRecord()]);
    const onCopyFullContext = vi.fn();
    const onRunRecent = vi.fn();
    render(
      <CopyTreeRecentsPanel onCopyFullContext={onCopyFullContext} onRunRecent={onRunRecent} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy full context" }));

    expect(onCopyFullContext).toHaveBeenCalledTimes(1);
    expect(onRunRecent).not.toHaveBeenCalled();
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

  it("reports the last run time relative to now", () => {
    const meta = formatRecentMeta(makeRecord({ lastUsedAt: 0 }), 3 * 60 * 60 * 1000);
    expect(meta).toContain("hours ago");
  });
});
