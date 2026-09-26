import type { LeaseArgPath, LeaseTarget, LeaseTargetSource } from "../ipc/channelLeasePolicy.js";

type MaybePromise<T> = T | Promise<T>;

/**
 * This Host's own records, which the lease gate reads to find the project a
 * call changes. Each answers null when it can't tell, which refuses the call;
 * the list-valued ones answer [] for a record that changes no project (an
 * operation that has finished and gone, a panel with no preview running).
 */
export interface LeaseTargetResolvers {
  /** The registered project a repository, worktree or folder path belongs to. */
  projectForPath(path: string): MaybePromise<string | null>;
  /** The project a terminal's pty-host record names. */
  projectForTerminal(terminalId: string): MaybePromise<string | null>;
  projectsForOperation(opId: string): MaybePromise<readonly string[]>;
  projectsForDevPreviewPanel(panelId: string): MaybePromise<readonly string[]>;
  projectsForHelpSession(sessionId: string): MaybePromise<readonly string[]>;
  /** This Host's current project, which some handlers fall back to; null for none. */
  currentProjectId(): string | null;
}

/**
 * What a call changes: the projects it names, `every` for a host-wide call,
 * or `unresolved` when one of its targets couldn't be traced to a project.
 */
export type LeaseTargetResolution =
  | { kind: "projects"; projectIds: readonly string[] }
  | { kind: "every" }
  | { kind: "unresolved"; reason: string };

type SourceResult = readonly string[] | "every" | { unresolved: string };

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

function readArg(args: readonly unknown[], at: LeaseArgPath): unknown {
  const [index, ...keys] = at;
  let value: unknown = args[index];
  for (const key of keys) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  }
  return value;
}

function one(projectId: string | null, what: string): SourceResult {
  return projectId ? [projectId] : { unresolved: what };
}

function resolveSource(
  source: LeaseTargetSource,
  args: readonly unknown[],
  callerProjectId: string | null,
  resolvers: LeaseTargetResolvers
): MaybePromise<SourceResult> {
  if (source.from === "caller") return one(callerProjectId, "the caller's project");
  if (source.from === "every-project") return "every";

  const value = readArg(args, source.at);
  if (value === undefined || value === null) {
    const optional = "optional" in source ? source.optional : undefined;
    if (optional === true) return [];
    if (optional === "caller") return one(callerProjectId, "the caller's project");
    if (optional === "current-project") {
      const current = resolvers.currentProjectId();
      return current ? [current] : [];
    }
    return { unresolved: `no ${source.from} argument` };
  }
  if (typeof value !== "string" || value.length === 0) {
    return { unresolved: `a malformed ${source.from} argument` };
  }

  const then = <T>(result: MaybePromise<T>, map: (resolved: T) => SourceResult) =>
    isPromiseLike(result) ? result.then(map) : map(result);

  switch (source.from) {
    case "project":
      return [value];
    case "path":
    case "worktree":
      return then(resolvers.projectForPath(value), (projectId) =>
        projectId
          ? [projectId]
          : source.from === "path" && source.unowned === "allow"
            ? []
            : { unresolved: `a ${source.from} in no registered project` }
      );
    case "terminal":
      return then(resolvers.projectForTerminal(value), (projectId) =>
        one(projectId, "a terminal with no owning project")
      );
    case "operation":
      return then(resolvers.projectsForOperation(value), (ids) => ids);
    case "dev-preview-panel":
      return then(resolvers.projectsForDevPreviewPanel(value), (ids) => ids);
    case "help-session":
      return then(resolvers.projectsForHelpSession(value), (ids) => ids);
  }
}

function combine(results: readonly SourceResult[]): LeaseTargetResolution {
  const projectIds = new Set<string>();
  let every = false;
  for (const result of results) {
    if (result === "every") every = true;
    else if ("unresolved" in result) return { kind: "unresolved", reason: result.unresolved };
    else for (const id of result) projectIds.add(id);
  }
  return every ? { kind: "every" } : { kind: "projects", projectIds: [...projectIds] };
}

/**
 * The projects a call on a `driver` channel changes, from its declared target
 * and this Host's own records. Synchronous when every record it reads is.
 */
export function resolveLeaseTarget(
  target: LeaseTarget,
  args: readonly unknown[],
  callerProjectId: string | null,
  resolvers: LeaseTargetResolvers
): MaybePromise<LeaseTargetResolution> {
  let results: Array<MaybePromise<SourceResult>>;
  try {
    results = target.map((source) => resolveSource(source, args, callerProjectId, resolvers));
  } catch {
    return { kind: "unresolved", reason: "a record that couldn't be read" };
  }
  if (!results.some(isPromiseLike)) return combine(results as SourceResult[]);
  return Promise.all(results).then(combine, () => ({
    kind: "unresolved" as const,
    reason: "a record that couldn't be read",
  }));
}
