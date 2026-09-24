/**
 * States of the dev preview's blocked-navigation banner, one per phase of the
 * reducer plus the widths and URLs that change how it lays out.
 *
 * Type imports only: the screenshot spec imports this module under Playwright's
 * Node loader, where anything reaching `import.meta.glob` fails to load.
 */

export type BlockedNavFixturePhase =
  | "blocked"
  | "oauth-started"
  | "oauth-intercepting"
  | "oauth-completed"
  | "oauth-timed-out"
  | "oauth-error";

export interface BlockedNavFixture {
  /** Pane width in CSS px. */
  width: number;
  url: string;
  canOpenExternal: boolean;
  phase: BlockedNavFixturePhase;
  /** `oauth-error` only: what main reported, or `not-ready` for a start that never left. */
  errorCause?: "not-ready" | "failed";
  errorMessage?: string;
  /** A pointer or keyboard drive the spec performs after load. */
  drive?: "copied" | "overflow-open" | "keyboard-focus";
}

const DOCS_URL = "https://docs.stripe.com/payments/checkout/how-checkout-works?lang=node";
const OAUTH_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=1043-orchid.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fauth%2Fcallback&response_type=code&scope=openid%20email%20profile&state=8f1c2e";
const LONG_URL =
  "https://orchid-studio-staging.eu-west-2.elasticbeanstalk.example.com/dashboard/projects/orchid-studio/settings/billing/invoices/2026-09?download=pdf&utm_source=preview";

export const BLOCKED_NAV_FIXTURES = {
  blocked: { width: 900, url: DOCS_URL, canOpenExternal: true, phase: "blocked" },
  "blocked-no-external": {
    width: 900,
    url: "slack://open?team=T024BE7LD&id=C04PREVIEW",
    canOpenExternal: false,
    phase: "blocked",
  },
  "blocked-long-url": { width: 900, url: LONG_URL, canOpenExternal: true, phase: "blocked" },
  "oauth-offer": { width: 900, url: OAUTH_URL, canOpenExternal: true, phase: "blocked" },
  "oauth-started": { width: 900, url: OAUTH_URL, canOpenExternal: true, phase: "oauth-started" },
  "oauth-intercepting": {
    width: 900,
    url: OAUTH_URL,
    canOpenExternal: true,
    phase: "oauth-intercepting",
  },
  "oauth-completed": {
    width: 900,
    url: OAUTH_URL,
    canOpenExternal: true,
    phase: "oauth-completed",
  },
  "oauth-timed-out": {
    width: 900,
    url: OAUTH_URL,
    canOpenExternal: true,
    phase: "oauth-timed-out",
  },
  "oauth-error": {
    width: 900,
    url: OAUTH_URL,
    canOpenExternal: true,
    phase: "oauth-error",
    errorCause: "not-ready",
  },
  "oauth-failed": {
    width: 900,
    url: OAUTH_URL,
    canOpenExternal: true,
    phase: "oauth-error",
    errorCause: "failed",
    errorMessage: "Navigation failed: net::ERR_CONNECTION_REFUSED",
  },
  "narrow-blocked": { width: 480, url: DOCS_URL, canOpenExternal: true, phase: "blocked" },
  "narrow-oauth-offer": { width: 480, url: OAUTH_URL, canOpenExternal: true, phase: "blocked" },
  "narrow-oauth-error": {
    width: 480,
    url: OAUTH_URL,
    canOpenExternal: true,
    phase: "oauth-timed-out",
  },
  copied: { width: 900, url: DOCS_URL, canOpenExternal: true, phase: "blocked", drive: "copied" },
  "overflow-open": {
    width: 900,
    url: OAUTH_URL,
    canOpenExternal: true,
    phase: "oauth-timed-out",
    drive: "overflow-open",
  },
  "keyboard-focus": {
    width: 900,
    url: OAUTH_URL,
    canOpenExternal: true,
    phase: "blocked",
    drive: "keyboard-focus",
  },
} satisfies Record<string, BlockedNavFixture>;

export type BlockedNavFixtureName = keyof typeof BLOCKED_NAV_FIXTURES;
export const BLOCKED_NAV_FIXTURE_NAMES: BlockedNavFixtureName[] =
  Object.keys(BLOCKED_NAV_FIXTURES).filter(isBlockedNavFixtureName);

export function isBlockedNavFixtureName(value: string): value is BlockedNavFixtureName {
  return Object.prototype.hasOwnProperty.call(BLOCKED_NAV_FIXTURES, value);
}
