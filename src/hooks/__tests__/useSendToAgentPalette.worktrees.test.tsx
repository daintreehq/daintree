// @vitest-environment jsdom
import { renderHook, act, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types";

const { useWorktreeStoreOptionalMock } = vi.hoisted(() => ({
  useWorktreeStoreOptionalMock: vi.fn(),
}));

// The real module drags WorktreeStoreContext's whole renderer graph in, and
// these tests only need the worktree map the selector reads.
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreOptional: useWorktreeStoreOptionalMock,
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    getCachedSelection: () => "",
    get: () => undefined,
    notifyUserInput: vi.fn(),
  },
}));

import { usePanelStore } from "@/store/panelStore";
import { usePaletteStore } from "@/store/paletteStore";
import { useSendToAgentPalette, openSendToAgentPaletteWithText } from "../useSendToAgentPalette";

function seedWorktrees(entries: Array<[string, string]>): void {
  const worktrees = new Map<string, Partial<WorktreeSnapshot>>(
    entries.map(([id, name]) => [id, { id, name }])
  );
  useWorktreeStoreOptionalMock.mockImplementation(
    (selector: (s: { worktrees: Map<string, Partial<WorktreeSnapshot>> }) => unknown) =>
      selector({ worktrees })
  );
}

function panel(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: "Claude",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    hasPty: true,
    ...overrides,
  };
}

function seedPanels(panels: PtyPanelData[]): void {
  const panelsById: Record<string, PtyPanelData> = {};
  for (const p of panels) panelsById[p.id] = p;
  usePanelStore.setState({ panelsById, panelIds: panels.map((p) => p.id) });
}

function subtitles(items: Array<{ subtitle?: string }>): Array<string | undefined> {
  return items.map((item) => item.subtitle);
}

describe("useSendToAgentPalette worktree identity", () => {
  beforeEach(() => {
    useWorktreeStoreOptionalMock.mockReset();
    seedWorktrees([]);
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
    usePaletteStore.setState({ activePaletteId: "send-to-agent" });
  });

  afterEach(() => {
    // Unmount first: resetting a store while the hook is still mounted notifies
    // React subscribers from outside act().
    cleanup();
    usePaletteStore.setState({ activePaletteId: null });
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
  });

  it("names the worktree on every row once the targets span more than one", () => {
    seedWorktrees([
      ["/repo", "main"],
      ["/repo-fix", "fix-auth"],
    ]);
    seedPanels([panel("a", { worktreeId: "/repo" }), panel("b", { worktreeId: "/repo-fix" })]);

    const { result } = renderHook(() => useSendToAgentPalette());
    const [first, second] = result.current.results;

    // Identically titled rows: the worktree is the only thing telling them apart.
    expect(first!.title).toBe(second!.title);
    expect(first!.subtitle).toBe(`${first!.chrome.label} · main`);
    expect(second!.subtitle).toBe(`${second!.chrome.label} · fix-auth`);
  });

  it("leaves the subtitle agent-only when every target sits in one worktree", () => {
    seedWorktrees([["/repo", "main"]]);
    seedPanels([panel("a", { worktreeId: "/repo" }), panel("b", { worktreeId: "/repo" })]);

    const { result } = renderHook(() => useSendToAgentPalette());

    expect(subtitles(result.current.results)).toEqual([
      result.current.results[0]!.chrome.label,
      result.current.results[1]!.chrome.label,
    ]);
    expect(result.current.results.every((item) => item.worktreeName === "main")).toBe(true);
  });

  it("finds a pane by its worktree name even where the name is never drawn", async () => {
    seedWorktrees([["/repo", "peregrine"]]);
    seedPanels([panel("a", { worktreeId: "/repo" }), panel("b")]);

    const { result } = renderHook(() => useSendToAgentPalette());
    await act(async () => {
      result.current.setQuery("peregrine");
    });

    expect(result.current.results.map((item) => item.id)).toEqual(["a"]);
    // Still suppressed from display: one named worktree is not a spread.
    expect(result.current.results[0]!.subtitle).toBe(result.current.results[0]!.chrome.label);
  });

  it("keeps the worktree suffix when a query narrows the list to a single worktree", async () => {
    seedWorktrees([
      ["/repo", "main"],
      ["/repo-fix", "fix-auth"],
    ]);
    seedPanels([
      panel("a", { worktreeId: "/repo", title: "Alpha" }),
      panel("b", { worktreeId: "/repo-fix", title: "Beta" }),
    ]);

    const { result } = renderHook(() => useSendToAgentPalette());
    await act(async () => {
      result.current.setQuery("Beta");
    });

    expect(result.current.results.map((item) => item.id)).toEqual(["b"]);
    expect(result.current.results[0]!.subtitle).toContain("fix-auth");
  });

  it("counts worktrees across the whole target list, not the truncated results", () => {
    seedWorktrees([
      ["/repo", "main"],
      ["/repo-fix", "fix-auth"],
    ]);
    // MAX_RESULTS is 20, so the only pane in the second worktree falls outside
    // the rendered window — the label has to survive that.
    const panels = Array.from({ length: 24 }, (_, i) =>
      panel(`p${i}`, { worktreeId: "/repo", title: `Pane ${i}` })
    );
    panels.push(panel("late", { worktreeId: "/repo-fix", title: "Pane late" }));
    seedPanels(panels);

    const { result, rerender } = renderHook(() => useSendToAgentPalette());

    // The pane that makes this a spread is not among the rows being labelled.
    expect(result.current.results).toHaveLength(20);
    expect(result.current.results.some((item) => item.id === "late")).toBe(false);
    expect(result.current.results[0]!.subtitle).toContain("main");

    // Drop it and the very same visible rows go back to bare agent labels.
    act(() => {
      seedPanels(panels.slice(0, 24));
    });
    rerender();
    expect(result.current.results[0]!.subtitle).toBe(result.current.results[0]!.chrome.label);
  });

  it("re-labels when a worktree map arrives after the palette is already open", () => {
    // Worktrees hydrate asynchronously, so the map routinely lands after the
    // palette has rendered its rows once.
    seedPanels([panel("a", { worktreeId: "/repo" }), panel("b", { worktreeId: "/repo-fix" })]);

    const { result, rerender } = renderHook(() => useSendToAgentPalette());
    expect(result.current.results[0]!.subtitle).toBe(result.current.results[0]!.chrome.label);

    act(() => {
      seedWorktrees([
        ["/repo", "main"],
        ["/repo-fix", "fix-auth"],
      ]);
    });
    rerender();

    expect(result.current.results[0]!.subtitle).toContain("main");
    expect(result.current.results[1]!.subtitle).toContain("fix-auth");
  });

  it("matches a long worktree name by its distinctive tail", async () => {
    // Branch-derived names run long, and the part that tells two of them apart
    // is at the end — past the window Fuse scores by position.
    seedWorktrees([["/repo", "feature-issue-12420-send-agent-palette-worktree"]]);
    seedPanels([panel("a", { worktreeId: "/repo" }), panel("b")]);

    const { result } = renderHook(() => useSendToAgentPalette());
    await act(async () => {
      result.current.setQuery("worktree");
    });

    expect(result.current.results.map((item) => item.id)).toEqual(["a"]);
  });

  it("ignores ineligible panels when deciding whether the targets spread", () => {
    seedWorktrees([
      ["/repo", "main"],
      ["/repo-fix", "fix-auth"],
      ["/repo-old", "stale"],
    ]);
    seedPanels([
      panel("a", { worktreeId: "/repo" }),
      panel("trashed", { worktreeId: "/repo-fix", location: "trash" }),
      panel("backgrounded", { worktreeId: "/repo-fix", location: "background" }),
      panel("overlaid", { worktreeId: "/repo-fix", location: "overlay" }),
      panel("dead", { worktreeId: "/repo-old", hasPty: false }),
    ]);

    const { result } = renderHook(() => useSendToAgentPalette());

    expect(result.current.results.map((item) => item.id)).toEqual(["a"]);
    expect(result.current.results[0]!.subtitle).toBe(result.current.results[0]!.chrome.label);
  });

  it("does not let the excluded source pane make the targets look like a spread", () => {
    seedWorktrees([
      ["/repo", "main"],
      ["/repo-fix", "fix-auth"],
    ]);
    seedPanels([
      panel("source", { worktreeId: "/repo-fix" }),
      panel("a", { worktreeId: "/repo" }),
      panel("b", { worktreeId: "/repo" }),
    ]);
    act(() => {
      openSendToAgentPaletteWithText("hello", "source");
    });

    const { result } = renderHook(() => useSendToAgentPalette());

    expect(result.current.results.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.current.results[0]!.subtitle).toBe(result.current.results[0]!.chrome.label);
  });

  it("omits the label rather than trailing a separator when the worktree is unknown", () => {
    // A worktree id is a path spelled two ways across a symlink, so a lookup
    // can miss for a worktree that really exists.
    seedWorktrees([["/repo", "main"]]);
    seedPanels([
      panel("a", { worktreeId: "/repo" }),
      panel("b", { worktreeId: "/private/repo-fix" }),
    ]);

    const { result } = renderHook(() => useSendToAgentPalette());
    const missing = result.current.results.find((item) => item.id === "b")!;

    expect(missing.worktreeName).toBeUndefined();
    expect(missing.subtitle).toBe(missing.chrome.label);
    expect(missing.subtitle).not.toContain("·");
    // The id that did not resolve still counts, so the one that did gets named.
    const known = result.current.results.find((item) => item.id === "a")!;
    expect(known.subtitle).toContain("main");
  });

  it("treats worktree-less panes as unnamed rather than as a second worktree", () => {
    seedWorktrees([["/repo", "main"]]);
    seedPanels([panel("a", { worktreeId: "/repo" }), panel("ambient")]);

    const { result } = renderHook(() => useSendToAgentPalette());

    expect(subtitles(result.current.results)).toEqual([
      result.current.results[0]!.chrome.label,
      result.current.results[1]!.chrome.label,
    ]);
    expect(result.current.results[1]!.worktreeName).toBeUndefined();
  });
});
