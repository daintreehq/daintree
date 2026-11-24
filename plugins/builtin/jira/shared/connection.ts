export const JIRA_PLUGIN_ID = "daintree.jira";
export const SITE_URL_SETTING = "siteUrl";
export const EMAIL_SETTING = "email";
export const PROJECT_KEY_SETTING = "projectKey";

/**
 * Which Jira a site is, read from its address alone: Cloud lives at an
 * atlassian.net tenant and nowhere else, so every other address is a Server or
 * Data Center instance.
 */
export type JiraDeployment = "cloud" | "dataCenter";

/**
 * One tenant label under atlassian.net, and nothing else. A Cloud API token goes
 * out in every request as Basic auth, and it belongs to the account rather than
 * the site, which makes any Atlassian tenant a safe destination for it and
 * everything else not. Custom Cloud domains stay out with that.
 */
const SITE_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/;

/** Any address Atlassian runs, which a Data Center base never is. */
const ATLASSIAN_HOST_PATTERN = /(?:^|\.)atlassian\.net$/;

/**
 * Where a page URL pasted from the browser stops being the base: the shapes of
 * Jira's own pages, under whatever context path the instance has. Only shapes
 * that can't also be a context path: an issue, a project by its key, a servlet
 * page. Anything else is taken as the base the person typed.
 */
const JIRA_PAGE_PATTERN =
  /\/(?:(?:browse\/[A-Za-z][A-Za-z0-9_]*-\d+|projects\/[A-Z][A-Z0-9_]*|secure\/[A-Za-z]+\.jspa|rest\/api\/(?:\d+|latest))(?:\/|$)|login\.jsp$)/;

/** Tried after the shapes above, so it can't swallow one of them below it. */
const SERVLET_PAGE_PATTERN = /\/plugins\/servlet\/[^/]+(?:\/|$)/;

/** The issue navigator, which only reads as a page when it carries a search. */
const ISSUE_NAVIGATOR_PATTERN = /\/issues\/?$/;

/** A scheme with no `//` after it (`https:/jira…`), which would read as a host named `https`. */
const MALFORMED_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:(?!\/\/)(?!\d)/i;

/** Plain segments only, so a context path can't hide `..` or an encoded slash. */
const CONTEXT_PATH_PATTERN = /^(?:\/[A-Za-z0-9._~-]+)*$/;

/** Short enough that `${siteIdOf(base)}/${issueId}` stays a link id the host stores. */
const MAX_DATA_CENTER_URL_LENGTH = 200;

/** A `:` would split the Basic credential in the wrong place. */
const EMAIL_PATTERN = /^[^\s@:]+@[^\s@:]+$/;

function parseUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\\") || MALFORMED_SCHEME_PATTERN.test(trimmed)) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

/**
 * The Cloud site's origin (`https://acme.atlassian.net`), or `null` when the
 * value isn't a Jira Cloud site. A bare host and a URL pasted from the browser
 * with a path both work, since only the host is kept.
 */
export function normalizeCloudSiteUrl(value: unknown): string | null {
  const url = parseUrl(value);
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  return SITE_HOST_PATTERN.test(host) ? `https://${host}` : null;
}

/**
 * A Server or Data Center instance's base (`https://jira.example.com:8443/jira`),
 * or `null` when the value can't be one. HTTPS only, since the personal access
 * token goes out in every request. The port and context path stay, because
 * either can tell two installations on one host apart; a page URL pasted from
 * the browser is cut back to the base it sits under. An Atlassian address is
 * refused: that's Cloud, which a personal access token never goes to.
 */
export function normalizeDataCenterUrl(value: unknown): string | null {
  const url = parseUrl(value);
  if (!url || url.protocol !== "https:" || url.username || url.password) return null;
  // A trailing dot names the same host, so it can't be allowed to hide one.
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".") || ATLASSIAN_HOST_PATTERN.test(host)) return null;
  const page =
    JIRA_PAGE_PATTERN.exec(url.pathname) ??
    SERVLET_PAGE_PATTERN.exec(url.pathname) ??
    (url.searchParams.has("jql") || url.searchParams.has("filter")
      ? ISSUE_NAVIGATOR_PATTERN.exec(url.pathname)
      : null);
  const path = (page ? url.pathname.slice(0, page.index) : url.pathname).replace(/\/+$/, "");
  if (!CONTEXT_PATH_PATTERN.test(path)) return null;
  const base = `${url.origin}${path}`;
  return base.length <= MAX_DATA_CENTER_URL_LENGTH ? base : null;
}

/** The site's normalized base, whichever deployment it is, or `null` when it's neither. */
export function normalizeSiteUrl(value: unknown): string | null {
  return normalizeCloudSiteUrl(value) ?? normalizeDataCenterUrl(value);
}

/** The deployment a normalized site URL belongs to. */
export function deploymentOf(siteUrl: string): JiraDeployment {
  return SITE_HOST_PATTERN.test(new URL(siteUrl).hostname) ? "cloud" : "dataCenter";
}

/** `acme.atlassian.net`, or `jira.example.com:8443`, from a normalized site URL. */
export function siteHostOf(siteUrl: string): string {
  return new URL(siteUrl).host;
}

/**
 * The site's base without its scheme: `acme.atlassian.net`, or
 * `jira.example.com:8443/jira`. Every normalized site is HTTPS, so this names it
 * completely.
 */
export function siteIdOf(siteUrl: string): string {
  return siteUrl.replace(/^https:\/\//, "");
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return EMAIL_PATTERN.test(trimmed) ? trimmed : null;
}
