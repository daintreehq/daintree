/** How long a loopback waits for the browser to come back before giving up. */
export const OAUTH_LOOPBACK_TIMEOUT_MS = 300_000;

export type OAuthLoopbackResult =
  | {
      success: true;
      callbackUrl: string;
      loopbackRedirectUri: string;
      originalRedirectUri: string;
    }
  | {
      success: false;
      cause: "cancelled" | "timed-out" | "server-error" | "open-external-failed";
    };
