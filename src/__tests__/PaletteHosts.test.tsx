// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { act, cleanup, render } from "@testing-library/react";
import type { WorktreeSnapshot } from "@shared/types";

// Each palette's query lives in its own host, so typing re-renders that host
// and nothing above it — above all not AppInner, the app shell, which used to
// own every palette's search state and re-rendered on each keystroke.

interface CapturedPalette {
  isOpen: boolean;
  query: string;
  results: { id: string }[];
  setQuery?: (query: string) => void;
  onQueryChange?: (query: string) => void;
}

const shown = vi.hoisted(() => ({
  quickSwitcher: null as CapturedPalette | null,
  worktreePalette: null as CapturedPalette | null,
}));

vi.mock("@/lazyPanels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lazyPanels")>()),
  LazyQuickSwitcher: (props: CapturedPalette) => {
    shown.quickSwitcher = props;
    return null;
  },
  LazyWorktreePalette: (props: CapturedPalette) => {
    shown.worktreePalette = props;
    return null;
  },
}));

function bridgeNamespace(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_target, key) =>
        typeof key === "string" && key.startsWith("on")
          ? () => () => {}
          : () => Promise.resolve(undefined),
    }
  );
}
const namespaces: Record<string, unknown> = {};
vi.stubGlobal(
  "electron",
  new Proxy(namespaces, {
    get: (target, key: string) => (target[key] ??= bridgeNamespace()),
  })
);

const { QuickSwitcherHost, WorktreePaletteHost } = await import("../PaletteHosts");
const { WorktreeStoreContext } = await import("@/contexts/WorktreeStoreContext");
const { createWorktreeStore } = await import("@/store/createWorktreeStore");
const { usePaletteStore } = await import("@/store/paletteStore");
const { usePanelStore } = await import("@/store/panelStore");

function snapshot(name: string, isMainWorktree = false): WorktreeSnapshot {
  return {
    id: name,
    worktreeId: name,
    path: `/repo/${name}`,
    name,
    branch: `feature/${name}`,
    isCurrent: isMainWorktree,
    isMainWorktree,
  } as WorktreeSnapshot;
}

let shellRenders = 0;

function Shell() {
  shellRenders++;
  return (
    <>
      <QuickSwitcherHost />
      <WorktreePaletteHost />
    </>
  );
}

function mount() {
  const store = createWorktreeStore();
  store.setState({
    worktrees: new Map(
      [snapshot("main", true), snapshot("alpha"), snapshot("beta")].map((w) => [w.id, w])
    ),
    isLoading: false,
    isInitialized: true,
  });
  render(
    <WorktreeStoreContext.Provider value={store}>
      <Shell />
    </WorktreeStoreContext.Provider>
  );
}

const openPalette = (id: "quick-switcher" | "worktree") =>
  act(() => usePaletteStore.getState().openPalette(id));

describe("palette hosts", () => {
  beforeEach(() => {
    shellRenders = 0;
    shown.quickSwitcher = null;
    shown.worktreePalette = null;
    usePaletteStore.setState({ activePaletteId: null });
    usePanelStore.setState({ panelsById: {}, panelIds: [], mruList: [] });
  });

  afterEach(() => {
    cleanup();
    usePaletteStore.setState({ activePaletteId: null });
  });

  it("filters as the user types without re-rendering the shell above", () => {
    mount();
    openPalette("worktree");
    expect(shown.worktreePalette!.results).toHaveLength(3);

    for (const query of ["a", "al", "alp"]) {
      act(() => shown.worktreePalette!.onQueryChange!(query));
    }
    expect(shown.worktreePalette!.query).toBe("alp");
    expect(shown.worktreePalette!.results.map((w) => w.id)).toEqual(["alpha"]);

    openPalette("quick-switcher");
    act(() => shown.quickSwitcher!.setQuery!("bet"));
    expect(shown.quickSwitcher!.query).toBe("bet");
    expect(shown.quickSwitcher!.results.map((r) => r.id)).toEqual(["worktree:beta"]);

    expect(shellRenders).toBe(1);
  });

  it("opens fresh from the store after another palette took over mid-search", () => {
    mount();
    openPalette("worktree");
    act(() => shown.worktreePalette!.onQueryChange!("alp"));

    openPalette("quick-switcher");
    expect(shown.worktreePalette!.isOpen).toBe(false);

    openPalette("worktree");
    expect(shown.worktreePalette!.isOpen).toBe(true);
    expect(shown.worktreePalette!.query).toBe("");
    expect(shown.worktreePalette!.results).toHaveLength(3);
  });
});

describe("AppInner", () => {
  // The shell renders the whole app, so a palette hook called there would put
  // every keystroke back on it.
  const PALETTE_STATE_HOOKS = [
    "useSearchablePalette",
    "useQuickSwitcher",
    "useActionPalette",
    "useWorktreePalette",
    "usePanelPalette",
    "useSendToAgentPalette",
    "useQuickCreatePalette",
    "useWorktrees",
  ];

  it("owns no palette's search state", () => {
    const file = path.resolve(__dirname, "../App.tsx");
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    let appInner: ts.FunctionDeclaration | undefined;
    source.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "AppInner") appInner = node;
    });
    expect(appInner).toBeDefined();

    const called = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        called.add(node.expression.text);
      }
      node.forEachChild(visit);
    };
    visit(appInner!);

    expect(called.has("useProjectSwitcherPalette")).toBe(true);
    expect(PALETTE_STATE_HOOKS.filter((hook) => called.has(hook))).toEqual([]);
  });
});
