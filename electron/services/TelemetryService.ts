import os from "os";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { store } from "../store.js";
import type { ActionBreadcrumb } from "../../shared/types/ipc/crashRecovery.js";
import type { SanitizedTelemetryEvent } from "../../shared/types/ipc/telemetryPreview.js";
import { scrubSecrets } from "../utils/secretScrubber.js";
import { emitTelemetryPreview, isTelemetryPreviewActive } from "./TelemetryPreviewBroadcaster.js";
import { getWritesSuppressed } from "./diskPressureState.js";

export interface SentryBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SentryRequest {
  url?: string;
  headers?: Record<string, unknown>;
  cookies?: unknown;
  data?: unknown;
  query_string?: unknown;
  [key: string]: unknown;
}

export interface SentryEvent {
  exception?: {
    values?: Array<{
      value?: string;
      stacktrace?: {
        frames?: Array<{ filename?: string; abs_path?: string }>;
      };
    }>;
  };
  message?: string;
  request?: SentryRequest;
  breadcrumbs?: SentryBreadcrumb[];
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

const HOME_DIR = os.homedir();

export function sanitizePath(str: string): string {
  const escaped = HOME_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return str
    .replace(new RegExp(escaped, "g"), "~")
    .replace(/\/Users\/[^/]+\//g, "/Users/USER/")
    .replace(/\/home\/[^/]+\//g, "/home/USER/")
    .replace(/C:\\Users\\[^\\]+\\/gi, "C:\\Users\\USER\\")
    .replace(/C:\/Users\/[^/]+\//gi, "C:/Users/USER/");
}

function sanitizeString(value: string): string {
  return scrubSecrets(sanitizePath(value));
}

// Recurse through arrays and plain objects, sanitizing every string leaf.
// Depth-capped to guard against pathological / circular inputs — Sentry
// breadcrumbs and `event.extra` are typically shallow, so 10 levels is well
// beyond any realistic payload.
const MAX_DEEP_SANITIZE_DEPTH = 10;

function sanitizeStringsDeep(value: unknown, depth = 0): unknown {
  // Scrub scalar strings regardless of depth — a secret nested beyond the
  // recursion cap is still worth redacting. Only the descent into containers
  // is stopped when depth overflows.
  if (typeof value === "string") return sanitizeString(value);
  if (depth > MAX_DEEP_SANITIZE_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStringsDeep(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = sanitizeStringsDeep(val, depth + 1);
    }
    return result;
  }
  return value;
}

export function sanitizeEvent(event: SentryEvent): SentryEvent | null {
  // `beforeSend` must never throw — a throw causes Sentry to drop the event
  // silently. Fail closed on unexpected input rather than leaking unscrubbed
  // data by returning the event as-is.
  try {
    if (Array.isArray(event.exception?.values)) {
      for (const ex of event.exception.values) {
        if (!ex || typeof ex !== "object") continue;
        if (Array.isArray(ex.stacktrace?.frames)) {
          for (const frame of ex.stacktrace.frames) {
            if (!frame || typeof frame !== "object") continue;
            if (frame.filename) frame.filename = sanitizeString(frame.filename);
            if (frame.abs_path) frame.abs_path = sanitizeString(frame.abs_path);
          }
        }
        if (ex.value) ex.value = sanitizeString(ex.value);
      }
    }
    if (typeof event.message === "string") {
      event.message = sanitizeString(event.message);
    }
    if (event.request) {
      if (typeof event.request.url === "string") {
        try {
          const u = new URL(event.request.url);
          u.search = "";
          u.hash = "";
          u.username = "";
          u.password = "";
          event.request.url = u.toString();
        } catch {
          // Not parseable as an absolute URL (relative path, mailto:, etc.)
          // Still scrub any inline free-text secrets before giving up.
          event.request.url = sanitizeString(event.request.url);
        }
      }
      if (event.request.headers && typeof event.request.headers === "object") {
        event.request.headers = sanitizeStringsDeep(event.request.headers) as Record<
          string,
          unknown
        >;
      }
      if (event.request.cookies !== undefined) {
        event.request.cookies = sanitizeStringsDeep(event.request.cookies);
      }
      if (event.request.data !== undefined) {
        event.request.data = sanitizeStringsDeep(event.request.data);
      }
      if (event.request.query_string !== undefined) {
        event.request.query_string = sanitizeStringsDeep(event.request.query_string);
      }
    }
    if (Array.isArray(event.breadcrumbs)) {
      for (const breadcrumb of event.breadcrumbs) {
        if (!breadcrumb || typeof breadcrumb !== "object") continue;
        if (typeof breadcrumb.message === "string") {
          breadcrumb.message = sanitizeString(breadcrumb.message);
        }
        if (breadcrumb.data && typeof breadcrumb.data === "object") {
          breadcrumb.data = sanitizeStringsDeep(breadcrumb.data) as Record<string, unknown>;
        }
      }
    }
    if (event.extra && typeof event.extra === "object") {
      event.extra = sanitizeStringsDeep(event.extra) as Record<string, unknown>;
    }
    return event;
  } catch {
    return null;
  }
}

let initialized = false;
let captureEventFn: ((event: SentryEvent) => string) | null = null;
let sentryModule: typeof import("@sentry/electron/main") | null = null;
let initPromise: Promise<void> | null = null;
let closingPromise: Promise<void> | null = null;

const SENTRY_CLOSE_TIMEOUT_MS = 2000;
// Cap the wait for in-flight init during shutdown. If init is still pending past
// this, proceed with close — the alternative is blocking exit on a potentially
// hung import.
const SENTRY_INIT_WAIT_CAP_MS = 500;

interface BufferedEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: number;
}

const preConsentBuffer: BufferedEvent[] = [];
const BUFFER_MAX = 100;

export async function initializeTelemetry(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (getTelemetryLevel() === "off") return;

    const dsn = process.env.SENTRY_DSN;
    if (!dsn) return;

    try {
      const sentry = await import("@sentry/electron/main");
      sentry.init({
        dsn,
        release: app.getVersion(),
        environment: app.isPackaged ? "production" : "development",
        // Drop the default minidump integration. Native .dmp payloads contain
        // stack/register memory that may include env vars (API keys, tokens) at
        // crash time, and JS-level beforeSend cannot scrub binary data. JS
        // crashes remain captured via globalErrorHandlers.ts / main-crash.log.
        integrations: (defaults) => defaults.filter((i) => i.name !== "SentryMinidump"),
        // Do not set `sampleRate` — it defaults to 1.0 (100% error capture). If
        // performance tracing is ever added, use `tracesSampleRate` instead.
        // The local `SentryEvent` interface is a narrower projection of the
        // SDK's `Event` type — cast through `unknown` at the hook boundary so
        // our scrubbing logic can use the shape we control.
        beforeSend: (event) => {
          const sanitized = sanitizeEvent(event as unknown as SentryEvent);
          if (sanitized) capturePreviewFromSanitizedEvent(sanitized);
          // Drop the SDK send under disk pressure but still mirror to the
          // preview stream above — preview is in-memory only.
          if (getWritesSuppressed()) return null;
          return sanitized as unknown as typeof event;
        },
        initialScope: {
          tags: {
            platform: process.platform,
            arch: process.arch,
            node: process.versions.node,
          },
        },
      });
      captureEventFn = sentry.captureEvent as unknown as (event: SentryEvent) => string;
      sentryModule = sentry;
      initialized = true;
    } catch (err) {
      console.warn("[Telemetry] Failed to initialize Sentry:", err);
    }
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

export type TelemetryLevel = "off" | "errors" | "full";

export function getTelemetryLevel(): TelemetryLevel {
  return store.get("privacy")?.telemetryLevel ?? "off";
}

export function isTelemetryEnabled(): boolean {
  return getTelemetryLevel() !== "off";
}

/**
 * Returns a UUID for correlating main-process errors with renderer error
 * envelopes. Only emits in packaged builds where Sentry has been initialized
 * — in dev or when the Sentry module was never loaded, returns `undefined`
 * so no orphan UUID ends up on the wire.
 */
export function getCurrentCorrelationId(): string | undefined {
  if (!app.isPackaged || sentryModule === null) return undefined;
  return randomUUID();
}

export async function setTelemetryLevel(level: TelemetryLevel): Promise<void> {
  store.set("privacy.telemetryLevel", level);

  if (level === "full") {
    await initializeTelemetry();
    // If the user flips telemetry on mid-session, Sentry has only just loaded
    // — stamp the onboarding_complete tag now so the rest of this session's
    // events carry it (we don't wait for the next launch).
    setOnboardingCompleteTag(store.get("onboarding")?.completed === true);
    flushPreConsentBuffer();
  } else if (level === "errors") {
    // Errors-only consent covers crash reports, not analytics — drop any
    // buffered onboarding analytics rather than replaying them to Sentry.
    preConsentBuffer.length = 0;
    await initializeTelemetry();
    setOnboardingCompleteTag(store.get("onboarding")?.completed === true);
  } else {
    preConsentBuffer.length = 0;
  }
}

export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  await setTelemetryLevel(enabled ? "errors" : "off");
}

function buildAnalyticsSentryEvent(
  event: string,
  properties: Record<string, unknown>,
  timestamp: number
): SentryEvent {
  return {
    message: event,
    level: "info" as unknown as undefined,
    extra: { ...properties, timestamp },
    tags: { kind: "analytics" },
  } as SentryEvent;
}

/**
 * Clone a sanitised Sentry event for the preview stream. Runs only when a
 * preview subscriber is active — `structuredClone` isn't free and we don't
 * want to pay for it when nobody is watching. Failure is swallowed: the
 * preview mirror must never block a real telemetry send.
 */
function capturePreviewFromSanitizedEvent(event: SentryEvent): void {
  if (!isTelemetryPreviewActive()) return;
  try {
    const clone = structuredClone(event) as Record<string, unknown>;
    const isAnalytics =
      clone.tags && typeof clone.tags === "object"
        ? (clone.tags as Record<string, unknown>).kind === "analytics"
        : false;
    const label = deriveTelemetryPreviewLabel(clone);
    const record: SanitizedTelemetryEvent = {
      id: randomUUID(),
      kind: isAnalytics ? "analytics" : "sentry",
      timestamp: Date.now(),
      label,
      payload: clone,
    };
    emitTelemetryPreview(record);
  } catch {
    // never let preview capture affect the real telemetry send
  }
}

function deriveTelemetryPreviewLabel(event: Record<string, unknown>): string {
  if (typeof event.message === "string" && event.message.length > 0) {
    return event.message;
  }
  const exception = event.exception as
    | { values?: Array<{ type?: string; value?: string }> }
    | undefined;
  const first = exception?.values?.[0];
  if (first) {
    if (first.type && first.value) return `${first.type}: ${first.value}`;
    if (first.value) return first.value;
    if (first.type) return first.type;
  }
  return "(event)";
}

function flushPreConsentBuffer(): void {
  if (!captureEventFn) return;
  // Under disk pressure `beforeSend` would drop each event, but invoking the
  // SDK still spins through serialisation and queueing — drop the buffer
  // contents up front so the flush is genuinely a no-op.
  if (getWritesSuppressed()) {
    preConsentBuffer.length = 0;
    return;
  }
  const events = preConsentBuffer.splice(0);
  for (const { event, properties, timestamp } of events) {
    captureEventFn(buildAnalyticsSentryEvent(event, properties, timestamp));
  }
}

export function trackEvent(event: string, properties: Record<string, unknown> = {}): void {
  const hasSeenPrompt = hasTelemetryPromptBeenShown();
  const level = getTelemetryLevel();

  // Only send analytics events at "full" level; "errors" only permits crash reports via Sentry
  if (level === "full" && captureEventFn) {
    // Skip the SDK submission under disk pressure but still mirror to the
    // preview stream below if a subscriber is active.
    if (!getWritesSuppressed()) {
      // `beforeSend` will fire the preview tap as part of the capture path.
      captureEventFn(buildAnalyticsSentryEvent(event, properties, Date.now()));
      return;
    }
  }

  // Preview should mirror what *would* be sent even when consent is off or
  // the user hasn't answered the prompt yet — that's the whole point of the
  // feature. Build the would-be event, run it through the same sanitiser,
  // and emit without touching Sentry.
  if (isTelemetryPreviewActive()) {
    const previewOnly = buildAnalyticsSentryEvent(event, properties, Date.now());
    const sanitized = sanitizeEvent(previewOnly);
    if (sanitized) capturePreviewFromSanitizedEvent(sanitized);
  }

  if (!hasSeenPrompt) {
    if (preConsentBuffer.length < BUFFER_MAX) {
      preConsentBuffer.push({ event, properties, timestamp: Date.now() });
    }
    return;
  }

  // Consent decided but disabled — drop the event
}

export function hasTelemetryPromptBeenShown(): boolean {
  return store.get("privacy")?.hasSeenPrompt ?? false;
}

/**
 * Sets the `onboarding_complete` Sentry scope tag so all subsequent captured
 * events are tagged with the user's onboarding state. Lets us separate
 * first-run crashes from established-user crashes in Sentry issue triage.
 *
 * Safe to call before telemetry is initialized — becomes a no-op. When called
 * after init (or re-called when state changes), it updates the global scope
 * and applies to all events captured afterward.
 */
/**
 * Record an action breadcrumb in the active Sentry scope so subsequent crash
 * events carry the user-action timeline. No-op when telemetry is disabled or
 * Sentry is not yet initialized. Never throws — telemetry must never escape
 * into product code.
 */
export function addActionBreadcrumb(crumb: ActionBreadcrumb): void {
  if (!isTelemetryEnabled()) return;
  if (!sentryModule) return;
  try {
    // Sentry expects `timestamp` in Unix seconds, not milliseconds.
    sentryModule.addBreadcrumb({
      category: crumb.category ? `action.${crumb.category}` : "action",
      message: crumb.actionId,
      level: "info",
      type: "user",
      timestamp: crumb.timestamp / 1000,
      data: {
        source: crumb.source,
        durationMs: crumb.durationMs,
        ...(crumb.count > 1 ? { count: crumb.count } : {}),
        ...(crumb.args ? { args: crumb.args } : {}),
      },
    });
  } catch {
    // never let telemetry errors escape into product code paths
  }
}

export function setOnboardingCompleteTag(completed: boolean): void {
  try {
    sentryModule?.setTag("onboarding_complete", completed ? "true" : "false");
  } catch {
    // never let telemetry errors escape into product code paths
  }
}

export function markTelemetryPromptShown(): void {
  store.set("privacy.hasSeenPrompt", true);
}

export function _getPreConsentBufferLength(): number {
  return preConsentBuffer.length;
}

// Drain buffered Sentry events before process exit. Safe to call when telemetry
// was never initialized (no-op) and idempotent. Never throws — telemetry failure
// must never block app exit. Concurrent callers share a single in-flight drain.
export async function closeTelemetry(): Promise<void> {
  if (closingPromise) return closingPromise;

  closingPromise = (async () => {
    // If init is still in flight, wait briefly so we don't miss late-arriving
    // events. Cap the wait so a hung import can't block exit.
    if (initPromise) {
      await Promise.race([
        initPromise.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, SENTRY_INIT_WAIT_CAP_MS)),
      ]);
    }

    if (!initialized || !sentryModule) return;
    const mod = sentryModule;
    try {
      const drained = await mod.close(SENTRY_CLOSE_TIMEOUT_MS);
      if (drained === false) {
        console.warn(
          `[Telemetry] Sentry.close timed out after ${SENTRY_CLOSE_TIMEOUT_MS}ms; some events may be lost`
        );
      }
    } catch {
      // never block exit on telemetry failure
    } finally {
      initialized = false;
      captureEventFn = null;
      sentryModule = null;
    }
  })();

  return closingPromise;
}
