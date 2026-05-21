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
