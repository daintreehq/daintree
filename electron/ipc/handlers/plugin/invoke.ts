import { CHANNELS } from "../../channels.js";
import { stableArgsSha256 } from "../../../utils/pluginMcpHash.js";
import { isAuditedHandlerFailure } from "../../../utils/pluginAuditMarker.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { isPluginInvokeOwnershipError } from "../../../services/plugin/PluginInvokeErrors.js";
import type { PluginInvokeOrigin, PluginIpcContext } from "../../../../shared/types/plugin.js";
import { projectIdFromPluginInstanceKey } from "../../../services/plugin/projectPluginIdentity.js";
import { PLUGIN_INVOKE_MAX_ARGS_BYTES } from "../../../../shared/config/pluginBudgets.js";
import {
  assertPayloadWithinLimit,
  isPluginPayloadTooLargeError,
} from "../../../services/plugin/pluginPayloadLimits.js";
import { getPluginService, peekPluginService, type PluginServiceSingleton } from "./service.js";
import { safeAppend } from "./auditAppend.js";

/**
 * Count an invoke refused for oversize args against its plugin. Refused args
 * never reach `dispatchHandler`, which meters every invoke that does. Applied
 * only where the dispatch itself would have accepted the sender's scope, so a
 * view cannot run up another project's plugin's numbers.
 *
 * Recorded synchronously, against whichever load is live at the refusal: a
 * deferred record could land after an unload and same-id reload and count
 * against the successor. Before the service has been resolved there is
 * nothing to count against — any plugin IPC call resolves it, and the
 * renderer makes several at startup.
 */
export function meterOversizeInvokeArgs(
  pluginId: unknown,
  senderProjectId: string | null,
  durationMs: number
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  const owner = projectIdFromPluginInstanceKey(pluginId);
  if (owner !== null && owner !== senderProjectId) return;
  try {
    peekPluginService()?.metrics.recordInvoke(pluginId, durationMs, "oversized");
  } catch {
    // Metrics are best-effort.
  }
}

interface PluginInvokeSource {
  projectId: string | null;
  webContentsId: number;
  start: number;
  origin?: PluginInvokeOrigin;
  resolveWorktreeId: (service: PluginServiceSingleton) => Promise<string | null>;
}

/**
 * The transport-independent half of `plugin:invoke`: the project ownership
 * check, the dispatch, and its audit. The caller has already established who
 * is calling — a trusted local frame, or an endpoint the host itself bound.
 */
export async function runPluginInvoke(
  source: PluginInvokeSource,
  pluginId: string,
  channel: string,
  args: unknown[]
): Promise<unknown> {
  const { start } = source;
  // A project plugin answers only to its own project's renderers. The
  // instance key names its project and is not a secret, so without this a
  // renderer for project B could invoke project A's plugin handler and make
  // it act on A — with A's host binding, A's capabilities and A's files.
  // Checked against the sender's own registration, never a supplied id.
  const boundProjectId = projectIdFromPluginInstanceKey(pluginId);
  if (boundProjectId !== null && boundProjectId !== source.projectId) {
    safeAppend({
      pluginId,
      actionId: channel,
      recordType: "ipc-invoke",
      channel: CHANNELS.PLUGIN_INVOKE,
      result: "restricted",
      errorMessage: "sender belongs to a different project",
      argsHash: "",
      durationMs: Date.now() - start,
    });
    throw new Error("plugin:invoke rejected: plugin belongs to a different project");
  }

  // Whether the args passed the size cap, so the failure audit below knows
  // it may hash them: hashing sorts and serialises the whole payload, which
  // is exactly the unbounded work the cap exists to refuse.
  let argsWithinLimit = false;
  try {
    // Before any dispatch work, so an oversize payload is never forwarded
    // to a plugin worker (a second full structured clone).
    assertPayloadWithinLimit(
      pluginId,
      `arguments to "${channel}"`,
      args,
      PLUGIN_INVOKE_MAX_ARGS_BYTES
    );
    argsWithinLimit = true;
    const service = await getPluginService();
    const worktreeId = await source.resolveWorktreeId(service);
    const ctx: PluginIpcContext = {
      projectId: source.projectId,
      worktreeId,
      webContentsId: source.webContentsId,
      pluginId,
      ...(source.origin ? { origin: source.origin } : {}),
    };
    return await service.dispatchHandler(pluginId, channel, ctx, args);
  } catch (err) {
    if (!argsWithinLimit && isPluginPayloadTooLargeError(err)) {
      meterOversizeInvokeArgs(pluginId, source.projectId, Date.now() - start);
    }
    // A throwing plugin handler is already audited at the dispatch
    // boundary (#10463); recording it again here would double-count the
    // failure. Errors that never reach a handler — schema/permission/
    // no-handler — aren't marked, so the IPC boundary still owns them.
    if (!isAuditedHandlerFailure(err)) {
      // `stableArgsSha256` content-discriminates without persisting any
      // arg bytes — two structurally identical failed invokes hash the
      // same, but distinct args produce distinct hashes. (A summary-based
      // hash via `summarizeMcpArgs` collapses arrays to a constant, which
      // would defeat forensic grouping.)
      //
      // Oversize args are recorded unhashed (`""`, the schema's "never
      // validated" value); the error message carries the limit and the
      // size measured.
      let argsHash = "";
      if (argsWithinLimit) {
        try {
          argsHash = stableArgsSha256(args);
        } catch {
          // Hashing is best-effort — a serialization throw here must not
          // mask the original handler error.
        }
      }
      // An ownership rejection (#10462) is a denied invocation, not a
      // handler failure — record it as "restricted" so it groups with the
      // untrusted-sender rejection above rather than with genuine dispatch
      // errors. The sender already passed its trust check, so the args are
      // from a trusted caller and the forensic `argsHash` is still useful.
      // An ownership error is thrown before any handler runs, so it is never
      // marked as an audited handler failure and always reaches this block.
      safeAppend({
        pluginId,
        actionId: channel,
        recordType: "ipc-invoke",
        channel: CHANNELS.PLUGIN_INVOKE,
        result: isPluginInvokeOwnershipError(err) ? "restricted" : "error",
        errorMessage: formatErrorMessage(err, "plugin:invoke dispatch failed"),
        argsHash,
        durationMs: Date.now() - start,
      });
    }
    throw err;
  }
}
