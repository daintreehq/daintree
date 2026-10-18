// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnectionState, HostListEntry } from "@shared/types/remoteHosts";

const connect = vi.hoisted(() => vi.fn(async () => ({ status: "connecting", attempt: 1 })));
vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: { connect } }));

import {
  OVERVIEW_TOUCH_MS,
  overviewWantsConnection,
  useOverviewConnections,
} from "../useOverviewConnections";

function host(id: string, connection: HostConnectionState): HostListEntry {
  return {
    descriptor: {
      id,
      name: id,
      connection: { kind: "ssh", target: id },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
      assistantControlEnabled: false,
    },
    connection,
    summary: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  connect.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useOverviewConnections", () => {
  it("connects the hosts it shows while open, and keeps them in use until it closes", async () => {
    const hosts = [
      host("studio", { status: "disconnected" }),
      host("locked", {
        status: "unreachable",
        lastSeenAt: null,
        detail: "Permission denied (publickey).",
        stoppedRetrying: true,
      }),
    ];
    const { unmount } = renderHook(() => useOverviewConnections(hosts));
    await vi.advanceTimersByTimeAsync(0);
    // A host waiting for the user isn't tried again just because the overview opened.
    expect(connect.mock.calls).toEqual([["studio"]]);

    await vi.advanceTimersByTimeAsync(OVERVIEW_TOUCH_MS);
    expect(connect).toHaveBeenCalledTimes(2);

    unmount();
    await vi.advanceTimersByTimeAsync(OVERVIEW_TOUCH_MS * 3);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("leaves a host on another build alone", () => {
    const handshake = {
      version: "1",
      commit: "c",
      protocolVersion: 2,
      platform: "linux",
      arch: "x64",
    } as const;
    const mismatched: HostConnectionState = {
      status: "version-mismatch",
      mismatch: { kind: "protocol", local: 1, remote: 2 },
      remote: handshake,
    };
    expect(overviewWantsConnection(mismatched)).toBe(false);
    expect(overviewWantsConnection({ status: "connecting", attempt: 2 })).toBe(true);
  });
});
