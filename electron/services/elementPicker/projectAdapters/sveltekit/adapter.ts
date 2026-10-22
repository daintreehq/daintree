import {
  PROJECT_CONTEXT_LIMITS,
  type ProjectContext,
  type ProjectRoute,
  type RouteFile,
} from "../../../../../shared/elementPicker/projectContext.js";
import { SourceFileRefSchema } from "../../../../../shared/elementPicker/resolution.js";
import { matchRoute } from "../../../../../shared/elementPicker/sveltekit/routeMatch.js";
import { lexicalSourcePath, type SourceRoots } from "../../sourceAccess.js";
import { toWorktreeRelative } from "../fs.js";
import type { ProjectAdapter } from "../types.js";
import { inspectProject } from "./index.js";
import type { ProjectModel, RouteNode } from "./model.js";

function isTruncated(model: ProjectModel): boolean {
  return (
    model.routeDiagnostics?.some((diagnostic) => diagnostic.code === "traversal-truncated") ?? false
  );
}

/**
 * The route the tree names for this path, when the tree can be trusted to name
 * one. Three ways it cannot: a base the config computes cannot be stripped from
 * the URL; routes walked in the default directory because the config was
 * unreadable describe a tree the app may not have; and a dynamic match on a
 * walk that stopped early may be standing in for a static route never reached.
 * Naming files in any of the three hands an agent a guess dressed as a reading.
 */
function routeFor(model: ProjectModel, pathname: string): RouteNode | null {
  if (model.basePath === null || model.routesDirectory?.source === "unresolved") return null;
  const match = matchRoute(model.routes, pathname, model.basePath ?? "");
  if (!match?.dynamic) return match;
  return isTruncated(model) ? null : match;
}

/**
 * The route's files as refs a resolver could read: inside the app, since that
 * is where a workspace's source reads are contained. A routes directory a
 * config points outside the app names files no selection can be traced into.
 */
function routeFiles(route: RouteNode, roots: SourceRoots, workspaceId: string): RouteFile[] {
  const named: Array<{ role: RouteFile["role"]; path: string }> = [
    ...(route.pageFile === null ? [] : [{ role: "page" as const, path: route.pageFile }]),
    ...route.layoutFiles.map((path) => ({ role: "layout" as const, path })),
    ...(route.dataFiles ?? []).map((path) => ({ role: "data" as const, path })),
  ];
  const files: RouteFile[] = [];
  for (const { role, path } of named) {
    if (lexicalSourcePath(roots, path) === null) continue;
    const file = SourceFileRefSchema.safeParse({ workspaceId, path });
    if (file.success) files.push({ role, file: file.data });
  }
  return files.slice(0, PROJECT_CONTEXT_LIMITS.routeFiles);
}

export const sveltekitAdapter: ProjectAdapter = {
  async describe({ workspaceId, roots, pathname, reader, signal }): Promise<ProjectContext> {
    const { model, support, routesDirectory } = await inspectProject(reader, {
      worktreeRoot: roots.worktreePath,
      appRoot: roots.appRoot,
      signal,
    });
    const match = routeFor(model, pathname);
    const route: ProjectRoute | null = match && {
      routeId: match.routeId,
      files: routeFiles(match, roots, workspaceId),
    };
    return {
      adapter: "sveltekit",
      appPath: toWorktreeRelative(roots.worktreePath, roots.appRoot),
      route,
      routes: {
        directory: toWorktreeRelative(roots.worktreePath, routesDirectory.path),
        source: routesDirectory.source,
        basePath: model.basePath ?? null,
        complete: !isTruncated(model),
      },
      toolchain: {
        versions: model.versions,
        verdict: support.verdict.level,
        reasons: (support.verdict.level === "untested" ? support.verdict.reasons : []).slice(
          0,
          PROJECT_CONTEXT_LIMITS.reasons
        ),
        missingInstall: support.missingInstall,
      },
      diagnostics: (model.routeDiagnostics ?? [])
        .slice(0, PROJECT_CONTEXT_LIMITS.diagnostics)
        .map((diagnostic) => ({
          ...diagnostic,
          files: diagnostic.files.slice(0, PROJECT_CONTEXT_LIMITS.diagnosticFiles),
        })),
    };
  },
};
