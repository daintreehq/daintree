/**
 * When a grant actually ends: its sliding expiry, unless the hard ceiling comes
 * first. `atCeiling` means using the tool again won't buy more time, which is
 * the one case a countdown should say so. A grant without a known ceiling ends
 * at its sliding expiry.
 */
export function grantDeadline(
  expiresAt: number,
  maxExpiresAt?: number
): { endsAt: number; atCeiling: boolean } {
  if (maxExpiresAt === undefined || expiresAt < maxExpiresAt) {
    return { endsAt: expiresAt, atCeiling: false };
  }
  return { endsAt: maxExpiresAt, atCeiling: true };
}
