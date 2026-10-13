// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingHostSwitch, RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";

const m = vi.hoisted(() => ({ notify: vi.fn((_payload: unknown) => "toast-1") }));
vi.mock("@/lib/notify", () => ({ notify: m.notify }));

import { useNotificationStore } from "@/store/notificationStore";
import { usePendingHostSwitchStore } from "@/store/pendingHostSwitchStore";
import { pendingHostSwitchTitle, watchPendingHostSwitch } from "../pendingHostSwitchFeedback";

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
    cancelPendingSwitch: vi.fn(async () => true),
  };
  const stop = watchPendingHostSwitch(api);
  const send = (next: PendingHostSwitch | null) =>
    listener?.({ type: "switch-pending", pending: next });
  return { api, stop, send };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

type NotifyCall = {
  title: string;
  message: string;
  actions: Array<{ label: string; onClick: () => void }>;
};

let update: ReturnType<typeof vi.fn<(id: string, patch: Record<string, unknown>) => void>>;
let dismiss: ReturnType<typeof vi.fn<(id: string) => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  m.notify.mockClear();
  update = vi.fn<(id: string, patch: Record<string, unknown>) => void>();
  dismiss = vi.fn<(id: string) => void>();
  useNotificationStore.setState({ updateNotification: update, dismissNotification: dismiss });
  usePendingHostSwitchStore.setState({ pending: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pendingHostSwitchTitle", () => {
  it("says what the switch is waiting on", () => {
    expect(pendingHostSwitchTitle(pending())).toBe("Connecting to studio-02…");
    expect(pendingHostSwitchTitle(pending({ phase: "starting" }))).toBe(
      "Starting Daintree on studio-02…"
    );
    expect(pendingHostSwitchTitle(pending({ phase: "opening", projectName: "api" }))).toBe(
      "Opening api on studio-02…"
    );
    expect(pendingHostSwitchTitle(pending({ phase: "opening" }))).toBe("Opening studio-02…");
  });
});

describe("watchPendingHostSwitch", () => {
  it("shows nothing for a switch that lands inside the loading gate", () => {
    const { send, stop } = harness();
    send(pending());
    vi.advanceTimersByTime(300);
    send(null);
    vi.advanceTimersByTime(10_000);

    expect(m.notify).not.toHaveBeenCalled();
    stop();
  });

  it("shows one progress notice for a slow switch, follows its phase and withdraws it when it ends", () => {
    const { send, stop } = harness();
    send(pending());
    vi.advanceTimersByTime(400);

    expect(m.notify).toHaveBeenCalledTimes(1);
    const shown = m.notify.mock.calls[0]![0] as NotifyCall;
    expect(shown.title).toBe("Connecting to studio-02…");
    expect(shown.actions.map((action) => action.label)).toEqual(["Cancel"]);

    send(pending({ phase: "opening", projectName: "api" }));
    expect(update).toHaveBeenLastCalledWith(
      "toast-1",
      expect.objectContaining({ title: "Opening api on studio-02…" })
    );
    expect(m.notify).toHaveBeenCalledTimes(1);

    send(null);
    expect(dismiss).toHaveBeenCalledWith("toast-1");
    stop();
  });

  it("adds Still working… once the wait passes five seconds", () => {
    const { send, stop } = harness();
    send(pending());
    vi.advanceTimersByTime(4_900);
    expect(update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(update).toHaveBeenLastCalledWith("toast-1", { message: "Still working…" });
    stop();
  });

  it("cancels the switch it was shown for", () => {
    const { api, send, stop } = harness();
    send(pending({ switchId: "sw-7" }));
    vi.advanceTimersByTime(400);

    (m.notify.mock.calls[0]![0] as NotifyCall).actions[0]!.onClick();
    expect(api.cancelPendingSwitch).toHaveBeenCalledWith({ switchId: "sw-7" });
    stop();
  });

  it("starts over for a newer switch rather than relabelling the old notice", () => {
    const { send, stop } = harness();
    send(pending({ switchId: "sw-1" }));
    vi.advanceTimersByTime(400);
    send(pending({ switchId: "sw-2", hostName: "studio-03" }));

    expect(dismiss).toHaveBeenCalledWith("toast-1");
    vi.advanceTimersByTime(400);
    expect(m.notify).toHaveBeenCalledTimes(2);
    expect((m.notify.mock.calls[1]![0] as NotifyCall).title).toBe("Connecting to studio-03…");
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

  it("shows a notice held back in the background once the window is looked at again", () => {
    const { send, stop } = harness();
    m.notify.mockReturnValueOnce("");
    send(pending());
    vi.advanceTimersByTime(400);
    expect(m.notify).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    expect(m.notify).toHaveBeenCalledTimes(2);
    stop();
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

  it("doesn't show early, or twice, when the window is looked at again before the gate", () => {
    const { send, stop } = harness();
    send(pending());
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event("focus"));
    expect(m.notify).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    window.dispatchEvent(new Event("focus"));
    expect(m.notify).toHaveBeenCalledTimes(1);

    send(null);
    expect(dismiss).toHaveBeenCalledWith("toast-1");
    stop();
  });
});
