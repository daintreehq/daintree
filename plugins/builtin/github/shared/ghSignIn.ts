/**
 * Signing the GitHub CLI in with the token just saved in Code forge, on the
 * machine whose Settings are open. Results carry no token and nothing gh
 * printed beyond a fixed reason.
 */
export const GH_SIGN_IN_CHANNELS = {
  status: "ghSignIn.status",
  signIn: "ghSignIn.signIn",
} as const;

export type GhCliFailureReason = "cli-not-found" | "cli-timeout" | "cli-failed" | "cancelled";

/** What gh holds for a host. `account` is null for a sign-in gh doesn't name. */
export type GhAccountObservation = { signedIn: false } | { signedIn: true; account: string | null };

export type GhAccountStatus =
  ({ ok: true } & GhAccountObservation) | { ok: false; reason: GhCliFailureReason };

/**
 * `token-changed`: the token saved for the host is no longer the one this
 * window saved (replaced or cleared since), or the host stopped being served.
 */
export type GhSignInFailureReason =
  GhCliFailureReason | "refused" | "missing-scopes" | "token-changed";

/**
 * `gh-changed`: gh no longer holds what the person was shown (another
 * window's sign-in landed meanwhile); `current` is what it holds now, to ask
 * about again.
 */
export type GhSignInResult =
  | { ok: true; gitConfigured: boolean }
  | { ok: false; reason: "gh-changed"; current: GhAccountObservation }
  | { ok: false; reason: GhSignInFailureReason; missingScopes?: string[] };
