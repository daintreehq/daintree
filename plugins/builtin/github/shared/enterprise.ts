/**
 * Channels the GitHub settings tab uses to manage the GitHub Enterprise Server
 * account, beside github.com's, which goes through the host's forge credential
 * surface. Results carry no token: the main process keeps it.
 */
import type { GitHubTokenConfig } from "./types.js";

export const GITHUB_PLUGIN_ID = "daintree.github";

export const ENTERPRISE_CHANNELS = {
  status: "enterprise.status",
  setHost: "enterprise.setHost",
  testToken: "enterprise.testToken",
  saveToken: "enterprise.saveToken",
  clearToken: "enterprise.clearToken",
  previewImport: "enterprise.previewImport",
  commitImport: "enterprise.commitImport",
} as const;

export interface EnterpriseStatus {
  /** The configured Enterprise Server host, or null when none is set. */
  host: string | null;
  /** A token is saved for the configured host. */
  hasToken: boolean;
  /**
   * The host the saved token was validated against, when it isn't the
   * configured one: that token stays unused until it is replaced or cleared.
   */
  staleTokenHost: string | null;
  account?: string;
}

export type EnterpriseSetHostResult =
  { ok: true; host: string | null } | { ok: false; error: string };

export interface EnterpriseTokenResult {
  valid: boolean;
  account?: string;
  scopes?: string[];
  error?: string;
}

export type EnterpriseImportPreviewResult =
  | {
      ok: true;
      host: string;
      account: string;
      scopes: string[];
      missingScopes: string[];
    }
  | { ok: false; reason: string };

export type EnterpriseImportCommitResult =
  { ok: true; account: string; scopes: string[] } | { ok: false; reason: string };

/** Whether any GitHub host — github.com or the Enterprise Server — has a token. */
export function hasAnyGitHubToken(config: GitHubTokenConfig): boolean {
  return config.hasToken || config.hasEnterpriseToken === true;
}
