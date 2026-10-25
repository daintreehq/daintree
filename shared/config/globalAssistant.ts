import {
  HOST_CALL_TOOL,
  HOST_LIST_TOOL,
  HOST_SETTINGS_TOOL,
  HOST_WATCH_TOOL,
} from "../types/hostControl.js";

/**
 * The one Daintree Assistant an installation may run outside any project
 * (#14159). It is not a project lane: it has no project, no view and no slot
 * of the project model, so nothing that sweeps lanes by project or by view
 * can reach it. The id is an opaque workspace id — a spawn naming it resolves
 * to no Project, so it never inherits the active one.
 */
export const GLOBAL_ASSISTANT_ID = "daintree:global-assistant";

/** The lane its resume pointer is stored under, in the project hibernation store. */
export const GLOBAL_ASSISTANT_SLOT = 0;

/** Folder under userData whose path stands in for the project path, so its session directory is stable. */
export const GLOBAL_ASSISTANT_DIR_NAME = "global-assistant";

export function isGlobalAssistantId(projectId: string): boolean {
  return projectId === GLOBAL_ASSISTANT_ID;
}

/**
 * Everything the global assistant may call directly (#14161). It names no
 * project, so every project tool reaches it only through `host.call`, where
 * the target host admits it as it would another machine's assistant: the owned
 * tools alone act, on what it launched there or was handed. `host.ensureProject`
 * acts on the caller's own project, which it has none of. `host.settings`
 * names hosts, never a project, and every change it makes the person approves.
 * `host.watch` names a host and only listens, so the coordinator that held
 * work for one hears when it comes back (#14463).
 */
export const GLOBAL_ASSISTANT_TOOL_IDS: ReadonlySet<string> = new Set([
  HOST_LIST_TOOL,
  HOST_CALL_TOOL,
  HOST_SETTINGS_TOOL,
  HOST_WATCH_TOOL,
]);

/**
 * The tool its readiness probe looks for in `tools/list` (#14483). Its set has
 * no `actions.getContext`, and `host.list` is listed from its start.
 */
export const GLOBAL_ASSISTANT_READINESS_TOOL = HOST_LIST_TOOL;
