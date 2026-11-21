import { useEffect, useState } from "react";
import {
  CONTEXT_MENU_AVAILABILITY_CHANNEL,
  CONTEXT_MENU_AVAILABILITY_REASON_MAX,
  CONTEXT_MENU_AVAILABILITY_TIMEOUT_MS,
  type ContextMenuAvailabilityRequest,
  type ContextMenuLocation,
} from "@shared/types/plugin";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logWarn } from "@/utils/logger";

export type PluginContextMenuAvailability =
  { status: "checking" } | { status: "available" } | { status: "unavailable"; reason: string };

const CHECKING: PluginContextMenuAvailability = { status: "checking" };
const AVAILABLE: PluginContextMenuAvailability = { status: "available" };

const STRING_SUBJECT_KEYS = [
  "panelId",
  "panelKind",
  "worktreeId",
  "projectId",
  "relativePath",
] as const;

/**
 * The request a plugin's availability handler is asked, built from the args the
 * menu would dispatch with. Only the fields that name the subject cross over: a
 * browser page's URL and a file's absolute path and root stay on the dispatch,
 * which the person chooses, rather than going to the plugin every time a menu
 * opens.
 */
export function contextMenuAvailabilityRequest(
  availability: string,
  location: ContextMenuLocation,
  dispatchArgs: Record<string, unknown> | undefined
): ContextMenuAvailabilityRequest {
  const request: ContextMenuAvailabilityRequest = { availability, location };
  for (const key of STRING_SUBJECT_KEYS) {
    const value = dispatchArgs?.[key];
    if (typeof value === "string" && value.length > 0) request[key] = value;
  }
  if (typeof dispatchArgs?.isDirectory === "boolean") {
    request.isDirectory = dispatchArgs.isDirectory;
  }
  return request;
}

/**
 * Reads a handler's answer: `null` for available, or a reason that is one line
 * of at most {@link CONTEXT_MENU_AVAILABILITY_REASON_MAX} characters once
 * trimmed. Anything else is malformed and returns `undefined`.
 */
export function readContextMenuAvailabilityAnswer(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || /[\r\n\u2028\u2029]/.test(value)) return undefined;
  const reason = value.trim();
  if (reason.length === 0 || reason.length > CONTEXT_MENU_AVAILABILITY_REASON_MAX) return undefined;
  return reason;
}

/**
 * Whether one plugin context-menu row that opted into an availability check
 * (#18141) can run on the subject its menu was opened on. Mounted only with the
 * open menu's row, so each opening asks afresh and a closed menu asks nothing.
 *
 * An answer belongs to the request the plugin was asked, so a row whose request
 * changes asks again, and one whose request reads the same keeps its answer.
 *
 * The answer is advisory, so every failure offers the item as it would be
 * without the check: no bridge, a rejected invoke (no handler, a crashed
 * worker), a malformed answer, or none within the timeout. An answer that
 * arrives after the row unmounted or moved to another subject is dropped.
 */
export function usePluginContextMenuAvailability(
  pluginId: string,
  label: string,
  request: ContextMenuAvailabilityRequest
): PluginContextMenuAvailability {
  const hasBridge = typeof window.electron?.plugin?.invoke === "function";
  // Primitives, so an equal subject rebuilt on a rerender keeps its answer
  // rather than asking again.
  const requestJson = JSON.stringify(request);
  const checkKey = `${pluginId}\u0000${requestJson}`;
  const { availability } = request;
  const [settled, setSettled] = useState<{
    key: string;
    state: PluginContextMenuAvailability;
  } | null>(null);
  // Dropped during render the moment the subject changes, so moving back to an
  // earlier subject asks again instead of reviving its old answer.
  if (settled !== null && settled.key !== checkKey) setSettled(null);

  useEffect(() => {
    const plugin = window.electron?.plugin;
    if (typeof plugin?.invoke !== "function") return;
    // The request crosses to the plugin as data; it is never read back here.
    const asked: unknown = JSON.parse(requestJson);
    const context = { pluginId, availability };
    let current = true;
    const settle = (state: PluginContextMenuAvailability): boolean => {
      if (!current) return false;
      current = false;
      setSettled({ key: checkKey, state });
      return true;
    };
    const timer = setTimeout(() => {
      if (!current) return;
      logWarn("[pluginContextMenu] Availability check timed out; offering the item", context);
      settle(AVAILABLE);
    }, CONTEXT_MENU_AVAILABILITY_TIMEOUT_MS);

    const onAnswer = (answer: unknown): void => {
      if (!current) return;
      const reason = readContextMenuAvailabilityAnswer(answer);
      if (reason === undefined) {
        logWarn(
          "[pluginContextMenu] Availability answer was malformed; offering the item",
          context
        );
        settle(AVAILABLE);
      } else if (reason === null) {
        settle(AVAILABLE);
      } else if (settle({ status: "unavailable", reason })) {
        // Arrow keys skip a disabled row, so a reason carried only on it
        // never reaches someone moving through the menu with a screen reader.
        useAnnouncerStore.getState().announce(`${label} unavailable, ${reason}`, "polite");
      }
    };
    const onFailure = (error: unknown): void => {
      if (!current) return;
      logWarn("[pluginContextMenu] Availability check failed; offering the item", {
        ...context,
        error,
      });
      settle(AVAILABLE);
    };
    // One microtask late, so an effect torn down at once (StrictMode's replay, a
    // subject that changes in the same commit) never reaches the plugin.
    queueMicrotask(() => {
      if (!current) return;
      try {
        void Promise.resolve(
          plugin.invoke(pluginId, CONTEXT_MENU_AVAILABILITY_CHANNEL, asked)
        ).then(onAnswer, onFailure);
      } catch (error) {
        onFailure(error);
      }
    });

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [pluginId, requestJson, checkKey, label, availability]);

  if (!hasBridge) return AVAILABLE;
  return settled?.key === checkKey ? settled.state : CHECKING;
}
