// eager-import-allow: reads telemetry consent/config via store.get synchronously
import { randomUUID } from "node:crypto";
import { app, type Details, type RenderProcessGoneDetails, type WebContents } from "electron";
import { store } from "../store.js";
import type { ActionBreadcrumb } from "../../shared/types/ipc/crashRecovery.js";
import type { SanitizedTelemetryEvent } from "../../shared/types/ipc/telemetryPreview.js";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";
import { sanitizePath } from "../utils/pathScrubber.js";
import { emitTelemetryPreview, isTelemetryPreviewActive } from "./TelemetryPreviewBroadcaster.js";
import { getWritesSuppressed } from "./diskPressureState.js";
import { BreadcrumbRepeatLimiter } from "./breadcrumbRepeatLimiter.js";
import {
  REPORTED_EXIT_REASONS,
  buildChildProcessExitEvent,
  buildRendererExitEvent,
  fatalErrorNotes,
  serviceNameOf,
  type ChildProcessExitDetails,
  type ChildProcessExitEvent,
} from "./childProcessExitReport.js";

export { sanitizePath };

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
      type?: string;
      value?: string;
      mechanism?: unknown;
      stacktrace?: {
        frames?: Array<{
          filename?: string;
          abs_path?: string;
          context_line?: string;
          pre_context?: string[];
          post_context?: string[];
          vars?: Record<string, unknown>;
        }>;
      };
    }>;
  };
  message?: string;
  transaction?: string;
  request?: SentryRequest;
  breadcrumbs?: SentryBreadcrumb[];
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

// Telemetry-local rather than a `scrubSecrets` pattern: that catalogue also
// drives `findSecretInValue`, which would start rejecting `GIT_AUTHOR_EMAIL`
// style config values as credentials. Matches the `%40`/`%2E`-encoded forms
// query strings carry; the lookbehind makes the whole local part go, not just
// a suffix of it. The TLD must be alphabetic so `pkg@1.2.3` survives, and the
// `git@host:` of an SSH remote is left to the remote rule.
const EMAIL_LOCAL_CHARS = "A-Za-z0-9._%+!#$&'*~-";
const EMAIL_REGEX = new RegExp(
  `(?<![${EMAIL_LOCAL_CHARS}])(?!git@[A-Za-z0-9.-]{1,253}:)[${EMAIL_LOCAL_CHARS}]{1,256}(?:@|%40)` +
    `(?:[A-Za-z0-9-]{1,63}(?:\\.|%2E)){1,10}[A-Za-z]{2,63}\\b`,
  "gi"
);
// SSH remotes name the (possibly private) owner and repo.
// Utility process names (`daintree-workspace-host:<project>-<hash>`, PTY shards,
// plugin workers) embed a project or plugin name after the colon.
const SERVICE_INSTANCE_REGEX = /\b(daintree-[a-z][a-z0-9-]*):[A-Za-z0-9_-]+/g;
const SSH_REMOTE_REGEX =
  /\b(git@[A-Za-z0-9.-]{1,253}:)[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100}){0,10}/g;
// Also matches the escaped form a JSON-stringified log argument carries (`\/`,
// and `\"` inside a query value).
// Parentheses and apostrophes are legal inside a URL path, so they don't end
// the match; a closing one from surrounding prose goes with the path.
const EMBEDDED_URL_REGEX = /\b(?:https?|wss?|ssh|git):(?:\/\/|\\\/\\\/)(?:\\[/"]|[^\s"`<>\\])+/gi;
const ORIGIN_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const REDACTED_URL = "[REDACTED_URL]";

function scrubText(value: string): string {
  return scrubSecrets(sanitizePath(value))
    .replace(SERVICE_INSTANCE_REGEX, "$1:[instance]")
    .replace(SSH_REMOTE_REGEX, "$1REDACTED/REDACTED")
    .replace(EMAIL_REGEX, "[EMAIL]");
}

// Paths and query strings name private repos (`/repos/<owner>/<repo>`) and
// carry search terms (`search/users?q=<email>`), so only the origin is kept.
function reduceUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (ORIGIN_PROTOCOLS.has(u.protocol)) return u.origin;
    return u.host ? `${u.protocol}//${u.host}` : u.protocol;
  } catch {
    return REDACTED_URL;
  }
}

// For fields that hold nothing but a URL. Both branches of `reduceUrl` end in
// the full string scrub here (lesson #10101).
function sanitizeUrlField(value: string): string {
  return scrubText(reduceUrl(value));
}

function sanitizeString(value: string): string {
  return scrubText(value.replace(EMBEDDED_URL_REGEX, (url) => reduceUrl(url)));
}

// Stack locations are often URLs (`app:///dist/main.js`), and reducing them to
// an origin would strip the file the frame points at. Only the query,
// fragment and credentials go.
function sanitizeLocation(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      u.search = "";
      u.hash = "";
      u.username = "";
      u.password = "";
      return scrubText(u.toString());
    } catch {
      // fall through to the plain scrub
    }
  }
  return scrubText(value);
}

const FRAME_LOCATION_KEYS = new Set(["filename", "abs_path"]);

// Shared by exception and thread stacks. contextLinesIntegration and
// localVariablesIntegration (default integrations in @sentry/electron) fill
// `context_line`, `pre_context`/`post_context` and `vars` with raw source lines
// and local values before beforeSend fires; `function` and `module` are
// caller-influenced too (computed method names), so every field is scrubbed.
function sanitizeFrames(frames: unknown): void {
  if (!Array.isArray(frames)) return;
  for (const frame of frames) {
    if (!frame || typeof frame !== "object") continue;
    const record = frame as Record<string, unknown>;
    for (const [key, val] of Object.entries(record)) {
      record[key] =
        FRAME_LOCATION_KEYS.has(key) && typeof val === "string"
          ? sanitizeLocation(val)
          : sanitizeStringsDeep(val);
    }
  }
}

const BREADCRUMB_URL_KEYS = ["url", "from", "to"] as const;
const BREADCRUMB_DROPPED_KEYS = ["http.query", "http.fragment"] as const;

// Recurse through arrays and plain objects, sanitizing every string leaf.
// Depth-capped to guard against pathological / circular inputs — Sentry
// breadcrumbs and `event.extra` are typically shallow, so 10 levels is well
// beyond any realistic payload. A `url` key anywhere (console arguments,
// contexts) gets the URL-field treatment rather than the free-text one, which
// would leave a relative path intact.
const MAX_DEEP_SANITIZE_DEPTH = 10;

function sanitizeStringsDeep(
  value: unknown,
  scrub: (value: string) => string = sanitizeString,
  depth = 0
): unknown {
  // Scrub scalar strings regardless of depth — a secret nested beyond the
  // recursion cap is still worth redacting. Only the descent into containers
  // is stopped when depth overflows.
  if (typeof value === "string") return scrub(value);
  if (depth > MAX_DEEP_SANITIZE_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStringsDeep(item, scrub, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] =
        key === "url" && typeof val === "string" && scrub === sanitizeString
          ? sanitizeUrlField(val)
          : sanitizeStringsDeep(val, scrub, depth + 1);
    }
    return result;
  }
  return value;
}

export function sanitizeEvent(event: SentryEvent): SentryEvent | null {
  // `beforeSend` must never throw — a throw causes Sentry to drop the event
  // silently. Fail closed on unexpected input rather than leaking unscrubbed
  // data by returning the event as-is.
  //
  // event.tags / event.user / event.contexts are deep-walked below: renderer
  // error paths (ErrorBoundary, onUncaughtError) inject caller-supplied tags
  // and contexts (e.g. React componentStack), so these fields can carry user
  // data. New Sentry scope-setter call sites outside this file are lint-banned
  // (see eslint.config.js, #10047).
  try {
    if (Array.isArray(event.exception?.values)) {
      for (const ex of event.exception.values) {
        if (!ex || typeof ex !== "object") continue;
        sanitizeFrames(ex.stacktrace?.frames);
        if (ex.value) ex.value = sanitizeString(ex.value);
        // The browser SDK copies `Error.name` into `type`, and it is caller-set.
        if (typeof ex.type === "string") ex.type = sanitizeString(ex.type);
        if (ex.mechanism !== undefined) ex.mechanism = sanitizeStringsDeep(ex.mechanism);
      }
    }
    if (typeof event.transaction === "string") {
      event.transaction = sanitizeString(event.transaction);
    }
    for (const key of ["logentry", "fingerprint"] as const) {
      if (event[key] !== undefined) event[key] = sanitizeStringsDeep(event[key]);
    }
    const threads = (event.threads as { values?: unknown } | undefined)?.values;
    if (Array.isArray(threads)) {
      for (const thread of threads) {
        if (!thread || typeof thread !== "object") continue;
        const record = thread as Record<string, unknown>;
        for (const [key, val] of Object.entries(record)) {
          if (key === "stacktrace") {
            sanitizeFrames((val as { frames?: unknown } | undefined)?.frames);
          } else {
            record[key] = sanitizeStringsDeep(val);
          }
        }
      }
    }
    // Debug images name the same source locations the frames do.
    if (event.debug_meta !== undefined) {
      event.debug_meta = sanitizeStringsDeep(event.debug_meta, sanitizeLocation);
    }
    if (typeof event.message === "string") {
      event.message = sanitizeString(event.message);
    }
    if (event.request) {
      if (typeof event.request.url === "string") {
        event.request.url = sanitizeUrlField(event.request.url);
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
      delete event.request.query_string;
    }
    if (Array.isArray(event.breadcrumbs)) {
      for (const breadcrumb of event.breadcrumbs) {
        if (!breadcrumb || typeof breadcrumb !== "object") continue;
        if (typeof breadcrumb.message === "string") {
          breadcrumb.message = sanitizeString(breadcrumb.message);
        }
        const rawData: unknown = breadcrumb.data;
        if (typeof rawData === "string") {
          // A `toJSON()` on the original data can leave a bare string here.
          breadcrumb.data = sanitizeString(rawData) as unknown as Record<string, unknown>;
        } else if (breadcrumb.data && typeof breadcrumb.data === "object") {
          // Network breadcrumbs (electron.net, http, fetch, xhr) carry `url`
          // plus split-out query/fragment keys; navigation carries `from`/`to`.
          const data = breadcrumb.data;
          for (const key of BREADCRUMB_DROPPED_KEYS) delete data[key];
          for (const key of BREADCRUMB_URL_KEYS) {
            const value = data[key];
            if (typeof value === "string") data[key] = sanitizeUrlField(value);
          }
          breadcrumb.data = sanitizeStringsDeep(data) as Record<string, unknown>;
        }
      }
    }
    if (event.extra && typeof event.extra === "object") {
      event.extra = sanitizeStringsDeep(event.extra) as Record<string, unknown>;
    }
    if (event.tags && typeof event.tags === "object") {
      event.tags = sanitizeStringsDeep(event.tags) as Record<string, unknown>;
    }
    if (event.user && typeof event.user === "object") {
      event.user = sanitizeStringsDeep(event.user) as Record<string, unknown>;
    }
    if (event.contexts && typeof event.contexts === "object") {
      event.contexts = sanitizeStringsDeep(event.contexts) as Record<string, unknown>;
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

type SentryTransport = ReturnType<
  (typeof import("@sentry/electron/main"))["makeElectronTransport"]
>;

// Every upload ends at the base transport's `send`: client events and sessions,
// offline-queue retries, and the non-event envelopes the SDK forwards from
// renderers straight to the transport without touching `beforeSend` or the
// client's `enabled` flag. Gating here is what makes Off stop everything
// mid-session. A dropped envelope resolves as delivered so the offline queue
// discards it instead of persisting it for a later retry.
function gateTransportOnConsent(transport: SentryTransport): SentryTransport {
  return {
    send: (envelope) => (isTelemetryEnabled() ? transport.send(envelope) : Promise.resolve({})),
    flush: (timeout) => transport.flush(timeout),
  };
}

export async function initializeTelemetry(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (getTelemetryLevel() === "off") return;

    const dsn = process.env.SENTRY_DSN;
    if (!dsn) return;

    try {
      const sentry = await import("@sentry/electron/main");
      // Consent can be withdrawn while the SDK module graph loads.
      if (getTelemetryLevel() === "off") return;
      sentry.init({
        dsn,
        release: app.getVersion(),
        environment: app.isPackaged ? "production" : "development",
        transport: sentry.makeElectronOfflineTransport((options) =>
          gateTransportOnConsent(sentry.makeElectronTransport(options))
        ),
        // Drop the default minidump integration. Native .dmp payloads contain
        // stack/register memory that may include env vars (API keys, tokens) at
        // crash time, and JS-level beforeSend cannot scrub binary data. JS
        // crashes remain captured via globalErrorHandlers.ts / main-crash.log.
        //
        // The ChildProcess integration's own exit events carry only the process
        // type and reason, so unrelated causes share one Sentry issue. Keep its
        // breadcrumbs and capture exits here instead (#13542).
        integrations: (defaults) => [
          ...defaults.filter((i) => i.name !== "SentryMinidump" && i.name !== "ChildProcess"),
          sentry.childProcessIntegration({ events: [] }),
        ],
        // Sentry normalizes events (default depth 3) *before* beforeSend fires,
        // replacing nested objects/arrays past the cap with the literal strings
        // "[Object]"/"[Array]". Raise to match MAX_DEEP_SANITIZE_DEPTH so the
        // deep-walk scrubber inspects real data, not already-flattened stubs.
        // Freeze normalizeMaxBreadth at its current SDK default to insulate
        // against a future change silently narrowing the breadth limit.
        normalizeDepth: MAX_DEEP_SANITIZE_DEPTH,
        normalizeMaxBreadth: 1000,
        // Raise the default 100-entry ring so high-frequency action dispatches
        // (drag bursts, agent-state polls, file-watcher fanouts) don't rotate
        // the crash-triggering breadcrumb out before flush. See #7575.
        maxBreadcrumbs: 250,
        beforeBreadcrumb: (breadcrumb) => breadcrumbLimiter.filter(breadcrumb),
        // No tracing backend consumes these, and the default fetch / Electron
        // net integrations otherwise stamp `sentry-trace` + `baggage` (public
        // key, release, trace id) onto every outbound request to third-party
        // hosts — the consent gate on the transport never sees those headers.
        tracePropagationTargets: [],
        // Do not set `sampleRate` — it defaults to 1.0 (100% error capture). If
        // performance tracing is ever added, use `tracesSampleRate` instead.
        // The local `SentryEvent` interface is a narrower projection of the
        // SDK's `Event` type — cast through `unknown` at the hook boundary so
        // our scrubbing logic can use the shape we control.
        beforeSend: (event) => {
          const sanitized = sanitizeEvent(event as unknown as SentryEvent);
          if (sanitized) capturePreviewFromSanitizedEvent(sanitized);
          // Drop the SDK send once consent is withdrawn or under disk pressure,
          // but still mirror to the preview stream above — preview is
          // in-memory only. Dropping here (not just at the transport) also
          // keeps Off-period errors out of the release-health session counts.
          if (!isTelemetryEnabled() || getWritesSuppressed()) return null;
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
      installExitReporting();
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

const breadcrumbLimiter = new BreadcrumbRepeatLimiter();
let removeExitListeners: (() => void) | null = null;
const pendingExitReports = new Set<() => void>();

function captureExitEvent(event: ChildProcessExitEvent): void {
  if (!captureEventFn) return;
  try {
    captureEventFn(event as unknown as SentryEvent);
  } catch {
    // never let telemetry errors escape into product code paths
  }
}

function installExitReporting(): void {
  if (removeExitListeners) return;

  const onChildGone = (_event: Electron.Event, details: Details) => {
    // GpuCrashMonitorService reports GPU exits: only it knows whether one
    // counts toward a fallback (reportGpuProcessExit).
    if (details.type === "GPU") return;
    if (!REPORTED_EXIT_REASONS.has(details.reason)) return;
    // A host posts its fatal error just before it exits, and that message can
    // land after `child-process-gone`; give it one turn to arrive.
    const report = () => {
      pendingExitReports.delete(report);
      clearImmediate(handle);
      const fatalError = fatalErrorNotes.consume(serviceNameOf(details));
      captureExitEvent(buildChildProcessExitEvent(details, { fatalError }));
    };
    const handle = setImmediate(report);
    pendingExitReports.add(report);
  };

  const onRendererGone = (
    _event: Electron.Event,
    webContents: WebContents,
    details: RenderProcessGoneDetails
  ) => {
    if (!REPORTED_EXIT_REASONS.has(details.reason)) return;
    let type = "unknown";
    try {
      type = webContents.getType();
    } catch {
      // destroyed webContents
    }
    captureExitEvent(buildRendererExitEvent(details.reason, details.exitCode, type));
  };

  app.on("child-process-gone", onChildGone);
  app.on("render-process-gone", onRendererGone);
  removeExitListeners = () => {
    app.off("child-process-gone", onChildGone);
    app.off("render-process-gone", onRendererGone);
  };
}

function uninstallExitReporting(): void {
  for (const report of [...pendingExitReports]) report();
  removeExitListeners?.();
  removeExitListeners = null;
  fatalErrorNotes.clear();
  breadcrumbLimiter.clear();
}

/**
 * Report a GPU process exit GpuCrashMonitorService decided is worth a Sentry
 * event. No-op until telemetry is initialized.
 */
export function reportGpuProcessExit(
  details: ChildProcessExitDetails,
  extra: Record<string, unknown>
): void {
  if (!REPORTED_EXIT_REASONS.has(details.reason)) return;
  captureExitEvent(buildChildProcessExitEvent(details, { extra }));
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
    // Pin grouping to the analytics event name so issue-tracking stays stable
    // across SDK upgrades. Sentry's default fingerprint hash is unstable —
    // without this, two analytics events with the same name can land in
    // different groups after a fingerprint-algorithm change.
    fingerprint: ["analytics", event],
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
    { values?: Array<{ type?: string; value?: string }> } | undefined;
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
  // `setTelemetryLevel("full")` flushes after awaiting init; a later level
  // change may have landed in that gap.
  if (getTelemetryLevel() !== "full") return;
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
        ...(crumb.confirmed !== undefined ? { confirmed: crumb.confirmed } : {}),
      },
    });
  } catch {
    // never let telemetry errors escape into product code paths
  }
}

export function setOnboardingCompleteTag(completed: boolean): void {
  try {
    // eslint-disable-next-line no-restricted-syntax -- sentry-scope-setter: ok — sole authorized scope mutator; fixed "true"/"false" values
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
    uninstallExitReporting();
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
