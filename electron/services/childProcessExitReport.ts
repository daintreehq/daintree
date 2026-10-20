// Builds the Sentry report for a child process exit. Kept free of Electron and
// Sentry imports so the grouping and redaction rules can be tested directly.

// The reasons @sentry/electron's ChildProcess integration captured by default.
export const REPORTED_EXIT_REASONS: ReadonlySet<string> = new Set([
  "abnormal-exit",
  "launch-failed",
  "integrity-failure",
]);

// Chromium's RESULT_CODE_GPU_EXIT_ON_CONTEXT_LOST: the GPU process restarting
// on purpose after a context loss.
export const GPU_EXIT_ON_CONTEXT_LOST = 34;

// Daintree's utility names are `daintree-<id>` or `daintree-<id>:<instance>`,
// and the instance part embeds a project, plugin or shard name.
const DAINTREE_SERVICE_NAME = /^daintree-([a-z][a-z0-9-]*)(?::.*)?$/;
const CHROMIUM_SERVICE_NAME = /^[A-Za-z][A-Za-z ]{0,63}$/;

export interface ChildProcessExitDetails {
  type: string;
  reason: string;
  exitCode: number;
  name?: string;
  serviceName?: string;
}

export function serviceNameOf(details: ChildProcessExitDetails): string | undefined {
  return details.name || details.serviceName || undefined;
}

export function processKind(details: ChildProcessExitDetails): string {
  for (const name of [details.name, details.serviceName]) {
    if (!name) continue;
    const daintree = DAINTREE_SERVICE_NAME.exec(name);
    if (daintree) return daintree[1];
    if (CHROMIUM_SERVICE_NAME.test(name)) return name;
  }
  return details.type;
}

/**
 * POSIX builds can report a raw wait status (`exit code << 8`) instead of the
 * exit code: 8704 for a GPU exit 34. Only exit reasons carry one; a
 * `launch-failed` code is a platform error and is never decoded.
 */
export function normalizeExitCode(
  reason: string,
  exitCode: number,
  platform: NodeJS.Platform = process.platform
): number {
  if (platform === "win32") return exitCode;
  if (reason !== "abnormal-exit" && reason !== "crashed") return exitCode;
  if (!Number.isInteger(exitCode) || exitCode <= 0xff || exitCode > 0xffff) return exitCode;
  if ((exitCode & 0xff) !== 0) return exitCode;
  return exitCode >> 8;
}

export function isGpuContextLossExit(
  details: ChildProcessExitDetails,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (
    details.type === "GPU" &&
    details.reason === "abnormal-exit" &&
    normalizeExitCode(details.reason, details.exitCode, platform) === GPU_EXIT_ON_CONTEXT_LOST
  );
}

const MAX_FATAL_ERROR_LENGTH = 300;
// Absolute paths name the project and worktree, and vary per machine.
// A quoted path can hold spaces; an unquoted one ends at whitespace.
const QUOTED_ABSOLUTE_PATH = /(['"`])(?:[A-Za-z]:[\\/]|\\\\|\/)[^'"`\n]*\1/g;
const ABSOLUTE_PATH = /(?<![\w.-])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"`,;()<>]*[^\s'"`,;()<>.:]/g;
const VOLATILE_ID =
  /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|\d{5,})\b/gi;

export function describeFatalError(message: string): string {
  const flat = message
    .replace(/\s+/g, " ")
    .trim()
    .replace(QUOTED_ABSOLUTE_PATH, "$1<path>$1")
    .replace(ABSOLUTE_PATH, "<path>");
  return flat.length > MAX_FATAL_ERROR_LENGTH ? `${flat.slice(0, MAX_FATAL_ERROR_LENGTH)}…` : flat;
}

export function fatalErrorGroupKey(description: string): string {
  return description.replace(VOLATILE_ID, "<id>");
}

export interface ChildProcessExitEvent {
  message: string;
  level: "warning" | "fatal";
  tags: Record<string, string>;
  extra: Record<string, unknown>;
  fingerprint: string[];
}

export function buildChildProcessExitEvent(
  details: ChildProcessExitDetails,
  {
    fatalError,
    extra = {},
    platform = process.platform,
  }: { fatalError?: string; extra?: Record<string, unknown>; platform?: NodeJS.Platform } = {}
): ChildProcessExitEvent {
  const kind = processKind(details);
  const exitCode = normalizeExitCode(details.reason, details.exitCode, platform);
  const cause = fatalError ? describeFatalError(fatalError) : undefined;
  return {
    message:
      `'${kind}' process exited with '${details.reason}' (exit code ${exitCode})` +
      (cause ? `: ${cause}` : ""),
    level: details.reason === "abnormal-exit" ? "warning" : "fatal",
    tags: {
      "event.process": details.type,
      "process.kind": kind,
      "exit.reason": details.reason,
      "exit.code": String(exitCode),
    },
    extra: {
      ...extra,
      ...(exitCode !== details.exitCode ? { rawExitCode: details.exitCode } : {}),
      ...(cause ? { fatalError: cause } : {}),
    },
    fingerprint: [
      "child-process-gone",
      kind,
      details.reason,
      String(exitCode),
      cause ? fatalErrorGroupKey(cause) : "no-reported-cause",
    ],
  };
}

export function buildRendererExitEvent(
  reason: string,
  exitCode: number,
  webContentsType: string,
  platform: NodeJS.Platform = process.platform
): ChildProcessExitEvent {
  const code = normalizeExitCode(reason, exitCode, platform);
  return {
    message: `'renderer' process exited with '${reason}' (exit code ${code})`,
    level: reason === "abnormal-exit" ? "warning" : "fatal",
    tags: {
      "event.process": "renderer",
      "process.kind": `renderer:${webContentsType}`,
      "exit.reason": reason,
      "exit.code": String(code),
    },
    extra: code !== exitCode ? { rawExitCode: exitCode } : {},
    fingerprint: ["render-process-gone", webContentsType, reason, String(code)],
  };
}

const FATAL_NOTE_TTL_MS = 10_000;
const MAX_FATAL_NOTES = 32;

interface FatalNote {
  message: string;
  at: number;
}

/**
 * Fatal errors a utility process reported just before exiting, keyed by its
 * service name, waiting for the `child-process-gone` that follows.
 */
export class FatalErrorNotes {
  private notes = new Map<string, FatalNote>();

  constructor(private readonly now: () => number = Date.now) {}

  note(serviceName: string, message: string): void {
    this.notes.delete(serviceName);
    this.notes.set(serviceName, { message, at: this.now() });
    while (this.notes.size > MAX_FATAL_NOTES) {
      const oldest = this.notes.keys().next().value;
      if (oldest === undefined) break;
      this.notes.delete(oldest);
    }
  }

  consume(serviceName: string | undefined): string | undefined {
    if (!serviceName) return undefined;
    const note = this.notes.get(serviceName);
    if (!note) return undefined;
    this.notes.delete(serviceName);
    return this.now() - note.at <= FATAL_NOTE_TTL_MS ? note.message : undefined;
  }

  clear(): void {
    this.notes.clear();
  }
}

export const fatalErrorNotes = new FatalErrorNotes();

/** Record the error a utility process reported as the reason it is exiting. */
export function noteChildProcessFatalError(serviceName: string, message: string): void {
  fatalErrorNotes.note(serviceName, message);
}
