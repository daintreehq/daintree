/** A lifetime is renewed once this little of it is left (or half of it, for a short one). */
export const RENEW_MARGIN_MS = 30 * 60_000;

/**
 * Whether a machine's automatic stop at `deadline` is near enough to move,
 * for a lifetime `lifetimeSeconds` long. The desktop's keeper and the
 * machine's own use the same rule, so neither renews what the other just did.
 */
export function lifetimeRenewalDue(
  now: number,
  deadline: number,
  lifetimeSeconds: number
): boolean {
  const margin = Math.min(RENEW_MARGIN_MS, (lifetimeSeconds * 1000) / 2);
  return deadline - now <= margin;
}

/** A stop the provider is still carrying out: nothing should renew or stop it again meanwhile. */
export function stopUnderWay(stop: { status: string } | null | undefined): boolean {
  return stop?.status === "pending" || stop?.status === "failing";
}
