import { isErrorLike } from "@shared/utils/ipcErrorSerialization";
import { scrubReportText } from "@shared/utils/reportScrubbers";

/**
 * Depth bound for the `.cause` walk. Spelled independently of the log walk's
 * `MAX_ERROR_SCAN_DEPTH`, but the same size: past this many links the chain is
 * describing a wrapper stack no reader follows, and an unbounded walk is a
 * denial-of-service surface handed to plugin authors.
 */
const MAX_CAUSE_DEPTH = 8;

/** Sentinels, spelled as `logErrorNormalization` and `ipcErrorSerialization` spell them. */
const MAX_DEPTH = "[MaxDepth]";
const CIRCULAR = "[Circular]";
const UNSERIALIZABLE = "[Unserializable]";

const FALLBACK_MESSAGE = "Unknown render error";

/**
 * Read one property without ever throwing. Every field here comes off a value a
 * plugin threw, which may be a Proxy or expose a throwing getter — the
 * diagnostics pane must not become the second failure.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readUnknown(source: unknown, key: string): unknown {
  if (!isRecord(source)) return undefined;
  try {
    return source[key];
  } catch {
    return undefined;
  }
}

function readString(source: unknown, key: string): string | undefined {
  const value = readUnknown(source, key);
  return typeof value === "string" ? value : undefined;
}

/**
 * Own-or-inherited `cause`, tested by presence rather than truthiness so an
 * explicit `{ cause: null }` is still reported as a link in the chain.
 */
function hasCause(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  try {
    return "cause" in value;
  } catch {
    return false;
  }
}

/** A structured error code, kept through redaction — it names a failure, not a user. */
function extractCode(value: unknown): string | undefined {
  const code = readUnknown(value, "code");
  if (typeof code === "string") return code.length > 0 ? code : undefined;
  // Not a truthiness test: `code: 0` is a real errno-style code.
  if (typeof code === "number" && Number.isFinite(code)) return String(code);
  return undefined;
}

/**
 * Readable JSON for an object that is not an Error. `JSON.stringify` throws on
 * cycles, BigInt, and a hostile `toJSON`, and overflows the stack on a
 * pathologically deep graph — all of which land in the `catch`. The `seen` set
 * is never unwound, so a value referenced twice reads `[Circular]` the second
 * time even without a true cycle; `ipcErrorSerialization` makes the same
 * trade for the same reason.
 */
function stringifyObject(value: object): string {
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(
      value,
      (_key, item: unknown) => {
        if (isErrorLike(item)) {
          return {
            name: readString(item, "name") ?? "Error",
            message: readString(item, "message") ?? "",
            stack: readString(item, "stack"),
          };
        }
        if (typeof item === "bigint") return String(item);
        if (typeof item !== "object" || item === null) return item;
        if (seen.has(item)) return CIRCULAR;
        seen.add(item);
        return item;
      },
      2
    );
    return json ?? UNSERIALIZABLE;
  } catch {
    return UNSERIALIZABLE;
  }
}

/** Render a cause that is not an Error, keeping its type legible. */
function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  // Quoted, so an empty-string cause is distinguishable from a missing one.
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return stringifyObject(value);
  if (typeof value === "function") return "[Function]";
  try {
    return String(value);
  } catch {
    return UNSERIALIZABLE;
  }
}

/**
 * The frame lines of a stack, without the `Name: message` header V8 prepends —
 * the caller has already printed that, and repeating it doubles every cause.
 */
function stackFrames(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split("\n");
  const firstFrame = lines.findIndex((line) => /^\s+at\s/.test(line));
  const frames = firstFrame === -1 ? lines : lines.slice(firstFrame);
  const joined = frames.join("\n");
  return joined.trim().length > 0 ? joined : undefined;
}

/**
 * The `.cause` chain as `Caused by:` blocks, in the shape a chained traceback
 * takes everywhere else. Walked iteratively — a cause chain is a list, not a
 * tree — with a `seen` set against cycles, mirroring
 * `gitOperationErrors.isMissingGitExecutableError`.
 */
function formatCauses(root: unknown): string[] {
  const blocks: string[] = [];
  const seen = new Set<unknown>();
  if (typeof root === "object" && root !== null) seen.add(root);

  let current: unknown = root;
  for (let depth = 0; hasCause(current); depth += 1) {
    if (depth >= MAX_CAUSE_DEPTH) {
      blocks.push(`Caused by: ${MAX_DEPTH}`);
      break;
    }
    const cause = readUnknown(current, "cause");
    if (typeof cause === "object" && cause !== null) {
      if (seen.has(cause)) {
        blocks.push(`Caused by: ${CIRCULAR}`);
        break;
      }
      seen.add(cause);
    }

    if (isErrorLike(cause)) {
      const name = readString(cause, "name") ?? "Error";
      const message = readString(cause, "message") ?? "";
      const code = extractCode(cause);
      const header =
        `Caused by: ${name}${message ? `: ${message}` : ""}` + (code ? ` (code: ${code})` : "");
      const frames = stackFrames(readString(cause, "stack"));
      blocks.push(frames ? `${header}\n${frames}` : header);
    } else {
      blocks.push(`Caused by: ${formatValue(cause)}`);
    }

    current = cause;
  }

  return blocks;
}

/** The message a plugin's thrown value carries, whatever kind of value it is. */
function extractMessage(error: unknown): string {
  if (isErrorLike(error)) return readString(error, "message") || FALLBACK_MESSAGE;
  if (typeof error === "string") return error || FALLBACK_MESSAGE;
  if (error === null || error === undefined) return FALLBACK_MESSAGE;
  // A thrown plain object reads `[object Object]` through `String`, which tells
  // the author nothing about what threw.
  return formatValue(error) || FALLBACK_MESSAGE;
}

function buildTrace(error: unknown, componentStack: string | null | undefined): string {
  return [
    "Stack:",
    readString(error, "stack") || "No stack trace available",
    ...formatCauses(error).flatMap((block) => ["", block]),
    "",
    "Component stack:",
    componentStack || "No component stack available",
  ].join("\n");
}

export interface PluginViewDiagnosticsInput {
  /** Whatever the view threw — React stores it unnormalized, so not always an Error. */
  error: unknown;
  componentStack: string | null | undefined;
  /** The owning plugin loads from a dir outside the managed plugins dir. */
  devMode: boolean;
  pluginId: string;
  pluginDisplayName: string;
  kindId: string;
  panelDisplayName: string;
  componentPath: string;
  incidentId: string | null | undefined;
}

export interface PluginViewDiagnostics {
  /** Redaction policy already applied — safe to render as-is. */
  message: string;
  /** Structured error code, when the thrown value carried one. */
  code: string | undefined;
  /** Stack, cause chain and component stack, redaction policy already applied. */
  trace: string;
  /** How this document was produced: `redacted` or `raw (dev mode)`. */
  mode: string;
  /** The copyable report. */
  report: string;
}

/**
 * Build the diagnostics an errored plugin view shows and copies.
 *
 * Everything a plugin author controls — the message, the cause chain, the
 * stacks — is untrusted text: the author decides what goes in it, and it
 * routinely carries absolute paths, credentialed URLs, request payloads and
 * tokens. So the *whole* document is scrubbed for an installed plugin, not just
 * the trace, and the report says which of the two it is (#12281). This is not a
 * reversal of #9427, which keeps the sibling `ErrorFallback`'s message raw: that
 * message is first-party Daintree text, where scrubbing costs signal and
 * prevents no leak. The trust boundary differs, so the policy does.
 *
 * A dev-mode plugin's paths are the author's own, so raw output is the useful
 * output there — labelled as raw rather than silently different.
 *
 * The assembled report is scrubbed a second time. `scrubReportText` is
 * idempotent, so this costs nothing on the fields already scrubbed above, and
 * it means a field added to the report later cannot ship raw the way `Message:`
 * did — which is the bug this function exists to close.
 */
export function buildPluginViewDiagnostics({
  error,
  componentStack,
  devMode,
  pluginId,
  pluginDisplayName,
  kindId,
  panelDisplayName,
  componentPath,
  incidentId,
}: PluginViewDiagnosticsInput): PluginViewDiagnostics {
  const scrub = (text: string): string => (devMode ? text : scrubReportText(text));

  const message = scrub(extractMessage(error));
  const rawCode = extractCode(error);
  const code = rawCode === undefined ? undefined : scrub(rawCode);
  const trace = scrub(buildTrace(error, componentStack));
  const mode = devMode ? "raw (dev mode)" : "redacted";

  const report = [
    `Plugin: ${pluginDisplayName} (${pluginId})`,
    `Panel: ${panelDisplayName} (${kindId})`,
    `Module: ${componentPath}`,
    ...(incidentId ? [`Error ID: ${incidentId}`] : []),
    ...(code ? [`Code: ${code}`] : []),
    `Report: ${mode}`,
    "",
    `Message: ${message}`,
    "",
    trace,
  ].join("\n");

  return { message, code, trace, mode, report: scrub(report) };
}
