import {
  PLUGIN_TASK_DETAIL_MAX,
  PLUGIN_TASK_MESSAGE_MAX,
  PLUGIN_TASK_RETRY_ARGS_MAX_BYTES,
  PLUGIN_TASK_TITLE_MAX,
  type PluginTaskAbortCause,
  type PluginTaskHandle,
  type PluginTaskProgress,
  type PluginTaskResult,
} from "../types/plugin.js";
import { readField } from "./pluginWorktreeCardStatus.js";

/** A vetted `PluginTaskStartOptions`, with its defaults filled in. */
export interface VettedPluginTaskStart {
  title: string;
  detail?: string;
  cancellable: boolean;
  fraction: number | null;
  /** Still in the manifest namespace; the host rewrites it, since only it knows the caller. */
  retry: { actionId: string; args?: Record<string, unknown> };
}

type Vetted<T> = { ok: true; value: T } | { ok: false; error: string };

const START_KEYS = new Set(["title", "detail", "cancellable", "fraction", "retry"]);
const RETRY_KEYS = new Set(["actionId", "args"]);
const PROGRESS_KEYS = new Set(["fraction", "detail"]);
const RESULT_KEYS = new Set(["outcome", "message"]);

function unknownKey(value: object, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(value).find((key) => !allowed.has(key));
}

function isPlainObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function vetLine(value: unknown, field: string, max: number): Vetted<string> {
  if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
  const trimmed = value.trim();
  if (/[\r\n]/.test(trimmed)) return { ok: false, error: `${field} must be a single line` };
  if (trimmed.length > max) {
    return { ok: false, error: `${field} must be at most ${max} characters` };
  }
  return { ok: true, value: trimmed };
}

function vetFraction(value: unknown, field: string): Vetted<number | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return { ok: false, error: `${field} must be a number from 0 to 1, or null` };
  }
  return { ok: true, value };
}

function vetRetryArgs(args: unknown): Vetted<Record<string, unknown>> {
  if (!isPlainObject(args)) return { ok: false, error: "retry.args must be an object" };
  let json: string | undefined;
  try {
    json = JSON.stringify(args);
  } catch {
    json = undefined;
  }
  if (
    json === undefined ||
    new TextEncoder().encode(json).length > PLUGIN_TASK_RETRY_ARGS_MAX_BYTES
  ) {
    return {
      ok: false,
      error: `retry.args must be JSON-serializable and at most ${PLUGIN_TASK_RETRY_ARGS_MAX_BYTES} bytes`,
    };
  }
  // A copy, so nothing the plugin still holds can change what a later Retry runs.
  // Checked again after the round trip: a `toJSON` can turn an object into
  // something else, and notify would then refuse the Retry the task needs.
  const copy: unknown = JSON.parse(json);
  if (!isPlainObject(copy)) {
    return { ok: false, error: "retry.args must serialize to a JSON object" };
  }
  return { ok: true, value: copy as Record<string, unknown> };
}

/**
 * Vet one `host.tasks.start(options)` call (#13819). Returns a fresh plain
 * copy, so nothing the plugin still holds can change what the host stores.
 * Shared by the in-process host, the worker proxy and the mock host so every
 * host accepts and refuses exactly the same calls. Whether `retry` names one
 * of the plugin's own actions is the host's check, not this one's.
 */
export function validatePluginTaskStart(options: unknown): Vetted<VettedPluginTaskStart> {
  if (!isPlainObject(options)) {
    return { ok: false, error: "options must be an object with a title and a retry" };
  }
  const extra = unknownKey(options, START_KEYS);
  if (extra !== undefined)
    return { ok: false, error: `options has an unsupported field "${extra}"` };

  const title = vetLine(readField(options, "title"), "title", PLUGIN_TASK_TITLE_MAX);
  if (!title.ok) return title;
  if (title.value.length === 0) return { ok: false, error: "title must not be empty" };

  let detail: string | undefined;
  const rawDetail = readField(options, "detail");
  if (rawDetail !== undefined) {
    const vetted = vetLine(rawDetail, "detail", PLUGIN_TASK_DETAIL_MAX);
    if (!vetted.ok) return vetted;
    if (vetted.value.length > 0) detail = vetted.value;
  }

  const cancellable = readField(options, "cancellable");
  if (cancellable !== undefined && typeof cancellable !== "boolean") {
    return { ok: false, error: "cancellable must be a boolean" };
  }

  let fraction: number | null = null;
  const rawFraction = readField(options, "fraction");
  if (rawFraction !== undefined) {
    const vetted = vetFraction(rawFraction, "fraction");
    if (!vetted.ok) return vetted;
    fraction = vetted.value;
  }

  const retry = readField(options, "retry");
  if (!isPlainObject(retry)) {
    return {
      ok: false,
      error: 'retry must be one of this plugin\'s own actions, { actionId: "<name>.<id>" }',
    };
  }
  const extraRetry = unknownKey(retry, RETRY_KEYS);
  if (extraRetry !== undefined) {
    return { ok: false, error: `retry has an unsupported field "${extraRetry}"` };
  }
  const actionId = readField(retry, "actionId");
  if (typeof actionId !== "string" || actionId.length === 0 || actionId.length > 200) {
    return {
      ok: false,
      error: "retry.actionId must be a non-empty string of at most 200 characters",
    };
  }
  let args: Record<string, unknown> | undefined;
  const rawArgs = readField(retry, "args");
  if (rawArgs !== undefined) {
    const vetted = vetRetryArgs(rawArgs);
    if (!vetted.ok) return vetted;
    args = vetted.value;
  }

  return {
    ok: true,
    value: {
      title: title.value,
      ...(detail !== undefined ? { detail } : {}),
      cancellable: cancellable === true,
      fraction,
      retry: { actionId, ...(args !== undefined ? { args } : {}) },
    },
  };
}

/**
 * Vet one `PluginTaskHandle.report(progress)` call. An omitted field keeps its
 * last value, so the copy only carries what the plugin passed. `detail: ""`
 * survives as the clear it asks for.
 */
export function validatePluginTaskProgress(progress: unknown): Vetted<PluginTaskProgress> {
  if (!isPlainObject(progress)) return { ok: false, error: "progress must be an object" };
  const extra = unknownKey(progress, PROGRESS_KEYS);
  if (extra !== undefined) {
    return { ok: false, error: `progress has an unsupported field "${extra}"` };
  }
  const value: PluginTaskProgress = {};
  const rawFraction = readField(progress, "fraction");
  if (rawFraction !== undefined) {
    const vetted = vetFraction(rawFraction, "progress.fraction");
    if (!vetted.ok) return vetted;
    value.fraction = vetted.value;
  }
  const rawDetail = readField(progress, "detail");
  if (rawDetail !== undefined) {
    const vetted = vetLine(rawDetail, "progress.detail", PLUGIN_TASK_DETAIL_MAX);
    if (!vetted.ok) return vetted;
    value.detail = vetted.value;
  }
  return { ok: true, value };
}

/** Vet one `PluginTaskHandle.finish(result)` call. */
export function validatePluginTaskResult(result: unknown): Vetted<PluginTaskResult> {
  if (!isPlainObject(result))
    return { ok: false, error: "result must be an object with an outcome" };
  const extra = unknownKey(result, RESULT_KEYS);
  if (extra !== undefined)
    return { ok: false, error: `result has an unsupported field "${extra}"` };
  const outcome = readField(result, "outcome");
  const rawMessage = readField(result, "message");
  let message: string | undefined;
  if (rawMessage !== undefined) {
    if (typeof rawMessage !== "string")
      return { ok: false, error: "result.message must be a string" };
    message = rawMessage.trim();
    if (message.length > PLUGIN_TASK_MESSAGE_MAX) {
      return {
        ok: false,
        error: `result.message must be at most ${PLUGIN_TASK_MESSAGE_MAX} characters`,
      };
    }
  }
  switch (outcome) {
    case "succeeded":
      return {
        ok: true,
        value: { outcome, ...(message !== undefined && message.length > 0 ? { message } : {}) },
      };
    case "failed":
      if (message === undefined || message.length === 0) {
        return { ok: false, error: "a failed task needs a message saying what went wrong" };
      }
      return { ok: true, value: { outcome, message } };
    case "cancelled":
      if (rawMessage !== undefined) {
        return { ok: false, error: "a cancelled task takes no message: it shows nothing" };
      }
      return { ok: true, value: { outcome } };
    default:
      return { ok: false, error: 'result.outcome must be "succeeded", "failed" or "cancelled"' };
  }
}

/** Fold a newer progress report into an older one still waiting to be sent. */
export function mergePluginTaskProgress(
  older: PluginTaskProgress | undefined,
  newer: PluginTaskProgress
): PluginTaskProgress {
  return older === undefined ? { ...newer } : { ...older, ...newer };
}

const ABORT_MESSAGES: Record<PluginTaskAbortCause, string> = {
  cancelled: "The user cancelled the task",
  interrupted: "The plugin stopped before the task finished",
};

/**
 * The `reason` a task's signal aborts with: an `AbortError`, as a bare
 * `abort()` gives, whose `cause` says whether the user cancelled or the host
 * interrupted.
 */
export function pluginTaskAbortReason(cause: PluginTaskAbortCause): DOMException {
  const reason = new DOMException(ABORT_MESSAGES[cause], "AbortError");
  Object.defineProperty(reason, "cause", { value: cause, enumerable: false });
  return reason;
}

/**
 * The cause a task signal's reason carries. Anything else — a relay that lost
 * it, a bare `abort()` — reads as `"interrupted"`, the one that writes nothing
 * durable.
 */
export function pluginTaskAbortCause(reason: unknown): PluginTaskAbortCause {
  return typeof reason === "object" &&
    reason !== null &&
    (reason as { cause?: unknown }).cause === "cancelled"
    ? "cancelled"
    : "interrupted";
}

const inertHandles = new WeakSet<PluginTaskHandle>();

/**
 * The handle `tasks.start` gives a plugin that is no longer loaded: already
 * aborted, and every method a no-op, so a timer firing after unload neither
 * throws nor shows anything.
 */
export function inertPluginTaskHandle(): PluginTaskHandle {
  const controller = new AbortController();
  controller.abort(pluginTaskAbortReason("interrupted"));
  const handle: PluginTaskHandle = {
    id: globalThis.crypto.randomUUID(),
    signal: controller.signal,
    report: () => {},
    finish: () => Promise.resolve(),
  };
  inertHandles.add(handle);
  return handle;
}

/**
 * Whether a handle is {@link inertPluginTaskHandle}'s. An aborted signal alone
 * doesn't say: a real task the user cancelled at once is aborted too, and
 * still needs its finish.
 */
export function isInertPluginTaskHandle(handle: PluginTaskHandle): boolean {
  return inertHandles.has(handle);
}
