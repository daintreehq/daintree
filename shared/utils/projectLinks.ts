import type {
  ProjectLink,
  ProjectLinkActor,
  ProjectLinkChange,
  ProjectLinksChangeResult,
} from "../types/projectLinks.js";

export const MAX_PROJECT_LINKS = 50;
export const MAX_PROJECT_LINK_TITLE_LENGTH = 80;
export const MAX_PROJECT_LINK_URL_LENGTH = 2048;

// Literal names only: anything else on plain http, a LAN address included,
// is a page the Assistant could be steered to that nobody can vouch for.
const ASSISTANT_HTTP_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Why `title` can't name a project link, or null when it can. */
export function projectLinkTitleProblem(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed) return "Enter a name for the link";
  if (trimmed.length > MAX_PROJECT_LINK_TITLE_LENGTH) {
    return `A link's name can be at most ${MAX_PROJECT_LINK_TITLE_LENGTH} characters`;
  }
  if (CONTROL_CHARACTERS.test(trimmed)) return "A link's name can't hold a line break";
  return null;
}

/**
 * The address a project link saves for `url`, or why it can't be one. The
 * Assistant may add `https` anywhere and `http` only for `localhost` or
 * `127.0.0.1`. A link added by hand may be any web address, as a person's own
 * global links may. Neither may carry a username or password, which would
 * be stored in plain settings.
 */
export function parseProjectLinkUrl(
  url: string,
  actor: ProjectLinkActor
): { ok: true; href: string } | { ok: false; message: string } {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, message: "Enter the link's URL" };
  if (trimmed.length > MAX_PROJECT_LINK_URL_LENGTH) {
    return {
      ok: false,
      message: `A link's URL can be at most ${MAX_PROJECT_LINK_URL_LENGTH} characters`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: "Enter a full URL, starting with https://" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      message:
        actor === "assistant"
          ? "The URL must use https://, or http:// for localhost"
          : "The URL must use http:// or https://",
    };
  }
  if (!parsed.hostname) return { ok: false, message: "Enter a full URL, starting with https://" };
  if (parsed.username || parsed.password) {
    return { ok: false, message: "A link can't carry a username or password" };
  }
  if (
    actor === "assistant" &&
    parsed.protocol === "http:" &&
    !ASSISTANT_HTTP_HOSTS.has(parsed.hostname)
  ) {
    return {
      ok: false,
      message: "An http:// link can only point at localhost or 127.0.0.1; use https://",
    };
  }
  if (parsed.href.length > MAX_PROJECT_LINK_URL_LENGTH) {
    return {
      ok: false,
      message: `A link's URL can be at most ${MAX_PROJECT_LINK_URL_LENGTH} characters`,
    };
  }
  return { ok: true, href: parsed.href };
}

/**
 * The links a settings file holds that a change could have written: entries
 * of the wrong shape, repeated ids, and addresses no writer accepts are
 * dropped, as is a marker on a link the Assistant could not have added.
 */
export function sanitizeProjectLinks(raw: unknown): ProjectLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const links: ProjectLink[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (links.length >= MAX_PROJECT_LINKS) break;
    if (!entry || typeof entry !== "object") continue;
    const { id, title, url, addedByAssistant } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || ids.has(id)) continue;
    if (typeof title !== "string" || projectLinkTitleProblem(title)) continue;
    if (typeof url !== "string") continue;
    const parsed = parseProjectLinkUrl(url, "user");
    if (!parsed.ok) continue;
    const byAssistant =
      addedByAssistant === true && parseProjectLinkUrl(url, "assistant").ok === true;
    ids.add(id);
    links.push({
      id,
      title: title.trim(),
      url: parsed.href,
      ...(byAssistant ? { addedByAssistant: true as const } : {}),
    });
  }
  return links;
}

/**
 * One change to a project's links, as main applies it to the list it has on
 * disk. The Assistant may only change or remove a link it added and nobody
 * has edited since; a change made by hand takes the link over.
 */
export function applyProjectLinkChange(
  links: readonly ProjectLink[],
  change: ProjectLinkChange,
  actor: ProjectLinkActor,
  createId: () => string
): ProjectLinksChangeResult {
  if (change.op === "add") {
    const titleProblem = projectLinkTitleProblem(change.title);
    if (titleProblem) return { saved: false, code: "invalid-title", message: titleProblem };
    const url = parseProjectLinkUrl(change.url, actor);
    if (!url.ok) return { saved: false, code: "invalid-url", message: url.message };
    if (links.length >= MAX_PROJECT_LINKS) {
      return {
        saved: false,
        code: "limit",
        message: `This project already has ${MAX_PROJECT_LINKS} links`,
      };
    }
    const link: ProjectLink = {
      id: createId(),
      title: change.title.trim(),
      url: url.href,
      ...(actor === "assistant" ? { addedByAssistant: true as const } : {}),
    };
    return { saved: true, links: [...links, link], link };
  }

  const index = links.findIndex((link) => link.id === change.id);
  const current = index >= 0 ? links[index] : undefined;
  if (!current) {
    return { saved: false, code: "not-found", message: "No link with that id in this project" };
  }
  const assistantOnly =
    actor === "assistant" || (change.op === "remove" && change.onlyIfAddedByAssistant === true);
  if (assistantOnly && current.addedByAssistant !== true) {
    return {
      saved: false,
      code: "not-added-by-assistant",
      message: "That link was added or edited by hand, so only the user can change it",
    };
  }

  if (change.op === "remove") {
    return { saved: true, links: links.filter((link) => link.id !== change.id), link: current };
  }

  let title = current.title;
  if (change.title !== undefined) {
    const titleProblem = projectLinkTitleProblem(change.title);
    if (titleProblem) return { saved: false, code: "invalid-title", message: titleProblem };
    title = change.title.trim();
  }
  let url = current.url;
  if (change.url !== undefined) {
    const parsed = parseProjectLinkUrl(change.url, actor);
    if (!parsed.ok) return { saved: false, code: "invalid-url", message: parsed.message };
    url = parsed.href;
  }
  const link: ProjectLink = {
    id: current.id,
    title,
    url,
    ...(actor === "assistant" ? { addedByAssistant: true as const } : {}),
  };
  const next = [...links];
  next[index] = link;
  return { saved: true, links: next, link };
}

/** A link's host as the launchpad prints it beside the name, so an odd address shows before a click. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}
