/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import type { PluginCapabilityConsentRequestEvent } from "@shared/types/pluginCapabilityConsent";

import { usePluginCapabilityConsentBridge } from "../usePluginCapabilityConsentBridge";
import {
  usePluginCapabilityConfirmStore,
  __resetPluginCapabilityConfirmStoreForTesting,
} from "@/store/pluginCapabilityConfirmStore";

type Listener = (payload: PluginCapabilityConsentRequestEvent) => void;

function Harness() {
  usePluginCapabilityConsentBridge();
  return null;
}

function request(requestId: string): PluginCapabilityConsentRequestEvent {
  return {
    requestId,
    pluginId: "acme.x",
    pluginDisplayName: "Acme",
    capability: "fs:project-write",
    declaredCapabilities: ["fs:project-write"],
  };
}

let listener: Listener | null = null;
let unsubscribe: ReturnType<typeof vi.fn>;
let acknowledgeConsent: ReturnType<typeof vi.fn>;
let resolveConsent: ReturnType<typeof vi.fn>;
/** What the store held at the moment each acknowledgement was sent. */
let queuedAtAck: Array<string | undefined>;

beforeEach(() => {
  listener = null;
  queuedAtAck = [];
  unsubscribe = vi.fn();
  acknowledgeConsent = vi.fn(() => {
    queuedAtAck.push(usePluginCapabilityConfirmStore.getState().current?.requestId);
    return Promise.resolve();
  });
  resolveConsent = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      events: {
        on: vi.fn((name: string, cb: Listener) => {
          if (name === "plugin-capability:consent-request") listener = cb;
          return unsubscribe;
        }),
      },
      pluginCapability: { acknowledgeConsent, resolveConsent },
    },
  });
});

afterEach(() => {
  cleanup();
  __resetPluginCapabilityConfirmStoreForTesting();
  vi.restoreAllMocks();
});

describe("usePluginCapabilityConsentBridge", () => {
  it("acknowledges receipt only after the prompt is queued for display (#11708)", async () => {
    render(<Harness />);
    act(() => listener!(request("req-1")));

    // Main takes the acknowledgement as proof the prompt is displayable, so it
    // must not be sent before the dialog store actually owns the request.
    expect(acknowledgeConsent).toHaveBeenCalledTimes(1);
    expect(acknowledgeConsent).toHaveBeenCalledWith({ requestId: "req-1" });
    expect(queuedAtAck).toEqual(["req-1"]);
  });

  it("forwards the user's decision back to main", async () => {
    render(<Harness />);
    act(() => listener!(request("req-1")));

    act(() => usePluginCapabilityConfirmStore.getState().resolveCurrent("approved-and-pin"));

    await waitFor(() =>
      expect(resolveConsent).toHaveBeenCalledWith({
        requestId: "req-1",
        decision: "approved-and-pin",
      })
    );
  });

  it("re-acknowledges a re-pushed prompt instead of queueing it twice (#11708)", async () => {
    render(<Harness />);
    act(() => listener!(request("req-1")));
    // Main re-pushes an unacknowledged prompt, so a re-push can cross the
    // acknowledgement on the wire and arrive for a request already queued.
    act(() => listener!(request("req-1")));

    expect(acknowledgeConsent).toHaveBeenCalledTimes(2);

    // Exactly one dialog: the second push must not enqueue a duplicate.
    const { current, queue } = usePluginCapabilityConfirmStore.getState();
    expect(current?.requestId).toBe("req-1");
    expect(queue).toHaveLength(0);

    // And critically, nothing was resolved. Re-enqueueing would hit the store's
    // duplicate guard, which resolves "rejected" — surfacing to the plugin as a
    // denial the user never made, which is the bug this whole path fixes.
    expect(resolveConsent).not.toHaveBeenCalled();

    act(() => usePluginCapabilityConfirmStore.getState().resolveCurrent("approved-once"));
    await waitFor(() =>
      expect(resolveConsent).toHaveBeenCalledWith({ requestId: "req-1", decision: "approved-once" })
    );
    expect(resolveConsent).toHaveBeenCalledTimes(1);
  });

  it("queues a genuinely different prompt rather than de-duplicating it", async () => {
    render(<Harness />);
    act(() => listener!(request("req-1")));
    act(() => listener!(request("req-2")));

    const { current, queue } = usePluginCapabilityConfirmStore.getState();
    expect(current?.requestId).toBe("req-1");
    expect(queue.map((item) => item.requestId)).toEqual(["req-2"]);
    expect(acknowledgeConsent).toHaveBeenCalledTimes(2);
  });

  it("ignores a re-push that arrives after the user already answered (#11708)", async () => {
    render(<Harness />);
    act(() => listener!(request("req-1")));
    act(() => usePluginCapabilityConfirmStore.getState().resolveCurrent("approved-once"));
    await waitFor(() => expect(resolveConsent).toHaveBeenCalled());

    // A retry main had already put on the wire before it settled. Both this
    // hook's record and the store's resolver are gone by now, so nothing but
    // the retained id stops it becoming a fresh dialog for a dead request —
    // one the consent dialog would refuse to act on twice, stranding it.
    act(() => listener!(request("req-1")));

    expect(usePluginCapabilityConfirmStore.getState().current).toBeNull();
    expect(usePluginCapabilityConfirmStore.getState().queue).toHaveLength(0);
    expect(resolveConsent).toHaveBeenCalledTimes(1);
  });

  it("survives a remount with a prompt still in flight (#11708)", async () => {
    const { unmount } = render(<Harness />);
    act(() => listener!(request("req-1")));
    unmount();

    // The dedupe Set dies with the effect, but the store's resolver map does
    // not — so a re-push after a remount reaches a store that already knows the
    // request. It must share that prompt, not treat it as a collision and
    // resolve "rejected", which would reach the plugin as a phantom denial.
    render(<Harness />);
    act(() => listener!(request("req-1")));

    expect(resolveConsent).not.toHaveBeenCalled();
    expect(usePluginCapabilityConfirmStore.getState().queue).toHaveLength(0);

    act(() => usePluginCapabilityConfirmStore.getState().resolveCurrent("approved-and-pin"));
    await waitFor(() =>
      expect(resolveConsent).toHaveBeenCalledWith({
        requestId: "req-1",
        decision: "approved-and-pin",
      })
    );
  });

  it("handles a rejected reply IPC instead of leaking an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    acknowledgeConsent.mockRejectedValue(new Error("channel gone"));
    resolveConsent.mockRejectedValue(new Error("channel gone"));

    render(<Harness />);
    act(() => listener!(request("req-1")));
    act(() => usePluginCapabilityConfirmStore.getState().resolveCurrent("approved-once"));

    // Both replies are fire-and-forget; a teardown-time rejection on either must
    // be consumed rather than surfacing as an unrelated renderer error.
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("failed to acknowledge"),
        expect.stringContaining("failed to deliver decision"),
      ])
    );
  });

  it("unsubscribes from the push on unmount", () => {
    const { unmount } = render(<Harness />);
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
