import os from "os";
import { app } from "electron";
import { store } from "../store.js";

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
  request?: { url?: string };
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

function sanitizeEvent(event: SentryEvent): SentryEvent | null {
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.stacktrace?.frames) {
        for (const frame of ex.stacktrace.frames) {
          if (frame.filename) frame.filename = sanitizePath(frame.filename);
          if (frame.abs_path) frame.abs_path = sanitizePath(frame.abs_path);
        }
      }
      if (ex.value) ex.value = sanitizePath(ex.value);
    }
  }
  if (typeof event.message === "string") {
    event.message = sanitizePath(event.message);
  }
  if (event.request?.url) {
    try {
      const u = new URL(event.request.url);
      u.search = "";
      event.request.url = u.toString();
    } catch {
      // not a valid URL, leave as-is
    }
  }
  return event;
}

let initialized = false;
let captureEventFn: ((event: SentryEvent) => string) | null = null;

interface BufferedEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: number;
}

const preConsentBuffer: BufferedEvent[] = [];
const BUFFER_MAX = 100;

export async function initializeTelemetry(): Promise<void> {
  if (getTelemetryLevel() === "off") return;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  if (initialized) return;

  try {
    const sentry = await import("@sentry/electron/main");
    sentry.init({
      dsn,
      release: app.getVersion(),
      environment: app.isPackaged ? "production" : "development",
      // Do not set `sampleRate` — it defaults to 1.0 (100% error capture). If
      // performance tracing is ever added, use `tracesSampleRate` instead.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      beforeSend: sanitizeEvent as any,
      initialScope: {
        tags: {
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
        },
      },
    });
    captureEventFn = sentry.captureEvent;
    initialized = true;
  } catch (err) {
    console.warn("[Telemetry] Failed to initialize Sentry:", err);
  }
}

export type TelemetryLevel = "off" | "errors" | "full";

const DEFAULT_PRIVACY = {
  telemetryLevel: "off" as const,
  hasSeenPrompt: false,
  logRetentionDays: 30 as const,
};

export function getTelemetryLevel(): TelemetryLevel {
  return store.get("privacy")?.telemetryLevel ?? "off";
}

export function isTelemetryEnabled(): boolean {
  return getTelemetryLevel() !== "off";
}

export async function setTelemetryLevel(level: TelemetryLevel): Promise<void> {
  const privacy = store.get("privacy") ?? DEFAULT_PRIVACY;
  store.set("privacy", { ...privacy, telemetryLevel: level });

  if (level === "full") {
    await initializeTelemetry();
    flushPreConsentBuffer();
  } else if (level === "errors") {
    // Errors-only consent covers crash reports, not analytics — drop any
    // buffered onboarding analytics rather than replaying them to Sentry.
    preConsentBuffer.length = 0;
    await initializeTelemetry();
  } else {
    preConsentBuffer.length = 0;
  }
}

export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  await setTelemetryLevel(enabled ? "errors" : "off");
}

function flushPreConsentBuffer(): void {
  if (!captureEventFn) return;
  const events = preConsentBuffer.splice(0);
  for (const { event, properties, timestamp } of events) {
    captureEventFn({
      message: event,
      level: "info" as unknown as undefined,
      extra: { ...properties, timestamp },
      tags: { kind: "analytics" },
    } as SentryEvent);
  }
}

export function trackEvent(event: string, properties: Record<string, unknown> = {}): void {
  const hasSeenPrompt = hasTelemetryPromptBeenShown();
  const level = getTelemetryLevel();

  // Only send analytics events at "full" level; "errors" only permits crash reports via Sentry
  if (level === "full" && captureEventFn) {
    captureEventFn({
      message: event,
      level: "info" as unknown as undefined,
      extra: { ...properties, timestamp: Date.now() },
      tags: { kind: "analytics" },
    } as SentryEvent);
    return;
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

export function markTelemetryPromptShown(): void {
  const privacy = store.get("privacy") ?? DEFAULT_PRIVACY;
  store.set("privacy", { ...privacy, hasSeenPrompt: true });
}

export function _getPreConsentBufferLength(): number {
  return preConsentBuffer.length;
}
