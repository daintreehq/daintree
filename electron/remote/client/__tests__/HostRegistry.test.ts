import { describe, expect, it, vi } from "vitest";
import { isValidRemoteHostId, type HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { HostRegistry, type RemoteHostsStore, type RemoteHostsValue } from "../HostRegistry.js";

function memoryStore(initial?: unknown): RemoteHostsStore & { value: unknown; writes: number } {
  const store = {
    value: initial,
    writes: 0,
    get: () => store.value as RemoteHostsValue | undefined,
    set: (_key: "remoteHosts", value: RemoteHostsValue) => {
      store.value = value;
      store.writes++;
    },
  };
  return store;
}

describe("HostRegistry", () => {
  it("reads an absent key as an empty list and never writes to do so", () => {
    const store = memoryStore(undefined);
    const registry = new HostRegistry(store);
    expect(registry.list()).toEqual([]);
    expect(registry.get("studio-01")).toBeNull();
    expect(store.writes).toBe(0);
  });

  it("adds a host with a valid, readable id and defaults applied", () => {
    const store = memoryStore();
    const registry = new HostRegistry(store, () => 1_000);
    const added = registry.add({
      name: "  Studio 01 ",
      connection: { kind: "ssh", target: "greg@studio-01" },
    });
    expect(added).toEqual({
      id: "studio-01",
      name: "Studio 01",
      connection: { kind: "ssh", target: "greg@studio-01" },
      platform: null,
      arch: null,
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1_000,
      notificationsEnabled: false,
    });
    expect(isValidRemoteHostId(added.id)).toBe(true);
    expect(registry.list()).toEqual([added]);
  });

  it("mints unique ids for hosts whose names slug alike", () => {
    const registry = new HostRegistry(memoryStore());
    const a = registry.add({ name: "box", connection: { kind: "ssh", target: "a.example" } });
    const b = registry.add({ name: "Box!", connection: { kind: "ssh", target: "b.example" } });
    expect(a.id).toBe("box");
    expect(b.id).toBe("box-2");
  });

  it("never mints the reserved local id or one with a colon", () => {
    const registry = new HostRegistry(memoryStore());
    const local = registry.add({
      name: "local",
      connection: { kind: "ssh", target: "one.example" },
    });
    const odd = registry.add({ name: "::", connection: { kind: "ssh", target: "two.example" } });
    for (const host of [local, odd]) {
      expect(isValidRemoteHostId(host.id)).toBe(true);
      expect(host.id).not.toContain(":");
    }
    expect(local.id).not.toBe("local");
  });

  it("rejects unusable names, targets and duplicates with VALIDATION", () => {
    const registry = new HostRegistry(memoryStore());
    registry.add({ name: "box", connection: { kind: "ssh", target: "box.example" } });
    for (const payload of [
      { name: "", connection: { kind: "ssh", target: "x.example" } },
      { name: "a\u0007b", connection: { kind: "ssh", target: "x.example" } },
      { name: "x".repeat(65), connection: { kind: "ssh", target: "x.example" } },
      { name: "x", connection: { kind: "ssh", target: "-oProxyCommand=evil" } },
      { name: "x", connection: { kind: "ssh", target: "host with space" } },
      { name: "x", connection: { kind: "ssh", target: "box.example" } },
    ] as const) {
      expect(() => registry.add(payload)).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    }
    expect(registry.list()).toHaveLength(1);
  });

  it("keeps display names unique and never this machine's, ignoring case", () => {
    const registry = new HostRegistry(memoryStore());
    const box = registry.add({ name: "Studio", connection: { kind: "ssh", target: "a.example" } });
    for (const name of ["studio", " STUDIO ", "This Mac", "this machine"]) {
      expect(() =>
        registry.add({ name, connection: { kind: "ssh", target: "b.example" } })
      ).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    }
    const other = registry.add({ name: "Lab", connection: { kind: "ssh", target: "b.example" } });
    expect(() => registry.update({ hostId: other.id, name: "STUDIO" })).toThrow(
      expect.objectContaining({ code: "VALIDATION" })
    );
    // Re-casing its own name is not a clash.
    expect(registry.update({ hostId: box.id, name: "STUDIO" }).name).toBe("STUDIO");
  });

  it("refuses the same account twice but adds another account on the same machine", () => {
    const registry = new HostRegistry(memoryStore());
    registry.add({ name: "a", connection: { kind: "ssh", target: "greg@Studio.local" } });
    expect(() =>
      registry.add({ name: "b", connection: { kind: "ssh", target: "greg@studio.LOCAL" } })
    ).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    const other = registry.add({
      name: "b",
      connection: { kind: "ssh", target: "admin@studio.local" },
    });
    expect(other.connection).toEqual({ kind: "ssh", target: "admin@studio.local" });
    expect(() =>
      registry.update({
        hostId: other.id,
        connection: { kind: "ssh", target: "greg@STUDIO.local" },
      })
    ).toThrow(expect.objectContaining({ code: "VALIDATION" }));
  });

  it("validates an update without writing it", () => {
    const store = memoryStore();
    const registry = new HostRegistry(store);
    const host = registry.add({ name: "box", connection: { kind: "ssh", target: "box.example" } });
    const next = registry.validateUpdate({
      hostId: host.id,
      connection: { kind: "ssh", target: "new.example" },
    });
    expect(next.connection).toEqual({ kind: "ssh", target: "new.example" });
    expect(registry.get(host.id)?.connection).toEqual({ kind: "ssh", target: "box.example" });
  });

  it("updates fields and clears what was observed about a previous target", () => {
    const registry = new HostRegistry(memoryStore());
    const host = registry.add({ name: "box", connection: { kind: "ssh", target: "box.example" } });
    registry.recordObservation(host.id, { lastSeenAt: 5, platform: "linux", arch: "x64" });
    const renamed = registry.update({ hostId: host.id, name: "Box", notificationsEnabled: true });
    expect(renamed).toMatchObject({ name: "Box", notificationsEnabled: true, lastSeenAt: 5 });
    const moved = registry.update({
      hostId: host.id,
      connection: { kind: "ssh", target: "other.example" },
    });
    expect(moved).toMatchObject({
      connection: { kind: "ssh", target: "other.example" },
      platform: null,
      arch: null,
      lastSeenAt: null,
    });
    expect(() => registry.update({ hostId: "missing", name: "x" })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" })
    );
  });

  it("forgets a host and reports changes", () => {
    const registry = new HostRegistry(memoryStore());
    const listener = vi.fn();
    registry.onChange(listener);
    const host = registry.add({ name: "box", connection: { kind: "ssh", target: "box.example" } });
    expect(registry.forget(host.id)).toBe(true);
    expect(registry.forget(host.id)).toBe(false);
    expect(registry.list()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("never gives a removed host's id to a host added later", () => {
    const store = memoryStore();
    const registry = new HostRegistry(store);
    const first = registry.add({
      name: "studio-02",
      connection: { kind: "ssh", target: "greg@studio-02" },
    });
    expect(first.id).toBe("studio-02");
    registry.forget(first.id);

    const second = registry.add({
      name: "studio-02",
      connection: { kind: "ssh", target: "greg@10.0.0.9" },
    });
    expect(second.id).toBe("studio-02-2");
    registry.forget(second.id);

    const third = registry.add({
      name: "Studio 02",
      connection: { kind: "ssh", target: "greg@10.0.0.10" },
    });
    expect(third.id).toBe("studio-02-3");
    expect([...registry.retiredIds()].sort()).toEqual(["studio-02", "studio-02-2"]);
  });

  it("keeps retired ids through later edits, and stored ids as they were", () => {
    const store = memoryStore({
      hosts: [
        {
          id: "old-box",
          name: "Old box",
          connection: { kind: "ssh", target: "old.example" },
          addedAt: 1,
        },
      ],
    });
    const registry = new HostRegistry(store);
    const gone = registry.add({
      name: "gone",
      connection: { kind: "ssh", target: "gone.example" },
    });
    registry.forget(gone.id);
    registry.update({ hostId: "old-box", name: "Renamed" });
    registry.recordObservation("old-box", { lastSeenAt: 5 });

    expect(registry.get("old-box")?.name).toBe("Renamed");
    expect((store.value as { retiredIds?: string[] }).retiredIds).toEqual(["gone"]);
    expect(
      registry.add({ name: "gone", connection: { kind: "ssh", target: "b.example" } }).id
    ).toBe("gone-2");
  });

  it("ignores retired ids a hand-edited settings file mangled", () => {
    const registry = new HostRegistry(
      memoryStore({ hosts: [], retiredIds: ["box", 7, "", "local", "BAD ID"] })
    );
    expect([...registry.retiredIds()]).toEqual(["box"]);
    expect(registry.add({ name: "box", connection: { kind: "ssh", target: "box" } }).id).toBe(
      "box-2"
    );
  });

  it("writes no retired list until a host is removed", () => {
    const store = memoryStore();
    new HostRegistry(store).add({ name: "box", connection: { kind: "ssh", target: "box" } });
    expect(store.value).not.toHaveProperty("retiredIds");
  });

  it("drops malformed entries a hand-edited settings file left behind", () => {
    const good: HostDescriptor = {
      id: "ok",
      name: "ok",
      connection: { kind: "ssh", target: "ok.example" },
      platform: "darwin",
      arch: "arm64",
      lastHandshake: null,
      lastSeenAt: 1,
      addedAt: 1,
      notificationsEnabled: false,
    };
    const registry = new HostRegistry(
      memoryStore({
        hosts: [
          good,
          { ...good, id: "local" },
          { ...good, id: "a:b" },
          { ...good, id: "dup" },
          { ...good, id: "dup", connection: { kind: "ssh", target: "dup2.example" } },
          { ...good, id: "bad-target", connection: { kind: "ssh", target: "-oEvil" } },
          null,
          "nope",
        ],
      })
    );
    expect(registry.list().map((host) => host.id)).toEqual(["ok", "dup"]);
  });

  it("reads a record a development build saved with the old `sshTarget` shape", () => {
    const store = memoryStore({
      hosts: [
        {
          id: "studio",
          name: "studio",
          sshTarget: "greg@studio",
          platform: "linux",
          arch: "x64",
          lastHandshake: null,
          lastSeenAt: 5,
          addedAt: 1,
          notificationsEnabled: true,
        },
        { id: "bad", name: "bad", sshTarget: "-oProxyCommand=evil", addedAt: 1 },
        { id: "unknown-kind", name: "x", connection: { kind: "telnet", target: "x" } },
      ],
    });
    const registry = new HostRegistry(store);
    expect(registry.list()).toEqual([
      {
        id: "studio",
        name: "studio",
        connection: { kind: "ssh", target: "greg@studio" },
        platform: "linux",
        arch: "x64",
        lastHandshake: null,
        lastSeenAt: 5,
        addedAt: 1,
        notificationsEnabled: true,
      },
    ]);
    // Reading changes nothing on disk; the next write saves the new shape.
    expect(store.writes).toBe(0);
    registry.update({ hostId: "studio", name: "Studio" });
    expect(store.value).toEqual({
      hosts: [expect.objectContaining({ connection: { kind: "ssh", target: "greg@studio" } })],
    });
    expect(JSON.stringify(store.value)).not.toContain("sshTarget");
  });

  it("refuses a connection kind it doesn't know", () => {
    const registry = new HostRegistry(memoryStore());
    expect(() =>
      registry.add({ name: "x", connection: { kind: "wsl", distro: "Ubuntu" } as never })
    ).toThrow(expect.objectContaining({ code: "VALIDATION" }));
  });
});
