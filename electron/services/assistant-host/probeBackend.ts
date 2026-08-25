import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type {
  AssistantBackendProbeResult,
  AssistantBackendVersionInfo,
} from "../../../shared/types/ipc/assistantHostBackendProbe.js";

/**
 * Ask a backend origin what it is, and refuse anything that is not one.
 *
 * This exists because of a specific, expensive confusion: `staging.daintree.org` is
 * Daintree's WEBSITE, and for a while the Staging environment pointed the assistant at
 * it. A website answers — cheerfully, with 200s and HTML — so the failure did not
 * present as "wrong host". It presented as a JSON parse error deep inside the engine,
 * which reads like a broken assistant rather than a misaddressed one.
 *
 * So the checks are about the SHAPE of the answer, not just its status:
 *
 *  - A redirect is refused rather than followed. Following one is how a probe ends up
 *    reporting on a host nobody selected — a marketing catch-all, a login wall, an SSO
 *    portal — as though it were the backend.
 *  - A non-JSON body is refused by media type AND by parse, because a server that
 *    labels HTML as JSON is exactly as wrong as one that does not.
 *  - The body has to carry the field a real backend carries. A JSON 404 page is still
 *    not a backend.
 *
 * ## What this deliberately does not repeat back
 *
 * The result is rendered in Settings and copied into bug reports, so everything derived
 * from a remote answer is treated as untrusted text: a redirect target is reduced to its
 * ORIGIN (a login redirect's query carries codes and state), version strings are bounded,
 * and no request carries credentials, so nothing sensitive of ours can be echoed back.
 * A server can still put anything it likes in its own body — see `MAX_SNIPPET`.
 */

/** Whole-operation budget: headers AND body. A server can stall either. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * How much of a body is read at all.
 *
 * Small on purpose. A `/version` document is a few hundred bytes; anything larger is
 * either not this backend or not worth buffering to find out. Enforced while STREAMING
 * rather than after `text()`, so a server cannot make the probe hold a large page in
 * memory just by sending one.
 */
const MAX_BODY_BYTES = 64 * 1024;

/** Enough of a body to name the problem, never enough to paste a page into a report. */
const MAX_SNIPPET = 200;

/** Bounded so a hostile or broken server cannot put an essay in a settings row. */
const MAX_VERSION_LEN = 100;

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function probeAssistantBackend(
  origin: string,
  opts: ProbeOptions = {}
): Promise<AssistantBackendProbeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  // Cleared in the `finally` at the very end, NOT when headers arrive: a server that
  // flushes headers and then stalls its body would otherwise hold this open forever.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  timer.unref?.();

  try {
    let response: Response;
    try {
      response = await doFetch(versionUrl(origin), {
        method: "GET",
        // Manual, so a 3xx arrives here as a RESULT to refuse rather than being chased.
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
    } catch (error) {
      return {
        reachable: false,
        code: "unreachable",
        detail: formatErrorMessage(error, "The request did not complete."),
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      // The body of a refused redirect is never read, so it is cancelled explicitly —
      // undici keeps the connection reserved until a body is consumed or cancelled.
      await response.body?.cancel().catch(() => {});
      return {
        reachable: false,
        code: "redirected",
        // The ORIGIN only. A login redirect's query string carries authorization codes
        // and state, and this string is rendered and copied.
        detail: location ? `redirected to ${safeOrigin(location, origin)}` : "redirected",
      };
    }

    const mediaType = (response.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    let body: string;
    try {
      body = await readBounded(response);
    } catch (error) {
      // A body that failed or timed out mid-read is a TRANSPORT failure, not a wrong
      // host — reporting it as "not a backend" would send the reader to change a
      // setting that is correct.
      return {
        reachable: false,
        code: "unreachable",
        detail: formatErrorMessage(error, "The response body did not arrive."),
      };
    }

    if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
      return {
        reachable: false,
        code: "not-a-backend",
        detail: `answered with ${mediaType || "no content type"}: ${snippet(body)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Labelled JSON, and is not. Same conclusion, different route to it.
      return { reachable: false, code: "not-a-backend", detail: snippet(body) };
    }

    if (!response.ok) {
      // Status only. A backend's own error body is not something to quote into a report.
      return { reachable: false, code: "http-error", detail: `HTTP ${response.status}` };
    }

    const version = readVersion(parsed);
    if (!version) {
      // Well-formed JSON from something that is not this backend.
      return { reachable: false, code: "not-a-backend", detail: "no server_version in the answer" };
    }
    return { reachable: true, version };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `{origin}/version`, keeping any path prefix the origin already has.
 *
 * `new URL("/version", origin)` would DISCARD it, and a path-prefixed backend is a
 * configuration `resolveBackendUrl` explicitly permits — so the probe would report on
 * `/version` while the engine talked to `/api/version`, and disagree with it about
 * whether the endpoint works.
 */
function versionUrl(origin: string): string {
  const url = new URL(origin);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/version`;
  url.search = "";
  url.hash = "";
  // Credentials are not sent on a probe. Undici rejects a URL carrying them and puts the
  // whole thing — password included — into the error message, which this result renders.
  url.username = "";
  url.password = "";
  return url.toString();
}

/** A redirect target reduced to scheme + host, resolved against where we asked. */
function safeOrigin(location: string, base: string): string {
  try {
    return new URL(location, base).origin;
  } catch {
    return "an unparseable address";
  }
}

/**
 * Reads a response body, capped, with the abort signal still live.
 *
 * `response.text()` buffers the whole body before anything can bound it, which lets a
 * server spend the probe's memory rather than its time.
 */
async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function readVersion(value: unknown): AssistantBackendVersionInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const serverVersion = record.server_version;
  if (typeof serverVersion !== "string" || serverVersion === "") return null;
  const buildSha = record.build_sha;
  return {
    serverVersion: bounded(serverVersion),
    ...(typeof buildSha === "string" && buildSha !== "" ? { buildSha: bounded(buildSha) } : {}),
  };
}

/** Remote strings are untrusted text: bounded, and flattened to one line. */
function bounded(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_VERSION_LEN ? `${flat.slice(0, MAX_VERSION_LEN)}…` : flat;
}

/**
 * A body is EVIDENCE, not content.
 *
 * Bounded and flattened. Worth being explicit about what this is: arbitrary text from
 * whatever answered. Nothing of ours can be in it — the probe sends no credentials — but
 * a server is free to put anything in its own body, so this is the one field in the
 * readout that is not ours to vouch for.
 */
function snippet(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SNIPPET ? `${flat.slice(0, MAX_SNIPPET)}…` : flat;
}
