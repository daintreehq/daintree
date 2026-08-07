// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These tests model Daintree's BrowserWindow/WebContentsView split, which the
 * pre-#11708 fixture did not: it returned a single `{ webContents }` object, so
 * "the window's webContents" and "the renderer running the app" were the same
 * object by construction and the routing bug could not be expressed, let alone
 * caught. Worse, `getAppWebContents()` falls back to `win.webContents` when no
 * app view is registered, so a fixture that skips registration passes
 * identically before and after the fix.
 *
 * So: a distinct shell WebContents and app-view WebContents, wired through the
 * REAL `webContentsRegistry`. Asserting the shell is never sent to is what makes
 * these tests fail against the old implementation.
 */

interface FakeWebContents extends EventEmitter {
  id: number;
  destroyed: boolean;
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
  destroy: () => void;
}

let nextWebContentsId = 100;

function makeWebContents(): FakeWebContents {
  const wc = new EventEmitter() as FakeWebContents;
  wc.id = nextWebContentsId++;
  wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed;
  wc.send = vi.fn();
  wc.destroy = () => {
    wc.destroyed = true;
    wc.emit("destroyed");
  };
  return wc;
}

interface Harness {
  win: { id: number; webContents: FakeWebContents; isDestroyed: () => boolean };
  /** The BrowserWindow's own renderer — `about:blank`, no preload, no listener. */
  shellWebContents: FakeWebContents;
  /** The WebContentsView actually running the React app. */
  appView: { webContents: FakeWebContents };
  appWebContents: FakeWebContents;
}

let nextWindowId = 1;

function makeHarness(): Harness {
  const shellWebContents = makeWebContents();
  const appWebContents = makeWebContents();
  return {
    win: { id: nextWindowId++, webContents: shellWebContents, isDestroyed: () => false },
    shellWebContents,
    appView: { webContents: appWebContents },
    appWebContents,
  };
}

let harness: Harness | null = null;

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((key: string) => `/mock/electron/${key}`),
    getVersion: vi.fn(() => "0.0.0"),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: {
    getFocusedWindow: () => harness?.win ?? null,
    getAllWindows: () => (harness ? [harness.win] : []),
    fromWebContents: () => null,
  },
  // The real webContentsRegistry imports both of these at module scope.
  WebContentsView: vi.fn(),
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock("../../../window/windowRef.js", () => ({
  getMainWindow: () => harness?.win ?? null,
}));

import {
  handleAcknowledgeConsent,
  handleResolveConsent,
  registerPluginCapabilityHandlers,
  _resetCapabilityConsentBridgeForTest,
} from "../pluginCapability.js";
import { registerAppView, unregisterAppView } from "../../../window/webContentsRegistry.js";
import {
  getPluginCapabilityConsentService,
  _resetPluginCapabilityServicesForTest,
} from "../../../services/plugin-capability/instances.js";
import {
  PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS,
  PLUGIN_CAPABILITY_CONSENT_RESEND_INTERVAL_MS,
  PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS,
} from "../../../../shared/types/pluginCapabilityConsent.js";
import type { IpcContext } from "../../types.js";

function ctx(webContentsId: number): IpcContext {
  return { event: {} as never, webContentsId, senderWindow: null, projectId: null };
}

/** Start a gated call and capture its settlement without an unhandled rejection. */
function startGatedCall(): Promise<{ ok: true } | { ok: false; err: Error }> {
  return getPluginCapabilityConsentService()
    .ensureAllowed("acme.x", "Acme", "shell:exec", ["shell:exec"])
    .then(
      () => ({ ok: true }) as const,
      (err: Error) => ({ ok: false, err }) as const
    );
}

/** The requestId of the Nth push made to a given WebContents. */
function pushedRequestId(wc: FakeWebContents, callIndex = 0): string {
  const call = wc.send.mock.calls[callIndex] as [string, { payload: { requestId: string } }];
  return call[1].payload.requestId;
}

beforeEach(() => {
  harness = makeHarness();
  registerAppView(harness.win as never, harness.appView as never);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  getPluginCapabilityConsentService();
});

afterEach(() => {
  _resetCapabilityConsentBridgeForTest();
  _resetPluginCapabilityServicesForTest();
  if (harness) unregisterAppView(harness.win as never);
  harness = null;
  vi.restoreAllMocks();
});

describe("pluginCapability consent bridge — routing (#11708)", () => {
  it("pushes the prompt to the app view's renderer, never the BrowserWindow shell", async () => {
    const dispose = registerPluginCapabilityHandlers();
    const settled = startGatedCall();

    // The app renderer got it...
    expect(harness!.appWebContents.send).toHaveBeenCalledTimes(1);
    const pushed = harness!.appWebContents.send.mock.calls[0][1] as {
      name: string;
      payload: { requestId: string; capability: string };
    };
    expect(pushed.name).toBe("plugin-capability:consent-request");
    expect(pushed.payload.capability).toBe("shell:exec");

    // ...and the shell — an `about:blank` document with no preload bridge — did
    // not. This is the assertion that fails against the pre-#11708 code.
    expect(harness!.shellWebContents.send).not.toHaveBeenCalled();

    await handleAcknowledgeConsent(ctx(harness!.appWebContents.id), {
      requestId: pushed.payload.requestId,
    });
    await handleResolveConsent(ctx(harness!.appWebContents.id), {
      requestId: pushed.payload.requestId,
      decision: "approved-once",
    });
    await expect(settled).resolves.toEqual({ ok: true });

    dispose();
  });

  it("pins the response to the app view, so the shell's id cannot answer", async () => {
    const dispose = registerPluginCapabilityHandlers();
    const settled = startGatedCall();
    const requestId = pushedRequestId(harness!.appWebContents);

    // The shell webContents is a real, live WebContents in production — it just
    // isn't the one holding the dialog. It must not be able to approve.
    await handleAcknowledgeConsent(ctx(harness!.shellWebContents.id), { requestId });
    await handleResolveConsent(ctx(harness!.shellWebContents.id), {
      requestId,
      decision: "approved-and-pin",
    });

    await handleResolveConsent(ctx(harness!.appWebContents.id), {
      requestId,
      decision: "rejected",
    });
    const outcome = await settled;
    expect(outcome.ok).toBe(false);

    dispose();
  });
});

describe("pluginCapability consent bridge — delivery acknowledgement (#11708)", () => {
  it("settles undeliverable well before the decision timeout when nothing acknowledges", async () => {
    vi.useFakeTimers();
    try {
      const dispose = registerPluginCapabilityHandlers();
      const settled = startGatedCall();

      await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS);

      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        // Fails closed, but does not claim the user refused.
        expect(outcome.err.message).toContain("PERMISSION_REQUIRED");
        expect(outcome.err.message).toContain("could not present");
        expect(outcome.err.message).not.toContain("was denied");
      }

      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on delivery far sooner than the five-minute decision window", () => {
    // The original bug held the plugin for the full decision timeout before
    // reporting a denial. Delivery failure must be detected in a fraction of it.
    expect(PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS).toBeLessThan(
      PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS / 10
    );
    expect(PLUGIN_CAPABILITY_CONSENT_RESEND_INTERVAL_MS).toBeLessThan(
      PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS
    );
  });

  it("re-pushes an unacknowledged prompt, then stops once it is acknowledged", async () => {
    vi.useFakeTimers();
    try {
      const dispose = registerPluginCapabilityHandlers();
      const settled = startGatedCall();
      const requestId = pushedRequestId(harness!.appWebContents);

      expect(harness!.appWebContents.send).toHaveBeenCalledTimes(1);

      // A renderer mid-cold-start isn't listening yet; the re-push is what lets
      // it receive the prompt once React mounts instead of losing it.
      await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_RESEND_INTERVAL_MS);
      expect(harness!.appWebContents.send).toHaveBeenCalledTimes(2);
      // Same request, not a second dialog.
      expect(pushedRequestId(harness!.appWebContents, 1)).toBe(requestId);

      await handleAcknowledgeConsent(ctx(harness!.appWebContents.id), { requestId });

      const callsAtAck = harness!.appWebContents.send.mock.calls.length;
      await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_RESEND_INTERVAL_MS * 3);
      expect(harness!.appWebContents.send).toHaveBeenCalledTimes(callsAtAck);

      await handleResolveConsent(ctx(harness!.appWebContents.id), {
        requestId,
        decision: "approved-once",
      });
      await expect(settled).resolves.toEqual({ ok: true });

      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the five-minute decision clock only after acknowledgement", async () => {
    vi.useFakeTimers();
    try {
      const dispose = registerPluginCapabilityHandlers();
      const settled = startGatedCall();
      const requestId = pushedRequestId(harness!.appWebContents);

      // Acknowledge late — the user's full decision window should start here,
      // not at push time, so a slow delivery doesn't eat into their time.
      await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_RESEND_INTERVAL_MS);
      await handleAcknowledgeConsent(ctx(harness!.appWebContents.id), { requestId });

      await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS - 1);
      await handleResolveConsent(ctx(harness!.appWebContents.id), {
        requestId,
        decision: "approved-and-pin",
      });

      await expect(settled).resolves.toEqual({ ok: true });
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an acknowledged-but-unanswered prompt as a timeout, not a denial", async () => {
    vi.useFakeTimers();
    try {
      const dispose = registerPluginCapabilityHandlers();
      const settled = startGatedCall();
      const requestId = pushedRequestId(harness!.appWebContents);

      await handleAcknowledgeConsent(ctx(harness!.appWebContents.id), { requestId });
      await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS);

      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.err.message).toContain("timed out");
        expect(outcome.err.message).not.toContain("was denied");
        expect(outcome.err.message).not.toContain("could not present");
      }

      // A reply arriving after the request is gone is a no-op.
      await handleResolveConsent(ctx(harness!.appWebContents.id), {
        requestId,
        decision: "approved-and-pin",
      });

      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an acknowledgement from a different sender and still fails delivery", async () => {
    vi.useFakeTimers();
    try {
      const dispose = registerPluginCapabilityHandlers();
      const settled = startGatedCall();
      const requestId = pushedRequestId(harness!.appWebContents);

      // A sibling renderer must not be able to vouch for delivery on behalf of
      // the renderer that was actually targeted.
      await handleAcknowledgeConsent(ctx(9999), { requestId });
      await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS);

      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.err.message).toContain("could not present");

      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a decision arriving before the acknowledgement as proof of delivery", async () => {
    vi.useFakeTimers();
    try {
      const dispose = registerPluginCapabilityHandlers();
      const settled = startGatedCall();
      const requestId = pushedRequestId(harness!.appWebContents);

      // The reply itself proves the prompt was displayed and answered, so it
      // must settle rather than being overtaken by the delivery deadline.
      await handleResolveConsent(ctx(harness!.appWebContents.id), {
        requestId,
        decision: "approved-once",
      });
      await expect(settled).resolves.toEqual({ ok: true });

      // The delivery timer was disarmed with everything else.
      await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS * 2);
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pluginCapability consent bridge — unpromptable states (#11708)", () => {
  it("fails fast as undeliverable when there is no window to prompt in", async () => {
    const dispose = registerPluginCapabilityHandlers();
    unregisterAppView(harness!.win as never);
    const saved = harness;
    harness = null; // no focused window, no primary window

    const outcome = await startGatedCall();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.err.message).toContain("could not present");
      expect(outcome.err.message).not.toContain("was denied");
    }

    harness = saved;
    dispose();
  });

  it("fails as undeliverable when the push itself throws", async () => {
    const dispose = registerPluginCapabilityHandlers();
    harness!.appWebContents.send.mockImplementation(() => {
      throw new Error("render frame was disposed");
    });

    const outcome = await startGatedCall();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err.message).toContain("could not present");

    dispose();
  });

  it("fails as undeliverable when the target renderer is destroyed before acknowledging", async () => {
    const dispose = registerPluginCapabilityHandlers();
    const settled = startGatedCall();

    harness!.appWebContents.destroy();

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err.message).toContain("could not present");

    dispose();
  });

  it("fails as undeliverable when the renderer is destroyed after acknowledging", async () => {
    const dispose = registerPluginCapabilityHandlers();
    const settled = startGatedCall();
    const requestId = pushedRequestId(harness!.appWebContents);

    await handleAcknowledgeConsent(ctx(harness!.appWebContents.id), { requestId });
    // The dialog the user was looking at went away with the renderer — they
    // never answered it, so this is still not a denial.
    harness!.appWebContents.destroy();

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err.message).toContain("could not present");

    dispose();
  });

  it("settles pending prompts as undeliverable when the handlers are torn down", async () => {
    const dispose = registerPluginCapabilityHandlers();
    const settled = startGatedCall();

    dispose();

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err.message).toContain("could not present");
  });
});

describe("pluginCapability consent bridge — decisions", () => {
  it("persists the grant on approve-and-pin so a second call never prompts", async () => {
    const dispose = registerPluginCapabilityHandlers();
    const first = startGatedCall();
    const requestId = pushedRequestId(harness!.appWebContents);

    await handleAcknowledgeConsent(ctx(harness!.appWebContents.id), { requestId });
    await handleResolveConsent(ctx(harness!.appWebContents.id), {
      requestId,
      decision: "approved-and-pin",
    });
    await expect(first).resolves.toEqual({ ok: true });

    const pushesAfterGrant = harness!.appWebContents.send.mock.calls.length;
    await expect(startGatedCall()).resolves.toEqual({ ok: true });
    expect(harness!.appWebContents.send).toHaveBeenCalledTimes(pushesAfterGrant);

    dispose();
  });

  it("still says the plugin was denied when the user actually rejects", async () => {
    const dispose = registerPluginCapabilityHandlers();
    const settled = startGatedCall();
    const requestId = pushedRequestId(harness!.appWebContents);

    await handleAcknowledgeConsent(ctx(harness!.appWebContents.id), { requestId });
    await handleResolveConsent(ctx(harness!.appWebContents.id), {
      requestId,
      decision: "rejected",
    });

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.err.message).toContain("was denied");
      expect(outcome.err.message).not.toContain("could not present");
      expect(outcome.err.message).not.toContain("timed out");
    }

    dispose();
  });

  it("is a no-op for an unknown requestId on both reply channels", async () => {
    await expect(
      handleResolveConsent(ctx(harness!.appWebContents.id), {
        requestId: "does-not-exist",
        decision: "rejected",
      })
    ).resolves.toBeUndefined();
    await expect(
      handleAcknowledgeConsent(ctx(harness!.appWebContents.id), { requestId: "does-not-exist" })
    ).resolves.toBeUndefined();
  });

  it("ignores a reply from a different sender and keeps waiting", async () => {
    vi.useFakeTimers();
    try {
      const dispose = registerPluginCapabilityHandlers();
      const settled = startGatedCall();
      const requestId = pushedRequestId(harness!.appWebContents);
      await handleAcknowledgeConsent(ctx(harness!.appWebContents.id), { requestId });

      // Must not settle, and must not disarm the decision clock either.
      await handleResolveConsent(ctx(9999), { requestId, decision: "approved-and-pin" });

      await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS);
      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.err.message).toContain("timed out");

      dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
