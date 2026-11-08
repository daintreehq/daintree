export const JIRA_PLUGIN_ID = "daintree.jira";
export const SITE_URL_SETTING = "siteUrl";
export const EMAIL_SETTING = "email";
export const PROJECT_KEY_SETTING = "projectKey";

/**
 * One tenant label under atlassian.net, and nothing else. The API token goes out
 * in every request, so the address it goes to can't be whatever a settings file
 * or a typo says: an Atlassian API token belongs to the account rather than the
 * site, which makes any Atlassian tenant a safe destination and everything else
 * not. This also keeps Server and Data Center out, and custom domains with them.
 */
const SITE_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/;

/** A `:` would split the Basic credential in the wrong place. */
const EMAIL_PATTERN = /^[^\s@:]+@[^\s@:]+$/;

/**
 * The site's origin (`https://acme.atlassian.net`), or `null` when the value
 * isn't a Jira Cloud site. A bare host and a URL pasted from the browser with a
 * path both work, since only the host is kept.
 */
export function normalizeSiteUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  return SITE_HOST_PATTERN.test(host) ? `https://${host}` : null;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return EMAIL_PATTERN.test(trimmed) ? trimmed : null;
}
