// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { HostListEntry } from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";

vi.mock("@/lib/remoteHosts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/remoteHosts")>()),
  isRemoteShellSupported: () => true,
}));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

import { _resetHostListForTesting, useHostList } from "../hostList";

function host(id: string): HostListEntry {
  return {
    descriptor: {
      id,
      name: id,
      connection: { kind: "ssh", target: `greg@${id}` },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
      assistantControlEnabled: false,
    },
    connection: { status: "disconnected" },
    summary: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let emit: ((event: RemoteHostsEvent) => void) | null = null;
const list = vi.fn<() => Promise<HostListEntry[]>>();

beforeEach(() => {
  _resetHostListForTesting();
  list.mockReset();
  emit = null;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      remoteHosts: {
        list,
        onEvent: (cb: (event: RemoteHostsEvent) => void) => {
          emit = cb;
          return () => {
            emit = null;
          };
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  _resetHostListForTesting();
  Reflect.deleteProperty(window, "electron");
});

const ids = (hosts: HostListEntry[]) => hosts.map((entry) => entry.descriptor.id);

describe("hostList", () => {
  it("keeps the hosts Remote Hosts announced when the read made before it started answers empty afterwards", async () => {
    const early = deferred<HostListEntry[]>();
    list.mockReturnValueOnce(early.promise);
    const { result } = renderHook(() => useHostList());
    expect(list).toHaveBeenCalledTimes(1);

    act(() => emit?.({ type: "hosts-changed", hosts: [host("studio-01")] }));
    expect(ids(result.current.hosts)).toEqual(["studio-01"]);

    await act(async () => {
      early.resolve([]);
      await early.promise;
    });
    expect(ids(result.current.hosts)).toEqual(["studio-01"]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("drops a read from a subscription that ended, after the next one has its list", async () => {
    const stale = deferred<HostListEntry[]>();
    list.mockReturnValueOnce(stale.promise);
    const first = renderHook(() => useHostList());
    first.unmount();

    list.mockResolvedValueOnce([host("studio-01")]);
    const { result } = renderHook(() => useHostList());
    await act(async () => {
      await Promise.resolve();
    });
    expect(ids(result.current.hosts)).toEqual(["studio-01"]);

    await act(async () => {
      stale.resolve([]);
      await stale.promise;
    });
    expect(ids(result.current.hosts)).toEqual(["studio-01"]);
  });
});
