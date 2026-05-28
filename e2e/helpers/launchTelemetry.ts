import { appendFileSync, mkdirSync } from "fs";
import path from "path";

export type LaunchFailureMode =
  | "cdp-handshake-silent"
  | "crashpad-stderr"
  | "webcontents-crash"
  | "main-process-exit"
  | "unknown";

interface ProtocolSnapshot {
  sent: number;
  received: number;
  pending: number;
  lastSentMethods: string[];
  lastReceivedMethods: string[];
  /** ms since beginAttempt */
  firstSendMs: number;
  lastReceiveMs: number;
}

interface TelemetrySummary {
  timestamp: string;
  attempt: number;
  maxAttempts: number;
  mode: LaunchFailureMode;
  elapsedMs: number;
  protocol: {
    sent: number;
    received: number;
    pending: number;
    lastSentMethods: string[];
    lastReceivedMethods: string[];
  };
  crashpad: { matched: boolean; signatures: string[] };
  rendererCrash: { seen: boolean };
  mainExit: { code: number | null; signal: string | null };
}

// Signatures indicative of a crashpad / breakpad failure in the Electron main
// process. These strings appear on stderr before the process exits abnormally.
const CRASHPAD_SIGNATURES = [
  "FATAL kr == KERN_SUCCESS",
  "crashpad",
  "exception_handler_server",
  "EXCEPTION_",
  "Breakpad",
  "handler_start",
  "Handler was started",
];

const MAX_METHOD_HISTORY = 6;
const MAX_SIGNATURE_LIST = 5;
const CDP_SILENT_MIN_SENT = 1;
const CDP_SILENT_MIN_ELAPSED_MS = 2000;

let installed = false;
let originalStderrWrite: typeof process.stderr.write | null = null;
let currentAttempt = 0;
let currentMaxAttempts = 0;
let attemptStartMs = 0;
let protocolSent = 0;
let protocolReceived = 0;
let pendingIds = new Set<number>();
let lastSentMethods: string[] = [];
let lastReceivedMethods: string[] = [];
let firstSendMs = 0;
let lastReceiveMs = 0;
let crashpadMatched = false;
let crashpadSignatures: string[] = [];
let rendererCrashSeen = false;
let mainExitCode: number | null = null;
let mainExitSignal: string | null = null;
let malformedCount = 0;

function isEnabled(): boolean {
  if (process.env.E2E_LAUNCH_TELEMETRY !== "1") return false;
  const debug = process.env.DEBUG ?? "";
  return debug.includes("pw:protocol") || debug.includes("pw:browser");
}

function isPlaywrightDebugLine(line: string): boolean {
  return line.includes("pw:protocol") || line.includes("pw:browser");
}

function restoreStderr(): void {
  if (originalStderrWrite) {
    process.stderr.write = originalStderrWrite;
    originalStderrWrite = null;
  }
  installed = false;
}

function parseProtocolLine(line: string): void {
  // pw:protocol lines look like:
  //   pw:protocol SEND ► {"id":1,"method":"Browser.getVersion","params":{}} +0ms
  //   pw:protocol ◀ RECV {"id":1,"result":{...}} +5ms
  // The JSON payload and delta suffix vary — be tolerant.

  const isSend = /SEND\s*[►▸]/.test(line);
  const isRecv = /◀\s*RECV|RECV/.test(line);
  if (!isSend && !isRecv) return;

  try {
    // Find the JSON payload: locate the first `{` after the directional
    // marker (►/▸/◀), then slice to end-of-line minus the debug-package
    // delta suffix (`+Nms`). This avoids false matches on bracketed
    // prefixes and handles text between the marker and JSON (e.g. "RECV").
    const markerIdx = Math.max(line.indexOf("►"), line.indexOf("▸"), line.indexOf("◀"));
    const searchStart = markerIdx >= 0 ? markerIdx + 1 : 0;
    const openBrace = line.indexOf("{", searchStart);
    if (openBrace < 0) return;
    const raw = line.slice(openBrace);
    const jsonStr = raw.replace(/\s+\+\d+ms\s*$/, "");
    const payload = JSON.parse(jsonStr);

    if (isSend && typeof payload?.method === "string") {
      const id = typeof payload.id === "number" ? payload.id : null;
      protocolSent++;
      if (id !== null) pendingIds.add(id);
      if (firstSendMs === 0) firstSendMs = Date.now() - attemptStartMs;
      lastSentMethods.unshift(payload.method);
      if (lastSentMethods.length > MAX_METHOD_HISTORY) lastSentMethods.pop();
    } else if (isRecv) {
      protocolReceived++;
      const id = typeof payload?.id === "number" ? payload.id : null;
      if (id !== null) pendingIds.delete(id);
      lastReceiveMs = Date.now() - attemptStartMs;
      if (typeof payload?.method === "string") {
        lastReceivedMethods.unshift(payload.method);
        if (lastReceivedMethods.length > MAX_METHOD_HISTORY) lastReceivedMethods.pop();
      }
    }
  } catch {
    malformedCount++;
  }
}

function parseBrowserLine(_line: string): void {
  // pw:browser lines track lifecycle: <launching>, <launched>, etc.
  // We don't need to parse these deeply; their presence is tracked via
  // protocol telemetry. This hook exists for future expansion.
}

function stderrWrite(chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean {
  const data = typeof chunk === "string" ? chunk : String(chunk);
  if (isPlaywrightDebugLine(data)) {
    if (data.includes("pw:protocol")) parseProtocolLine(data);
    else if (data.includes("pw:browser")) parseBrowserLine(data);
    // Swallow — don't forward raw Playwright debug to GHA stderr.
    return true;
  }
  return originalStderrWrite!.call(
    process.stderr,
    chunk,
    ...([encodingOrCb, cb].filter(Boolean) as Parameters<typeof process.stderr.write>)
  ) as boolean;
}

export function install(): void {
  if (!isEnabled() || installed) return;
  originalStderrWrite = process.stderr.write;
  process.stderr.write = stderrWrite as typeof process.stderr.write;
  installed = true;
}

export function beginAttempt(attempt: number, maxAttempts: number): void {
  currentAttempt = attempt;
  currentMaxAttempts = maxAttempts;
  attemptStartMs = Date.now();
  protocolSent = 0;
  protocolReceived = 0;
  pendingIds = new Set();
  lastSentMethods = [];
  lastReceivedMethods = [];
  firstSendMs = 0;
  lastReceiveMs = 0;
  crashpadMatched = false;
  crashpadSignatures = [];
  rendererCrashSeen = false;
  mainExitCode = null;
  mainExitSignal = null;
  malformedCount = 0;
}

export function observeStderrLine(line: string): void {
  if (!isEnabled()) return;
  for (const sig of CRASHPAD_SIGNATURES) {
    if (line.includes(sig)) {
      crashpadMatched = true;
      crashpadSignatures.unshift(sig);
      if (crashpadSignatures.length > MAX_SIGNATURE_LIST) crashpadSignatures.pop();
      break;
    }
  }
}

export function observeMainProcessExit(code: number | null, signal: string | null): void {
  mainExitCode = code;
  mainExitSignal = signal;
}

export function observeRendererCrash(): void {
  rendererCrashSeen = true;
}

export function classify(): LaunchFailureMode {
  if (rendererCrashSeen) return "webcontents-crash";
  if (mainExitCode !== null && mainExitCode !== 0) return "main-process-exit";
  if (mainExitSignal !== null) return "main-process-exit";
  if (crashpadMatched) return "crashpad-stderr";
  if (
    protocolSent >= CDP_SILENT_MIN_SENT &&
    protocolReceived === 0 &&
    Date.now() - attemptStartMs >= CDP_SILENT_MIN_ELAPSED_MS
  ) {
    return "cdp-handshake-silent";
  }
  return "unknown";
}

function snapshot(): ProtocolSnapshot {
  return {
    sent: protocolSent,
    received: protocolReceived,
    pending: pendingIds.size,
    lastSentMethods: [...lastSentMethods],
    lastReceivedMethods: [...lastReceivedMethods],
    firstSendMs,
    lastReceiveMs,
  };
}

function buildSummary(mode: LaunchFailureMode): TelemetrySummary {
  const proto = snapshot();
  return {
    timestamp: new Date().toISOString(),
    attempt: currentAttempt,
    maxAttempts: currentMaxAttempts,
    mode,
    elapsedMs: Date.now() - attemptStartMs,
    protocol: {
      sent: proto.sent,
      received: proto.received,
      pending: proto.pending,
      lastSentMethods: proto.lastSentMethods,
      lastReceivedMethods: proto.lastReceivedMethods,
    },
    crashpad: { matched: crashpadMatched, signatures: [...crashpadSignatures] },
    rendererCrash: { seen: rendererCrashSeen },
    mainExit: { code: mainExitCode, signal: mainExitSignal },
  };
}

export function writeSummary(mode?: LaunchFailureMode): string {
  const resolved = mode ?? classify();
  const summary = buildSummary(resolved);

  const shortLine =
    `[e2e_launch_telemetry] attempt=${summary.attempt}/${summary.maxAttempts}` +
    ` mode=${summary.mode} elapsedMs=${summary.elapsedMs}` +
    ` sent=${summary.protocol.sent} recv=${summary.protocol.received}` +
    ` pending=${summary.protocol.pending}` +
    (summary.protocol.lastSentMethods.length > 0
      ? ` lastSend=${summary.protocol.lastSentMethods[0]}`
      : "") +
    (summary.protocol.lastReceivedMethods.length > 0
      ? ` lastRecv=${summary.protocol.lastReceivedMethods[0]}`
      : "") +
    (summary.crashpad.matched ? ` crashpad=${summary.crashpad.signatures[0]}` : "") +
    (summary.rendererCrash.seen ? " rendererCrash=true" : "") +
    (summary.mainExit.code !== null ? ` exitCode=${summary.mainExit.code}` : "") +
    (summary.mainExit.signal !== null ? ` exitSignal=${summary.mainExit.signal}` : "");

  const telemetryFile = process.env.E2E_LAUNCH_TELEMETRY_FILE;
  if (telemetryFile) {
    try {
      mkdirSync(path.dirname(telemetryFile), { recursive: true });
      appendFileSync(telemetryFile, JSON.stringify(summary) + "\n", "utf-8");
    } catch {
      // Telemetry is best-effort; never fail the launch path.
    }
  }

  process.stderr.write(`${shortLine}\n`);
  return resolved;
}

export function dispose(): void {
  restoreStderr();
  currentAttempt = 0;
  currentMaxAttempts = 0;
  attemptStartMs = 0;
  protocolSent = 0;
  protocolReceived = 0;
  pendingIds = new Set();
  lastSentMethods = [];
  lastReceivedMethods = [];
  firstSendMs = 0;
  lastReceiveMs = 0;
  crashpadMatched = false;
  crashpadSignatures = [];
  rendererCrashSeen = false;
  mainExitCode = null;
  mainExitSignal = null;
  malformedCount = 0;
}
