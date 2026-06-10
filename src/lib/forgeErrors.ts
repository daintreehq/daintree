// Classification of forge-provider error messages. Providers normalize their
// failures into a stable message vocabulary ("<provider> token not configured",
// "Cannot reach <provider>. …", "<provider> rate limit exceeded. …"); these
// matchers key on the provider-independent fragments so any forge provider's
// errors classify the same way.

export function isTokenRelatedError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return (
    /token not configured/i.test(msg) ||
    /invalid \S+ token/i.test(msg) ||
    msg.includes("Token lacks required permissions") ||
    msg.includes("SSO authorization required")
  );
}

export function isTransientNetworkError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /^cannot reach /i.test(msg) || /^\S+ is temporarily unavailable\./i.test(msg);
}

export function isRateLimitError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /rate limit exceeded\./i.test(msg) || /secondary rate limit triggered\./i.test(msg);
}
