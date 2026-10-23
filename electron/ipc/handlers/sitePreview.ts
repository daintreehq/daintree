/**
 * IPC surface for the site-preview bridge: the lifecycle commands for a binding
 * the Element Picker made through `elementPicker.bind`.
 *
 * Deliberately absent: any way for a caller to choose the script that runs in a
 * guest. There is no `evaluate` op and no runtime source on the wire. Either
 * would give every renderer-side caller — including a compromised plugin view —
 * arbitrary code execution inside whatever site the user is previewing, so this
 * is a security boundary rather than an API-surface preference.
 *
 * Every op takes its project from the IPC context, never from the payload: the
 * sender's WebContents is what the host can actually prove, and resolving an
 * omitted project from current UI focus would let one project's panel drive
 * another's preview.
 */

import { z } from "zod";
import { defineIpcNamespace, opValidated } from "../define.js";
import { AppError } from "../../utils/errorTypes.js";
import { getSitePreviewBridge, resetSitePreviewBridge } from "../../services/SitePreviewBridge.js";
import type { HandlerDependencies } from "../types.js";
import type { IpcContext } from "../types.js";
import type { SitePreviewBindingState } from "../../../shared/types/ipc/sitePreview.js";
import { SITE_PREVIEW_METHOD_CHANNELS } from "./sitePreview.preload.js";

const modeSchema = z.enum(["browse", "select"]);

const sessionSchema = z.object({ sessionId: z.string().min(1).max(128) }).strict();

const setModeSchema = z
  .object({ sessionId: z.string().min(1).max(128), mode: modeSchema })
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
  },
});

export function registerSitePreviewHandlers(_deps: HandlerDependencies): () => void {
  // Created here, not on first use: the bridge refuses access before its
  // handlers have registered, so nothing can bind ahead of the disposal below.
  const bridge = getSitePreviewBridge({});
  const disposeNamespace = sitePreviewNamespace.register();
  return () => {
    disposeNamespace();
    void bridge.disposeAll();
    resetSitePreviewBridge();
  };
}
