export function isTokenRelatedError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return (
    msg.includes("GitHub token not configured") ||
    msg.includes("Invalid GitHub token") ||
    msg.includes("Token lacks required permissions") ||
    msg.includes("SSO authorization required")
  );
}
