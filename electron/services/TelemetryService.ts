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

export async function initializeTelemetry(): Promise<void> {
  const { enabled } = store.get("telemetry") ?? { enabled: false, hasSeenPrompt: false };
  if (!enabled) return;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  if (initialized) return;

  try {
    const { init } = await import("@sentry/electron/main");
    init({
      dsn,
      release: app.getVersion(),
      environment: app.isPackaged ? "production" : "development",
      sampleRate: 0.1,
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
    initialized = true;
  } catch (err) {
    console.warn("[Telemetry] Failed to initialize Sentry:", err);
  }
}

export function isTelemetryEnabled(): boolean {
  return store.get("telemetry")?.enabled ?? false;
}

export function setTelemetryEnabled(enabled: boolean): void {
  const current = store.get("telemetry") ?? { enabled: false, hasSeenPrompt: false };
  store.set("telemetry", { ...current, enabled });
}

export function hasTelemetryPromptBeenShown(): boolean {
  return store.get("telemetry")?.hasSeenPrompt ?? false;
}

export function markTelemetryPromptShown(): void {
  const current = store.get("telemetry") ?? { enabled: false, hasSeenPrompt: false };
  store.set("telemetry", { ...current, hasSeenPrompt: true });
}
