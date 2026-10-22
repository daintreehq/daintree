import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostConnectionState } from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import { remoteHostsClient } from "../remoteHostsClient";

function stubRemoteHosts() {
  const listeners = new Set<(event: RemoteHostsEvent) => void>();
  const connect = vi.fn(
    async (_payload: { hostId: string; restart?: boolean }): Promise<HostConnectionState> => ({
      status: "connecting",
      attempt: 1,
    })
  );
  vi.stubGlobal("window", {
    electron: {
      remoteHosts: {
        connect,
        onEvent: (listener: (event: RemoteHostsEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  const emit = (connection: HostConnectionState) => {
    for (const listener of listeners) {
      listener({ type: "connection-changed", hostId: "studio-01", connection } as RemoteHostsEvent);
    }
  };
  return { connect, emit, listeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connectAndSettle", () => {
  it("asks the Shell to start over only for a person's Retry", async () => {
    const { connect } = stubRemoteHosts();
    void remoteHostsClient.connectAndSettle("studio-01", { restart: true, timeoutMs: 10 });
    void remoteHostsClient.connectAndSettle("studio-01", { timeoutMs: 10 });
    expect(connect.mock.calls.map(([payload]) => payload)).toEqual([
      { hostId: "studio-01", restart: true },
      { hostId: "studio-01" },
    ]);
  });

  it("settles on the first state past connecting, and stops listening", async () => {
    const { emit, listeners } = stubRemoteHosts();
    const settled = remoteHostsClient.connectAndSettle("studio-01", { restart: true });
    // The abandoned attempt's replacement starts out connecting too.
    emit({ status: "connecting", attempt: 2 });
    const unreachable: HostConnectionState = {
      status: "unreachable",
      lastSeenAt: null,
      detail: "ssh: connect to host studio port 22: Operation timed out",
    };
    emit(unreachable);
    await expect(settled).resolves.toEqual(unreachable);
    expect(listeners.size).toBe(0);
  });
});
