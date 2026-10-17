// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CanopyHostEvent } from "@shared/types/ipc/canopyHost";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";

const bridge = vi.hoisted(() => ({
  listeners: new Set<(event: CanopyHostEvent) => void>(),
  invoke: vi.fn(),
  release: vi.fn(async () => {}),
}));
vi.mock("@/clients/canopyHostClient", () => ({
  canopyHostClient: {
    invoke: bridge.invoke,
    release: bridge.release,
    onEvent: (callback: (event: CanopyHostEvent) => void) => {
      bridge.listeners.add(callback);
      return () => bridge.listeners.delete(callback);
    },
  },
}));

import { remoteCanopyApi, useRemoteCanopy } from "../canopyHostSource";

function canopy(refreshedAt: number, sequence?: number): CanopySnapshot {
  return {
    mode: "on",
    activated: true,
    tier: "priority",
    dispositions: [],
    seen: [],
    reads: [],
    scope: null,
    active: true,
    busy: false,
    refreshedAt,
    cards: [],
    lastError: null,
    failedRuns: [],
    glances: [],
    ...(sequence !== undefined ? { sequence } : {}),
  };
}

function fleet(changedAt: number): FleetSnapshot {
  return { runs: [], changedAt, degraded: false, lastSuccessfulAt: changedAt };
}

function emit(event: CanopyHostEvent) {
  act(() => {
    for (const listener of [...bridge.listeners]) listener(event);
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  bridge.invoke.mockImplementation(async (_hostId: string, channel: string) =>
    channel === "fleet:get-snapshot" ? fleet(1) : canopy(1, 1)
  );
});

afterEach(() => {
  // Unmounted before the mocks are cleared, so a hook's release lands in its own test.
  cleanup();
  bridge.listeners.clear();
  vi.clearAllMocks();
});

describe("useRemoteCanopy", () => {
  it("reads nothing for the window's own host, or while the panel is closed", () => {
    renderHook(() => useRemoteCanopy(null, true));
    renderHook(() => useRemoteCanopy("studio", false));
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it("opens the panel on the host and reads its agents there", async () => {
    const { result } = renderHook(() => useRemoteCanopy("studio", true));
    await settle();
    expect(bridge.invoke).toHaveBeenCalledWith("studio", "canopy:set-active", true);
    expect(bridge.invoke).toHaveBeenCalledWith("studio", "fleet:get-snapshot");
    expect(result.current.canopy?.refreshedAt).toBe(1);
    expect(result.current.fleet?.changedAt).toBe(1);
  });

  it("takes only its own host's pushes, and never an older snapshot after a newer one", async () => {
    const { result } = renderHook(() => useRemoteCanopy("studio", true));
    await settle();
    emit({ kind: "canopy-snapshot", hostId: "other", snapshot: canopy(99, 9) });
    expect(result.current.canopy?.refreshedAt).toBe(1);
    emit({ kind: "canopy-snapshot", hostId: "studio", snapshot: canopy(5, 5) });
    emit({ kind: "canopy-snapshot", hostId: "studio", snapshot: canopy(4, 4) });
    expect(result.current.canopy?.refreshedAt).toBe(5);
  });

  it("says why a host can't be read, and reads again once its link comes back", async () => {
    const unreachable = Object.assign(new Error("Host studio is not connected"), {
      code: "HOST_DISCONNECTED",
    });
    bridge.invoke.mockRejectedValue(unreachable);
    const { result } = renderHook(() => useRemoteCanopy("studio", true));
    await settle();
    expect(result.current.error).toBe(unreachable);
    expect(result.current.canopy).toBeNull();

    bridge.invoke.mockImplementation(async (_hostId: string, channel: string) =>
      // A host that came back counts its snapshots from the start again.
      channel === "fleet:get-snapshot" ? fleet(2) : canopy(2, 0)
    );
    emit({ kind: "resync", hostId: "studio" });
    await settle();
    expect(result.current.error).toBeNull();
    expect(result.current.canopy?.refreshedAt).toBe(2);
    expect(result.current.epoch).toBe(1);
  });

  it("keeps a fleet push over the answer to a pull that began before it", async () => {
    let answer: (snapshot: FleetSnapshot) => void = () => {};
    bridge.invoke.mockImplementation((_hostId: string, channel: string) =>
      channel === "fleet:get-snapshot"
        ? new Promise<FleetSnapshot>((resolve) => (answer = resolve))
        : Promise.resolve(canopy(1, 1))
    );
    const { result } = renderHook(() => useRemoteCanopy("studio", true));
    emit({ kind: "fleet-snapshot", hostId: "studio", snapshot: fleet(7) });
    answer(fleet(3));
    await settle();
    expect(result.current.fleet?.changedAt).toBe(7);
  });

  it("releases the host it stops showing, and drops what it answers afterwards", async () => {
    let answer: (snapshot: CanopySnapshot) => void = () => {};
    bridge.invoke.mockImplementation((_hostId: string, channel: string) =>
      channel === "canopy:set-active"
        ? new Promise<CanopySnapshot>((resolve) => (answer = resolve))
        : Promise.resolve(fleet(1))
    );
    const { result, rerender } = renderHook(({ hostId }) => useRemoteCanopy(hostId, true), {
      initialProps: { hostId: "studio" as string | null },
    });
    const studioAnswer = answer;
    rerender({ hostId: "lab" });
    expect(bridge.release).toHaveBeenCalledWith("studio");
    studioAnswer(canopy(42, 42));
    await settle();
    expect(result.current.canopy?.refreshedAt).not.toBe(42);
  });
});

describe("useRemoteCanopy, trying again", () => {
  it("reads again on the viewer it has, and says the panel's state there again", async () => {
    const { result } = renderHook(() => useRemoteCanopy("studio", true));
    await settle();
    bridge.invoke.mockClear();
    act(() => result.current.retry());
    await settle();
    // The host still holds what this panel told it: no new viewer to tell from scratch.
    expect(bridge.release).not.toHaveBeenCalled();
    expect(bridge.invoke).toHaveBeenCalledWith("studio", "canopy:set-active", true);
    expect(result.current.epoch).toBe(1);
  });

  it("keeps one read's failure while the other read lands", async () => {
    const refused = new Error("Canopy refused");
    bridge.invoke.mockImplementation(async (_hostId: string, channel: string) => {
      if (channel === "canopy:set-active") throw refused;
      return fleet(1);
    });
    const { result } = renderHook(() => useRemoteCanopy("studio", true));
    await settle();
    expect(result.current.fleet?.changedAt).toBe(1);
    expect(result.current.error).toBe(refused);
    emit({ kind: "fleet-snapshot", hostId: "studio", snapshot: fleet(2) });
    expect(result.current.error).toBe(refused);
  });

  it("drops a read answered after the link came back and was read again", async () => {
    const answers: Array<(snapshot: FleetSnapshot) => void> = [];
    bridge.invoke.mockImplementation((_hostId: string, channel: string) =>
      channel === "fleet:get-snapshot"
        ? new Promise<FleetSnapshot>((resolve) => answers.push(resolve))
        : Promise.resolve(canopy(1, 1))
    );
    const { result } = renderHook(() => useRemoteCanopy("studio", true));
    emit({ kind: "resync", hostId: "studio" });
    answers[1]!(fleet(9));
    await settle();
    answers[0]!(fleet(3));
    await settle();
    expect(result.current.fleet?.changedAt).toBe(9);
  });
});

describe("remoteCanopyApi", () => {
  it("sends each inbox action to the host it was made for", async () => {
    const api = remoteCanopyApi("studio");
    await api.archive("run-1", { spawnedAt: 5 });
    await api.setRead("run-1", { spawnedAt: 5 }, true, 2);
    await api.runBranch("run-1", { spawnedAt: 5 });
    await api.rename("run-1", { spawnedAt: 5 }, "auth fix");
    await api.trash("run-1", { spawnedAt: 5 });
    await api.untrash(7);
    expect(bridge.invoke.mock.calls).toEqual([
      ["studio", "canopy:archive", "run-1", { spawnedAt: 5 }],
      ["studio", "canopy:set-read", "run-1", { spawnedAt: 5 }, true, 2],
      ["studio", "canopy:run-branch", "run-1", { spawnedAt: 5 }],
      ["studio", "canopy:rename", "run-1", { spawnedAt: 5 }, "auth fix"],
      ["studio", "canopy:trash", "run-1", { spawnedAt: 5 }],
      ["studio", "canopy:untrash", 7],
    ]);
  });
});
