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
import { TooltipProvider } from "@/components/ui/tooltip";
import { CopyTreeRecentsPanel, formatRecentMeta } from "../CopyTreeRecentsPanel";
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

function makeRecord(overrides: Partial<CopyTreeHistoryRecord> = {}): CopyTreeHistoryRecord {
  const id = overrides.id ?? "r1";
  return {
    id,
    dedupeKey: `key-${id}`,
    name: `Run ${id}`,
    // A recent worth listing is one that differs from the pinned action.
    // A record with no options IS the pinned "Copy full context" run, and the
    // panel drops it rather than showing the button twice — so a fixture that
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
 * The row titles are wrapped in `TruncatedTooltip`, which is a Radix tooltip
 * underneath. In the app the provider sits at the root of `App.tsx` and reaches
 * the portalled panel through React context; in isolation the panel has to
 * bring its own.
 */
function renderPanel(props: Partial<React.ComponentProps<typeof CopyTreeRecentsPanel>> = {}) {
  return render(
    <TooltipProvider>
      <CopyTreeRecentsPanel onCopyFullContext={noop} onRunRecent={noop} {...props} />
    </TooltipProvider>
  );
}

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
    renderPanel({ onCopyFullContext: noop, onRunRecent: noop });
    expect(initSpy).toHaveBeenCalled();
  });

  it("offers the full copy while history is still hydrating", () => {
    // The primary row is the old one-click behavior. Gating it behind the
    // history pull would make the panel slower than the button it replaced.
    renderPanel({ onCopyFullContext: noop, onRunRecent: noop });
    expect(screen.getByRole("button", { name: "Copy full context" })).toBeTruthy();
  });

  it("shows no loading chrome before the Doherty threshold, then skeleton rows", () => {
    vi.useFakeTimers();
    const { unmount } = renderPanel({ onCopyFullContext: noop, onRunRecent: noop });

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
    // `.animate-spin` is what the shared Spinner actually renders — it carries
    // no test id, so that is the only marker that would catch a regression.
    vi.useFakeTimers();
    const { container, unmount } = renderPanel({ onCopyFullContext: noop, onRunRecent: noop });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector(".animate-spin")).toBeNull();
    unmount();
  });

  it("tears the skeleton down once history resolves and does not bring it back", () => {
    // The gate's timer is still pending when loading flips. Without the outer
    // `loading` branch owning the swap, a late-firing gate would remount a
    // skeleton over an already-populated list.
    vi.useFakeTimers();
    const { unmount } = renderPanel({ onCopyFullContext: noop, onRunRecent: noop });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole("status")).not.toBeNull();

    act(() => {
      useCopyTreeHistoryStore.setState({ records: [makeRecord()], loading: false });
    });
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByRole("status")).toBeNull();

    unmount();
  });

  it("shows no skeleton at all when history resolves inside the gate", () => {
    vi.useFakeTimers();
    const { unmount } = renderPanel({ onCopyFullContext: noop, onRunRecent: noop });

    act(() => {
      vi.advanceTimersByTime(200);
      useCopyTreeHistoryStore.setState({ records: [makeRecord()], loading: false });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.queryByRole("status")).toBeNull();
    unmount();
  });

  it("is a named dialog that takes focus so the rows are keyboard-reachable", () => {
    // The trigger declares aria-haspopup="dialog" and the panel now owns the
    // button's former action. Portaled to the end of <body>, an unfocused panel
    // would leave a keyboard user tabbing through the whole app to reach it.
    // The panel has no visible heading — the primary button is its header — so
    // the dialog's name must come from an aria-label instead. Resolved through
    // the accessibility tree rather than read off the attribute.
    seed([makeRecord()]);
    renderPanel({ onCopyFullContext: noop, onRunRecent: noop });

    expect(screen.getByRole("dialog", { name: /copy context/i })).toBeTruthy();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy full context" }));
  });

  it("builds every row as a real button so Enter and Space work natively", () => {
    // Asserting the element type rather than firing Enter: jsdom does not
    // synthesize a click from Enter, so a keydown test would prove nothing
    // about activation. Native button semantics are the thing this component
    // actually controls — a regression to a clickable div would fail here,
    // and it is what makes the panel operable without a roving-tabindex system.
    seed([makeRecord({ name: "authentication stuff" })]);
    renderPanel({ onCopyFullContext: noop, onRunRecent: noop });

    const rows = [
      screen.getByRole("button", { name: "Copy full context" }),
      screen.getByRole("button", { name: /authentication stuff/ }),
    ];
    for (const row of rows) {
      expect(row.tagName).toBe("BUTTON");
      // Without an explicit type, a button inside a form defaults to submit.
      expect(row.getAttribute("type")).toBe("button");
      expect(row.hasAttribute("disabled")).toBe(false);
      expect(row.getAttribute("tabindex")).toBeNull();
    }
  });

  it("names the next action when the project has no history yet", () => {
    seed([]);
    renderPanel({ onCopyFullContext: noop, onRunRecent: noop });
    // Empty-state convention: point at what to do, not at what is missing.
    const emptyText = screen.getByText(/copy context to reuse/i).textContent ?? "";
    expect(emptyText.toLowerCase()).not.toContain("no recent");
  });

  it("surfaces only the five newest runs, in the order Main sent them", () => {
    // Main already sorts newest-first and caps the durable list; re-sorting here
    // would fight that, so the contract is "take the first five, unchanged".
    const records = Array.from({ length: 8 }, (_, i) => makeRecord({ id: `r${i}` }));
    seed(records);
    renderPanel({ onCopyFullContext: noop, onRunRecent: noop });

    const rendered = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((t) => t.startsWith("Run "));

    expect(rendered).toHaveLength(5);
    expect(rendered[0]).toContain("Run r0");
    expect(rendered[4]).toContain("Run r4");
    expect(screen.queryByText("Run r5")).toBeNull();
  });

  it("does not repeat the pinned action as the first recent", () => {
    // Fluent's rule, and the reason the panel looked like it was offering two
    // versions of the same command: a full-context run records no options, so
    // it is the button above it, not a separate thing to choose between.
    seed([
      makeRecord({ id: "d", name: "Full context", options: {} }),
      makeRecord({ id: "s", name: "src", options: { scopePaths: ["src"] } }),
    ]);
    renderPanel();

    const listed = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((t) => !t.includes("Copy full context"));

    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain("src");
  });

  it("keeps a run that only shares the default's NAME", () => {
    // The guard against deduplicating by label: a record called "Full context"
    // that carries a format or a filter is a genuinely different run, and
    // dropping it would silently lose the user's history.
    seed([makeRecord({ id: "m", name: "Full context", options: { modified: true } })]);
    renderPanel();

    expect(screen.getByRole("button", { name: /Full context.*file/s })).toBeTruthy();
  });

  it("spends the five-row cap on runs it will actually show", () => {
    // Filtering before the cap rather than after it: a default run among the
    // newest records must not consume a slot and leave the list one short.
    seed([
      makeRecord({ id: "d", options: {} }),
      ...Array.from({ length: 6 }, (_, i) => makeRecord({ id: `s${i}` })),
    ]);
    renderPanel();

    const listed = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((t) => t.startsWith("Run "));

    expect(listed).toHaveLength(5);
    expect(listed[0]).toContain("Run s0");
  });

  it("gives hover and keyboard focus different treatments", () => {
    // They used to paint the same `overlay-raised` fill, so a hovered row and
    // the focused row were indistinguishable. The rule is that the two states
    // must remain separable — whatever tokens they end up using.
    seed([makeRecord()]);
    renderPanel();

    const row = screen.getAllByRole("button").find((b) => (b.textContent ?? "").startsWith("Run "));
    const classes = row?.className ?? "";

    const hover = classes.match(/(?<!focus-visible:)\bhover:bg-\S+/g) ?? [];
    const focusFill = classes.match(/focus-visible:bg-\S+/g) ?? [];
    const focusRing = classes.match(/focus-visible:outline\S*/g) ?? [];

    expect(hover.length).toBeGreaterThan(0);
    expect(focusRing.length).toBeGreaterThan(0);
    // A focus fill is allowed, but not one identical to the hover fill.
    for (const fill of focusFill) {
      expect(hover).not.toContain(fill.replace("focus-visible:", "hover:"));
    }
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
    renderPanel({ onCopyFullContext: noop, onRunRecent: onRunRecent });

    fireEvent.click(screen.getByRole("button", { name: /authentication stuff/ }));

    expect(onRunRecent).toHaveBeenCalledWith(record);
    expect(onRunRecent.mock.calls[0]![0].options).toBe(record.options);
  });

  it("routes the primary row to the full-copy callback", () => {
    seed([makeRecord()]);
    const onCopyFullContext = vi.fn();
    const onRunRecent = vi.fn();
    renderPanel({ onCopyFullContext: onCopyFullContext, onRunRecent: onRunRecent });

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

  it("agrees with the relative-time formatter the rest of the app uses", async () => {
    // Asserting agreement rather than a wording: the row deliberately uses the
    // compact formatter ("3h ago") that the branch picker uses, and pinning the
    // literal string here would just be a copy of the implementation.
    const { formatTimeAgo } = await import("@/utils/timeAgo");
    const now = 3 * 60 * 60 * 1000;
    const meta = formatRecentMeta(makeRecord({ lastUsedAt: 0 }), now);
    expect(meta.endsWith(formatTimeAgo(0, now))).toBe(true);
  });

  it("names a non-default output format, and stays silent about the default one", async () => {
    // The format changes what lands on the clipboard and nothing else in the
    // row says so — but naming the default on every row would spend the line's
    // scarcest space on the one fact that is never news.
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
});
