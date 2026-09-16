import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginFsApi, PluginHostApi } from "../../../../shared/types/plugin.js";
import {
  CHANNELS,
  ClassCompleteArgsSchema,
  ClassCompleteResultSchema,
  EditApplyArgsSchema,
  EditApplyResultSchema,
  EditUndoArgsSchema,
  EditUndoResultSchema,
  IssuePushSchema,
  ProjectModelResultSchema,
  PUSH_CHANNELS,
  SelectionResolveArgsSchema,
  SelectionResolveResultSchema,
  SourceChangedPushSchema,
  SourceExcerptArgsSchema,
  SourceExcerptResultSchema,
  TailwindCatalogResultSchema,
  ProjectModelArgsSchema,
  TailwindCatalogArgsSchema,
  WorkspaceCloseArgsSchema,
  WorkspaceCloseResultSchema,
  WorkspaceOpenArgsSchema,
  WorkspaceOpenResultSchema,
  INSPECTOR_PANEL_KIND,
  OPEN_INSPECTOR_ACTION_ID,
} from "../shared/protocol.js";
import type { ProjectFileReader } from "../shared/project/fs.js";
import { applyEdit, undoEdit } from "./edits.js";
import { EditJournal, KeyedLock } from "./journal.js";
import { resolveSelection } from "./selection.js";
import {
  containsRealPath,
  isGeneratedPath,
  offsetToLocation,
  readSource,
  resolveWorktreePath,
} from "./source.js";
import { completeClasses, tailwindCatalog } from "./tailwind.js";
import { SourceTracker } from "./tracker.js";
import { WorkspaceRegistry, type Workspace } from "./workspace.js";

/**
 * Main-side half of the SvelteKit Site Builder: source truth. It resolves the
 * app, turns guest observations into source identity against current bytes,
 * applies deterministic edits and keeps the undo journal. The live preview is
 * the renderer view's; nothing here touches it.
 *
 * Activation registers channels and nothing else. The project scan, the Svelte
 * compiler, the source model and Tailwind all load on first use inside a
 * handler, so activation stays well inside its five-second window.
 */

const MAX_EXCERPT_LINES = 200;
const MAX_EXCERPT_CHARS = 64 * 1024;
/** Source the excerpt may show. Not `.env`, not lockfiles: only what a component is made of. */
const EXCERPTABLE = /\.(svelte|ts|js|mjs|cjs|css|pcss|html)$/;

/** Thrown for a session id main does not hold, so the view can reopen rather than retry. */
function workspaceClosed(): Error {
  return new Error("WORKSPACE_CLOSED: that source workspace is not open; open it again");
}

function projectReader(fs: PluginFsApi): ProjectFileReader {
  return {
    readFile: (target) => fs.readFile(target),
    readdir: (target) => fs.readdir(target),
    stat: (target) => fs.stat(target),
  };
}

export async function activate(host: PluginHostApi): Promise<() => void> {
  const registry = new WorkspaceRegistry();
  const lock = new KeyedLock();
  const reader = projectReader(host.fs);

  const post = (channel: string, payload: unknown): void => {
    void host.postToPanel(channel, payload, null).catch((error: unknown) => {
      host.logger.warn("site-builder push failed", { channel, error: String(error) });
    });
  };

  const warnIssue = (code: string, message: string): void => {
    post(PUSH_CHANNELS.issue, IssuePushSchema.parse({ severity: "warning", code, message }));
  };

  // Declared in the manifest so the palette lists it before activation; the
  // handler binds here, on the first dispatch that activates the plugin.
  await host.registerAction(
    {
      id: OPEN_INSPECTOR_ACTION_ID,
      title: "Site Builder: Open Site Inspector",
      description:
        "Open the Site Inspector and bind it to a running SvelteKit dev preview in this worktree.",
      category: "panels",
      kind: "command",
      danger: "safe",
      keywords: ["svelte", "sveltekit", "site", "builder", "inspector", "preview", "tailwind"],
    },
    async () => host.dispatch("panel.openPluginPanel", { kind: INSPECTOR_PANEL_KIND })
  );

  await host.registerHandler(
    CHANNELS.workspaceOpen,
    {
      args: WorkspaceOpenArgsSchema,
      result: WorkspaceOpenResultSchema,
      requires: ["fs:project-read"],
    },
    async (_ctx, args) => {
      const { inspectWorktree } = await import("../shared/project/index.js");
      const worktreePath = path.resolve(args.worktreePath);
      const requested = args.appRoot === undefined ? undefined : path.resolve(args.appRoot);

      let scan = await inspectWorktree(reader, worktreePath, requested);
      if (!scan.inspection) {
        if (requested !== undefined || scan.apps.length === 0) return { status: "no-app" as const };
        if (scan.apps.length > 1) {
          return { status: "ambiguous" as const, appRoots: scan.apps.map((app) => app.appRoot) };
        }
        // One app on a scan that hit its budget. Discovery will not call it
        // "the only app", and neither does this: it opens the one it found and
        // says the list may be incomplete.
        const only = scan.apps[0]!;
        scan = await inspectWorktree(reader, worktreePath, only.appRoot);
        if (!scan.inspection) return { status: "no-app" as const };
        warnIssue(
          "APP_SCAN_TRUNCATED",
          "This worktree is too large to scan completely. Opened the one SvelteKit app found; pick another app root if this is the wrong one."
        );
      }

      const { appRoot, support } = scan.inspection.model;
      const id = randomUUID();
      const workspace: Workspace = {
        id,
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        worktreePath,
        appRoot,
        support,
        fs: host.fs,
        journal: new EditJournal(),
        tracker: new SourceTracker({
          fs: host.fs,
          workspaceSessionId: id,
          push: (payload) =>
            post(PUSH_CHANNELS.sourceChanged, SourceChangedPushSchema.parse(payload)),
          warn: (message, detail) => host.logger.warn(message, detail),
        }),
        edits: new Map(),
        reversals: new Map(),
        tailwind: null,
      };
      registry.add(workspace);
      return { status: "ready" as const, workspaceSessionId: id, appRoot, support };
    }
  );

  await host.registerHandler(
    CHANNELS.workspaceClose,
    { args: WorkspaceCloseArgsSchema, result: WorkspaceCloseResultSchema },
    (_ctx, { workspaceSessionId }) => ({ closed: registry.close(workspaceSessionId) })
  );

  await host.registerHandler(
    CHANNELS.selectionResolve,
    {
      args: SelectionResolveArgsSchema,
      result: SelectionResolveResultSchema,
      requires: ["fs:project-read"],
    },
    async (_ctx, args) => {
      const workspace = registry.get(args.workspaceSessionId);
      if (!workspace) throw workspaceClosed();
      return resolveSelection(workspace, args);
    }
  );

  await host.registerHandler(
    CHANNELS.sourceExcerpt,
    {
      args: SourceExcerptArgsSchema,
      result: SourceExcerptResultSchema,
      requires: ["fs:project-read"],
    },
    async (_ctx, { workspaceSessionId, file, range, contextLines }) => {
      const unavailable = { status: "unavailable" as const };
      const workspace = registry.get(workspaceSessionId);
      if (!workspace) return unavailable;
      const target = resolveWorktreePath(workspace, file);
      if (!target.ok || !EXCERPTABLE.test(target.appRelative)) return unavailable;
      const { isGeneratedSourceFile } = await import("@daintreehq/svelte-source-model");
      if (isGeneratedPath(isGeneratedSourceFile, target.appRelative)) return unavailable;
      if (!(await containsRealPath(workspace.appRoot, target.absolute))) return unavailable;

      const read = await readSource(workspace.fs, target.absolute);
      if (read.status !== "ok" || range.end > read.text.length) return unavailable;
      workspace.tracker.observe(target.absolute, target.worktreeRelative, read.revision);

      const lines = read.text.split("\n");
      const startLine = offsetToLocation(read.text, range.start).line;
      const endLine = offsetToLocation(read.text, range.end).line;
      const firstLine = Math.max(1, startLine - contextLines);
      const lastLine = Math.min(
        lines.length,
        endLine + contextLines,
        firstLine + MAX_EXCERPT_LINES - 1
      );
      const text = lines
        .slice(firstLine - 1, lastLine)
        .join("\n")
        .slice(0, MAX_EXCERPT_CHARS);
      return { status: "ok" as const, text, firstLine, revision: read.revision };
    }
  );

  await host.registerHandler(
    CHANNELS.editApply,
    {
      args: EditApplyArgsSchema,
      result: EditApplyResultSchema,
      requires: ["fs:project-read", "fs:project-write"],
    },
    async (_ctx, args) => {
      const workspace = registry.get(args.workspaceSessionId);
      if (!workspace) {
        return {
          status: "error" as const,
          code: "OUT_OF_SCOPE" as const,
          message: "that source workspace is not open",
        };
      }
      return applyEdit(workspace, args, lock);
    }
  );

  await host.registerHandler(
    CHANNELS.editUndo,
    {
      args: EditUndoArgsSchema,
      result: EditUndoResultSchema,
      requires: ["fs:project-read", "fs:project-write"],
    },
    async (_ctx, { workspaceSessionId, transactionId }) => {
      const workspace = registry.get(workspaceSessionId);
      if (!workspace) {
        return {
          status: "error" as const,
          code: "OUT_OF_SCOPE" as const,
          message: "that source workspace is not open",
        };
      }
      return undoEdit(workspace, transactionId, lock);
    }
  );

  await host.registerHandler(
    CHANNELS.tailwindCatalog,
    {
      args: TailwindCatalogArgsSchema,
      result: TailwindCatalogResultSchema,
      requires: ["fs:project-read"],
    },
    async (_ctx, { workspaceSessionId }) => {
      const workspace = registry.get(workspaceSessionId);
      if (!workspace)
        return { status: "unavailable" as const, reason: "that source workspace is not open" };
      return tailwindCatalog(workspace);
    }
  );

  await host.registerHandler(
    CHANNELS.classComplete,
    {
      args: ClassCompleteArgsSchema,
      result: ClassCompleteResultSchema,
      requires: ["fs:project-read"],
    },
    async (_ctx, { workspaceSessionId, query, limit }) => {
      const workspace = registry.get(workspaceSessionId);
      if (!workspace)
        return { status: "unavailable" as const, reason: "that source workspace is not open" };
      return completeClasses(workspace, query, limit);
    }
  );

  await host.registerHandler(
    CHANNELS.projectModel,
    {
      args: ProjectModelArgsSchema,
      result: ProjectModelResultSchema,
      requires: ["fs:project-read"],
    },
    async (_ctx, { workspaceSessionId }) => {
      const workspace = registry.get(workspaceSessionId);
      if (!workspace) throw workspaceClosed();
      const { inspectProject } = await import("../shared/project/index.js");
      // Read fresh: routes are exactly what an agent adds while the panel is open.
      const { model } = await inspectProject(reader, {
        worktreeRoot: workspace.worktreePath,
        appRoot: workspace.appRoot,
      });
      return model;
    }
  );

  return () => registry.closeAll();
}
