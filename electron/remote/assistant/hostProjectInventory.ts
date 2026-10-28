import { createHash } from "node:crypto";
import {
  HOST_LIST_PROJECT_BYTES_MAX,
  HOST_LIST_PROJECT_CURSOR_MAX,
  HOST_LIST_PROJECT_NAME_MAX,
  HOST_LIST_PROJECT_QUERY_MAX,
  HOST_LIST_PROJECTS_MAX,
  type HostListEntry,
} from "../../../shared/types/hostControl.js";
import type { HostProjectSummary } from "../../../shared/types/ipc/remoteHosts.js";

/**
 * Pages of a host's project list for `host.list` (#14457). A cursor carries no
 * authority and holds no list: it names the host, the query, where the next
 * page starts and a revision of the list it was cut from, so a list that
 * changed between pages starts again rather than skipping or repeating one.
 */

type ListedProject = NonNullable<HostListEntry["projects"]>[number];
type ProjectInventory = NonNullable<HostListEntry["projectInventory"]>;

export interface ProjectCursor {
  hostId: string;
  query: string | null;
  offset: number;
  revision: string;
}

const CURSOR_VERSION = 1;

export function encodeProjectCursor(cursor: ProjectCursor): string {
  const { hostId, query, offset, revision } = cursor;
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, h: hostId, q: query, o: offset, r: revision })
  ).toString("base64url");
}

/** A cursor `host.list` gave, or null for anything else. */
export function decodeProjectCursor(raw: string): ProjectCursor | null {
  if (raw.length > HOST_LIST_PROJECT_CURSOR_MAX) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { v, h, q, o, r } = parsed as Record<string, unknown>;
  if (v !== CURSOR_VERSION) return null;
  if (typeof h !== "string" || h.length === 0 || h.length > 64) return null;
  if (
    q !== null &&
    (typeof q !== "string" || q.length === 0 || q.length > HOST_LIST_PROJECT_QUERY_MAX)
  )
    return null;
  if (typeof o !== "number" || !Number.isSafeInteger(o) || o < 0) return null;
  if (typeof r !== "string" || !/^[0-9a-f]{16}$/.test(r)) return null;
  return { hostId: h, query: q, offset: o, revision: r };
}

function revisionOf(projects: readonly HostProjectSummary[]): string {
  const hash = createHash("sha256");
  for (const project of projects) hash.update(`${project.id}\0`);
  return hash.digest("hex").slice(0, 16);
}

function matches(project: HostProjectSummary, query: string | null): boolean {
  return query === null || project.name.toLowerCase().includes(query.toLowerCase());
}

/** A name cut to its first code points, never through a surrogate pair. */
function boundedName(name: string): string {
  if (name.length <= HOST_LIST_PROJECT_NAME_MAX) return name;
  const points = Array.from(name);
  return points.length <= HOST_LIST_PROJECT_NAME_MAX
    ? name
    : `${points.slice(0, HOST_LIST_PROJECT_NAME_MAX - 1).join("")}…`;
}

/** A project as `host.list` names it, with whether a frontend is attached as its host said. */
function listedProject(project: HostProjectSummary): ListedProject {
  return {
    projectId: project.id,
    name: boundedName(project.name),
    frontendAttached: project.frontendAttached ?? null,
  };
}

/** One host's page, and what it needs to be cut shorter to fit the answer. */
export interface ProjectPage {
  hostId: string;
  query: string | null;
  revision: string;
  matching: number;
  /** The host's own list stopped at its limit, so what lies past it is unknown. */
  capped: boolean;
  offset: number;
  listChanged: boolean;
  projects: ListedProject[];
}

export function pageProjects(
  all: readonly HostProjectSummary[],
  options: {
    hostId: string;
    query: string | null;
    cursor: ProjectCursor | null;
    capped: boolean;
  }
): ProjectPage {
  const { hostId, query, cursor, capped } = options;
  const eligible = all.filter((project) => matches(project, query));
  const revision = revisionOf(eligible);
  const listChanged = cursor !== null && cursor.revision !== revision;
  const offset = cursor !== null && !listChanged ? Math.min(cursor.offset, eligible.length) : 0;
  return {
    hostId,
    query,
    revision,
    matching: eligible.length,
    capped,
    offset,
    listChanged,
    projects: eligible.slice(offset, offset + HOST_LIST_PROJECTS_MAX).map(listedProject),
  };
}

export function inventoryOf(page: ProjectPage): ProjectInventory {
  const { matching, capped, offset, projects } = page;
  const next = offset + projects.length;
  return {
    complete: !capped && projects.length === matching,
    total: capped ? null : matching,
    offset,
    omitted: capped ? null : matching - projects.length,
    nextCursor:
      next < matching
        ? encodeProjectCursor({
            hostId: page.hostId,
            query: page.query,
            offset: next,
            revision: page.revision,
          })
        : null,
    listChanged: page.listChanged,
  };
}

const encoder = new TextEncoder();

function projectBytes(project: ListedProject): number {
  // Its comma in the array counts too.
  return encoder.encode(JSON.stringify(project)).length + 1;
}

/**
 * Cuts the pages short until every host's projects fit in one answer's
 * budget, taking from the longest page first so no host's list is crowded out
 * by another's. A page cut to nothing still carries its cursor, and a lone
 * page keeps one project, so following cursors always gets somewhere.
 */
export function fitProjectPages(
  pages: readonly ProjectPage[],
  budget = HOST_LIST_PROJECT_BYTES_MAX
): void {
  const costs = pages.map((page) => page.projects.map(projectBytes));
  let total = costs.flat().reduce((sum, cost) => sum + cost, 0);
  while (total > budget) {
    let longest = -1;
    for (let index = 0; index < pages.length; index++) {
      const length = pages[index]!.projects.length;
      if (length > 0 && (longest < 0 || length >= pages[longest]!.projects.length)) {
        longest = index;
      }
    }
    if (longest < 0) return;
    if (pages.length === 1 && pages[longest]!.projects.length === 1) return;
    pages[longest]!.projects.pop();
    total -= costs[longest]!.pop() ?? 0;
  }
}
