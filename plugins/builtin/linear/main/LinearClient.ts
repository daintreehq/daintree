export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const LINEAR_API_TIMEOUT_MS = 15_000;

/** Linear API failure, with the HTTP status when the transport supplied one. */
export class LinearApiError extends Error {
  readonly status: number | undefined;
  /** `true` when Linear refused the key itself, as opposed to a failed request. */
  readonly credentialRejected: boolean;
  /** Linear's own error kind (`not_found`, `ratelimited`, …), lower-cased, when it sent one. */
  readonly kind: string | undefined;

  constructor(
    message: string,
    options: { status?: number; credentialRejected?: boolean; kind?: string } = {}
  ) {
    super(message);
    this.name = "LinearApiError";
    this.status = options.status;
    this.credentialRejected = options.credentialRejected ?? false;
    this.kind = options.kind;
  }
}

let memoryToken: string | null = null;
let tokenVersion = 0;

export function getToken(): string | null {
  return memoryToken;
}

/** Bumps on every change, so work started under one key can tell it was replaced. */
export function getTokenVersion(): number {
  return tokenVersion;
}

export function setMemoryToken(token: string | null): void {
  const next = token?.trim() ? token.trim() : null;
  if (next === memoryToken) return;
  memoryToken = next;
  tokenVersion++;
}

interface GraphQLError {
  message?: string;
  extensions?: { type?: string; code?: string; userPresentableMessage?: string };
}

/** `extensions.code` is `AUTHENTICATION_ERROR`-style, `extensions.type` the spaced form. */
function errorKind(error: GraphQLError): string {
  return (error.extensions?.code ?? error.extensions?.type ?? "").toLowerCase().replace(/ /g, "_");
}

/**
 * POST one GraphQL document to Linear. A personal API key goes in the
 * `Authorization` header bare: the `Bearer` form is for OAuth tokens and is
 * refused for personal keys. Linear reports query failures with HTTP 200 and an
 * `errors` array, so a 200 alone is never success.
 */
export async function linearGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
  options: { token?: string; timeoutMs?: number } = {}
): Promise<T> {
  const token = options.token ?? memoryToken;
  if (!token) {
    throw new LinearApiError("No Linear API key configured. Add one in Settings → Code forge.", {
      credentialRejected: true,
    });
  }

  let response: Response;
  try {
    response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(options.timeoutMs ?? LINEAR_API_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new LinearApiError(
      timedOut ? "Linear didn't respond in time" : "Couldn't reach Linear",
      {}
    );
  }

  // A body that isn't JSON (a proxy's error page) reads as no payload.
  const payload = (await response.json().catch(() => null)) as {
    data?: T;
    errors?: GraphQLError[];
  } | null;

  const errors = payload?.errors ?? [];
  if (response.status === 401 || errors.some((e) => errorKind(e) === "authentication_error")) {
    throw new LinearApiError("Linear rejected the API key", {
      status: response.status,
      credentialRejected: true,
    });
  }
  if (errors.length > 0) {
    const first = errors[0];
    const kind = errorKind(first);
    if (kind === "ratelimited") {
      throw new LinearApiError("Linear's rate limit was reached. Try again shortly.", {
        status: response.status,
        kind,
      });
    }
    throw new LinearApiError(
      first.extensions?.userPresentableMessage ?? first.message ?? "Linear request failed",
      { status: response.status, ...(kind ? { kind } : {}) }
    );
  }
  if (response.status === 429) {
    throw new LinearApiError("Linear's rate limit was reached. Try again shortly.", {
      status: response.status,
      kind: "ratelimited",
    });
  }
  if (!response.ok || !payload?.data) {
    throw new LinearApiError(`Linear request failed (HTTP ${response.status})`, {
      status: response.status,
    });
  }
  return payload.data;
}
