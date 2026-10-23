/**
 * IPC surface for the core Element Picker: the dev preview's own picker,
 * reached without any plugin.
 *
 * Two halves, answered by different machines when a window is attached to a
 * remote host. `bind` and `reselect` drive the preview's page, so they run
 * where the preview is shown; the workspace ops read the project's source, so
 * they run where the worktree is. Lifecycle calls on a binding (detach, mode,
 * clearing the selection or the hover) stay on the site-preview namespace.
 *
 * Every op takes its project from the IPC context and nothing else: no
 * project id, subscriber, absolute path or script crosses from the payload.
 * A workspace names a worktree of the sender's own project and main reads
 * where it is; every later call re-checks that the workspace is the caller's.
 *
 * Nothing under `services/elementPicker/` is imported here eagerly: main must
 * not evaluate the picker's code until a view first asks for it.
 */

import { z } from "zod";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, opValidated } from "../define.js";
import { getWebContentsForProject } from "../../window/webContentsRegistry.js";
import { getWorkspaceClientRef } from "../../window/serviceRefs.js";
import { projectStore } from "../../services/ProjectStore.js";
import { AppError } from "../../utils/errorTypes.js";
import { getSitePreviewBridge } from "../../services/SitePreviewBridge.js";
import { ElementPickerFrameworkSchema } from "../../../shared/elementPicker/source.js";
import type { IpcContext } from "../types.js";
import type {
  ElementPickerBindingState,
  ElementPickerProjectOutcome,
  ElementPickerPushPayload,
  ElementPickerResolveRequest,
  ElementPickerResolveResponse,
  ElementPickerSourceRevisionsResult,
  ElementPickerWorkspaceOpenResult,
} from "../../../shared/types/ipc/elementPicker.js";
import type {
  ElementPickerWorkspaceOwner,
  ElementPickerWorkspaceService,
} from "../../services/elementPicker/workspaceService.js";
import { ELEMENT_PICKER_METHOD_CHANNELS } from "./elementPicker.preload.js";

const modeSchema = z.enum(["browse", "select"]);

const bindSchema = z
  .object({ panelId: z.string().min(1).max(256), mode: modeSchema.optional() })
  .strict();

// A compiled source location as the page reported it. Bounded here because it
// is JSON-encoded into host-authored guest source, where the guest's reader
// validates it again before it acts on any of it.
const sourcePointSchema = z
  .object({
    file: z.string().min(1).max(1024),
    line: z.number().int().positive(),
    column: z.number().int().nonnegative(),
  })
  .strict();

const reselectSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    elementId: z.string().min(1).max(128).optional(),
    framework: ElementPickerFrameworkSchema.optional(),
    locator: z
      .object({
        loc: sourcePointSchema,
        index: z.number().int().nonnegative().max(100_000),
        component: sourcePointSchema.optional(),
      })
      .strict()
      .optional(),
    reveal: z.boolean().optional(),
  })
  .strict();

const workspaceIdSchema = z.string().min(1).max(128);

const workspaceOpenSchema = z
  .object({
    panelId: z.string().min(1).max(256),
    // A worktree's id is its path, so it is bounded like one.
    worktreeId: z.string().min(1).max(4096),
    serverCwd: z.string().min(1).max(4096).optional(),
    appPath: z.string().min(1).max(1024).optional(),
    previewOrigin: z.string().min(1).max(2048).optional(),
  })
  .strict();

const workspaceSchema = z.object({ workspaceId: workspaceIdSchema }).strict();

const describeProjectSchema = z
  .object({ workspaceId: workspaceIdSchema, url: z.string().min(1).max(2048) })
  .strict();

const sourceRevisionsSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    paths: z.array(z.string().min(1).max(1024)).max(128),
  })
  .strict();

/**
 * Only the workspace is checked here; the host parses the whole request with
 * `ResolveRequestSchema` before it does anything with it, and answers a
 * malformed one with VALIDATION. Checking it here as well would load every
 * picker schema into main at startup, for an app that may never pick.
 */
const resolveSchema = z.custom<ElementPickerResolveRequest>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    workspaceIdSchema.safeParse((value as { workspaceId?: unknown }).workspaceId).success
);

function requireProject(ctx: IpcContext): string {
  if (!ctx.projectId) {
    throw new AppError({
      code: "PERMISSION",
      message: "Element Picker operations require a project-scoped sender",
    });
  }
  return ctx.projectId;
}

function ownerOf(ctx: IpcContext): ElementPickerWorkspaceOwner {
  return { projectId: requireProject(ctx), endpoint: ctx.endpoint };
}

/**
 * Where one core binding's traffic goes: the view that bound it, while it is
 * still a view of the binding's project, and nowhere else: what a page
 * reports belongs to the view that asked for it, not to every view of the
 * project.
 */
function addressedSink(
  projectId: string,
  subscriberWebContentsId: number
): (payload: ElementPickerPushPayload) => void {
  return (payload) => {
    for (const wc of getWebContentsForProject(projectId)) {
      if (wc.id !== subscriberWebContentsId) continue;
      if (wc.isDestroyed()) return;
      try {
        wc.send(CHANNELS.ELEMENT_PICKER_EVENT, payload);
      } catch {
        // A view torn down between the lookup and the send; nothing to do.
      }
      return;
    }
  };
}

let workspaces: Promise<ElementPickerWorkspaceService> | null = null;

function workspaceService(): Promise<ElementPickerWorkspaceService> {
  workspaces ??= import("../../services/elementPicker/workspaceService.js").then(
    ({ ElementPickerWorkspaceService: Service }) =>
      new Service({
        getProject: (projectId) => projectStore.getProjectById(projectId),
        listWorktrees: async (projectPath, projectId) => {
          const client = getWorkspaceClientRef();
          if (!client) return null;
          const result = await client.getAllStatesForProjectResultAsync(projectPath, projectId);
          return result.status === "ok" ? result.states : null;
        },
      }),
    (error: unknown) => {
      // Not cached: a failed load must not disable the picker for the session.
      workspaces = null;
      throw error;
    }
  );
  return workspaces;
}

export const elementPickerNamespace = defineIpcNamespace({
  name: "elementPicker",
  ops: {
    bind: opValidated(
      ELEMENT_PICKER_METHOD_CHANNELS.bind,
      bindSchema,
      async (ctx, payload): Promise<ElementPickerBindingState> => {
        const projectId = requireProject(ctx);
        // The sender, not anything it claims to be: the one address this
        // binding's traffic is delivered to.
        const subscriberWebContentsId = ctx.webContentsId;
        return getSitePreviewBridge().bindElementPicker({
          projectId,
          panelId: payload.panelId,
          mode: payload.mode ?? "select",
          subscriberWebContentsId,
          sink: addressedSink(projectId, subscriberWebContentsId),
        });
      },
      { withContext: true }
    ),
    reselect: opValidated(
      ELEMENT_PICKER_METHOD_CHANNELS.reselect,
      reselectSchema,
      async (ctx, payload): Promise<boolean> =>
        getSitePreviewBridge().reselectElementPicker(
          requireProject(ctx),
          payload.sessionId,
          payload
        ),
      { withContext: true }
    ),
    openWorkspace: opValidated(
      ELEMENT_PICKER_METHOD_CHANNELS.openWorkspace,
      workspaceOpenSchema,
      async (ctx, payload): Promise<ElementPickerWorkspaceOpenResult> => {
        const owner = ownerOf(ctx);
        return (await workspaceService()).open(owner, payload);
      },
      { withContext: true }
    ),
    closeWorkspace: opValidated(
      ELEMENT_PICKER_METHOD_CHANNELS.closeWorkspace,
      workspaceSchema,
      async (ctx, payload): Promise<{ closed: boolean }> => {
        const owner = ownerOf(ctx);
        // Nothing was ever opened, so there is nothing to close and no reason to load the service.
        if (workspaces === null) return { closed: false };
        return (await workspaceService()).close(owner, payload.workspaceId);
      },
      { withContext: true }
    ),
    resolve: opValidated(
      ELEMENT_PICKER_METHOD_CHANNELS.resolve,
      resolveSchema,
      async (ctx, payload): Promise<ElementPickerResolveResponse> => {
        const owner = ownerOf(ctx);
        return (await workspaceService()).resolve(owner, payload);
      },
      { withContext: true }
    ),
    describeProject: opValidated(
      ELEMENT_PICKER_METHOD_CHANNELS.describeProject,
      describeProjectSchema,
      async (ctx, payload): Promise<ElementPickerProjectOutcome> => {
        const owner = ownerOf(ctx);
        return (await workspaceService()).describeProject(owner, payload.workspaceId, payload.url);
      },
      { withContext: true }
    ),
    sourceRevisions: opValidated(
      ELEMENT_PICKER_METHOD_CHANNELS.sourceRevisions,
      sourceRevisionsSchema,
      async (ctx, payload): Promise<ElementPickerSourceRevisionsResult> => {
        const owner = ownerOf(ctx);
        return (await workspaceService()).sourceRevisions(
          owner,
          payload.workspaceId,
          payload.paths
        );
      },
      { withContext: true }
    ),
  },
});

export function registerElementPickerHandlers(): () => void {
  const disposeNamespace = elementPickerNamespace.register();
  return () => {
    disposeNamespace();
    const pending = workspaces;
    workspaces = null;
    void pending?.then((service) => service.disposeAll()).catch(() => undefined);
  };
}
