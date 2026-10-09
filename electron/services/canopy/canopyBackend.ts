/**
 * Canopy's own service, credential-free: a light classifier-only read
 * (`/v1/classify`) for every changed screen, and a streamed read that writes a
 * run's card field by field (`/v1/read`). The prompts are built on the
 * service's side, and every card it writes goes through `toDescriberResult`.
 *
 * Screen text reaches the service already redacted by the canopy service, and
 * none of it is ever logged here.
 */
import { CANOPY_CATEGORIES, type CanopyCategory } from "../../../shared/types/ipc/canopy.js";
import { cleanStatusLine } from "./canopyScreen.js";
import {
  CanopyProviderError,
  toDescriberResult,
  toPartialDescription,
  type CanopyPartialDescription,
  type CanopyScreenInput,
  type ClassifierResult,
  type DescriberResult,
  type RawCanopyCard,
} from "./canopyProviders.js";

export const CANOPY_SERVICE_URL_ENV = "DAINTREE_CANOPY_URL";
const DEFAULT_SERVICE_URL = "https://canopy.daintree.org";
const USER_AGENT = "Daintree-Canopy/0.2";
/**
 * Longest a read waits for its first event. A worker waking from idle can take
 * minutes; the row shows the screen's own words meanwhile, and the next poll
 * tries again rather than holding a slot the whole time.
 */
const FIRST_EVENT_TIMEOUT_MS = 15_000;
/** Longest a whole read may run, its card included. */
const READ_TIMEOUT_MS = 45_000;
/** Longest a read waits out a rate limit or a starting worker before trying again. */
const RETRY_WAIT_MAX_MS = 4_000;
/** How long a worker is given to wake on a ping before the ping gives up. */
const WAKE_TIMEOUT_MS = 300_000;
/**
 * The card fields worth showing before the card is finished: its words. Its
 * state and score wait for the whole card (see `CanopyPartialDescription`).
 */
const STREAMED_FIELDS: ReadonlySet<string> = new Set(["headline", "summary"]);

export function canopyServiceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[CANOPY_SERVICE_URL_ENV]?.trim();
  return (configured || DEFAULT_SERVICE_URL).replace(/\/+$/, "");
}

/**
 * The service rate limits per address, so one 429 means every read from this
 * machine is over: they all hold off until it passes, rather than each finding
 * out for itself.
 */
let holdUntil = 0;

export function __resetCanopyBackendForTests(): void {
  holdUntil = 0;
  waking = null;
  classifyEndpoint = true;
}

type Stage = "classifier" | "describer";

class RetryableError extends CanopyProviderError {
  constructor(
    stage: Stage,
    message: string,
    readonly retryAfterMs: number
  ) {
    super(stage, message, true);
  }
}

interface ReadHandlers {
  onField?: (name: string, value: unknown) => void;
}

interface ReadOutcome {
  classifier: ClassifierResult;
  card: Record<string, unknown> | null;
}

/** The input as the service takes it: everything but main's own bookkeeping. */
function wireInput(
  input: CanopyScreenInput
): Omit<CanopyScreenInput, "runId" | "failureRepeatsCap"> {
  const { runId: _runId, failureRepeatsCap: _cap, ...rest } = input;
  return rest;
}

function retryAfterMs(header: string | null, fallbackMs: number): number {
  const jitter = Math.round(Math.random() * 400);
  if (header === null) return fallbackMs + jitter;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000) + jitter;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) + jitter : fallbackMs + jitter;
}

function sleep(stage: Stage, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CanopyProviderError(stage, "request cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CanopyProviderError(stage, "request cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function probability(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The classifier event, checked: already on the app's scales, so only held to them. */
export function toClassifierResult(data: unknown): ClassifierResult {
  if (typeof data !== "object" || data === null) {
    throw new CanopyProviderError("classifier", "unexpected response shape");
  }
  const raw = data as Record<string, unknown>;
  const category = raw.category;
  if (typeof category !== "string" || !CANOPY_CATEGORIES.includes(category as CanopyCategory)) {
    throw new CanopyProviderError("classifier", "unexpected response shape");
  }
  const asks = category === "approval" || category === "question";
  const picked = text(raw.status);
  const status = picked === null ? null : cleanStatusLine(picked);
  return {
    category: category as CanopyCategory,
    confidence: probability(raw.confidence),
    attention: probability(raw.attention),
    blocked: probability(raw.blocked),
    notable: probability(raw.notable),
    question: asks ? text(raw.question) : null,
    status: status !== null && status.length >= 4 ? status : null,
  };
}

/** Codes a stream ends with that the next read may not meet. */
const PASSING_STREAM_ERRORS: ReadonlySet<string> = new Set([
  "worker_disconnected",
  "inference_timeout",
  "no_workers_available",
]);
/** Every code the service names; anything else is reported as a bare failure. */
const STREAM_ERROR_CODES: ReadonlySet<string> = new Set([
  ...PASSING_STREAM_ERRORS,
  "inference_failed",
  "bad_request",
  "rate_limited",
]);

/**
 * A stream that failed after it started, by its code alone: the rest of the
 * event can echo the request back.
 */
function streamError(stage: Stage, data: string): CanopyProviderError {
  let code: unknown = null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "object" && parsed !== null) {
      const raw = parsed as Record<string, unknown>;
      code = raw.code ?? raw.error;
    }
  } catch {
    // A code is all that is read from it; without one it is a failure all the same.
  }
  const known = typeof code === "string" && STREAM_ERROR_CODES.has(code) ? code : null;
  return new CanopyProviderError(
    stage,
    known ? `stream failed: ${known}` : "stream failed",
    known === null || PASSING_STREAM_ERRORS.has(known)
  );
}

/**
 * One streamed read. Events are handed on as they arrive; the promise settles
 * once the stream ends, with the classifier's reading and the finished card.
 */
async function readOnce(
  input: CanopyScreenInput,
  describe: "never" | "always",
  classifierSays: CanopyCategory | null,
  signal: AbortSignal | undefined,
  handlers: ReadHandlers
): Promise<ReadOutcome> {
  // A card read's failures are the describer's from the start: its classifier
  // came from `/v1/classify`, whose successes must not clear them.
  const stage: Stage = describe === "always" ? "describer" : "classifier";
  const controller = new AbortController();
  let timedOut = false;
  const timeOut = () => {
    timedOut = true;
    controller.abort();
  };
  const firstEvent = setTimeout(timeOut, FIRST_EVENT_TIMEOUT_MS);
  const whole = setTimeout(timeOut, READ_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const fail = (error: unknown): never => {
    if (error instanceof CanopyProviderError) throw error;
    if (signal?.aborted) throw new CanopyProviderError(stage, "request cancelled");
    // No answer is most often a worker still waking: ping it awake for the next read.
    wakeCanopy();
    if (timedOut) throw new CanopyProviderError(stage, "request timed out", true);
    throw new CanopyProviderError(stage, "request failed", true);
  };

  try {
    let response: Response;
    try {
      response = await fetch(`${canopyServiceUrl()}/v1/read`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          input: wireInput(input),
          describe,
          tier: "paid",
          stream: true,
          ...(classifierSays ? { classifier_says: classifierSays } : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      return fail(error);
    }
    if (response.status === 429) {
      const wait = retryAfterMs(response.headers.get("retry-after"), 2_000);
      holdUntil = Math.max(holdUntil, Date.now() + wait);
      throw new RetryableError(stage, "HTTP 429", wait);
    }
    if (response.status === 503) {
      wakeCanopy();
      throw new RetryableError(
        stage,
        "HTTP 503",
        retryAfterMs(response.headers.get("retry-after"), 2_000)
      );
    }
    // The status alone: an error body can echo the request back.
    if (!response.ok || !response.body) {
      const gateway = response.status === 502 || response.status === 504;
      if (gateway) wakeCanopy();
      throw new CanopyProviderError(stage, `HTTP ${response.status}`, gateway);
    }

    let classifier: ClassifierResult | null = null;
    let card: Record<string, unknown> | null = null;
    let done = false;
    const dispatch = (event: string, data: string) => {
      if (event === "error") throw streamError(stage, data);
      if (event === "" || data === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new CanopyProviderError(stage, "response was not JSON");
      }
      if (event === "classifier") {
        clearTimeout(firstEvent);
        classifier = toClassifierResult(parsed);
      } else if (event === "field") {
        const field = parsed as { name?: unknown; value?: unknown };
        if (typeof field.name === "string") handlers.onField?.(field.name, field.value);
      } else if (event === "card") {
        const raw = parsed as Record<string, unknown>;
        // Generation stopped part way: as broken as a stream cut off.
        if (raw._incomplete === true) throw new CanopyProviderError("describer", "card cut off");
        card = raw;
      } else if (event === "done") {
        done = true;
      }
    };

    try {
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let event = "";
      let data = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line === "") {
            dispatch(event, data);
            event = "";
            data = "";
          } else if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            data += (data === "" ? "" : "\n") + line.slice(5).replace(/^ /, "");
          }
        }
      }
      // A last line the stream ended without a newline after.
      const last = buffer.replace(/\r$/, "");
      if (last.startsWith("data:"))
        data += (data === "" ? "" : "\n") + last.slice(5).replace(/^ /, "");
      else if (last.startsWith("event:")) event = last.slice(6).trim();
      dispatch(event, data);
    } catch (error) {
      return fail(error);
    }
    // A stream closed by a cancel or a timeout ends quietly; say which it was.
    if (signal?.aborted) throw new CanopyProviderError(stage, "request cancelled");
    if (timedOut) return fail(new Error("timed out"));
    if (classifier === null) throw new CanopyProviderError("classifier", "stream ended early");
    if (describe === "always" && card === null) {
      throw new CanopyProviderError("describer", "stream ended early");
    }
    // Everything came but the end: a connection cut before the service was done.
    if (!done) throw new CanopyProviderError(stage, "stream ended early", true);
    return { classifier, card };
  } finally {
    clearTimeout(firstEvent);
    clearTimeout(whole);
    signal?.removeEventListener("abort", onAbort);
    // A read that ended early stops the stream behind it; one that finished has nothing left.
    controller.abort();
  }
}

/**
 * A request, waiting out a rate limit another read already met, and retried
 * once when the service says to come back shortly: a burst over the limit, or
 * no worker free just then. Never retried once events have arrived.
 */
async function withRetry<T>(
  stage: Stage,
  signal: AbortSignal | undefined,
  once: () => Promise<T>
): Promise<T> {
  const attempt = async () => {
    if (signal?.aborted) throw new CanopyProviderError(stage, "request cancelled");
    // A worker being woken: wait for it rather than send a read it can't answer yet.
    if (waking) {
      const ready = await Promise.race([
        waking.then(() => true),
        sleep(stage, FIRST_EVENT_TIMEOUT_MS, signal).then(() => false),
      ]);
      if (!ready) throw new CanopyProviderError(stage, "service waking", true);
    }
    // Checked before every attempt, and again after each wait: another read
    // may have met the limit meanwhile, and pushed it further out.
    // One deadline across every wait, so extensions can't add up past it.
    const deadline = Date.now() + RETRY_WAIT_MAX_MS;
    for (let held = holdUntil - Date.now(); held > 0; held = holdUntil - Date.now()) {
      if (holdUntil > deadline) throw new CanopyProviderError(stage, "HTTP 429", true);
      await sleep(stage, held, signal);
    }
    // A cancel can land while a wait above was settling.
    if (signal?.aborted) throw new CanopyProviderError(stage, "request cancelled");
    return once();
  };
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof RetryableError) || signal?.aborted) throw error;
    if (error.retryAfterMs > RETRY_WAIT_MAX_MS) throw error;
    await sleep(stage, error.retryAfterMs, signal);
    return attempt();
  }
}

function read(
  input: CanopyScreenInput,
  describe: "never" | "always",
  classifierSays: CanopyCategory | null,
  signal: AbortSignal | undefined,
  handlers: ReadHandlers
): Promise<ReadOutcome> {
  const stage: Stage = describe === "always" ? "describer" : "classifier";
  return withRetry(stage, signal, () =>
    readOnce(input, describe, classifierSays, signal, handlers)
  );
}

/**
 * Whether the service has the classifier-only endpoint. A service from before
 * it answers 404 once, and is read through the streamed path from then on.
 */
let classifyEndpoint = true;

/**
 * One classifier-only reading through `POST /v1/classify`: one JSON answer, no
 * stream, and on the workers' light lane, so a fleet busy writing cards never
 * holds up the watch that lights the toolbar.
 */
async function classifyOnce(
  input: CanopyScreenInput,
  signal: AbortSignal | undefined
): Promise<ClassifierResult> {
  const stage: Stage = "classifier";
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FIRST_EVENT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const fail = (): never => {
    if (signal?.aborted) throw new CanopyProviderError(stage, "request cancelled");
    wakeCanopy();
    throw new CanopyProviderError(stage, timedOut ? "request timed out" : "request failed", true);
  };
  try {
    let response: Response;
    try {
      response = await fetch(`${canopyServiceUrl()}/v1/classify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ input: wireInput(input), tier: "paid" }),
        signal: controller.signal,
      });
    } catch {
      return fail();
    }
    if (response.status === 404) {
      classifyEndpoint = false;
      return (await readOnce(input, "never", null, signal, {})).classifier;
    }
    if (response.status === 429) {
      const wait = retryAfterMs(response.headers.get("retry-after"), 2_000);
      holdUntil = Math.max(holdUntil, Date.now() + wait);
      throw new RetryableError(stage, "HTTP 429", wait);
    }
    if (response.status === 503) {
      wakeCanopy();
      throw new RetryableError(
        stage,
        "HTTP 503",
        retryAfterMs(response.headers.get("retry-after"), 2_000)
      );
    }
    // The status alone: an error body can echo the request back.
    if (!response.ok) {
      const gateway = response.status === 502 || response.status === 504;
      if (gateway) wakeCanopy();
      throw new CanopyProviderError(stage, `HTTP ${response.status}`, gateway);
    }
    let body: string;
    try {
      body = await response.text();
    } catch {
      // Cut off on the way: the same passing failure as no answer at all.
      return fail();
    }
    if (signal?.aborted) throw new CanopyProviderError(stage, "request cancelled");
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new CanopyProviderError(stage, "response was not JSON");
    }
    const classifier =
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>).classifier
        : undefined;
    return toClassifierResult(classifier);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    // An error answer's body is never read; this lets it go.
    controller.abort();
  }
}

export async function classifyWithCanopy(
  input: CanopyScreenInput,
  signal?: AbortSignal
): Promise<ClassifierResult> {
  // Chosen per attempt, so a retry after the 404 stays on the streamed path.
  return withRetry("classifier", signal, async () =>
    classifyEndpoint
      ? classifyOnce(input, signal)
      : (await readOnce(input, "never", null, signal, {})).classifier
  );
}

/**
 * The run's card, written by the service. `onPartial` hears what the card says
 * so far each time a field worth showing early lands; the promise resolves
 * with the finished card, checked like any other.
 */
export async function describeWithCanopy(
  input: CanopyScreenInput,
  classifierSays: CanopyCategory,
  signal?: AbortSignal,
  onPartial?: (partial: CanopyPartialDescription) => void
): Promise<DescriberResult> {
  const raw: Record<string, unknown> = {};
  const outcome = await read(input, "always", classifierSays, signal, {
    onField: (name, value) => {
      raw[name] = value;
      if (!onPartial || !STREAMED_FIELDS.has(name)) return;
      try {
        onPartial(toPartialDescription(raw as RawCanopyCard));
      } catch {
        // What the row shows early is a courtesy; the finished card is the reading.
      }
    },
  });
  return toDescriberResult(outcome.card, input);
}

let waking: Promise<void> | null = null;

/** A wake ping is still waiting on a worker to start. */
export function canopyWaking(): boolean {
  return waking !== null;
}

/**
 * Wakes a worker before the reads arrive: the service scales to nothing when
 * idle, and the first read after a quiet spell would otherwise wait out the
 * whole start. Best effort; one ping at a time.
 */
export function wakeCanopy(): void {
  if (waking) return;
  waking = fetch(`${canopyServiceUrl()}/ping`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
  })
    .then(
      () => undefined,
      () => undefined
    )
    .finally(() => {
      waking = null;
    });
}
