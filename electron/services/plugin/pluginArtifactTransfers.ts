import { createReadStream, createWriteStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import type { LookupFunction } from "node:net";
import dns from "node:dns";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { net as ElectronNet } from "electron";
import {
  PLUGIN_ARTIFACT_IDLE_TIMEOUT_MS,
  PLUGIN_ARTIFACT_UPLOAD_RESPONSE_MAX_BYTES,
} from "../../../shared/config/pluginArtifacts.js";
import type {
  PluginArtifactProgress,
  PluginArtifactUploadResult,
} from "../../../shared/types/pluginArtifacts.js";
import { isPrivateOrLoopbackHostname } from "../../schemas/pluginIdentifiers.js";
import { fetchWithPrivateHostGuard } from "../../utils/pluginDownloadPolicy.js";
import { artifactError } from "./pluginArtifactErrors.js";
import type { ArtifactUrlMatcher } from "./pluginArtifactNetworkPolicy.js";
import { headersForHop } from "./pluginArtifactNetworkPolicy.js";
import type { ArtifactReservation } from "./PluginArtifactStore.js";

type Progress = (progress: PluginArtifactProgress) => void;

/** A failure the next download attempt may get past: a stall, a dropped body, a 503. */
class RetryableError extends Error {}

/** An AbortError carrying the host's `ABORT_ERR` code, so it survives the worker boundary. */
export function transferAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason as { code?: unknown } | undefined;
  // Ours already (an unload's abort); a DOMException's `code` is a read-only number, so never reuse one.
  if (reason instanceof Error && reason.code === "ABORT_ERR") return reason;
  const error = new Error("ABORT_ERR: the transfer was cancelled") as Error & { code: string };
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/**
 * Counts bytes as they pass, holds them against the reservation, and fails
 * the stream once nothing has moved for `idleMs` — a stalled provider must
 * not pin a transfer slot forever.
 */
function meter(options: {
  start: number;
  reservation?: ArtifactReservation;
  maxBytes?: number;
  idleMs: number;
  onBytes: (transferred: number) => void;
}): Transform {
  let transferred = options.start;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.length;
      try {
        if (options.maxBytes !== undefined && transferred > options.maxBytes) {
          throw artifactError(
            "ARTIFACT_TRANSFER_FAILED",
            "the provider sent more bytes than it declared"
          );
        }
        options.reservation?.ensure(transferred);
      } catch (error) {
        callback(error as Error);
        return;
      }
      arm();
      options.onBytes(transferred);
      callback(null, chunk);
    },
    flush(callback) {
      if (idle) clearTimeout(idle);
      callback();
    },
    destroy(error, callback) {
      if (idle) clearTimeout(idle);
      callback(error);
    },
  });
  const arm = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      stream.destroy(new RetryableError(`no data arrived for ${options.idleMs} ms`));
    }, options.idleMs);
    idle.unref?.();
  };
  arm();
  return stream;
}

/**
 * Copy an opened, verified source file into `partPath`. The caller owns the
 * descriptor; the read stream never closes it.
 */
export async function copyHandleToPart(options: {
  handle: FileHandle;
  size: number;
  partPath: string;
  reservation: ArtifactReservation;
  signal: AbortSignal;
  onProgress: Progress;
  idleMs?: number;
}): Promise<number> {
  options.reservation.ensure(options.size);
  let transferred = 0;
  try {
    await pipeline(
      options.handle.createReadStream({ autoClose: false, start: 0 }),
      meter({
        start: 0,
        reservation: options.reservation,
        idleMs: options.idleMs ?? PLUGIN_ARTIFACT_IDLE_TIMEOUT_MS,
        onBytes: (n) => {
          transferred = n;
          options.onProgress({ transferredBytes: n, totalBytes: options.size, attempt: 1 });
        },
      }),
      createWriteStream(options.partPath, { flags: "wx", mode: 0o600 }),
      { signal: options.signal }
    );
  } catch (error) {
    if (options.signal.aborted) throw transferAbortError(options.signal);
    throw error;
  }
  return transferred;
}

export interface DownloadResult {
  size: number;
  contentType: string | null;
  fileName: string | null;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function strongValidator(response: Response): string | null {
  const etag = response.headers.get("etag");
  if (etag && !etag.startsWith("W/")) return etag;
  return response.headers.get("last-modified");
}

function parseContentRange(value: string | null): { start: number; total: number | null } | null {
  const match = value ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value.trim()) : null;
  if (!match) return null;
  const start = Number(match[1]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || (total !== null && !Number.isSafeInteger(total))) return null;
  return { start, total };
}

function fileNameFrom(response: Response, url: URL): string | null {
  const disposition = response.headers.get("content-disposition") ?? "";
  const quoted = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const raw = quoted?.[1] ?? url.pathname.split("/").filter(Boolean).pop() ?? null;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(transferAbortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(transferAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Stream a provider file into `partPath`, retrying up to `attempts` times.
 *
 * Every hop of every attempt goes through {@link fetchWithPrivateHostGuard}:
 * https only, no private targets, and each hop held to the declared scope.
 * The plugin's headers ride only on hops at the origin it asked for.
 *
 * A retry resumes from the bytes already written when the first response
 * carried a strong validator and no content coding. It sends `Range` with
 * `If-Range`, and appends only after the 206's `Content-Range` starts exactly
 * where the file ends; any other answer truncates and starts over. Nothing
 * from an error response is ever written.
 */
export async function downloadToPart(options: {
  netFetch: typeof ElectronNet.fetch;
  url: URL;
  headers: Record<string, string>;
  isAllowed: ArtifactUrlMatcher;
  partPath: string;
  reservation: ArtifactReservation;
  signal: AbortSignal;
  attempts: number;
  onProgress: Progress;
  idleMs?: number;
  backoffMs?: (attempt: number) => number;
}): Promise<DownloadResult> {
  const idleMs = options.idleMs ?? PLUGIN_ARTIFACT_IDLE_TIMEOUT_MS;
  const backoff = options.backoffMs ?? ((attempt) => Math.min(4000, 500 * 2 ** (attempt - 1)));
  let received = 0;
  let validator: string | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    if (options.signal.aborted) throw transferAbortError(options.signal);
    if (attempt > 1) {
      await abortableSleep(backoff(attempt - 1), options.signal);
      // Resume from what reached the disk, not what passed the meter: a
      // pipeline torn down by a failing body can drop chunks it never wrote.
      received =
        validator === null ? 0 : ((await fs.stat(options.partPath).catch(() => null))?.size ?? 0);
    }
    const resuming = received > 0 && validator !== null;
    const transport: Record<string, string> = resuming
      ? { range: `bytes=${received}-`, "if-range": validator! }
      : {};
    const attemptAbort = new AbortController();
    const signal = AbortSignal.any([options.signal, attemptAbort.signal]);
    try {
      const guarded = await fetchWithPrivateHostGuard(
        options.netFetch,
        options.url.toString(),
        { signal, credentials: "omit", cache: "no-store" },
        undefined,
        {
          isAllowedUrl: options.isAllowed,
          initFor: (hop) => ({
            signal,
            credentials: "omit",
            cache: "no-store",
            headers: { ...headersForHop(options.url, hop, options.headers), ...transport },
          }),
        }
      );
      if (!guarded.ok) {
        throw artifactError(
          guarded.reason === "too-many-redirects"
            ? "ARTIFACT_TRANSFER_FAILED"
            : "ARTIFACT_URL_NOT_ALLOWED",
          `download refused: ${guarded.reason}`
        );
      }
      const response = guarded.response;
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel().catch(() => {});
        const message = `the provider answered ${response.status}`;
        if (RETRYABLE_STATUS.has(response.status)) throw new RetryableError(message);
        throw artifactError("ARTIFACT_TRANSFER_FAILED", message);
      }

      let append = false;
      let total: number | null = null;
      if (response.status === 206) {
        const range = parseContentRange(response.headers.get("content-range"));
        const sameFile = validator !== null && strongValidator(response) === validator;
        if (!resuming || !range || range.start !== received || !sameFile) {
          // A range we did not ask for, or one that doesn't continue this file.
          await response.body?.cancel().catch(() => {});
          received = 0;
          validator = null;
          throw new RetryableError("the provider answered a range that doesn't continue the file");
        }
        append = true;
        total = range.total;
      } else {
        received = 0;
        const length = Number(response.headers.get("content-length"));
        total =
          response.headers.has("content-length") && Number.isSafeInteger(length) ? length : null;
        const coding = response.headers.get("content-encoding");
        validator = coding && coding !== "identity" ? null : strongValidator(response);
      }
      if (total !== null) options.reservation.ensure(total);
      if (!response.body) {
        if (total !== null && total !== received) throw new RetryableError("the body was empty");
        if (!append) await fs.writeFile(options.partPath, new Uint8Array(0), { mode: 0o600 });
        return {
          size: received,
          contentType: response.headers.get("content-type"),
          fileName: fileNameFrom(response, options.url),
        };
      }

      const start = append ? received : 0;
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        meter({
          start,
          reservation: options.reservation,
          maxBytes: total ?? undefined,
          idleMs,
          onBytes: (n) => {
            received = n;
            options.onProgress({ transferredBytes: n, totalBytes: total, attempt });
          },
        }),
        createWriteStream(options.partPath, { flags: append ? "a" : "w", mode: 0o600 }),
        { signal }
      );
      if (total !== null && received !== total) {
        throw new RetryableError(`the body ended after ${received} of ${total} bytes`);
      }
      return {
        size: received,
        contentType: response.headers.get("content-type"),
        fileName: fileNameFrom(response, options.url),
      };
    } catch (error) {
      attemptAbort.abort();
      if (options.signal.aborted) throw transferAbortError(options.signal);
      const code = (error as { code?: unknown }).code;
      // Coded errors are verdicts (out of scope, too big, a 404); anything
      // else — a stall, a reset, a short body — is worth another attempt.
      if (typeof code === "string" && code.startsWith("ARTIFACT_")) throw error;
      lastError = error;
      // Without a validator the next attempt starts from zero.
      if (validator === null) received = 0;
    }
  }
  throw artifactError(
    "ARTIFACT_TRANSFER_FAILED",
    `download failed after ${options.attempts} attempt${options.attempts === 1 ? "" : "s"}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

/**
 * A DNS lookup that refuses private, loopback and link-local answers at
 * connect time, so the upload connects to the address that was checked —
 * no rebinding window between a check and the connect.
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 4);
      return;
    }
    const list = addresses as dns.LookupAddress[];
    const usable = list.filter((a) => !isPrivateOrLoopbackHostname(a.address));
    if (usable.length === 0 || usable.length !== list.length) {
      callback(
        Object.assign(new Error(`refusing to connect to a private address for ${hostname}`), {
          code: "ARTIFACT_URL_NOT_ALLOWED",
        }),
        "",
        4
      );
      return;
    }
    if (options.all) callback(null, usable as never);
    else callback(null, usable[0]!.address, usable[0]!.family);
  });
};

export type HttpsRequest = typeof https.request;

/**
 * Send a stored artifact as one request body with a known length. Node's
 * https streams the file with backpressure; Electron's net would either
 * buffer the whole body in memory or drop `Content-Length` for chunked
 * encoding, which presigned-URL providers refuse. Redirects are not followed:
 * a 3xx comes back as the answer. No cookies or session state are involved.
 */
export async function uploadFromFile(options: {
  request?: HttpsRequest;
  url: URL;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  filePath: string;
  size: number;
  signal: AbortSignal;
  onProgress: Progress;
  idleMs?: number;
}): Promise<PluginArtifactUploadResult> {
  if (options.signal.aborted) throw transferAbortError(options.signal);
  const request = options.request ?? https.request;
  const idleMs = options.idleMs ?? PLUGIN_ARTIFACT_IDLE_TIMEOUT_MS;
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    ...options.headers,
    "content-length": String(options.size),
  };

  return new Promise<PluginArtifactUploadResult>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, result?: PluginArtifactUploadResult) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      if (error) {
        req.destroy();
        reject(options.signal.aborted ? transferAbortError(options.signal) : error);
      } else resolve(result!);
    };
    const req = request(options.url, {
      method: options.method,
      headers,
      lookup: publicOnlyLookup,
      timeout: idleMs,
    });
    const onAbort = () => finish(transferAbortError(options.signal));
    options.signal.addEventListener("abort", onAbort, { once: true });
    req.on("timeout", () =>
      finish(artifactError("ARTIFACT_TRANSFER_FAILED", `no progress for ${idleMs} ms`))
    );
    req.on("error", (error: Error & { code?: string }) =>
      finish(
        error.code === "ARTIFACT_URL_NOT_ALLOWED"
          ? error
          : artifactError("ARTIFACT_TRANSFER_FAILED", `upload failed: ${error.message}`)
      )
    );
    req.on("response", (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let kept = 0;
      let truncated = false;
      res.on("data", (chunk: Buffer) => {
        const room = PLUGIN_ARTIFACT_UPLOAD_RESPONSE_MAX_BYTES - kept;
        if (room <= 0) {
          truncated = true;
          res.destroy();
          return;
        }
        if (chunk.length > room) truncated = true;
        const part = chunk.subarray(0, room);
        chunks.push(part);
        kept += part.length;
        if (truncated) res.destroy();
      });
      const answer = () => {
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined || name === "set-cookie") continue;
          responseHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
        }
        finish(null, {
          status: res.statusCode ?? 0,
          headers: responseHeaders,
          body: Buffer.concat(chunks).toString("utf8"),
          bodyTruncated: truncated,
        });
      };
      res.on("end", answer);
      res.on("close", answer);
      res.on("error", answer);
    });

    const body = createReadStream(options.filePath);
    let sent = 0;
    body.on("data", (chunk) => {
      sent += chunk.length;
      options.onProgress({ transferredBytes: sent, totalBytes: options.size, attempt: 1 });
    });
    body.on("error", (error) =>
      finish(
        artifactError("ARTIFACT_TRANSFER_FAILED", `reading the artifact failed: ${error.message}`)
      )
    );
    body.pipe(req);
  });
}
