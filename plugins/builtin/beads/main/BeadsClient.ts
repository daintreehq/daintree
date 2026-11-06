export const BEADS_API_TIMEOUT_MS = 15_000;

/** A `bd serve` failure, carrying the Problem body's `code` and `reason` when it sent one. */
export class BeadsApiError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly reason: string | undefined;
  /** `true` when the server refused the token itself, as opposed to a failed request. */
  readonly credentialRejected: boolean;

  constructor(
    message: string,
    options: { status?: number; code?: string; reason?: string; credentialRejected?: boolean } = {}
  ) {
    super(message);
    this.name = "BeadsApiError";
    this.status = options.status;
    this.code = options.code;
    this.reason = options.reason;
    this.credentialRejected = options.credentialRejected ?? false;
  }
}

let memoryToken: string | null = null;
let tokenVersion = 0;

export function getToken(): string | null {
  return memoryToken;
}

/** Bumps on every change, so work started under one token can tell it was replaced. */
export function getTokenVersion(): number {
  return tokenVersion;
}

export function setMemoryToken(token: string | null): void {
  const next = token?.trim() ? token.trim() : null;
  if (next === memoryToken) return;
  memoryToken = next;
  tokenVersion++;
}

export type QueryValue = string | number | boolean | undefined | readonly string[];

export interface BeadsRequest {
  method?: "GET" | "POST" | "PATCH";
  /** Path under the server root, starting `/v0/`. Ids must already be encoded. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** The operation's token, captured once. `null` sends none: `bd serve` may run without auth. */
  token: string | null;
  timeoutMs?: number;
}

interface Problem {
  title?: string;
  detail?: string;
  code?: string;
  reason?: string;
  param?: string;
}

function buildUrl(baseUrl: string, path: string, query: Record<string, QueryValue> = {}): string {
  // The base may carry a proxy mount prefix, so the route is appended to it
  // rather than resolved against it.
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function problemMessage(problem: Problem | null, status: number): string {
  const detail = problem?.detail?.trim() || problem?.title?.trim();
  return detail ? `Beads: ${detail}` : `Beads request failed (HTTP ${status})`;
}

/**
 * One request to a `bd serve` `/v0` route. Every non-2xx answer is a Problem
 * body, so failures are classified by its `code`, never its prose. Redirects
 * are refused: a token must not follow one to another host.
 */
export async function beadsRequest<T>(baseUrl: string, request: BeadsRequest): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (request.token) headers.Authorization = `Bearer ${request.token}`;
  if (request.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(buildUrl(baseUrl, request.path, request.query), {
      method: request.method ?? "GET",
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(request.timeoutMs ?? BEADS_API_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new BeadsApiError(
      timedOut
        ? "The Beads server didn't respond in time"
        : `Couldn't reach the Beads server at ${baseUrl}`
    );
  }

  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    const problem = (payload && typeof payload === "object" ? payload : null) as Problem | null;
    const code = typeof problem?.code === "string" ? problem.code : undefined;
    const reason = typeof problem?.reason === "string" ? problem.reason : undefined;
    if (response.status === 401 || code === "unauthenticated") {
      throw new BeadsApiError(
        request.token
          ? "The Beads server rejected the token"
          : "The Beads server needs a token. Add one in Settings → Code forge.",
        { status: response.status, code, reason, credentialRejected: true }
      );
    }
    if (problem?.param === "Host") {
      throw new BeadsApiError(
        "The Beads server refused this address. Start bd serve with --allowed-host for it.",
        { status: response.status, code, reason }
      );
    }
    throw new BeadsApiError(problemMessage(problem, response.status), {
      status: response.status,
      code,
      reason,
    });
  }
  if (payload === null || typeof payload !== "object") {
    throw new BeadsApiError("The Beads server sent a response that isn't JSON", {
      status: response.status,
    });
  }
  return payload as T;
}
