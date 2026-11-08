export const JIRA_API_TIMEOUT_MS = 15_000;

const REJECTED_MESSAGE =
  "Jira rejected the email and API token. Check both, and use a classic API token: tokens with scopes don't work with a site URL.";

/** Jira's own login verdicts that mean these credentials weren't accepted. */
const FAILED_LOGIN_REASONS = ["AUTHENTICATED_FAILED", "AUTHENTICATION_DENIED"];

const MAX_ERROR_MESSAGE_LENGTH = 300;

/** Jira API failure. Messages never carry the credential or the request's headers. */
export class JiraApiError extends Error {
  readonly status: number | undefined;
  /** `true` when Jira refused the credential, as opposed to a failed request. */
  readonly credentialRejected: boolean;

  constructor(message: string, options: { status?: number; credentialRejected?: boolean } = {}) {
    super(message);
    this.name = "JiraApiError";
    this.status = options.status;
    this.credentialRejected = options.credentialRejected ?? false;
  }
}

/** Everything one request authenticates with, captured once per operation. */
export interface JiraConnection {
  siteUrl: string;
  email: string;
  token: string;
}

let memoryToken: string | null = null;
let tokenVersion = 0;

export function getToken(): string | null {
  return memoryToken;
}

/** Bumps on every change, so caches filled under one token can't serve another. */
export function getTokenVersion(): number {
  return tokenVersion;
}

export function setMemoryToken(token: string | null): void {
  const next = token?.trim() ? token.trim() : null;
  if (next === memoryToken) return;
  memoryToken = next;
  tokenVersion++;
}

function errorFromBody(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const { errorMessages, errors } = payload as { errorMessages?: unknown; errors?: unknown };
  const candidates = [
    ...(Array.isArray(errorMessages) ? errorMessages : []),
    ...(errors && typeof errors === "object" ? Object.values(errors) : []),
  ];
  const message = candidates.find((c): c is string => typeof c === "string" && c.length > 0);
  return message ? message.slice(0, MAX_ERROR_MESSAGE_LENGTH) : null;
}

function rateLimitMessage(response: Response): string {
  const seconds = Number(response.headers.get("retry-after"));
  return seconds > 0
    ? `Jira's rate limit was reached. Try again in ${Math.ceil(seconds)}s.`
    : "Jira's rate limit was reached. Try again shortly.";
}

/**
 * One call to Jira's REST v3 API. Basic auth with the account email and API
 * token, and redirects aren't followed: the credential only ever goes to the
 * site it was validated against.
 */
export async function jiraRequest<T>(
  connection: JiraConnection,
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {}
): Promise<T> {
  const authorization = Buffer.from(`${connection.email}:${connection.token}`).toString("base64");
  let response: Response;
  try {
    response = await fetch(`${connection.siteUrl}/rest/api/3${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${authorization}`,
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? JIRA_API_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new JiraApiError(timedOut ? "Jira didn't respond in time" : "Couldn't reach Jira");
  }

  // Jira doesn't always refuse bad credentials. It can serve the request as
  // anonymous and answer 200 with no results, which would read as an empty
  // project, so the login verdict it reports is checked before the status.
  const loginReason = response.headers.get("x-seraph-loginreason") ?? "";
  if (
    response.status === 401 ||
    FAILED_LOGIN_REASONS.some((reason) => loginReason.includes(reason))
  ) {
    throw new JiraApiError(REJECTED_MESSAGE, {
      status: response.status,
      credentialRejected: true,
    });
  }
  if (response.status === 429) {
    throw new JiraApiError(rateLimitMessage(response), { status: 429 });
  }
  if (response.status >= 300 && response.status < 400) {
    throw new JiraApiError(
      "Jira redirected the request instead of answering. Check the site URL in Settings → Code forge.",
      { status: response.status }
    );
  }

  // A body that isn't JSON (a proxy's error page) reads as no payload.
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new JiraApiError(
      errorFromBody(payload) ?? `Jira request failed (HTTP ${response.status})`,
      { status: response.status }
    );
  }
  if (payload === null) {
    throw new JiraApiError("Jira sent a response Daintree couldn't read", {
      status: response.status,
    });
  }
  return payload as T;
}
