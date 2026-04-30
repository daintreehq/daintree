// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SentryInit = {
  integrations?: unknown;
  beforeSend?: (event: unknown) => unknown;
  beforeBreadcrumb?: (breadcrumb: unknown) => unknown;
};

const sentryInit = vi.fn<(opts: SentryInit) => void>();

vi.mock("@sentry/electron/renderer", () => ({
  init: (opts: SentryInit) => sentryInit(opts),
  captureException: vi.fn(),
}));

type ConsentPayload = { level: "off" | "errors" | "full"; hasSeenPrompt: boolean };

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
    const initPromise = mod.initRendererSentry();

    // Broadcast fires while snapshot is still pending
    await Promise.resolve();
    consentListener?.({ level: "off", hasSeenPrompt: true });

    // Now the stale snapshot resolves
    resolveSnapshot({ level: "errors", hasSeenPrompt: true });
    await initPromise;

    const opts = sentryInit.mock.calls[0]![0];
    // The live broadcast must have won; beforeSend must still drop events.
    expect(opts.beforeSend!({ message: "x" })).toBeNull();
    expect(mod.getRendererSentryConsent()).toEqual({ level: "off", hasSeenPrompt: true });
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
