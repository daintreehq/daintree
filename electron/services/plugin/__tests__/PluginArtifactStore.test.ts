// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginArtifactStore, type ArtifactSlot } from "../PluginArtifactStore.js";

let root: string;
let clock: number;
let store: PluginArtifactStore;

function makeStore(limits?: ConstructorParameters<typeof PluginArtifactStore>[0]["limits"]) {
  return new PluginArtifactStore({ rootDir: root, now: () => clock, limits });
}

async function put(
  target: PluginArtifactStore,
  pluginId: string,
  bytes: number,
  extra: { projectId?: string | null; ttlMs?: number; name?: string } = {}
) {
  const slot = await target.allocate(pluginId);
  try {
    slot.reservation.ensure(bytes);
    await fs.writeFile(slot.partPath, Buffer.alloc(bytes, 7));
    return await target.commit(slot, {
      pluginId,
      projectId: extra.projectId ?? null,
      name: extra.name ?? "clip.mp4",
      mimeType: "video/mp4",
      size: bytes,
      ttlMs: extra.ttlMs ?? 60_000,
      origin: "import",
    });
  } finally {
    await slot.discard();
  }
}

async function runDirs(): Promise<string[]> {
  return (await fs.readdir(root)).filter((name) => name.startsWith("run-"));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-store-"));
  clock = 1_000_000;
  store = makeStore();
});

afterEach(async () => {
  await store.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

describe("PluginArtifactStore", () => {
  it("publishes a committed artifact to its owner only", async () => {
    const artifact = await put(store, "acme.a", 10, { projectId: "p".repeat(64) });
    expect(store.get("acme.a", artifact.id)).toEqual(artifact);
    expect(store.get("acme.b", artifact.id)).toBeNull();
    expect(store.list("acme.a").map((a) => a.id)).toEqual([artifact.id]);
    expect(store.list("acme.a", null)).toEqual([]);
    expect(store.list("acme.b")).toEqual([]);
    expect(store.release("acme.b", artifact.id)).toBe(false);
    expect(store.release("acme.a", artifact.id)).toBe(true);
    expect(store.get("acme.a", artifact.id)).toBeNull();
  });

  it("removes earlier runs at startup and nothing it did not plant", async () => {
    await fs.mkdir(path.join(root, "run-0123456789abcdef"), { recursive: true });
    await fs.writeFile(path.join(root, "run-0123456789abcdef", "stale"), "x");
    await fs.mkdir(path.join(root, "someone-elses"));
    await store.init();
    const entries = await fs.readdir(root);
    expect(entries).toContain("someone-elses");
    expect(entries).not.toContain("run-0123456789abcdef");
    expect(await runDirs()).toHaveLength(1);
  });

  it("leaves nothing behind for a slot that never commits", async () => {
    const slot: ArtifactSlot = await store.allocate("acme.a");
    slot.reservation.ensure(5);
    await fs.writeFile(slot.partPath, "12345");
    expect(store.usage("acme.a")).toBe(5);
    await slot.discard();
    expect(store.usage("acme.a")).toBe(0);
    const [run] = await runDirs();
    expect(await fs.readdir(path.join(root, run!))).toEqual([]);
  });

  it("expires an artifact at its expiry and revokes its leases", async () => {
    const artifact = await put(store, "acme.a", 4, { ttlMs: 60_000 });
    const lease = store.mintLease("acme.a", artifact.id, 7)!;
    expect(store.resolveLease(artifact.id, lease)).toEqual({
      pluginId: "acme.a",
      webContentsId: 7,
    });
    clock += 60_000;
    expect(store.get("acme.a", artifact.id)).toBeNull();
    expect(store.resolveLease(artifact.id, lease)).toBeNull();
  });

  it("evicts the plugin's least recently used artifact to fit its quota", async () => {
    store = makeStore({ pluginQuotaBytes: 100 });
    const older = await put(store, "acme.a", 40);
    clock += 1;
    const newer = await put(store, "acme.a", 40);
    clock += 1;
    // Reading the older one makes it the more recent.
    store.get("acme.a", older.id);
    clock += 1;
    const third = await put(store, "acme.a", 40);
    expect(store.get("acme.a", newer.id)).toBeNull();
    expect(store.get("acme.a", older.id)).not.toBeNull();
    expect(store.get("acme.a", third.id)).not.toBeNull();
  });

  it("never evicts another plugin's artifact for one plugin's quota", async () => {
    store = makeStore({ pluginQuotaBytes: 50, cacheQuotaBytes: 1000 });
    const other = await put(store, "acme.b", 40);
    await put(store, "acme.a", 40);
    await expect(put(store, "acme.a", 60)).rejects.toMatchObject({
      code: "ARTIFACT_QUOTA_EXCEEDED",
    });
    expect(store.get("acme.b", other.id)).not.toBeNull();
  });

  it("evicts across plugins for the cache's quota, but never one being read", async () => {
    store = makeStore({ pluginQuotaBytes: 1000, cacheQuotaBytes: 100 });
    const reading = await put(store, "acme.b", 60);
    const pin = store.openForRead("acme.b", reading.id)!;
    await expect(put(store, "acme.a", 60)).rejects.toMatchObject({
      code: "ARTIFACT_QUOTA_EXCEEDED",
    });
    pin.unpin();
    const fits = await put(store, "acme.a", 60);
    expect(store.get("acme.b", reading.id)).toBeNull();
    expect(store.get("acme.a", fits.id)).not.toBeNull();
  });

  it("refuses an artifact past the size ceiling as it grows", async () => {
    store = makeStore({ maxArtifactBytes: 10 });
    const slot = await store.allocate("acme.a");
    expect(() => slot.reservation.ensure(11)).toThrow(/ARTIFACT_TOO_LARGE/);
    await slot.discard();
  });

  it("keeps a removed artifact's file until its last reader closes", async () => {
    const artifact = await put(store, "acme.a", 8);
    const pin = store.openForRead("acme.a", artifact.id)!;
    store.release("acme.a", artifact.id);
    await expect(fs.stat(pin.filePath)).resolves.toBeTruthy();
    pin.unpin();
    await expect
      .poll(() =>
        fs.stat(pin.filePath).then(
          () => true,
          () => false
        )
      )
      .toBe(false);
  });

  it("keeps a removed artifact charged while a reader still holds its file", async () => {
    store = makeStore({ pluginQuotaBytes: 100 });
    const artifact = await put(store, "acme.a", 60);
    const pin = store.openForRead("acme.a", artifact.id)!;
    store.release("acme.a", artifact.id);
    expect(store.usage("acme.a")).toBe(60);
    await expect(put(store, "acme.a", 60)).rejects.toMatchObject({
      code: "ARTIFACT_QUOTA_EXCEEDED",
    });
    pin.unpin();
    await expect.poll(() => store.usage("acme.a")).toBe(0);
    await expect(put(store, "acme.a", 60)).resolves.toBeTruthy();
  });

  it("counts slots still in flight against the artifact cap", async () => {
    store = makeStore({ maxPerPlugin: 2 });
    await put(store, "acme.a", 1);
    const inFlight = await store.allocate("acme.a");
    // The committed one is evicted to make room; the open slot is not counted twice.
    const third = await store.allocate("acme.a");
    expect(store.list("acme.a")).toEqual([]);
    // Two open slots fill a cap of two: nothing committed is left to evict.
    await expect(store.allocate("acme.a")).rejects.toMatchObject({
      code: "ARTIFACT_QUOTA_EXCEEDED",
    });
    await inFlight.discard();
    await third.discard();
  });

  it("publishes nothing when the transfer ended during the commit", async () => {
    const slot = await store.allocate("acme.a");
    await fs.writeFile(slot.partPath, "abc");
    await expect(
      store.commit(
        slot,
        {
          pluginId: "acme.a",
          projectId: null,
          name: "a.bin",
          mimeType: "application/octet-stream",
          size: 3,
          ttlMs: 60_000,
          origin: "import",
        },
        () => false
      )
    ).rejects.toMatchObject({ code: "ARTIFACT_TRANSFER_FAILED" });
    await slot.discard();
    expect(store.list("acme.a")).toEqual([]);
    const [run] = await runDirs();
    expect(await fs.readdir(path.join(root, run!))).toEqual([]);
  });

  it("binds a lease to its artifact, its view and its plugin", async () => {
    const a = await put(store, "acme.a", 1);
    const b = await put(store, "acme.a", 1);
    expect(store.mintLease("acme.b", a.id, 1)).toBeNull();
    const lease = store.mintLease("acme.a", a.id, 1)!;
    expect(store.resolveLease(b.id, lease)).toBeNull();
    expect(store.revokeLease(lease, 2)).toBe(false);
    expect(store.resolveLease(a.id, lease)).not.toBeNull();
    store.revokeLeasesForView(1);
    expect(store.resolveLease(a.id, lease)).toBeNull();
  });

  it("caps the leases one view holds, dropping its oldest", async () => {
    store = makeStore({ leasesPerView: 2 });
    const artifact = await put(store, "acme.a", 1);
    const first = store.mintLease("acme.a", artifact.id, 3)!;
    const second = store.mintLease("acme.a", artifact.id, 3)!;
    const third = store.mintLease("acme.a", artifact.id, 3)!;
    expect(store.resolveLease(artifact.id, first)).toBeNull();
    expect(store.resolveLease(artifact.id, second)).not.toBeNull();
    expect(store.resolveLease(artifact.id, third)).not.toBeNull();
  });

  it("drops a project's artifacts, every plugin's, and nothing else", async () => {
    const project = "a".repeat(64);
    const mine = await put(store, "acme.a", 1, { projectId: project });
    const theirs = await put(store, "acme.b", 1, { projectId: project });
    const appWide = await put(store, "acme.a", 1, { projectId: null });
    store.releaseWhere((owner) => owner.projectId === project);
    expect(store.get("acme.a", mine.id)).toBeNull();
    expect(store.get("acme.b", theirs.id)).toBeNull();
    expect(store.get("acme.a", appWide.id)).not.toBeNull();
  });

  it("removes this run's files on dispose and admits nothing after", async () => {
    await put(store, "acme.a", 3);
    await store.dispose();
    expect(await runDirs()).toEqual([]);
    await expect(store.allocate("acme.a")).rejects.toMatchObject({
      code: "ARTIFACT_TRANSFER_FAILED",
    });
  });
});
