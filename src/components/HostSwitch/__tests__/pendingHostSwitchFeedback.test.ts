// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingHostSwitch, RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";

const m = vi.hoisted(() => ({ notify: vi.fn((_payload: unknown) => "toast-1") }));
vi.mock("@/lib/notify", () => ({ notify: m.notify }));

import { usePendingHostSwitchStore } from "@/store/pendingHostSwitchStore";
import { pendingHostSwitchTitle, watchPendingHostSwitch } from "../pendingHostSwitchFeedback";
import {
  _resetTerminalInputGateForTesting,
  isHostSwitchPending,
} from "@/services/terminal/inputGate";

function pending(overrides: Partial<PendingHostSwitch> = {}): PendingHostSwitch {
  return {
    switchId: "sw-1",
    hostId: "studio-02",
    hostName: "studio-02",
    projectName: null,
    phase: "connecting",
    ...overrides,
  };
}

function harness(snapshot: PendingHostSwitch | null = null) {
  let listener: ((event: RemoteHostsEvent) => void) | null = null;
  const api = {
    onEvent: vi.fn((callback: (event: RemoteHostsEvent) => void) => {
      listener = callback;
      return () => void (listener = null);
    }),
    getPendingSwitch: vi.fn(async () => snapshot),
  };
  const stop = watchPendingHostSwitch(api);
  const send = (next: PendingHostSwitch | null) =>
    listener?.({ type: "switch-pending", pending: next });
  return { api, stop, send };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  m.notify.mockClear();
  usePendingHostSwitchStore.setState({ pending: null });
});

afterEach(() => {
  _resetTerminalInputGateForTesting();
});

describe("pendingHostSwitchTitle", () => {
  it("says what the switch is waiting on, or that it gave up", () => {
    expect(pendingHostSwitchTitle(pending())).toBe("Connecting to studio-02…");
    expect(pendingHostSwitchTitle(pending({ phase: "starting" }))).toBe(
      "Starting Daintree on studio-02…"
    );
    expect(pendingHostSwitchTitle(pending({ phase: "opening", projectName: "api" }))).toBe(
      "Opening api on studio-02…"
    );
    expect(pendingHostSwitchTitle(pending({ phase: "opening" }))).toBe("Opening studio-02…");
    expect(pendingHostSwitchTitle(pending({ phase: "failed" }))).toBe(
      "Couldn't switch to studio-02"
    );
  });
});

describe("watchPendingHostSwitch", () => {
  it("follows the window's switch into the store, and never raises a notice for it", () => {
    const { send, stop } = harness();
    send(pending());
    expect(usePendingHostSwitchStore.getState().pending?.phase).toBe("connecting");
    send(pending({ phase: "failed", failure: { code: "HOST_DISCONNECTED", message: "down" } }));
    expect(usePendingHostSwitchStore.getState().pending?.phase).toBe("failed");
    send(null);
    expect(usePendingHostSwitchStore.getState().pending).toBeNull();
    expect(m.notify).not.toHaveBeenCalled();
    stop();
  });

  it("picks up a switch already under way when the view mounts, unless an event came first", async () => {
    const first = harness(pending({ switchId: "sw-9" }));
    await flushMicrotasks();
    expect(usePendingHostSwitchStore.getState().pending?.switchId).toBe("sw-9");
    first.stop();
    expect(usePendingHostSwitchStore.getState().pending).toBeNull();

    const second = harness(pending({ switchId: "stale" }));
    second.send(null);
    await flushMicrotasks();
    expect(usePendingHostSwitchStore.getState().pending).toBeNull();
    second.stop();
  });

  it("keeps typing held from the first moment until the switch clears, committed or failed", () => {
    const { send, stop } = harness();
    send(pending({ phase: "opening", projectName: "api" }));
    expect(isHostSwitchPending()).toBe(true);
    send(pending({ phase: "opening", projectName: "api", committed: true }));
    expect(isHostSwitchPending()).toBe(true);
    send(pending({ phase: "failed" }));
    expect(isHostSwitchPending()).toBe(true);

    send(null);
    expect(isHostSwitchPending()).toBe(false);
    stop();
  });

  it("asks again when a cached view is shown, so a switch that ended while it was parked lets go", async () => {
    let revealed: (() => void) | null = null;
    let answer: PendingHostSwitch | null = pending();
    const api = {
      onEvent: vi.fn(() => () => {}),
      getPendingSwitch: vi.fn(async () => answer),
    };
    const stop = watchPendingHostSwitch(api, {
      onViewRevealed: (callback) => {
        revealed = callback;
        return () => void (revealed = null);
      },
    });
    await flushMicrotasks();
    expect(isHostSwitchPending()).toBe(true);

    answer = null;
    revealed!();
    await flushMicrotasks();
    expect(api.getPendingSwitch).toHaveBeenCalledTimes(2);
    expect(usePendingHostSwitchStore.getState().pending).toBeNull();
    expect(isHostSwitchPending()).toBe(false);
    stop();
    expect(revealed).toBeNull();
  });

  it("lets go of the switch when the view is cached, so the view a switch left never blocks its sends", async () => {
    let listener: ((event: RemoteHostsEvent) => void) | null = null;
    let cached: (() => void) | null = null;
    let revealed: (() => void) | null = null;
    let answer!: (pending: PendingHostSwitch | null) => void;
    const api = {
      onEvent: vi.fn((callback: (event: RemoteHostsEvent) => void) => {
        listener = callback;
        return () => void (listener = null);
      }),
      getPendingSwitch: vi.fn(
        () => new Promise<PendingHostSwitch | null>((resolve) => (answer = resolve))
      ),
    };
    const stop = watchPendingHostSwitch(api, {
      onViewRevealed: (callback) => {
        revealed = callback;
        return () => void (revealed = null);
      },
      onViewCached: (callback) => {
        cached = callback;
        return () => void (cached = null);
      },
    });
    listener!({ type: "switch-pending", pending: pending({ hostName: "studio-03" }) });
    expect(isHostSwitchPending()).toBe(true);

    // Shown, asks, and is cached before the answer comes back.
    revealed!();
    cached!();
    expect(usePendingHostSwitchStore.getState().pending).toBeNull();
    expect(isHostSwitchPending()).toBe(false);
    answer(pending({ hostName: "studio-03" }));
    await flushMicrotasks();
    expect(isHostSwitchPending()).toBe(false);

    stop();
    expect(cached).toBeNull();
  });

  it("ignores a snapshot that answers after it was torn down", async () => {
    let answer!: (pending: PendingHostSwitch | null) => void;
    const api = {
      onEvent: vi.fn(() => () => {}),
      getPendingSwitch: vi.fn(
        () => new Promise<PendingHostSwitch | null>((resolve) => (answer = resolve))
      ),
    };
    const stop = watchPendingHostSwitch(api);
    stop();
    answer(pending({ switchId: "late" }));
    await flushMicrotasks();

    expect(usePendingHostSwitchStore.getState().pending).toBeNull();
  });
});
