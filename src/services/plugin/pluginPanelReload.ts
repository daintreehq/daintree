import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import type { PanelReloadResult } from "@shared/types/plugin";
import type {
  PluginPanelReloadRequest,
  PluginPanelReloadResponse,
} from "@shared/types/pluginPanelReload";
import { getPanelStoreSnapshot } from "@/store/storeAccessors";
import { isProjectViewCached } from "@/lib/viewCacheState";

/**
 * Renderer side of `host.reloadPanel()` (#12610).
 *
 * Mounted plugin views register a handler here; main's request for a panel is
 * re-validated against this renderer's live panel record and kind registry and
 * then handed to that panel's handler, which runs the same rationed reload path
 * as the view's own `requestReload`. Main already checked ownership against its
 * broker, but that record is a report from this renderer — the panel store is
 * the authority on what the panel is right now.
 */

type PanelReloadHandler = () => Promise<PanelReloadResult>;

interface Registration {
  token: number;
  handler: PanelReloadHandler;
}

const handlers = new Map<string, Registration>();
let nextToken = 1;

/**
 * Register the reload handler for a mounted panel view. The returned cleanup
 * removes only its own registration, so a StrictMode replay or a remount whose
 * cleanup runs after the new mount's setup cannot unregister the live view.
 */
export function registerPanelReloadHandler(
  panelId: string,
  handler: PanelReloadHandler
): () => void {
  const token = nextToken++;
  handlers.set(panelId, { token, handler });
  return () => {
    if (handlers.get(panelId)?.token === token) handlers.delete(panelId);
  };
}

/** Answer one main request. Never throws; every path produces a response. */
export async function handlePanelReloadRequest(
  request: PluginPanelReloadRequest
): Promise<PluginPanelReloadResponse> {
  const { requestId, panelId, pluginId, expiresAt } = request;
  const respond = (result: PanelReloadResult): PluginPanelReloadResponse => ({
    requestId,
    result,
  });

  // Delivered late — this view was frozen while main waited and has already
  // told the plugin "unavailable". Acting now would contradict that answer.
  if (Date.now() > expiresAt) return respond("unavailable");
  if (isProjectViewCached()) return respond("unavailable");

  const panel = getPanelStoreSnapshot()?.panelsById[panelId];
  if (!panel) return respond("not-mounted");
  const kind = panel.kind ? getPanelKindConfig(panel.kind) : undefined;
  // Unregistered while its plugin upgrades: ownership cannot be judged, and a
  // plugin panel must not be refused as "non-plugin" in that window.
  if (!kind) return respond("unavailable");
  if (!kind.extensionId) return { requestId, rejected: "non-plugin" };
  if (kind.extensionId !== pluginId) return { requestId, rejected: "foreign" };

  return respond(await reloadRegisteredPanel(panelId));
}

/**
 * Run the registered view's reload for `panelId`, with no target validation —
 * {@link handlePanelReloadRequest} is the only production caller.
 */
export async function reloadRegisteredPanel(panelId: string): Promise<PanelReloadResult> {
  const registration = handlers.get(panelId);
  if (!registration) return "not-mounted";
  try {
    return await registration.handler();
  } catch {
    return "unavailable";
  }
}

/** Test seam — drops every registration. */
export function resetPanelReloadHandlersForTests(): void {
  handlers.clear();
  nextToken = 1;
}
