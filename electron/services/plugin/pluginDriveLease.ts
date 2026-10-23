import { AppError } from "../../utils/errorTypes.js";
import type { LeaseTargetResolvers } from "../driveLeaseTargets.js";
import { getEndedPluginInvocation, getPluginInvokeOrigin } from "./pluginFrontendRouting.js";
import type { ClientEndpoint } from "../../ipc/endpoint.js";

/** Who made a call the host can no longer place: it holds no lease, so it drives nothing. */
const UNKNOWN_CALLER: Pick<ClientEndpoint, "endpointId" | "clientId"> = Object.freeze({
  endpointId: "",
  clientId: "",
});

/**
 * Who the current work answers to: the call it runs in, or the call that
 * started it if that call has since returned. Null is a plugin's own
 * background work.
 */
function callerOf(pluginId: string): Pick<ClientEndpoint, "endpointId" | "clientId"> | null {
  const origin = getPluginInvokeOrigin(pluginId);
  if (origin !== null) return origin.endpoint;
  const ended = getEndedPluginInvocation(pluginId);
  return ended === null ? null : (ended.caller ?? UNKNOWN_CALLER);
}

/** What a plugin's host call is about to change: paths on disk, or a terminal it types into. */
export type PluginWriteTarget =
  { readonly paths: readonly string[] } | { readonly terminalId: string };

/**
 * Refuse a plugin's change to a project when the call it runs in came from a
 * view that doesn't drive that project, as that view's own project writes are
 * refused (`DRIVEN_ELSEWHERE`). `plugin:invoke` carries reads as well as
 * writes, so the lease can't be held per channel: each host API that changes a
 * project asks here, naming what it is about to change.
 *
 * Only calls are held to it: a plugin's own background work is nobody's call,
 * and with no lease service (anyone not in Host mode) nothing is checked.
 * Work a call started that runs after it returned is still that call's, held
 * to the lease as it stands when the work arrives (#14251). A
 * path in no registered project changes none, so a plugin's own data and
 * drafts stay writable from any view. The project is traced through this
 * Host's records, as the dispatcher's gate traces it, and a lookup that fails
 * refuses rather than lets the write through.
 */
export async function assertPluginCallerDrives(
  pluginId: string,
  op: string,
  target: PluginWriteTarget
): Promise<void> {
  const caller = callerOf(pluginId);
  if (caller === null) return;
  // Loaded once a call is in hand: calls carry an origin only in Host mode.
  const { peekDriveLeaseService, drivenElsewhereError, unmatchedTargetError } =
    await import("../DriveLeaseService.js");
  const lease = peekDriveLeaseService();
  if (lease === null || lease.projectsDrivenElsewhere(caller).size === 0) return;

  const what = `plugin "${pluginId}" ${op}`;
  const { createLeaseTargetResolvers } = await import("../driveLeaseTargetResolvers.js");
  let traced: readonly string[] | { readonly unresolved: string };
  try {
    traced = await projectsChangedBy(createLeaseTargetResolvers(), target);
  } catch {
    throw forPlugin(unmatchedTargetError(what, "a record that couldn't be read"));
  }
  if ("unresolved" in traced) throw forPlugin(unmatchedTargetError(what, traced.unresolved));

  // Judged against the leases as they stand once the lookup answered: a
  // takeover while it ran counts.
  const elsewhere = lease.projectsDrivenElsewhere(caller);
  for (const projectId of traced) {
    const holder = elsewhere.get(projectId);
    if (holder) throw forPlugin(drivenElsewhereError(what, projectId, holder));
  }
}

/**
 * The projects a write changes. A terminal the host doesn't have, or can't
 * place in a project, is refused as the dispatcher's gate refuses one: nothing
 * vouches that the write wouldn't land in a project someone else drives.
 */
async function projectsChangedBy(
  resolvers: LeaseTargetResolvers,
  target: PluginWriteTarget
): Promise<readonly string[] | { readonly unresolved: string }> {
  if ("paths" in target) {
    return (await Promise.all(target.paths.map((p) => resolvers.projectsForPath(p)))).flat();
  }
  const record = await resolvers.describeTerminal(target.terminalId);
  if (record === "missing") return { unresolved: "a terminal this host doesn't have" };
  if (record.projectId === null) return { unresolved: "a terminal with no owning project" };
  return [record.projectId];
}

/**
 * The gate's refusal as a plugin sees it: like every host error a plugin can
 * match, its message starts with the code, and here goes on to say what to do,
 * so a plugin that shows the message shows the Take control wording.
 */
function forPlugin(refusal: AppError): AppError {
  return new AppError({
    code: "DRIVEN_ELSEWHERE",
    message: `DRIVEN_ELSEWHERE: ${refusal.userMessage}`,
    userMessage: refusal.userMessage,
    context: refusal.context,
  });
}
