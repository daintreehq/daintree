// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ActionContext } from "@shared/types/actions";
import type { Project, Scratch } from "@shared/types";

const { contextProvider, projectState, scratchState } = vi.hoisted(() => ({
  contextProvider: { current: null as (() => ActionContext) | null },
  projectState: {
    current: {
      projects: [] as Partial<Project>[],
      currentProject: null as Partial<Project> | null,
    },
  },
  scratchState: {
    current: {
      scratches: [] as Partial<Scratch>[],
      currentScratch: null as Partial<Scratch> | null,
    },
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    register: vi.fn(),
    listIds: () => [],
    setContextProvider: (provider: () => ActionContext) => {
      contextProvider.current = provider;
    },
  },
  installE2EActionDispatchBridge: vi.fn(),
}));

vi.mock("@/services/actions/actionDefinitions", () => ({
  createActionDefinitions: () => new Map(),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => projectState.current },
}));

vi.mock("@/store/scratchStore", () => ({
  useScratchStore: { getState: () => scratchState.current },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ focusedId: null, panelsById: {} }) },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => ({ focusedWorktreeId: null }) },
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: new Map() }) }),
}));

vi.mock("@/utils/performance", () => ({ startRendererSpan: () => () => {} }));
vi.mock("@/utils/safeFireAndForget", () => ({ safeFireAndForget: vi.fn() }));

import { useActionRegistry, type ActionCallbacks } from "../useActionRegistry";

function seedView(id: string | undefined) {
  const shell = window as { __DAINTREE_INITIAL_PROJECT__?: { id: string } };
  if (id === undefined) {
    delete shell.__DAINTREE_INITIAL_PROJECT__;
    return;
  }
  shell.__DAINTREE_INITIAL_PROJECT__ = { id };
}

/** Mount the hook and read the ActionContext it installs. */
function readContext(): ActionContext {
  // `ActionCallbacks` has ~30 members and the context provider only reaches
  // these two; stubbing all of them would be noise, not coverage.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial callbacks: only these two are reachable from the context provider
  const callbacks = {
    getActiveWorktreeId: () => null,
    getIsSettingsOpen: () => false,
  } as unknown as ActionCallbacks;
  renderHook(() => useActionRegistry(callbacks));
  const provider = contextProvider.current;
  if (!provider) throw new Error("useActionRegistry never installed a context provider");
  return provider();
}

beforeEach(() => {
  contextProvider.current = null;
  projectState.current = { projects: [], currentProject: null };
  scratchState.current = { scratches: [], currentScratch: null };
  seedView(undefined);
  // `stubGlobal` rather than a cast assignment: the bridge is fully typed, so a
  // partial stand-in would need an `as unknown as` that regresses the
  // no-unsafe-type-assertion lint ratchet.
  vi.stubGlobal("electron", {
    plugin: { validateActionIds: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  seedView(undefined);
  vi.unstubAllGlobals();
});

describe("useActionRegistry workspace context", () => {
  it("names this view's project rather than the window that switched last", () => {
    // `currentProject` is broadcast to every view, so a sibling window moving to
    // p-2 must not repoint the actions dispatched in this one.
    seedView("p-1");
    projectState.current = {
      projects: [
        { id: "p-1", name: "Notes", path: "/folders/notes" },
        { id: "p-2", name: "Other", path: "/folders/other" },
      ],
      currentProject: { id: "p-2", name: "Other", path: "/folders/other" },
    };

    const ctx = readContext();
    expect({ id: ctx.projectId, name: ctx.projectName, path: ctx.projectPath }).toEqual({
      id: "p-1",
      name: "Notes",
      path: "/folders/notes",
    });
  });

  it("leaves the project pointer unset in a scratch view", () => {
    // Both halves resolve from one lookup, so a consumer reading
    // `projectPath ?? scratchPath` can't land on a leftover project.
    seedView("s-1");
    projectState.current = {
      projects: [{ id: "p-1", name: "Notes", path: "/folders/notes" }],
      currentProject: { id: "p-1", name: "Notes", path: "/folders/notes" },
    };
    scratchState.current = {
      scratches: [{ id: "s-1", name: "Scratch one", path: "/scratches/one" }],
      currentScratch: { id: "s-1", name: "Scratch one", path: "/scratches/one" },
    };

    const ctx = readContext();
    expect(ctx.projectPath).toBeUndefined();
    expect(ctx.scratchPath).toBe("/scratches/one");
  });

  it("reports no workspace at all when this view's id resolves to neither", () => {
    // Unresolved beats naming a sibling window's folder: the palette gate reads
    // these pointers, and a borrowed one would enable a row that opens nothing.
    seedView("gone");
    projectState.current = {
      projects: [{ id: "p-1", name: "Notes", path: "/folders/notes" }],
      currentProject: { id: "p-1", name: "Notes", path: "/folders/notes" },
    };

    const ctx = readContext();
    expect(ctx.projectPath ?? ctx.scratchPath).toBeUndefined();
  });

  it("falls back to the broadcast pointers only for an unbound view", () => {
    // No seeded id at all — a shell window, where nothing else can answer.
    projectState.current = {
      projects: [{ id: "p-9", name: "Nine", path: "/folders/nine" }],
      currentProject: { id: "p-9", name: "Nine", path: "/folders/nine" },
    };

    expect(readContext().projectPath).toBe("/folders/nine");
  });
});
