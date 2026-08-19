import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PLUGIN_RECIPE_USAGE_HISTORY,
  PluginRecipeMetadataStore,
} from "../PluginRecipeMetadataStore.js";

let dir: string;
let store: PluginRecipeMetadataStore;
const metadataPath = () => path.join(dir, "plugin-recipe-metadata.json");

async function readFileJson(): Promise<{
  _schemaVersion: number;
  recipes: Record<string, unknown>;
}> {
  return JSON.parse(await readFile(metadataPath(), "utf-8"));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "daintree-recipe-meta-"));
  store = new PluginRecipeMetadataStore(dir);
  await store.initialize();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("PluginRecipeMetadataStore (#11860)", () => {
  it("creates the config dir on first write", async () => {
    const nested = path.join(dir, "not", "yet");
    const fresh = new PluginRecipeMetadataStore(nested);
    await fresh.initialize();
    await fresh.recordUse("acme.tools.deploy", "acme.tools", "deploy", 1);
    const contents = JSON.parse(
      await readFile(path.join(nested, "plugin-recipe-metadata.json"), "utf-8")
    );
    expect(Object.keys(contents.recipes)).toEqual(["acme.tools.deploy"]);
  });

  it("keeps both timestamps when two runs are recorded concurrently", async () => {
    // The whole point of an atomic main-process append: two windows running the
    // same recipe must not each write their own read-modify-write and lose one.
    await Promise.all([
      store.recordUse("acme.tools.deploy", "acme.tools", "deploy", 100),
      store.recordUse("acme.tools.deploy", "acme.tools", "deploy", 200),
    ]);
    const history = store.getAllSync()["acme.tools.deploy"]?.usageHistory ?? [];
    expect(history).toHaveLength(2);
    expect(new Set(history)).toEqual(new Set([100, 200]));
  });

  it("keeps the newest suffix of the run history once it is full", async () => {
    // Bounded BY the exported cap, never asserted to equal a copied literal:
    // the invariant is "the retained history is the newest suffix of what was
    // recorded, capped", which stays true if the cap ever changes.
    const recorded: number[] = [];
    for (let i = 1; i <= MAX_PLUGIN_RECIPE_USAGE_HISTORY + 5; i++) {
      recorded.push(i);
      await store.recordUse("acme.tools.deploy", "acme.tools", "deploy", i);
    }
    const entry = store.getAllSync()["acme.tools.deploy"]!;
    expect(entry.usageHistory).toEqual(recorded.slice(-MAX_PLUGIN_RECIPE_USAGE_HISTORY));
    expect(entry.usageHistory).toHaveLength(MAX_PLUGIN_RECIPE_USAGE_HISTORY);
    expect(entry.lastUsedAt).toBe(recorded.at(-1));
  });

  it("stores a false override rather than treating it as absent", async () => {
    // Absence means "use the manifest default", so an explicit `false` against a
    // manifest default of `true` has to survive the round trip.
    await store.setUserOverrides("acme.tools.deploy", "acme.tools", "deploy", {
      showInEmptyState: false,
    });
    expect((await readFileJson()).recipes["acme.tools.deploy"]).toMatchObject({
      showInEmptyState: false,
    });
  });

  it("null clears an override and removes a record left holding nothing", async () => {
    await store.setUserOverrides("acme.tools.deploy", "acme.tools", "deploy", {
      autoAssign: "never",
    });
    expect(store.getAllSync()["acme.tools.deploy"]?.autoAssign).toBe("never");
    await store.setUserOverrides("acme.tools.deploy", "acme.tools", "deploy", {
      autoAssign: null,
    });
    expect(store.getAllSync()["acme.tools.deploy"]).toBeUndefined();
  });

  it("clearing one override keeps a record that still holds another", async () => {
    await store.recordUse("acme.tools.deploy", "acme.tools", "deploy", 7);
    await store.setUserOverrides("acme.tools.deploy", "acme.tools", "deploy", {
      autoAssign: null,
    });
    expect(store.getAllSync()["acme.tools.deploy"]?.lastUsedAt).toBe(7);
  });

  it("purges by the stored pluginId, not by splitting the key", async () => {
    // A contribution id containing dots makes the qualified key unsplittable —
    // this is exactly why pluginId is a real field (#10109).
    await store.recordUse("acme.tools.deploy.prod", "acme.tools", "deploy.prod", 1);
    await store.recordUse("other.tools.deploy", "other.tools", "deploy", 1);
    await store.purgePlugin("acme.tools");
    expect(Object.keys(store.getAllSync())).toEqual(["other.tools.deploy"]);
  });

  it("reconcile keeps a disabled plugin's metadata but drops orphans and dropped ids", async () => {
    await store.recordUse("acme.tools.kept", "acme.tools", "kept", 1);
    await store.recordUse("acme.tools.gone", "acme.tools", "gone", 1);
    await store.recordUse("disabled.plugin.pinned", "disabled.plugin", "pinned", 1);
    await store.recordUse("removed.plugin.orphan", "removed.plugin", "orphan", 1);

    await store.reconcile({
      // `disabled.plugin` is installed but contributed no known recipe set,
      // which is what a disabled/blocked/incompatible plugin looks like.
      installedPluginIds: new Set(["acme.tools", "disabled.plugin"]),
      knownQualifiedIdsByPlugin: new Map([["acme.tools", new Set(["acme.tools.kept"])]]),
    });

    expect(Object.keys(store.getAllSync()).sort()).toEqual([
      "acme.tools.kept",
      "disabled.plugin.pinned",
    ]);
  });

  it("discards a record whose identity fields disagree with its key", async () => {
    await writeFile(
      metadataPath(),
      JSON.stringify({
        _schemaVersion: 1,
        recipes: {
          "acme.tools.deploy": { pluginId: "evil.plugin", contributionId: "deploy", lastUsedAt: 1 },
          "acme.tools.ok": { pluginId: "acme.tools", contributionId: "ok", lastUsedAt: 1 },
        },
      })
    );
    const reloaded = new PluginRecipeMetadataStore(dir);
    await reloaded.initialize();
    expect(Object.keys(reloaded.getAllSync())).toEqual(["acme.tools.ok"]);
  });

  it("quarantines malformed content to a sibling file and recovers to an empty store", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const corrupt = '{ "recipes": { unterminated';
    await writeFile(metadataPath(), corrupt);
    const reloaded = new PluginRecipeMetadataStore(dir);
    await reloaded.initialize();
    expect(reloaded.getAllSync()).toEqual({});

    // The original bytes must survive somewhere — recovering by overwriting
    // would silently destroy whatever the user had.
    const quarantined = (await readdir(dir)).filter((name) => name.includes(".corrupted."));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(path.join(dir, quarantined[0]!), "utf-8")).toBe(corrupt);

    await reloaded.recordUse("acme.tools.deploy", "acme.tools", "deploy", 5);
    expect(Object.keys((await readFileJson()).recipes)).toEqual(["acme.tools.deploy"]);
    error.mockRestore();
  });

  it("never writes over a file a newer build owns, through any mutator", async () => {
    // Reading it as empty is not enough: a mutator that then persisted its
    // empty view as v1 would destroy state the newer build still uses, so a
    // downgrade-then-run-a-recipe would silently wipe it.
    const future = JSON.stringify({
      _schemaVersion: 99,
      recipes: { "acme.tools.deploy": { pluginId: "acme.tools", contributionId: "deploy" } },
    });
    await writeFile(metadataPath(), future);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reloaded = new PluginRecipeMetadataStore(dir);
    await reloaded.initialize();
    expect(reloaded.getAllSync()).toEqual({});

    await reloaded.recordUse("acme.tools.deploy", "acme.tools", "deploy", 1);
    await reloaded.setUserOverrides("acme.tools.deploy", "acme.tools", "deploy", {
      showInEmptyState: true,
    });
    await reloaded.purgePlugin("acme.tools");
    await reloaded.reconcile({
      installedPluginIds: new Set(),
      knownQualifiedIdsByPlugin: new Map(),
    });

    expect(await readFile(metadataPath(), "utf-8")).toBe(future);
    warn.mockRestore();
  });

  it("runs inert with no resolvable config dir instead of guessing a path", async () => {
    // A unit test installing a minimal Electron stub must not cause writes into
    // the user's real home tree, and a production getPath failure must not
    // relocate metadata to a directory nothing else reads.
    const inert = new PluginRecipeMetadataStore(null);
    await inert.initialize();
    expect(inert.getAllSync()).toEqual({});
    await inert.recordUse("acme.tools.deploy", "acme.tools", "deploy", 1);
    await inert.setUserOverrides("acme.tools.deploy", "acme.tools", "deploy", {
      autoAssign: "never",
    });
    expect(inert.getAllSync()).toEqual({});
  });

  it("keeps accepting writes after one mutation fails", async () => {
    // The write tail swallows a failed link so a single bad turn can't poison
    // every later write on the same instance.
    await store.recordUse("acme.tools.deploy", "acme.tools", "deploy", 1);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = store.recordUse("acme.tools.boom", "acme.tools", "boom", Number.NaN);
    await failing.catch(() => {});
    error.mockRestore();
    await store.recordUse("acme.tools.deploy", "acme.tools", "deploy", 2);
    expect(store.getAllSync()["acme.tools.deploy"]?.usageHistory).toEqual([1, 2]);
  });

  it("aborts a mutation rather than rewriting the store from an unreadable base", async () => {
    // A transient read failure is not corruption. Treating it as an empty store
    // would let this one write erase every other plugin's history.
    await store.recordUse("acme.tools.deploy", "acme.tools", "deploy", 1);
    const before = await readFile(metadataPath(), "utf-8");
    await rm(metadataPath());
    await mkdir(metadataPath());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(store.recordUse("acme.tools.deploy", "acme.tools", "deploy", 2)).rejects.toThrow();
    error.mockRestore();
    await rm(metadataPath(), { recursive: true });
    await writeFile(metadataPath(), before);
    const reloaded = new PluginRecipeMetadataStore(dir);
    await reloaded.initialize();
    expect(reloaded.getAllSync()["acme.tools.deploy"]?.usageHistory).toEqual([1]);
  });
});
