import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest, PluginWorktreeSnapshot } from "../../../../shared/types/plugin.js";
import {
  clearAllPluginContributionScopes,
  setPluginContributionScope,
} from "../PluginContributionBroadcaster.js";
import {
  clearWorktreeDeleteNotesBindings,
  registerWorktreeDeleteNotesBinding,
  type WorktreeDeleteNotesBinding,
} from "../worktreeDeleteNotesRegistry.js";
import {
  collectWorktreeDeleteNotes,
  getWorktreeDeleteNotes,
  listWorktreeDeleteNoteSources,
  type WorktreeDeleteNotesHost,
  type WorktreeDeleteNotesTarget,
} from "../worktreeDeleteNotes.js";

const WORKTREE = { id: "/repo/wt", worktreeId: "/repo/wt" } as PluginWorktreeSnapshot;

function manifest(name: string, declares = true): { manifest: PluginManifest } {
  return {
    manifest: {
      name,
      displayName: `${name} display`,
      version: "1.0.0",
      contributes: declares ? { worktreeDeleteNotes: [{ id: "notes" }] } : {},
    } as unknown as PluginManifest,
  };
}

function makeHost(overrides: Partial<WorktreeDeleteNotesHost> = {}) {
  const plugins = new Map([
    ["acme.sync", manifest("acme.sync")],
    ["acme.other", manifest("acme.other", false)],
  ]);
  const muted = new Set<string>();
  const activatePlugin = vi.fn(async () => {});
  const readWorktree = vi.fn(async (): Promise<WorktreeDeleteNotesTarget> => ({
    status: "ok",
    worktree: WORKTREE,
  }));
  const host: WorktreeDeleteNotesHost = {
    plugins,
    activatePlugin,
    readWorktree,
    isMuted: (id) => muted.has(id),
    timeoutMs: 1000,
    ...overrides,
  };
  return { host, plugins, muted, activatePlugin, readWorktree };
}

function bind(pluginId: string, provideNotes: WorktreeDeleteNotesBinding["provideNotes"]) {
  const binding: WorktreeDeleteNotesBinding = { contributionId: "notes", provideNotes };
  registerWorktreeDeleteNotesBinding(pluginId, binding);
  return binding;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  clearWorktreeDeleteNotesBindings();
  clearAllPluginContributionScopes();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("listWorktreeDeleteNoteSources", () => {
  it("names the declaring plugins without activating any", () => {
    const { host, activatePlugin } = makeHost();
    expect(listWorktreeDeleteNoteSources(host, "p1")).toEqual([
      { pluginId: "acme.sync", pluginName: "acme.sync display" },
    ]);
    expect(activatePlugin).not.toHaveBeenCalled();
  });

  it("leaves out a muted plugin and another project's plugin", () => {
    const { host, plugins, muted } = makeHost();
    plugins.set("project__p2__acme.local", manifest("acme.local"));
    setPluginContributionScope("project__p2__acme.local", "p2");
    muted.add("acme.sync");
    expect(listWorktreeDeleteNoteSources(host, "p1")).toEqual([]);
    expect(listWorktreeDeleteNoteSources(host, "p2").map((s) => s.pluginId)).toEqual([
      "project__p2__acme.local",
    ]);
  });
});

describe("getWorktreeDeleteNotes", () => {
  it("activates the plugin, asks about the project's worktree, and returns vetted notes", async () => {
    const { host, activatePlugin, readWorktree } = makeHost();
    const provideNotes = vi.fn(async () => [{ severity: "warning" as const, text: " 3 edits " }]);
    bind("acme.sync", provideNotes);
    await expect(getWorktreeDeleteNotes(host, "p1", "acme.sync", "/repo/wt")).resolves.toEqual({
      status: "answered",
      notes: [{ severity: "warning", text: "3 edits" }],
    });
    expect(activatePlugin).toHaveBeenCalledWith("acme.sync");
    expect(readWorktree).toHaveBeenCalledWith("p1", "/repo/wt");
    expect(provideNotes).toHaveBeenCalledWith(WORKTREE, expect.any(AbortSignal));
  });

  it("is null for a plugin the confirmation doesn't ask, without activating it", async () => {
    const { host, muted, activatePlugin } = makeHost();
    muted.add("acme.sync");
    await expect(getWorktreeDeleteNotes(host, "p1", "acme.sync", "/repo/wt")).resolves.toBeNull();
    await expect(getWorktreeDeleteNotes(host, "p1", "acme.other", "/repo/wt")).resolves.toBeNull();
    await expect(getWorktreeDeleteNotes(host, "p1", "nobody", "/repo/wt")).resolves.toBeNull();
    expect(activatePlugin).not.toHaveBeenCalled();
  });

  it("is null when the worktree isn't the project's, and never asks the plugin", async () => {
    const { host } = makeHost({ readWorktree: async () => ({ status: "missing" }) });
    const provideNotes = vi.fn(async () => []);
    bind("acme.sync", provideNotes);
    await expect(getWorktreeDeleteNotes(host, "p1", "acme.sync", "/other")).resolves.toBeNull();
    expect(provideNotes).not.toHaveBeenCalled();
  });

  it.each([
    ["throws", () => Promise.reject(new Error("boom"))],
    ["breaks the rules", async () => [{ severity: "fatal", text: "x" }]],
  ])("reads as no answer when the plugin %s", async (_label, provide) => {
    const { host } = makeHost();
    bind("acme.sync", provide as WorktreeDeleteNotesBinding["provideNotes"]);
    await expect(getWorktreeDeleteNotes(host, "p1", "acme.sync", "/repo/wt")).resolves.toEqual({
      status: "no-answer",
    });
  });

  it("reads as no answer when activation leaves nothing bound", async () => {
    const { host } = makeHost();
    await expect(getWorktreeDeleteNotes(host, "p1", "acme.sync", "/repo/wt")).resolves.toEqual({
      status: "no-answer",
    });
  });

  it("reads as no answer when the worktree couldn't be read", async () => {
    const { host } = makeHost({ readWorktree: async () => ({ status: "unavailable" }) });
    bind("acme.sync", async () => []);
    await expect(getWorktreeDeleteNotes(host, "p1", "acme.sync", "/repo/wt")).resolves.toEqual({
      status: "no-answer",
    });
  });

  it("gives up at the deadline and aborts the call it was waiting on", async () => {
    vi.useFakeTimers();
    const { host } = makeHost();
    let signal: AbortSignal | undefined;
    bind("acme.sync", (_worktree, s) => {
      signal = s;
      return new Promise(() => {});
    });
    const pending = getWorktreeDeleteNotes(host, "p1", "acme.sync", "/repo/wt");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ status: "no-answer" });
    expect(signal?.aborted).toBe(true);
  });

  it("counts activation against the deadline and never asks once it has passed", async () => {
    vi.useFakeTimers();
    let finishActivation: () => void = () => {};
    const { host } = makeHost({
      activatePlugin: () => new Promise<void>((resolve) => (finishActivation = resolve)),
    });
    const provideNotes = vi.fn(async () => []);
    bind("acme.sync", provideNotes);
    const pending = getWorktreeDeleteNotes(host, "p1", "acme.sync", "/repo/wt");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ status: "no-answer" });
    finishActivation();
    await vi.advanceTimersByTimeAsync(0);
    expect(provideNotes).not.toHaveBeenCalled();
  });

  it("drops an answer from a plugin muted or reloaded while it was asked", async () => {
    const { host, muted, plugins } = makeHost();
    bind("acme.sync", async () => {
      muted.add("acme.sync");
      return [{ severity: "info", text: "late" }];
    });
    await expect(getWorktreeDeleteNotes(host, "p1", "acme.sync", "/repo/wt")).resolves.toBeNull();

    muted.clear();
    bind("acme.sync", async () => {
      plugins.set("acme.sync", manifest("acme.sync"));
      return [{ severity: "info", text: "stale" }];
    });
    await expect(getWorktreeDeleteNotes(host, "p1", "acme.sync", "/repo/wt")).resolves.toBeNull();
  });
});

describe("collectWorktreeDeleteNotes", () => {
  it("returns every asked plugin's answer, attributed, leaving out the ones that went away", async () => {
    const { host, plugins } = makeHost();
    plugins.set("acme.slow", manifest("acme.slow"));
    plugins.set("acme.gone", manifest("acme.gone"));
    bind("acme.sync", async () => [{ severity: "info", text: "hello" }]);
    bind("acme.slow", () => Promise.reject(new Error("down")));
    bind("acme.gone", async () => {
      plugins.delete("acme.gone");
      return [];
    });
    await expect(collectWorktreeDeleteNotes(host, "p1", "/repo/wt")).resolves.toEqual([
      {
        pluginId: "acme.sync",
        pluginName: "acme.sync display",
        answer: { status: "answered", notes: [{ severity: "info", text: "hello" }] },
      },
      { pluginId: "acme.slow", pluginName: "acme.slow display", answer: { status: "no-answer" } },
    ]);
  });
});
