import { AppError } from "../../../utils/errorTypes.js";
import { SCOPED_PLUGIN_NAME_PATTERN } from "../../../schemas/pluginIdentifiers.js";
import type {
  ProjectPluginInfo,
  ProjectPluginTrustDecision,
  ProjectPluginVisibility,
} from "../../../../shared/types/plugin.js";
import type { IpcContext } from "../../types.js";
import { getPluginService } from "./service.js";

/**
 * Project-local plugin rows for the SENDER's project.
 *
 * The project is resolved from the sender's own view registration, never from a
 * renderer-supplied id — the same reason the pull-on-mount contribution
 * handlers do it: a compromised or merely confused renderer must not be able to
 * read, or act on, another project's plugin state. A sender with no project
 * binding (the picker window, an unbound window) legitimately has none, and
 * gets an empty list rather than the active project's.
 */
export async function handleProjectPluginsList(ctx: IpcContext): Promise<ProjectPluginInfo[]> {
  if (!ctx.projectId) return [];
  const svc = await getPluginService();
  return svc.listProjectPlugins(ctx.projectId);
}

/**
 * Record the trust decision for the sender's project. `"session"` is held in
 * memory only; `"enabled"` and `"disabled"` persist. Revoking (`"disabled"`)
 * unloads every plugin the project owns and purges its capability grants.
 */
export async function handleProjectPluginsSetTrust(
  ctx: IpcContext,
  decision: ProjectPluginTrustDecision
): Promise<void> {
  if (!ctx.projectId) throw new Error("project plugins: sender has no project");
  if (decision !== "enabled" && decision !== "disabled" && decision !== "session") {
    throw new Error("project plugins: invalid trust decision");
  }
  const svc = await getPluginService();
  await svc.setProjectPluginTrust(ctx.projectId, decision);
}

/** One-click activation of a plugin the project staged rather than ran. */
export async function handleProjectPluginsActivateStaged(
  ctx: IpcContext,
  pluginId: string
): Promise<void> {
  if (!ctx.projectId) throw new Error("project plugins: sender has no project");
  if (typeof pluginId !== "string" || !SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) {
    throw new Error("project plugins: pluginId must be a scoped plugin name (publisher.name)");
  }
  const svc = await getPluginService();
  await svc.activateStagedProjectPlugin(ctx.projectId, pluginId);
}

/** Manual re-scan. Runs the same trust gate and staging rules as a project open. */
export async function handleProjectPluginsReload(ctx: IpcContext): Promise<void> {
  if (!ctx.projectId) throw new Error("project plugins: sender has no project");
  const svc = await getPluginService();
  await svc.reloadProjectPlugins(ctx.projectId);
}

/**
 * Switch one of the sender project's own plugins off, or back on. Unlike the
 * trust decision this is per plugin and leaves the folder's grant alone.
 */
export async function handleProjectPluginsSetMuted(
  ctx: IpcContext,
  pluginId: string,
  muted: boolean
): Promise<void> {
  if (!ctx.projectId) throw new Error("project plugins: sender has no project");
  if (typeof pluginId !== "string" || !SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) {
    throw new Error("project plugins: pluginId must be a scoped plugin name (publisher.name)");
  }
  if (typeof muted !== "boolean") {
    throw new Error("project plugins: muted must be a boolean");
  }
  const svc = await getPluginService();
  await svc.setProjectPluginMuted(ctx.projectId, pluginId, muted);
}

/**
 * The sender project's visibility overlay for INSTALLED plugins. Same
 * sender-resolved project rule as every other project-plugin op: a renderer
 * never names the project, so asking about another one is not expressible.
 */
export async function handleProjectPluginVisibilityGet(
  ctx: IpcContext
): Promise<ProjectPluginVisibility> {
  if (!ctx.projectId) return { defaultHiddenPluginIds: [], overrides: {} };
  const svc = await getPluginService();
  return svc.getProjectPluginVisibility(ctx.projectId);
}

/**
 * Hide or show one installed plugin in the sender's project. `visible: null`
 * clears the decision back to the default rather than storing an explicit
 * allow, so turning something back on leaves nothing behind.
 */
export async function handleProjectPluginVisibilitySet(
  ctx: IpcContext,
  pluginId: string,
  visible: boolean | null
): Promise<void> {
  if (!ctx.projectId) throw new Error("project plugins: sender has no project");
  if (typeof pluginId !== "string" || !SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) {
    throw new Error("project plugins: pluginId must be a scoped plugin name (publisher.name)");
  }
  if (visible !== null && typeof visible !== "boolean") {
    throw new Error("project plugins: visible must be a boolean or null");
  }
  const svc = await getPluginService();
  svc.setProjectPluginVisibility(ctx.projectId, pluginId, visible);
}

/**
 * Turn an installed `instanceMode: "project"` package on or off in the sender's
 * project. The project and its root are both resolved from the sender, so no
 * payload field can reach another project's instance.
 */
export async function handleProjectInstanceEnabledSet(
  ctx: IpcContext,
  pluginId: string,
  enabled: boolean
): Promise<void> {
  const projectId = ctx.projectId;
  if (!projectId) {
    throw new AppError({ code: "VALIDATION", message: "project plugins: sender has no project" });
  }
  if (typeof pluginId !== "string" || !SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) {
    throw new AppError({
      code: "VALIDATION",
      message: "project plugins: pluginId must be a scoped plugin name (publisher.name)",
    });
  }
  if (typeof enabled !== "boolean") {
    throw new AppError({
      code: "VALIDATION",
      message: "project plugins: enabled must be a boolean",
    });
  }
  const svc = await getPluginService();
  // A read before the deferred initialize() would find no packages at all.
  await svc.waitForCatalog();
  const { projectStore } = await import("../../../services/ProjectStore.js");
  const projectRoot = projectStore.getProjectById(projectId)?.path;
  if (!projectRoot) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "project plugins: sender's project is unknown",
    });
  }
  // Checked after the last await above, and the service persists before its
  // own first await, so a global disable cannot slip in between.
  const mode = svc.getInstalledPackageMode(pluginId);
  if (mode === "singleton") {
    throw new AppError({
      code: "UNSUPPORTED",
      message: `"${pluginId}" runs once for every project and can't be turned on per project`,
    });
  }
  if (mode === "project-unavailable") {
    throw new AppError({
      code: "UNSUPPORTED",
      message: `"${pluginId}" is turned off or blocked, so it can't be turned on in a project`,
    });
  }
  if (mode !== "project") {
    throw new AppError({ code: "NOT_FOUND", message: `"${pluginId}" is not an installed plugin` });
  }
  await svc.setProjectInstanceEnabled(projectId, projectRoot, pluginId, enabled);
}

/**
 * Whether one installed plugin is hidden in projects that have made no explicit
 * choice — the "everywhere" / "only where I turn it on" switch. Global in
 * effect, but reached from a project's settings, so the sender's project is
 * still what the resulting push is addressed to.
 */
export async function handlePluginVisibilityDefaultSet(
  ctx: IpcContext,
  pluginId: string,
  hidden: boolean
): Promise<void> {
  if (!ctx.projectId) throw new Error("project plugins: sender has no project");
  if (typeof pluginId !== "string" || !SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) {
    throw new Error("project plugins: pluginId must be a scoped plugin name (publisher.name)");
  }
  if (typeof hidden !== "boolean") {
    throw new Error("project plugins: hidden must be a boolean");
  }
  const svc = await getPluginService();
  svc.setPluginVisibilityDefault(ctx.projectId, pluginId, hidden);
}
