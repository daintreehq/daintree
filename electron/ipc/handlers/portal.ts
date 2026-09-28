import { session } from "electron";
import { defineIpcNamespace, op } from "../define.js";
import { PORTAL_METHOD_CHANNELS } from "./portal.preload.js";
import { isDevPreviewPartition } from "../../../shared/utils/partitionUtils.js";
import type { HandlerDependencies } from "../types.js";
import type {
  PortalCreatePayload,
  PortalShowPayload,
  PortalCloseTabPayload,
  PortalNavigatePayload,
  PortalBounds,
} from "../../../shared/types/portal.js";

function isValidBounds(bounds: unknown): bounds is PortalBounds {
  if (!bounds || typeof bounds !== "object") return false;
  const candidate = bounds as Partial<PortalBounds>;
  return (
    typeof candidate.x === "number" &&
    Number.isFinite(candidate.x) &&
    typeof candidate.y === "number" &&
    Number.isFinite(candidate.y) &&
    typeof candidate.width === "number" &&
    Number.isFinite(candidate.width) &&
    typeof candidate.height === "number" &&
    Number.isFinite(candidate.height)
  );
}

export function registerPortalHandlers(deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "portal",
    ops: {
      create: op(PORTAL_METHOD_CHANNELS.create, async (payload: PortalCreatePayload) => {
        try {
          if (!deps.portalManager) return;
          if (!payload?.tabId || typeof payload.tabId !== "string") {
            throw new Error("Invalid tabId");
          }
          if (!payload?.url || typeof payload.url !== "string") {
            throw new Error("Invalid url");
          }
          // Only a well-formed dev-preview partition may override the default
          // portal session; anything else silently falls back so a malformed
          // value never blocks tab creation.
          const partition = isDevPreviewPartition(payload.partition)
            ? payload.partition
            : "persist:portal";
          if (partition !== "persist:portal") {
            // Flush pending storage writes from the shared dev-preview session
            // before the WebContentsView attaches, guarding against the
            // renderer→storage IPC race documented in #4685/#4574.
            try {
              await session.fromPartition(partition).flushStorageData();
            } catch (error) {
              console.warn("[PortalHandler] flushStorageData failed before promote:", error);
            }
          }
          // Restore-intent creates are shielded from LRU eviction until the
          // follow-up show lands; createTab clears the guard on failure.
          if (payload.isRestore === true) {
            deps.portalManager.markRestoring(payload.tabId);
          }
          deps.portalManager.createTab(payload.tabId, payload.url, partition);
        } catch (error) {
          console.error("[PortalHandler] Error in create:", error);
          throw error;
        }
      }),
      show: op(PORTAL_METHOD_CHANNELS.show, async (payload: PortalShowPayload) => {
        try {
          if (!deps.portalManager) return;
          if (!payload?.tabId || typeof payload.tabId !== "string") {
            throw new Error("Invalid tabId");
          }
          if (!isValidBounds(payload?.bounds)) {
            throw new Error("Invalid bounds");
          }
          deps.portalManager.showTab(payload.tabId, payload.bounds);
        } catch (error) {
          console.error("[PortalHandler] Error in show:", error);
          throw error;
        }
      }),
      hide: op(PORTAL_METHOD_CHANNELS.hide, async () => {
        if (!deps.portalManager) return;
        deps.portalManager.hideAll();
      }),
      resize: op(PORTAL_METHOD_CHANNELS.resize, async (bounds: PortalBounds) => {
        try {
          if (!deps.portalManager) return;
          if (!isValidBounds(bounds)) {
            throw new Error("Invalid bounds");
          }
          deps.portalManager.updateBounds(bounds);
        } catch (error) {
          console.error("[PortalHandler] Error in resize:", error);
          throw error;
        }
      }),
      closeTab: op(PORTAL_METHOD_CHANNELS.closeTab, async (payload: PortalCloseTabPayload) => {
        if (!deps.portalManager) return;
        if (!payload || typeof payload !== "object" || typeof payload.tabId !== "string") {
          return;
        }
        await deps.portalManager.closeTab(payload.tabId);
      }),
      navigate: op(PORTAL_METHOD_CHANNELS.navigate, async (payload: PortalNavigatePayload) => {
        if (!deps.portalManager) return;
        if (
          !payload ||
          typeof payload !== "object" ||
          typeof payload.tabId !== "string" ||
          typeof payload.url !== "string"
        ) {
          return;
        }
        deps.portalManager.navigate(payload.tabId, payload.url);
      }),
      goBack: op(PORTAL_METHOD_CHANNELS.goBack, async (tabId: string): Promise<boolean> => {
        if (!deps.portalManager) return false;
        if (typeof tabId !== "string") return false;
        return deps.portalManager.goBack(tabId);
      }),
      goForward: op(PORTAL_METHOD_CHANNELS.goForward, async (tabId: string): Promise<boolean> => {
        if (!deps.portalManager) return false;
        if (typeof tabId !== "string") return false;
        return deps.portalManager.goForward(tabId);
      }),
      reload: op(PORTAL_METHOD_CHANNELS.reload, async (tabId: string) => {
        if (!deps.portalManager) return;
        if (typeof tabId !== "string") return;
        deps.portalManager.reload(tabId);
      }),
    },
  });

  return namespace.register();
}
