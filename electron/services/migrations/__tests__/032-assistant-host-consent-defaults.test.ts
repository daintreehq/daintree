import { describe, expect, it, vi } from "vitest";
import { migration032 } from "../032-assistant-host-consent-defaults.js";

function run(remoteHosts: unknown) {
  const data: Record<string, unknown> = remoteHosts === undefined ? {} : { remoteHosts };
  const store = {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration032.up>[0] & { set: ReturnType<typeof vi.fn> };
  migration032.up(store);
  return { store, after: data.remoteHosts as Record<string, unknown> | undefined };
}

const ssh = {
  id: "studio",
  name: "studio",
  connection: { kind: "ssh", target: "greg@studio" },
  notificationsEnabled: false,
  assistantMessagingEnabled: false,
  assistantStartEnabled: false,
};

describe("migration032 — assistant host consent defaults", () => {
  it("has version 32", () => {
    expect(migration032.version).toBe(32);
  });

  it("turns both switches on for every stored SSH host and keeps the rest of the record", () => {
    const legacy = { id: "old", name: "old", sshTarget: "greg@old" };
    const wsl = { ...ssh, id: "ubuntu", connection: { kind: "wsl", distro: "Ubuntu" } };
    const { after } = run({
      hosts: [ssh, legacy, wsl],
      retiredIds: ["gone"],
      lastUsed: "studio",
    });
    expect(after).toEqual({
      hosts: [
        { ...ssh, assistantMessagingEnabled: true, assistantStartEnabled: true },
        { ...legacy, assistantMessagingEnabled: true, assistantStartEnabled: true },
        wsl,
      ],
      retiredIds: ["gone"],
      lastUsed: "studio",
    });
  });

  it("writes nothing when every SSH host already has both on", () => {
    const on = { ...ssh, assistantMessagingEnabled: true, assistantStartEnabled: true };
    expect(run({ hosts: [on] }).store.set).not.toHaveBeenCalled();
  });

  it("leaves malformed entries and a missing or corrupt host list alone", () => {
    const { after } = run({ hosts: [ssh, "junk", { id: "bad", connection: { kind: "tcp" } }] });
    expect((after?.hosts as unknown[]).slice(1)).toEqual([
      "junk",
      { id: "bad", connection: { kind: "tcp" } },
    ]);
    expect(run(undefined).store.set).not.toHaveBeenCalled();
    expect(run({ hosts: "corrupt" }).store.set).not.toHaveBeenCalled();
    expect(() => run("corrupt")).not.toThrow();
  });
});
