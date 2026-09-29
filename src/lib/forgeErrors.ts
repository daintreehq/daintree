// Classification of forge-provider error messages. Providers normalize their
// failures into a stable message vocabulary ("<provider> token not configured",
// "Cannot reach <provider>. …", "<provider> rate limit exceeded. …"); these
// matchers key on the provider-independent fragments so any forge provider's
// errors classify the same way.

/**
 * Why a credential-bound request failed. `not-configured` is the one kind that
 * is not a failure of a credential the user has — there is nothing to
 * reconnect, so surfaces that interrupt (the forge pill's token callout) skip
 * it and leave the dimmed pill to say it.
 */
export type ForgeTokenErrorKind = "not-configured" | "invalid" | "permissions" | "sso";

export function classifyTokenError(msg: string | null | undefined): ForgeTokenErrorKind | null {
  if (!msg) return null;
  if (/token not configured/i.test(msg)) return "not-configured";
  if (/invalid \S+ token/i.test(msg)) return "invalid";
  if (msg.includes("Token lacks required permissions")) return "permissions";
  if (msg.includes("SSO authorization required")) return "sso";
  return null;
}

export function isTokenRelatedError(msg: string | null | undefined): boolean {
  return classifyTokenError(msg) !== null;
}

export function isTransientNetworkError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /^cannot reach /i.test(msg) || /^\S+ is temporarily unavailable\./i.test(msg);
}

export function isRateLimitError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /rate limit exceeded\./i.test(msg) || /secondary rate limit triggered\./i.test(msg);
}
