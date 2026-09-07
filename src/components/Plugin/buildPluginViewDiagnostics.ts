import { isErrorLike } from "@shared/utils/ipcErrorSerialization";
import { scrubReportText } from "@shared/utils/reportScrubbers";

/**
 * Depth bound for the `.cause` walk. Past this many links the chain is
 * describing a wrapper stack no reader follows, and an unbounded walk is a
 * denial-of-service surface handed to plugin authors.
 */
const MAX_CAUSE_DEPTH = 8;

/**
 * Bounds on serializing a non-Error cause. `new Error("x", { cause: new
 * Array(0xffffffff) })` costs the author nothing to build and would otherwise
 * park `JSON.stringify` on billions of holes during render.
 */
const MAX_ARRAY_ENTRIES = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_VALUE_CHARS = 4000;

/** Sentinels, spelled as `logErrorNormalization` and `ipcErrorSerialization` spell them. */
const MAX_DEPTH = "[MaxDepth]";
const CIRCULAR = "[Circular]";
const UNSERIALIZABLE = "[Unserializable]";
const TRUNCATED = "[Truncated]";

const FALLBACK_MESSAGE = "Unknown render error";

/**
 * Applies the redaction policy to one leaf string.
 *
 * Threaded down to every leaf rather than run once over the finished document,
 * because both the label and the encoding a leaf ends up inside destroy the
 * anchors the scrubber matches on: `Caused by: Error: access_token=…` is no
 * longer at a line start for `oauth-query-param`'s `(^|[?&])`, and JSON's
 * `"\nghp_…"` puts a literal `n` against the sigil `\bghp_` needs. Scrubbing
 * first and labelling after keeps every pattern anchored where it was written
 * to match.
 */
type Scrub = (text: string) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read one property without ever throwing. Every field here comes off a value a
 * plugin threw, which may be a Proxy or expose a throwing getter — the
 * diagnostics pane must not become the second failure.
 */
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
  if (!isRecord(value)) return false;
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
 * Readable JSON for an object that is not an Error, scrubbed as it is walked.
 *
 * `JSON.stringify` throws on cycles, BigInt and a hostile `toJSON`, and
 * overflows the stack on a pathologically deep graph — all of which land in the
 * `catch`. The `seen` set is never unwound, so a value referenced twice reads
 * `[Circular]` the second time even without a true cycle;
 * `ipcErrorSerialization` makes the same trade for the same reason.
 */
function stringifyObject(value: object, scrub: Scrub): string {
  const seen = new WeakSet<object>();
  let json: string | undefined;
  try {
    json = JSON.stringify(
      value,
      (_key, item: unknown) => {
        if (typeof item === "string") return scrub(item);
        if (typeof item === "bigint") return String(item);
        if (isErrorLike(item)) {
          return {
            name: readString(item, "name") ?? "Error",
            message: readString(item, "message") ?? "",
            // Frames only. A stack's `Name: message` header carries a second,
            // unanchored copy of the message, which the line-anchored patterns
            // then miss — and the `message` field above already has it.
            stack: stackFrames(readString(item, "stack")),
          };
        }
        // A boxed primitive is an object with indexed own properties, so the
        // record branch below would explode `new String(token)` into one
        // property per character and scrub none of them.
        const boxed = unboxPrimitive(item);
        if (boxed !== undefined) return typeof boxed === "string" ? scrub(boxed) : boxed;
        if (!isRecord(item)) return item;
        if (seen.has(item)) return CIRCULAR;
        seen.add(item);
        if (Array.isArray(item)) {
          return item.length > MAX_ARRAY_ENTRIES
            ? [...item.slice(0, MAX_ARRAY_ENTRIES), TRUNCATED]
            : item;
        }
        const entries = Object.entries(item);
        if (entries.length <= MAX_OBJECT_KEYS) return item;
        // Only the over-wide case is rebuilt, and it keeps the original keys:
        // rewriting them collapses `/Users/alice/f` and `/Users/bob/f` onto one
        // entry, silently dropping a diagnostic. Keys are covered by the text
        // pass below instead. Null-prototype so an own `__proto__` entry lands
        // as data rather than hitting the setter.
        const capped: Record<string, unknown> = Object.create(null);
        for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) capped[key] = child;
        capped[TRUNCATED] = entries.length - MAX_OBJECT_KEYS;
        return capped;
      },
      2
    );
  } catch {
    return UNSERIALIZABLE;
  }
  if (json === undefined) return UNSERIALIZABLE;
  // A second pass over the encoded text, because some patterns match a key and
  // its value together (`"SecretAccessKey": "…"`) and so can never fire while
  // each leaf is scrubbed in isolation. This also covers the keys.
  const scrubbed = scrub(json);
  // Safe to cut only after both passes: a slice through raw text would leave
  // the leading bytes of a secret that straddled the boundary.
  return scrubbed.length > MAX_VALUE_CHARS
    ? `${scrubbed.slice(0, MAX_VALUE_CHARS)}\n${TRUNCATED}`
    : scrubbed;
}

/** The primitive inside a boxed `String`/`Number`/`Boolean`, else undefined. */
function unboxPrimitive(value: unknown): string | number | boolean | undefined {
  if (!isRecord(value)) return undefined;
  // Tag rather than `instanceof`: a value from another realm has its own
  // constructors, and these arrive from plugin code.
  switch (Object.prototype.toString.call(value)) {
    case "[object String]":
      return String(value);
    case "[object Number]":
      return Number(value);
    case "[object Boolean]":
      return value.valueOf() === true;
    default:
      return undefined;
  }
}

/** Render a cause that is not an Error, keeping its type legible. */
function formatValue(value: unknown, scrub: Scrub): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  // Scrubbed before quoting, not after: `JSON.stringify` escapes the very
  // characters the secret patterns anchor against.
  if (typeof value === "string") return JSON.stringify(scrub(value));
  if (typeof value === "object") return stringifyObject(value, scrub);
  if (typeof value === "function") return "[Function]";
  // The description alone, then wrapped: scrubbing `Symbol(access_token=…)`
  // would already have moved the value off the anchor its pattern needs.
  if (typeof value === "symbol") return `Symbol(${scrub(value.description ?? "")})`;
  try {
    return scrub(String(value));
  } catch {
    return UNSERIALIZABLE;
  }
}

/**
 * The frame lines of a stack, without the `Name: message` header V8 prepends —
 * the caller has already printed that, and repeating it doubles every cause.
 * A stack with no `at` frames at all (Safari and Firefox spell them
 * `fn@file:line`) is kept whole rather than guessed at.
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
function formatCauses(root: unknown, scrub: Scrub): string[] {
  const blocks: string[] = [];
  const seen = new Set<unknown>();
  if (isRecord(root)) seen.add(root);

  let current: unknown = root;
  for (let depth = 0; hasCause(current); depth += 1) {
    if (depth >= MAX_CAUSE_DEPTH) {
      blocks.push(`Caused by: ${MAX_DEPTH}`);
      break;
    }
    const cause = readUnknown(current, "cause");
    if (isRecord(cause)) {
      if (seen.has(cause)) {
        blocks.push(`Caused by: ${CIRCULAR}`);
        break;
      }
      seen.add(cause);
    }

    if (isErrorLike(cause)) {
      const name = scrub(readString(cause, "name") ?? "Error");
      const message = scrub(readString(cause, "message") ?? "");
      const code = extractCode(cause);
      const header =
        `Caused by: ${name}${message ? `: ${message}` : ""}` +
        (code ? ` (code: ${scrub(code)})` : "");
      const frames = stackFrames(readString(cause, "stack"));
      blocks.push(frames ? `${header}\n${scrub(frames)}` : header);
    } else {
      blocks.push(`Caused by: ${formatValue(cause, scrub)}`);
    }

    current = cause;
  }

  return blocks;
}

/** The message a plugin's thrown value carries, whatever kind of value it is. */
function extractMessage(error: unknown, scrub: Scrub): string {
  const raw = isErrorLike(error)
    ? readString(error, "message")
    : typeof error === "string"
      ? error
      : error === null || error === undefined
        ? undefined
        : // A thrown plain object reads `[object Object]` through `String`,
          // which tells the author nothing about what threw.
          formatValue(error, scrub);
  if (raw === undefined) return FALLBACK_MESSAGE;
  // Whitespace-only would render as an empty pane saying nothing at all.
  const scrubbed = scrub(raw);
  return scrubbed.trim().length > 0 ? scrubbed : FALLBACK_MESSAGE;
}

function buildTrace(
  error: unknown,
  componentStack: string | null | undefined,
  scrub: Scrub
): string {
  return [
    "Stack:",
    scrub(readString(error, "stack") || "No stack trace available"),
    ...formatCauses(error, scrub).flatMap((block) => ["", block]),
    "",
    "Component stack:",
    scrub(componentStack || "No component stack available"),
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
  message: string;
  /** Structured error code, when the thrown value carried one. */
  code: string | undefined;
  /** Stack, cause chain and component stack. */
  trace: string;
  /** How this document was produced: `redacted` or `raw (dev mode)`. */
  mode: string;
  /** The copyable report. */
  report: string;
  /**
   * Identity as the pane should display it. Manifest-supplied, so it is
   * author-controlled text like every other field here — the pane renders
   * these rather than its own props so a screenshot and a copy say the same
   * thing.
   */
  pluginId: string;
  pluginDisplayName: string;
  kindId: string;
  panelDisplayName: string;
  componentPath: string;
  incidentId: string | undefined;
}

/**
 * Build the diagnostics an errored plugin view shows and copies. Every string
 * on the returned object has the redaction policy already applied.
 *
 * Everything a plugin author controls — the message, the cause chain, the
 * stacks, and the manifest identity — is untrusted text: the author decides
 * what goes in it, and it routinely carries absolute paths, credentialed URLs,
 * request payloads and tokens. So the *whole* document is scrubbed for an
 * installed plugin, not just the trace, and it says which of the two it is
 * (#12281).
 *
 * This is not a reversal of #9427. That issue was about the sibling
 * `ErrorBoundary/ErrorFallback`, which shows fixed first-party copy in
 * production and the raw message only under `import.meta.env.DEV` — so it has
 * no untrusted message to redact in the first place. This pane deliberately
 * shows plugin-authored text to a production user, which is exactly why it has
 * to scrub it.
 *
 * A dev-mode plugin's paths are the author's own, so raw output is the useful
 * output there — labelled as raw rather than silently different.
 *
 * The assembled report is scrubbed once more at the end. `scrubReportText` is
 * idempotent, so this costs nothing on fields already scrubbed above, and it
 * means a field added to the report later cannot ship raw the way `Message:`
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
  const scrub: Scrub = (text) => (devMode ? text : scrubReportText(text));

  const identity = {
    pluginId: scrub(pluginId),
    pluginDisplayName: scrub(pluginDisplayName),
    kindId: scrub(kindId),
    panelDisplayName: scrub(panelDisplayName),
    componentPath: scrub(componentPath),
    incidentId: incidentId ? scrub(incidentId) : undefined,
  };

  const message = extractMessage(error, scrub);
  const rawCode = extractCode(error);
  const code = rawCode === undefined ? undefined : scrub(rawCode);
  const trace = scrub(buildTrace(error, componentStack, scrub));
  const mode = devMode ? "raw (dev mode)" : "redacted";

  const report = [
    `Plugin: ${identity.pluginDisplayName} (${identity.pluginId})`,
    `Panel: ${identity.panelDisplayName} (${identity.kindId})`,
    `Module: ${identity.componentPath}`,
    ...(identity.incidentId ? [`Error ID: ${identity.incidentId}`] : []),
    ...(code ? [`Code: ${code}`] : []),
    `Report: ${mode}`,
    "",
    `Message: ${message}`,
    "",
    trace,
  ].join("\n");

  return { ...identity, message, code, trace, mode, report: scrub(report) };
}
