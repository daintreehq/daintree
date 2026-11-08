export const JIRA_API_TIMEOUT_MS = 15_000;

const REJECTED_MESSAGE =
  "Jira rejected the email and API token. Check both, and use a classic API token: tokens with scopes don't work with a site URL.";

/** Jira's own login verdicts that mean these credentials weren't accepted. */
const FAILED_LOGIN_REASONS = ["AUTHENTICATED_FAILED", "AUTHENTICATION_DENIED"];

const MAX_ERROR_MESSAGE_LENGTH = 300;

/**
 * How long a connection is left alone after Jira refuses it. Lookups repeat on
 * every poll for as long as a worktree's issue is unresolved, so without this a
 * revoked token would keep failing logins against the account in the background.
 */
const REJECTED_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;

/** Jira API failure. Messages never carry the credential or the request's headers. */
export class JiraApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
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

let cooldown: { connectionKey: string; until: number; status: number; message: string } | null =
  null;

let cooldownEpoch = 0;

export function clearJiraCooldown(): void {
  cooldown = null;
  cooldownEpoch++;
}

function connectionKeyOf(connection: JiraConnection): string {
  return `${connection.siteUrl}\u0000${connection.email}\u0000${connection.token}`;
}

/** Jira's explanation of a failure, with anything of the credential taken back out. */
function errorFromBody(payload: unknown, secrets: string[]): string | null {
  if (!payload || typeof payload !== "object") return null;
  const { errorMessages, errors } = payload as { errorMessages?: unknown; errors?: unknown };
  const candidates = [
    ...(Array.isArray(errorMessages) ? errorMessages : []),
    ...(errors && typeof errors === "object" ? Object.values(errors) : []),
  ];
  const message = candidates.find((c): c is string => typeof c === "string" && c.length > 0);
  if (!message) return null;
  // Before truncating, or a cut through the middle of one would survive this.
  const redacted = secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), message);
  return redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

const RATE_LIMITED_MESSAGE = "Jira's rate limit was reached. Try again shortly.";

function retryAfterSeconds(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return seconds > 0 ? seconds : null;
}

/**
 * One call to Jira's REST v3 API. Basic auth with the account email and API
 * token, and redirects aren't followed: the credential only ever goes to the
 * site it was validated against.
 */
export async function jiraRequest<T>(
  connection: JiraConnection,
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
    timeoutMs?: number;
    /** A deliberate check, like saving a token: goes out whatever the cooldown says. */
    ignoreCooldown?: boolean;
  } = {}
): Promise<T> {
  const connectionKey = connectionKeyOf(connection);
  const epoch = cooldownEpoch;
  // A response landing after a clear must not put back what the clear let go of.
  const canStartCooldown = () => !options.ignoreCooldown && epoch === cooldownEpoch;
  if (
    !options.ignoreCooldown &&
    cooldown?.connectionKey === connectionKey &&
    Date.now() < cooldown.until
  ) {
    throw new JiraApiError(cooldown.message, cooldown.status);
  }
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
    if (canStartCooldown()) {
      cooldown = {
        connectionKey,
        until: Date.now() + REJECTED_COOLDOWN_MS,
        status: response.status,
        message: REJECTED_MESSAGE,
      };
    }
    throw new JiraApiError(REJECTED_MESSAGE, response.status);
  }
  if (response.status === 429) {
    const seconds = retryAfterSeconds(response);
    if (canStartCooldown()) {
      cooldown = {
        connectionKey,
        until:
          Date.now() +
          Math.min(
            seconds ? seconds * 1000 : DEFAULT_RATE_LIMIT_COOLDOWN_MS,
            MAX_RATE_LIMIT_COOLDOWN_MS
          ),
        status: 429,
        message: RATE_LIMITED_MESSAGE,
      };
    }
    throw new JiraApiError(
      seconds
        ? `Jira's rate limit was reached. Try again in ${Math.ceil(seconds)}s.`
        : RATE_LIMITED_MESSAGE,
      429
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new JiraApiError(
      "Jira redirected the request instead of answering. Check the site URL in Settings → Code forge.",
      response.status
    );
  }

  // A body that isn't JSON (a proxy's error page) reads as no payload.
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new JiraApiError(
      errorFromBody(payload, [authorization, connection.token, connection.email]) ??
        `Jira request failed (HTTP ${response.status})`,
      response.status
    );
  }
  if (payload === null) {
    throw new JiraApiError("Jira sent a response Daintree couldn't read", response.status);
  }
  // Jira answered, so whatever the cooldown was about has passed.
  if (cooldown?.connectionKey === connectionKey) cooldown = null;
  return payload as T;
}
