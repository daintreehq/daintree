/**
 * IPC surface for the site-preview bridge.
 *
 * Deliberately absent: any way for a caller to choose the script that runs in a
 * guest. `bind` names one of the guest adapters main registered at startup and
 * the host loads that adapter's body itself; there is no `evaluate` op and no
 * runtime source on the wire. Either would give every renderer-side caller —
 * including a compromised plugin view — arbitrary code execution inside
 * whatever site the user is previewing, so this is a security boundary rather
 * than an API-surface preference.
 *
 * Every op takes its project from the IPC context, never from the payload: the
 * sender's WebContents is what the host can actually prove, and resolving an
 * omitted project from current UI focus would let one project's panel bind to
 * another's preview.
 */

import { z } from "zod";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import { getWebContentsForProject } from "../../window/webContentsRegistry.js";
import { AppError } from "../../utils/errorTypes.js";
import { getSitePreviewBridge, resetSitePreviewBridge } from "../../services/SitePreviewBridge.js";
import { registerBuiltinGuestAdapters } from "../../services/sitePreview/builtinGuestAdapters.js";
import type { HandlerDependencies } from "../types.js";
import type { IpcContext } from "../types.js";
import type {
  SitePreviewBindingState,
  SitePreviewCandidate,
} from "../../../shared/types/ipc/sitePreview.js";
import { SITE_PREVIEW_METHOD_CHANNELS } from "./sitePreview.preload.js";
import { LOCAL_HOST_ID, parseHostScopedKey } from "../../../shared/types/remoteHosts.js";
import { getRemoteService } from "../../remote/runtime.js";

const modeSchema = z.enum(["browse", "select"]);

const bindSchema = z
  .object({
    panelId: z.string().min(1).max(256),
    /** A guest adapter the host registered; unknown ids are refused by the bridge. */
    adapterId: z.string().min(1).max(200),
    mode: modeSchema.optional(),
  })
  .strict();

const sessionSchema = z.object({ sessionId: z.string().min(1).max(128) }).strict();

const setModeSchema = z
  .object({ sessionId: z.string().min(1).max(128), mode: modeSchema })
  .strict();

// A compiled source location: worktree-relative file, 1-based line, 0-based
// column. Bounded here because the value is interpolated into host-authored
// guest source, and the guest treats it as identity, not display text.
const reselectSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    loc: z
      .object({
        file: z.string().min(1).max(1024),
        line: z.number().int().positive(),
        column: z.number().int().nonnegative(),
      })
      .strict(),
    /** Which of the elements sharing that location, in document order. */
    index: z.number().int().nonnegative().max(100_000).optional(),
    /** The component call site the selection was widened to, kept through the reselect. */
    component: z
      .object({
        file: z.string().min(1).max(1024),
        line: z.number().int().positive(),
        column: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /**
     * The id the runtime reported the element under, so it is asked for by
     * identity while it is still the same node: on a hydrated page its true
     * location is stamped on a neighbour.
     */
    occurrence: z.string().min(1).max(128).optional(),
  })
  .strict();

function requireProject(ctx: IpcContext): string {
  if (!ctx.projectId) {
    throw new AppError({
      code: "PERMISSION",
      message: "Site preview operations require a project-scoped sender",
    });
  }
  return ctx.projectId;
}

export const sitePreviewNamespace = defineIpcNamespace({
  name: "sitePreview",
  ops: {
    listCandidates: op(
      SITE_PREVIEW_METHOD_CHANNELS.listCandidates,
      async (ctx): Promise<SitePreviewCandidate[]> =>
        getSitePreviewBridge().listCandidates(requireProject(ctx)),
      { withContext: true }
    ),
    bind: opValidated(
      SITE_PREVIEW_METHOD_CHANNELS.bind,
      bindSchema,
      async (ctx, payload): Promise<SitePreviewBindingState> =>
        getSitePreviewBridge().bind({
          projectId: requireProject(ctx),
          panelId: payload.panelId,
          adapterId: payload.adapterId,
          mode: payload.mode ?? "browse",
          // The sender, not anything it claims to be: this is the address every
          // observation from the resulting binding is delivered to.
          subscriberWebContentsId: ctx.webContentsId,
        }),
      { withContext: true }
    ),
    detach: opValidated(
      SITE_PREVIEW_METHOD_CHANNELS.detach,
      sessionSchema,
      async (ctx, payload): Promise<void> => {
        await getSitePreviewBridge().detach(requireProject(ctx), payload.sessionId);
      },
      { withContext: true }
    ),
    setMode: opValidated(
      SITE_PREVIEW_METHOD_CHANNELS.setMode,
      setModeSchema,
      async (ctx, payload): Promise<SitePreviewBindingState> =>
        getSitePreviewBridge().setMode(requireProject(ctx), payload.sessionId, payload.mode),
      { withContext: true }
    ),
    reselect: opValidated(
      SITE_PREVIEW_METHOD_CHANNELS.reselect,
      reselectSchema,
      async (ctx, payload): Promise<boolean> =>
        getSitePreviewBridge().reselect(
          requireProject(ctx),
          payload.sessionId,
          payload.loc,
          payload.index ?? 0,
          payload.component ?? null,
          payload.occurrence ?? null
        ),
      { withContext: true }
    ),
    clearSelection: opValidated(
      SITE_PREVIEW_METHOD_CHANNELS.clearSelection,
      sessionSchema,
      async (ctx, payload): Promise<void> =>
        getSitePreviewBridge().clearSelection(requireProject(ctx), payload.sessionId),
      { withContext: true }
    ),
    clearHover: opValidated(
      SITE_PREVIEW_METHOD_CHANNELS.clearHover,
      sessionSchema,
      async (ctx, payload): Promise<void> =>
        getSitePreviewBridge().clearHover(requireProject(ctx), payload.sessionId),
      { withContext: true }
    ),
    getState: opValidated(
      SITE_PREVIEW_METHOD_CHANNELS.getState,
      sessionSchema,
      async (ctx, payload): Promise<SitePreviewBindingState | null> =>
        getSitePreviewBridge().getState(requireProject(ctx), payload.sessionId),
      { withContext: true }
    ),
  },
});

export function registerSitePreviewHandlers(_deps: HandlerDependencies): () => void {
  // Registered here rather than in a plugin's activation: the bodies are app
  // assets, and the bridge must be able to resolve one whether or not the
  // declaring plugin's renderer view has ever been loaded. Which adapters exist
  // comes from the built-in manifests, so no plugin is named here.
  const disposeAdapters = registerBuiltinGuestAdapters();

  const bridge = getSitePreviewBridge({
    // Supplied here rather than defaulted inside the bridge: `PluginService`
    // reaches the other way for its unload step, and the bridge importing it
    // back would close the cycle.
    //
    // Imported when a bind first asks, not at module load: `PluginService`
    // pulls in `ProjectStore`, which reads `app.getPath("userData")` while it
    // evaluates. Registering these handlers must not require an Electron app
    // to exist. `bindLocked` is async, so the deferral costs nothing.
    //
    // A view bound to a remote host uses that host's plugins, not this
    // machine's: the host is asked whether the adapter's plugin is loaded
    // there. The guest and its CDP session stay on this machine either way.
    isPluginEnabled: async (pluginId, projectId) => {
      if (__DAINTREE_REMOTE_HOSTS__) {
        const { hostId } = parseHostScopedKey(projectId);
        if (hostId !== LOCAL_HOST_ID) {
          const parity = getRemoteService("pluginParityClient");
          return parity ? parity.isPluginLoadedOnHost(hostId, pluginId) : false;
        }
      }
      const { pluginService } = await import("../../services/PluginService.js");
      return pluginService.hasPlugin(pluginId);
    },
    push: (payload, route) => {
      // Addressed, not broadcast. A guest observation carries the structure of
      // the user's page, what they selected in it and source locations from
      // their repository, and only the view that established the binding has
      // any claim on it — so this delivers to that one sender and stops.
      // Fanning out across the project would hand the same content to a second
      // window on the project, and to every other plugin view sharing that
      // renderer realm, none of which ever bound.
      //
      // The project lookup is still what supplies the WebContents: it is a
      // second gate, so a recycled id now serving a different project's view
      // cannot inherit the address. Deliberately NOT
      // `broadcastToProjectRenderers` either — that helper falls back to an
      // app-wide broadcast when no project views are registered.
      for (const wc of getWebContentsForProject(payload.projectId)) {
        if (wc.id !== route.subscriberWebContentsId) continue;
        if (wc.isDestroyed()) continue;
        try {
          wc.send(CHANNELS.SITE_PREVIEW_EVENT, payload);
        } catch {
          // A view torn down between the lookup and the send; nothing to do.
        }
        return;
      }
      // No live project view under that id: the subscriber is gone, or has been
      // re-created since. The binding's own teardown follows; dropping the
      // payload is the right outcome either way.
    },
  });

  const disposeNamespace = sitePreviewNamespace.register();
  return () => {
    disposeNamespace();
    disposeAdapters();
    void bridge.disposeAll();
    resetSitePreviewBridge();
  };
}
