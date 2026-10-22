import { AppError } from "../../utils/errorTypes.js";
import { getPluginInvokeOrigin } from "./pluginFrontendRouting.js";

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
 * and with no lease service (anyone not in Host mode) nothing is checked. A
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
  const origin = getPluginInvokeOrigin(pluginId);
  if (origin === null) return;
  // Loaded once a call is in hand: calls carry an origin only in Host mode.
  const { peekDriveLeaseService, drivenElsewhereError, unmatchedTargetError } =
    await import("../DriveLeaseService.js");
  const lease = peekDriveLeaseService();
  if (lease === null || lease.projectsDrivenElsewhere(origin.endpoint).size === 0) return;

  const what = `plugin "${pluginId}" ${op}`;
  const { createLeaseTargetResolvers } = await import("../driveLeaseTargetResolvers.js");
  const resolvers = createLeaseTargetResolvers();
  let projectIds: readonly (string | null)[];
  try {
    projectIds =
      "paths" in target
        ? (await Promise.all(target.paths.map((p) => resolvers.projectsForPath(p)))).flat()
        : [await resolvers.projectForTerminal(target.terminalId)];
  } catch {
    throw forPlugin(unmatchedTargetError(what, "a record that couldn't be read"));
  }

  // Judged against the leases as they stand once the lookup answered: a
  // takeover while it ran counts.
  const elsewhere = lease.projectsDrivenElsewhere(origin.endpoint);
  for (const projectId of projectIds) {
    if (projectId === null) {
      throw forPlugin(unmatchedTargetError(what, "a terminal with no owning project"));
    }
    const holder = elsewhere.get(projectId);
    if (holder) throw forPlugin(drivenElsewhereError(what, projectId, holder));
  }
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
