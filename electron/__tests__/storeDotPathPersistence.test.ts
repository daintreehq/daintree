import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("electron-store", async () => {
  const conf = await import("conf");
  return { default: conf.default };
});

import { initializeStore, _resetStoreInstance } from "../store.js";

type AnyStore = {
  set: (key: string, value: unknown) => void;
  get: (key: string) => unknown;
  delete: (key: string) => void;
};

describe("Store dot-path persistence", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    _resetStoreInstance();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-store-dotpath-"));
    configPath = path.join(tempDir, "config.json");
  });

  afterEach(() => {
    _resetStoreInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  }

  function makeStore(defaults: Record<string, unknown> = {}): AnyStore {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return initializeStore({ defaults, cwd: tempDir } as any) as unknown as AnyStore;
  }

  it("dot-path set writes only the leaf, not the whole slice", () => {
    const store = makeStore();
    store.set("foo.bar", 1);
    expect(readConfig()).toEqual({ foo: { bar: 1 } });
  });

  it("dot-path set preserves siblings already on disk", () => {
    fs.writeFileSync(configPath, JSON.stringify({ foo: { bar: 1, baz: 2 } }), "utf8");
    const store = makeStore();
    store.set("foo.bar", 99);
    expect(readConfig()).toEqual({ foo: { bar: 99, baz: 2 } });
  });

  it("multiple dot-path sets accumulate without clobbering siblings", () => {
    const store = makeStore();
    store.set("foo.bar", 1);
    store.set("foo.baz", 2);
    expect(readConfig()).toEqual({ foo: { bar: 1, baz: 2 } });
  });

  it("nested dot-path set writes deeply without baking unrelated keys", () => {
    const store = makeStore();
    store.set("a.b.c", true);
    expect(readConfig()).toEqual({ a: { b: { c: true } } });
  });

  it("dot-path set on a missing slice creates only that field, no defaults of siblings", () => {
    // Simulate a user whose config existed before some new sibling defaults were added.
    fs.writeFileSync(configPath, JSON.stringify({ foo: { existing: "user" } }), "utf8");
    const store = makeStore();
    store.set("foo.existing", "user-modified");
    const slice = readConfig().foo as Record<string, unknown>;
    expect(slice).toEqual({ existing: "user-modified" });
  });

  it("whole-slice replacement still works for explicit resets", () => {
    fs.writeFileSync(configPath, JSON.stringify({ foo: { keep: 1, drop: 2 } }), "utf8");
    const store = makeStore();
    store.set("foo", { onlyField: "value" });
    expect(readConfig()).toEqual({ foo: { onlyField: "value" } });
  });

  it("dot-path delete clears a leaf without dropping siblings", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ appState: { activeWorktreeId: "wt-old", sidebarWidth: 350 } }),
      "utf8"
    );
    const store = makeStore();
    store.delete("appState.activeWorktreeId");
    const slice = readConfig().appState as Record<string, unknown>;
    expect(slice).not.toHaveProperty("activeWorktreeId");
    expect(slice.sidebarWidth).toBe(350);
  });

  it("set with undefined throws — callers must use delete to clear", () => {
    const store = makeStore();
    store.set("appState.sidebarWidth", 350);
    expect(() => store.set("appState.activeWorktreeId", undefined)).toThrow();
  });

  it("preserves nested record fields not addressed by the dot-path", () => {
    // Models the agentSettings.agents pattern: writing the whole `agents` record
    // at slice.field level instead of per-agent leaves (which would be unsafe for
    // user-defined agent IDs containing dots).
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agentSettings: {
          rootField: "preserved",
          agents: { claude: { customFlags: "--foo" } },
        },
      }),
      "utf8"
    );
    const store = makeStore();
    store.set("agentSettings.agents", {
      claude: { customFlags: "--bar" },
      gemini: { model: "gemini-2.0" },
    });
    const after = readConfig().agentSettings as Record<string, unknown>;
    expect(after.rootField).toBe("preserved");
    expect(after.agents).toEqual({
      claude: { customFlags: "--bar" },
      gemini: { model: "gemini-2.0" },
    });
  });
});
