// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SentryInit = {
  integrations?: unknown;
  beforeSend?: (event: unknown) => unknown;
  beforeBreadcrumb?: (breadcrumb: unknown) => unknown;
  maxBreadcrumbs?: number;
};

const sentryInit = vi.fn<(opts: SentryInit) => void>();

vi.mock("@sentry/electron/renderer", () => ({
  init: (opts: SentryInit) => sentryInit(opts),
  captureException: vi.fn(),
}));

type ConsentPayload = { level: "off" | "errors" | "full"; hasSeenPrompt: boolean };

// `initRendererSentry` runs `Sentry.init` synchronously and detaches the
// consent IPC hydration as a `.then()` continuation, so callers (bootstrap)
// don't block on the round-trip. Tests that assert post-hydration state must
// flush pending microtasks first.
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("rendererSentry", () => {
  let consentListener: ((payload: ConsentPayload) => void) | undefined;
  let getConsentState: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    sentryInit.mockClear();
    consentListener = undefined;
    getConsentState = vi.fn(async () => ({ level: "errors", hasSeenPrompt: true }));

    (window as unknown as { electron: unknown }).electron = {
      sentry: { getConsentState },
      privacy: {
        onTelemetryConsentChanged: (cb: (payload: ConsentPayload) => void) => {
          consentListener = cb;
          return () => {
            consentListener = undefined;
          };
        },
      },
    };
  });

  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it("calls Sentry.init exactly once across repeated init calls", async () => {
    const mod = await import("../rendererSentry");
    await mod.initRendererSentry();
    await mod.initRendererSentry();
    expect(sentryInit).toHaveBeenCalledTimes(1);
  });

  it("filters out the GlobalHandlers integration", async () => {
    const mod = await import("../rendererSentry");
    await mod.initRendererSentry();

    const opts = sentryInit.mock.calls[0]![0];
    const integrations = opts.integrations as (
      defaults: Array<{ name: string }>
    ) => Array<{ name: string }>;
    const defaults = [{ name: "GlobalHandlers" }, { name: "BrowserApiErrors" }, { name: "Dedupe" }];
    const result = integrations(defaults).map((i) => i.name);

    expect(result).not.toContain("GlobalHandlers");
    expect(result).toContain("BrowserApiErrors");
    expect(result).toContain("Dedupe");
  });

  // #7575 — the renderer keeps its own breadcrumb ring buffer, so the bump must
  // be applied here too or renderer breadcrumbs stay capped at the SDK default 100.
  it("passes maxBreadcrumbs: 250 to Sentry.init", async () => {
    const mod = await import("../rendererSentry");
    await mod.initRendererSentry();

    const opts = sentryInit.mock.calls[0]![0];
    expect(opts.maxBreadcrumbs).toBe(250);
  });

  it.each([
    [{ level: "off", hasSeenPrompt: false }, null],
    [{ level: "errors", hasSeenPrompt: false }, null],
    [{ level: "off", hasSeenPrompt: true }, null],
    [{ level: "errors", hasSeenPrompt: true }, "pass"],
    [{ level: "full", hasSeenPrompt: true }, "pass"],
  ] as const)("beforeSend with %j returns %s", async (state, expected) => {
    getConsentState.mockResolvedValueOnce(state);
    const mod = await import("../rendererSentry");
    await mod.initRendererSentry();

    const opts = sentryInit.mock.calls[0]![0];
    const event = { message: "test" };
    const result = opts.beforeSend!(event);
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toBe(event);
    }
  });

  it("beforeBreadcrumb drops breadcrumbs when consent is closed", async () => {
    getConsentState.mockResolvedValueOnce({ level: "off", hasSeenPrompt: true });
    const mod = await import("../rendererSentry");
    await mod.initRendererSentry();

    const opts = sentryInit.mock.calls[0]![0];
    expect(opts.beforeBreadcrumb!({ message: "click" })).toBeNull();
  });

  it("defaults to closed gate when IPC is unavailable", async () => {
    delete (window as unknown as { electron?: unknown }).electron;
    const mod = await import("../rendererSentry");
    await mod.initRendererSentry();

    const opts = sentryInit.mock.calls[0]![0];
    expect(opts.beforeSend!({ message: "x" })).toBeNull();
  });

  it("push events from main update the consent gate at runtime", async () => {
    getConsentState.mockResolvedValueOnce({ level: "off", hasSeenPrompt: false });
    const mod = await import("../rendererSentry");
    await mod.initRendererSentry();

    const opts = sentryInit.mock.calls[0]![0];
    expect(opts.beforeSend!({ message: "pre" })).toBeNull();

    consentListener?.({ level: "errors", hasSeenPrompt: true });
    expect(opts.beforeSend!({ message: "post" })).toEqual({ message: "post" });
  });

  it("broadcast arriving during initial hydration is not lost (regression)", async () => {
    // Simulate the race: getConsentState returns slowly with a stale value,
    // meanwhile another window broadcasts a fresh consent change. The fresh
    // broadcast must win — the stale snapshot must NOT overwrite it.
    let resolveSnapshot: (v: ConsentPayload) => void = () => {};
    getConsentState.mockImplementationOnce(
      () => new Promise<ConsentPayload>((r) => (resolveSnapshot = r))
    );

    const mod = await import("../rendererSentry");
    mod.initRendererSentry();

    // The consent listener is registered synchronously inside init, so the
    // broadcast lands on the hydration-aware subscription (which sets
    // `liveUpdateReceived = true`) before the snapshot resolves.
    consentListener?.({ level: "off", hasSeenPrompt: true });

    // Now the stale snapshot resolves; the post-hydration `.then` must
    // observe `liveUpdateReceived` and refuse to overwrite the fresher
    // broadcast value.
    resolveSnapshot({ level: "errors", hasSeenPrompt: true });
    await flushMicrotasks();

    const opts = sentryInit.mock.calls[0]![0];
    // The live broadcast must have won; beforeSend must still drop events.
    expect(opts.beforeSend!({ message: "x" })).toBeNull();
    expect(mod.getRendererSentryConsent()).toEqual({ level: "off", hasSeenPrompt: true });
  });

  it("calls Sentry.init synchronously before the consent IPC resolves (#8632)", async () => {
    // The first React render must not be blocked on the renderer→main
    // round-trip for consent state — Sentry.init runs up front, consent
    // hydrates as a detached continuation.
    let resolveSnapshot: (v: ConsentPayload) => void = () => {};
    getConsentState.mockImplementationOnce(
      () => new Promise<ConsentPayload>((r) => (resolveSnapshot = r))
    );

    const mod = await import("../rendererSentry");
    mod.initRendererSentry();

    // Sentry.init must have been called before the IPC promise resolves.
    expect(sentryInit).toHaveBeenCalledTimes(1);

    // Until the snapshot resolves the gate stays closed (consent defaults
    // to `off`/`!hasSeenPrompt`), so events are dropped even though the
    // SDK is fully initialized.
    const opts = sentryInit.mock.calls[0]![0];
    expect(opts.beforeSend!({ message: "pre-hydrate" })).toBeNull();

    resolveSnapshot({ level: "full", hasSeenPrompt: true });
    await flushMicrotasks();

    expect(opts.beforeSend!({ message: "post-hydrate" })).toEqual({ message: "post-hydrate" });
  });

  it("consent IPC rejection does not produce an unhandled rejection", async () => {
    getConsentState.mockRejectedValueOnce(new Error("IPC down"));

    const mod = await import("../rendererSentry");
    mod.initRendererSentry();
    await flushMicrotasks();

    // Sentry.init ran regardless; gate stays closed because consent never
    // hydrated.
    expect(sentryInit).toHaveBeenCalledTimes(1);
    const opts = sentryInit.mock.calls[0]![0];
    expect(opts.beforeSend!({ message: "x" })).toBeNull();
  });

  it("captureRendererException returns the Sentry event ID when capture succeeds", async () => {
    const sentry = await import("@sentry/electron/renderer");
    vi.mocked(sentry.captureException).mockReturnValueOnce("evt-deadbeef");

    const mod = await import("../rendererSentry");
    const eventId = mod.captureRendererException(new Error("boom"));
    expect(eventId).toBe("evt-deadbeef");
  });

  it("captureRendererException returns null when Sentry returns an empty string", async () => {
    const sentry = await import("@sentry/electron/renderer");
    vi.mocked(sentry.captureException).mockReturnValueOnce("");

    const mod = await import("../rendererSentry");
    const eventId = mod.captureRendererException(new Error("boom"));
    expect(eventId).toBeNull();
  });

  it("captureRendererException returns null and logs when Sentry throws", async () => {
    const sentry = await import("@sentry/electron/renderer");
    vi.mocked(sentry.captureException).mockImplementationOnce(() => {
      throw new Error("Sentry transport down");
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const mod = await import("../rendererSentry");
    const eventId = mod.captureRendererException(new Error("boom"));
    expect(eventId).toBeNull();
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("updateRendererSentryConsent also flips the gate", async () => {
    getConsentState.mockResolvedValueOnce({ level: "off", hasSeenPrompt: false });
    const mod = await import("../rendererSentry");
    await mod.initRendererSentry();

    mod.updateRendererSentryConsent("full", true);
    const opts = sentryInit.mock.calls[0]![0];
    expect(opts.beforeSend!({ message: "x" })).toEqual({ message: "x" });
    expect(mod.getRendererSentryConsent()).toEqual({ level: "full", hasSeenPrompt: true });
  });
});
