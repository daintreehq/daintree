import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetPluginArchiveInstallStoreForTesting,
  usePluginArchiveInstallStore,
} from "../pluginArchiveInstallStore";
import type { PluginArchiveInstallIntent } from "@shared/types/plugin";

function intent(overrides: Partial<PluginArchiveInstallIntent> = {}): PluginArchiveInstallIntent {
  return {
    intentId: "i1",
    archivePath: "/tmp/a.dntr",
    archiveFileName: "a.dntr",
    manifest: {
      name: "acme.tool",
      version: "1.0.0",
      authors: [],
      capabilities: [],
    },
    ...overrides,
  };
}

const store = () => usePluginArchiveInstallStore.getState();

describe("pluginArchiveInstallStore", () => {
  beforeEach(() => {
    __resetPluginArchiveInstallStoreForTesting();
  });

  it("promotes the first intent straight to current", () => {
    store().enqueue(intent());

    expect(store().current?.archivePath).toBe("/tmp/a.dntr");
    expect(store().queue).toHaveLength(0);
  });

  it("queues later intents behind the current one and promotes them FIFO", () => {
    store().enqueue(intent({ intentId: "i1", archivePath: "/tmp/1.dntr" }));
    store().enqueue(intent({ intentId: "i2", archivePath: "/tmp/2.dntr" }));
    store().enqueue(intent({ intentId: "i3", archivePath: "/tmp/3.dntr" }));

    expect(store().current?.archivePath).toBe("/tmp/1.dntr");
    expect(store().queue.map((i) => i.archivePath)).toEqual(["/tmp/2.dntr", "/tmp/3.dntr"]);

    store().resolveCurrent();
    expect(store().current?.archivePath).toBe("/tmp/2.dntr");

    store().resolveCurrent();
    expect(store().current?.archivePath).toBe("/tmp/3.dntr");

    store().resolveCurrent();
    expect(store().current).toBeNull();
    expect(store().queue).toHaveLength(0);
  });

  it("ignores a duplicate of the archive currently being decided", () => {
    store().enqueue(intent({ intentId: "i1", archivePath: "/tmp/dup.dntr" }));
    store().enqueue(intent({ intentId: "i2", archivePath: "/tmp/dup.dntr" }));

    expect(store().current?.intentId).toBe("i1");
    expect(store().queue).toHaveLength(0);
  });

  it("ignores a duplicate of an archive already waiting in the queue", () => {
    store().enqueue(intent({ intentId: "i1", archivePath: "/tmp/1.dntr" }));
    store().enqueue(intent({ intentId: "i2", archivePath: "/tmp/2.dntr" }));
    store().enqueue(intent({ intentId: "i3", archivePath: "/tmp/2.dntr" }));

    expect(store().queue.map((i) => i.intentId)).toEqual(["i2"]);
  });

  it("keeps distinct archives apart even when their manifests match", () => {
    store().enqueue(intent({ intentId: "i1", archivePath: "/tmp/copy-1.dntr" }));
    store().enqueue(intent({ intentId: "i2", archivePath: "/tmp/copy-2.dntr" }));

    expect(store().current?.archivePath).toBe("/tmp/copy-1.dntr");
    expect(store().queue.map((i) => i.archivePath)).toEqual(["/tmp/copy-2.dntr"]);
  });

  it("re-prompts for a path once its earlier decision is resolved", () => {
    store().enqueue(intent({ intentId: "i1", archivePath: "/tmp/again.dntr" }));
    store().resolveCurrent();
    store().enqueue(intent({ intentId: "i2", archivePath: "/tmp/again.dntr" }));

    expect(store().current?.intentId).toBe("i2");
  });

  it("resolving with nothing pending is a no-op", () => {
    store().resolveCurrent();

    expect(store().current).toBeNull();
    expect(store().queue).toHaveLength(0);
  });

  it("dropping the current intent promotes the next one", () => {
    store().enqueue(intent({ intentId: "i1", archivePath: "/tmp/1.dntr" }));
    store().enqueue(intent({ intentId: "i2", archivePath: "/tmp/2.dntr" }));

    store().drop("i1");

    expect(store().current?.intentId).toBe("i2");
  });

  it("dropping a queued intent leaves the current one untouched", () => {
    store().enqueue(intent({ intentId: "i1", archivePath: "/tmp/1.dntr" }));
    store().enqueue(intent({ intentId: "i2", archivePath: "/tmp/2.dntr" }));
    store().enqueue(intent({ intentId: "i3", archivePath: "/tmp/3.dntr" }));

    store().drop("i3");

    expect(store().current?.intentId).toBe("i1");
    expect(store().queue.map((i) => i.intentId)).toEqual(["i2"]);
  });

  it("dropping an unknown id changes nothing", () => {
    store().enqueue(intent({ intentId: "i1", archivePath: "/tmp/1.dntr" }));
    const before = store().current;

    store().drop("nope");

    expect(store().current).toBe(before);
  });
});
