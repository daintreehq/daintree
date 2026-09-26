import { describe, expect, it, vi } from "vitest";
import { isValidRemoteHostId, type HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { HostRegistry, type RemoteHostsStore } from "../HostRegistry.js";

function memoryStore(initial?: unknown): RemoteHostsStore & { value: unknown; writes: number } {
  const store = {
    value: initial,
    writes: 0,
    get: () => store.value as { hosts: HostDescriptor[] } | undefined,
    set: (_key: "remoteHosts", value: { hosts: HostDescriptor[] }) => {
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

  it("mints unique ids for hosts with the same name", () => {
    const registry = new HostRegistry(memoryStore());
    const a = registry.add({ name: "box", connection: { kind: "ssh", target: "a.example" } });
    const b = registry.add({ name: "box", connection: { kind: "ssh", target: "b.example" } });
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
