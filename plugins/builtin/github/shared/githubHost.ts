import { normalizeConfiguredForgeHost } from "../../../../shared/utils/forgeHostnames.js";

export const GITHUB_COM_HOST = "github.com";

/** The `contributes.settings` ids that configure a GitHub Enterprise Server host. */
export const ENTERPRISE_HOST_SETTING = "enterpriseHost";
export const ENTERPRISE_TOKEN_SETTING = "enterpriseToken";

/**
 * Canonical GitHub Enterprise Server hostname for a settings value, or `null`
 * when it is empty or can't name one. github.com and its subdomains are never
 * an enterprise host: they are served, and authenticated, as github.com.
 */
export function normalizeEnterpriseHost(raw: unknown): string | null {
  const host = normalizeConfiguredForgeHost(raw);
  if (host === null) return null;
  if (host === GITHUB_COM_HOST || host.endsWith(`.${GITHUB_COM_HOST}`)) return null;
  return host;
}

/** Where a personal access token for `host` is created. */
export function newTokenUrl(host: string, scopes: readonly string[]): string {
  return `https://${host}/settings/tokens/new?scopes=${scopes.join(",")}&description=Daintree`;
}
