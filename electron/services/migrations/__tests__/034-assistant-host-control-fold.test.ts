import { describe, expect, it, vi } from "vitest";
import { migration034 } from "../034-assistant-host-control-fold.js";

function run(remoteHosts: unknown) {
  const data: Record<string, unknown> = remoteHosts === undefined ? {} : { remoteHosts };
  const store = {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as Parameters<typeof migration034.up>[0] & { set: ReturnType<typeof vi.fn> };
  migration034.up(store);
  return { store, after: data.remoteHosts as { hosts: unknown[] } | undefined };
}

const base = {
  id: "studio",
  name: "studio",
  connection: { kind: "ssh", target: "greg@studio" },
  notificationsEnabled: false,
};
const ssh = (switches: Record<string, unknown>) => ({ ...base, ...switches });
const wsl = (switches: Record<string, unknown>) => ({
  ...base,
  id: "ubuntu",
  connection: { kind: "wsl", distro: "Ubuntu" },
  ...switches,
});

describe("migration034 — fold assistant host switches into control", () => {
  it("has version 34", () => {
    expect(migration034.version).toBe(34);
  });

  it("keeps control on for an SSH host with every switch on, dropping the old two", () => {
    const { after } = run({
      hosts: [
        ssh({
          assistantMessagingEnabled: true,
          assistantStartEnabled: true,
          assistantControlEnabled: true,
        }),
      ],
      lastUsed: "studio",
    });
    expect(after).toEqual({ hosts: [ssh({ assistantControlEnabled: true })], lastUsed: "studio" });
  });

  it("carries an SSH host's explicit messaging or start opt-out over as control off", () => {
    const { after } = run({
      hosts: [
        ssh({
          assistantMessagingEnabled: false,
          assistantStartEnabled: true,
          assistantControlEnabled: true,
        }),
        ssh({
          id: "other",
          assistantMessagingEnabled: true,
          assistantStartEnabled: false,
          assistantControlEnabled: true,
        }),
      ],
    });
    expect(after?.hosts).toEqual([
      ssh({ assistantControlEnabled: false }),
      ssh({ id: "other", assistantControlEnabled: false }),
    ]);
  });

  it("keeps an SSH host's control opt-out whatever the old switches said", () => {
    const { after } = run({
      hosts: [
        ssh({
          assistantMessagingEnabled: true,
          assistantStartEnabled: true,
          assistantControlEnabled: false,
        }),
      ],
    });
    expect(after?.hosts).toEqual([ssh({ assistantControlEnabled: false })]);
  });

  it("takes control from messaging for a host saved before control existed", () => {
    const { after } = run({
      hosts: [
        ssh({ assistantMessagingEnabled: true, assistantStartEnabled: true }),
        wsl({ assistantMessagingEnabled: false, assistantStartEnabled: false }),
      ],
    });
    expect(after?.hosts).toEqual([
      ssh({ assistantControlEnabled: true }),
      wsl({ assistantControlEnabled: false }),
    ]);
  });

  it("keeps a WSL host's stored control, since off there was only the default", () => {
    const { after } = run({
      hosts: [
        wsl({
          assistantMessagingEnabled: false,
          assistantStartEnabled: false,
          assistantControlEnabled: true,
        }),
      ],
    });
    expect(after?.hosts).toEqual([wsl({ assistantControlEnabled: true })]);
  });

  it("leaves a malformed control for the registry to read, unless an opt-out decides it", () => {
    const { after } = run({
      hosts: [
        ssh({ assistantMessagingEnabled: "yes", assistantControlEnabled: "on" }),
        wsl({ assistantStartEnabled: true }),
      ],
    });
    expect(after?.hosts).toEqual([ssh({ assistantControlEnabled: "on" }), wsl({})]);
  });

  it("writes nothing when no host carries the old switches", () => {
    expect(
      run({ hosts: [ssh({ assistantControlEnabled: true })] }).store.set
    ).not.toHaveBeenCalled();
  });

  it("leaves malformed entries and a missing or corrupt host list alone", () => {
    const { after } = run({
      hosts: [ssh({ assistantMessagingEnabled: false }), "junk", { id: "bad" }],
    });
    expect(after?.hosts.slice(1)).toEqual(["junk", { id: "bad" }]);
    expect(run(undefined).store.set).not.toHaveBeenCalled();
    expect(run({ hosts: "corrupt" }).store.set).not.toHaveBeenCalled();
    expect(() => run("corrupt")).not.toThrow();
  });
});
