import type { JiraDeployment } from "../shared/connection.js";

export const JIRA_API_TIMEOUT_MS = 15_000;

// Both keep "rejected the … API token", which is how the host tells a refused
// credential from an unreachable tracker.
const REJECTED_MESSAGES: Record<JiraDeployment, string> = {
  cloud:
    "Jira rejected the email and API token. Check both, and use a classic API token: tokens with scopes don't work with a site URL.",
  dataCenter:
    "Jira rejected the API token. Check that the personal access token hasn't expired or been revoked.",
};

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
  /** Jira refused the credential itself, not just this request. */
  readonly credentialRejected: boolean;

  constructor(message: string, status?: number, credentialRejected = false) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
    this.credentialRejected = credentialRejected;
  }
}

/**
 * Everything one request authenticates with, captured once per operation. Cloud
 * takes the account email and API token as Basic auth against REST v3; Server
 * and Data Center take a personal access token as a Bearer against REST v2.
 */
export type JiraConnection =
  | { deployment: "cloud"; siteUrl: string; email: string; token: string }
  | { deployment: "dataCenter"; siteUrl: string; token: string };

export type JiraFetch = (url: string, init: RequestInit) => Promise<Response>;

let transportOverride: JiraFetch | null = null;
let chromiumFetch: JiraFetch | null = null;

/** Tests hand in a fake; `null` goes back to Chromium's network stack. */
export function setJiraTransport(transport: JiraFetch | null): void {
  transportOverride = transport;
}

/**
 * Chromium's network stack rather than Node's fetch, because it checks
 * certificates against the operating system's trust store: an instance behind a
 * company CA that the machine trusts is reachable, with no switch to turn the
 * check off. Nothing from the session rides along: no cookies, so a Jira login
 * in a browser panel can't stand in for the token, and no cache.
 */
async function jiraFetch(): Promise<JiraFetch> {
  if (transportOverride) return transportOverride;
  if (!chromiumFetch) {
    const [{ net }, { createManualRedirectFetch }] = await Promise.all([
      import("electron"),
      import("../../../../electron/utils/netManualRedirectFetch.js"),
    ]);
    const manualFetch = createManualRedirectFetch((options) => net.request(options));
    chromiumFetch = (url, init) =>
      manualFetch(url, { ...init, credentials: "omit", cache: "no-store" });
  }
  return chromiumFetch;
}

let cooldown: {
  connectionKey: string;
  until: number;
  status: number;
  message: string;
  credentialRejected: boolean;
} | null = null;

let cooldownEpoch = 0;

export function clearJiraCooldown(): void {
  cooldown = null;
  cooldownEpoch++;
}

function connectionKeyOf(connection: JiraConnection): string {
  const email = connection.deployment === "cloud" ? connection.email : "";
  return `${connection.siteUrl}\u0000${email}\u0000${connection.token}`;
}

function authorizationOf(connection: JiraConnection): { header: string; secrets: string[] } {
  if (connection.deployment === "dataCenter") {
    return { header: `Bearer ${connection.token}`, secrets: [connection.token] };
  }
  const basic = Buffer.from(`${connection.email}:${connection.token}`).toString("base64");
  return { header: `Basic ${basic}`, secrets: [basic, connection.token, connection.email] };
}

const TIMED_OUT_MESSAGE = "Jira didn't respond in time";

function unreachableMessage(err: unknown): string {
  if (!(err instanceof Error)) return "Couldn't reach Jira";
  if (err.name === "TimeoutError") return TIMED_OUT_MESSAGE;
  // Chromium names a certificate it couldn't verify in the error's message.
  if (/\bERR_CERT_/.test(err.message)) {
    return "Couldn't reach Jira: this computer doesn't trust its certificate";
  }
  return "Couldn't reach Jira";
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
 * One call to Jira's REST API: v3 with Basic auth on Cloud, v2 with a Bearer
 * token on Server and Data Center. Paths append to the site's base, which keeps
 * an instance's context path. Redirects aren't followed: the credential only
 * ever goes to the site it was validated against.
 */
export async function jiraRequest<T>(
  connection: JiraConnection,
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT";
    body?: unknown;
    timeoutMs?: number;
    /** A deliberate check, like saving a token: goes out whatever the cooldown says. */
    ignoreCooldown?: boolean;
    /** A write Jira answers with 204 and nothing to read, like setting the assignee. */
    noContent?: boolean;
    /**
     * Sent with no credential, to learn what a site is before trusting it with
     * one. A refusal is then the site's rule, not a verdict on the token.
     */
    anonymous?: boolean;
    /**
     * Asks about the site, not the credential (`serverInfo`), so an answer says
     * nothing about whether the token is good and can't end a cooldown.
     */
    metadata?: boolean;
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
    throw new JiraApiError(cooldown.message, cooldown.status, cooldown.credentialRejected);
  }
  const authorization = authorizationOf(connection);
  const apiVersion = connection.deployment === "cloud" ? 3 : 2;
  const rejectedMessage = REJECTED_MESSAGES[connection.deployment];
  // Covers reading the body too: headers can arrive on time and the body stall.
  const signal = AbortSignal.timeout(options.timeoutMs ?? JIRA_API_TIMEOUT_MS);
  let response: Response;
  try {
    const transport = await jiraFetch();
    response = await transport(`${connection.siteUrl}/rest/api/${apiVersion}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.anonymous ? {} : { Authorization: authorization.header }),
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: "manual",
      signal,
    });
  } catch (err) {
    throw new JiraApiError(unreachableMessage(err));
  }

  // Jira doesn't always refuse bad credentials. It can serve the request as
  // anonymous and answer 200 with no results, which would read as an empty
  // project, so the login verdict it reports is checked before the status.
  const loginReason = response.headers.get("x-seraph-loginreason") ?? "";
  if (
    !options.anonymous &&
    (response.status === 401 || FAILED_LOGIN_REASONS.some((reason) => loginReason.includes(reason)))
  ) {
    if (canStartCooldown()) {
      cooldown = {
        connectionKey,
        until: Date.now() + REJECTED_COOLDOWN_MS,
        status: response.status,
        message: rejectedMessage,
        credentialRejected: true,
      };
    }
    throw new JiraApiError(rejectedMessage, response.status, true);
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
        credentialRejected: false,
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

  // A body that isn't JSON (a proxy's error page) reads as no payload, and so
  // does an empty one from a request that expected to read something.
  const payload =
    options.noContent && response.status === 204
      ? undefined
      : ((await response.json().catch(() => null)) as unknown);
  if (payload === null && signal.aborted)
    throw new JiraApiError(TIMED_OUT_MESSAGE, response.status);
  if (!response.ok) {
    throw new JiraApiError(
      errorFromBody(payload, authorization.secrets) ??
        `Jira request failed (HTTP ${response.status})`,
      response.status
    );
  }
  if (payload === null) {
    throw new JiraApiError("Jira sent a response Daintree couldn't read", response.status);
  }
  // Jira answered the credential, so whatever the cooldown was about has passed.
  if (!options.anonymous && !options.metadata && cooldown?.connectionKey === connectionKey) {
    cooldown = null;
  }
  return payload as T;
}
