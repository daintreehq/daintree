import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BuiltinPluginFsApi,
  BuiltinPluginHostApi,
  PluginIpcContext,
} from "../../../../shared/types/plugin.js";
import {
  CHANNELS,
  IssuePushSchema,
  ProjectModelResultSchema,
  PUSH_CHANNELS,
  SelectionResolveArgsSchema,
  SelectionResolveResultSchema,
  SourceChangedPushSchema,
  ProjectModelArgsSchema,
  WorkspaceCloseArgsSchema,
  WorkspaceCloseResultSchema,
  WorkspaceOpenArgsSchema,
  WorkspaceOpenResultSchema,
  ComponentDefinitionsArgsSchema,
  SourceRevisionsArgsSchema,
  SourceRevisionsResultSchema,
  ComponentDefinitionsResultSchema,
  DetectAppsArgsSchema,
  DetectAppsResultSchema,
  BUILDER_TOOL_ID,
  TOGGLE_BUILDER_ACTION_ID,
} from "../shared/protocol.js";
import type { ProjectFileReader, ProjectReadOptions } from "../shared/project/fs.js";
import { loadParse, loadSourceModel } from "./engine.js";
import { resolveSelection } from "./selection.js";
import {
  containsRealPath,
  isGeneratedPath,
  MAX_SOURCE_BYTES,
  readSource,
  resolveReportedPath,
} from "./source.js";
import { SourceTracker } from "./tracker.js";
import { ScanGate, WorkspaceRegistry, type Workspace } from "./workspace.js";

/**
 * Main-side half of the SvelteKit Site Builder: source truth. It resolves the
 * app and turns guest observations into source identity against current bytes.
 * It never writes — the agent the selection is handed to does that, and the
 * source tracker is how the view learns of it. The live preview is the
 * renderer view's; nothing here touches it.
 *
 * Activation registers channels and nothing else. The project scan, the Svelte
 * compiler and the source model all load on first use inside a handler, so
 * activation stays well inside its five-second window.
 */

/** Thrown for a session id main does not hold, so the view can reopen rather than retry. */
function workspaceClosed(): Error {
  return new Error("WORKSPACE_CLOSED: that source workspace is not open; open it again");
}

/**
 * Thrown when a view names a project other than its own — opening a workspace,
 * or scanning one for apps. The project and worktree arrive from the renderer,
 * and they decide which files the read may reach, so the only trustworthy check
 * is against the project the host itself resolved for the sender. The worktree
 * is not checked the same way: the context reports the sender window's ACTIVE
 * worktree, and a builder on a background worktree legitimately names a
 * different one.
 */
function workspaceForbidden(): Error {
  return new Error("WORKSPACE_FORBIDDEN: that project is not this view's project");
}

/**
 * A session id is not authority: it rides along in every source-changed push,
 * so a view of another project could hold one. Ownership is re-checked on every
 * lookup against the project the host resolved for the caller — otherwise the
 * workspace's pinned filesystem would read another project's files on its
 * behalf, which is the confused deputy this whole change exists to close.
 */
function ownedWorkspace(
  registry: WorkspaceRegistry,
  ctx: PluginIpcContext,
  workspaceSessionId: string
): Workspace | undefined {
  const workspace = registry.get(workspaceSessionId);
  if (!workspace) return undefined;
  if (workspace.projectId !== ctx.projectId) throw workspaceForbidden();
  return workspace;
}

/** A manifest's bytes as text. Non-fatal: a manifest we cannot decode fails the parse, like any other malformed one. */
const metadataDecoder = new TextDecoder("utf-8");

/**
 * The project model's view of one workspace's filesystem.
 *
 * `signal` is bound into the reader rather than passed per call because
 * `inspectProject` and `inspectWorktree` take a reader and nothing else — this
 * is how a closed workspace's cancellation reaches every read they make. It
 * stops further I/O being scheduled and rejects the read in flight; it does
 * not interrupt a parse already running.
 */
function projectReader(fs: BuiltinPluginFsApi, signal?: AbortSignal): ProjectFileReader {
  const callOptions = (options?: ProjectReadOptions) => {
    const chosen = options?.signal ?? signal;
    return chosen ? { signal: chosen } : undefined;
  };
  const bounded = fs.readFileBounded;
  return {
    readFile: (target, options) => fs.readFile(target, callOptions(options)),
    readdir: (target, options) => fs.readdir(target, callOptions(options)),
    stat: (target, options) => fs.stat(target, callOptions(options)),
    ...(bounded && {
      readBoundedText: async (target, options) => {
        const read = await bounded.call(fs, target, {
          ...callOptions(options),
          limitBytes: options.limitBytes,
        });
        if (read.status !== "ok") return read;
        const text = metadataDecoder.decode(read.bytes);
        // A BOM would fail `JSON.parse`; every other caller reads config text.
        return {
          status: "ok" as const,
          text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
        };
      },
    }),
  };
}

export async function activate(host: BuiltinPluginHostApi): Promise<() => void> {
  const registry = new WorkspaceRegistry();
  // Every worktree scan goes through here, so the number running at once is a
  // property of the plugin rather than of how often a renderer asks.
  const scans = new ScanGate();

  // Every push names the preview panel it is about: the workspace's owner
  // subscribes per panel, so a builder on another preview — or in another
  // project's window — never receives it and never has to filter it out.
  const post = (channel: string, payload: unknown, previewPanelId: string): void => {
    void host.postToPanel(channel, payload, previewPanelId).catch((error: unknown) => {
      host.logger.warn("site-builder push failed", { channel, error: String(error) });
    });
  };

  const warnIssue = (code: string, message: string, previewPanelId: string): void => {
    post(
      PUSH_CHANNELS.issue,
      IssuePushSchema.parse({ severity: "warning", code, message }),
      previewPanelId
    );
  };

  // Declared in the manifest so the palette lists it before activation; the
  // handler binds here, on the first dispatch that activates the plugin.
  await host.registerAction(
    {
      id: TOGGLE_BUILDER_ACTION_ID,
      title: "Toggle Site Builder",
      description:
        "Switch the Site Builder on or off in this worktree's dev preview, opening the preview if none is running.",
      category: "panels",
      kind: "command",
      danger: "safe",
      keywords: ["svelte", "sveltekit", "site", "builder", "inspector", "preview", "agent"],
      // Toggling a preview tool exercises none of the plugin's capabilities, so
      // it asks for none: the host elevates a command to a confirm prompt from
      // what it requires, and a dialog on every toolbar click is not that.
      requires: [],
    },
    async () => host.dispatch("devPreview.toggleTool", { toolId: BUILDER_TOOL_ID })
  );

  await host.registerHandler(
    CHANNELS.workspaceOpen,
    {
      args: WorkspaceOpenArgsSchema,
      result: WorkspaceOpenResultSchema,
      requires: ["fs:project-read"],
    },
    async (ctx, args) => {
      if (args.projectId !== ctx.projectId) throw workspaceForbidden();
      const { inspectWorktree } = await import("../shared/project/index.js");
      const worktreePath = path.resolve(args.worktreePath);
      const requested = args.appRoot === undefined ? undefined : path.resolve(args.appRoot);

      // The workspace's filesystem authority, pinned to the project and
      // worktree it is about: this builder keeps reading its own worktree's
      // files while the user works in another worktree or another project.
      const workspaceFs = host.fsForWorkspace({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
      });
      // Created before the first scan and handed to the workspace that scan
      // opens, so from then on a close aborts everything the workspace reads.
      // It does NOT cover this scan: until the session id exists there is
      // nothing for `workspaceClose` to name, and the view waits for the open
      // before closing it. An open that ends without a workspace aborts its
      // own controller rather than leaving one behind.
      const lifetime = new AbortController();
      const workspaceReader = projectReader(workspaceFs, lifetime.signal);

      let scan;
      try {
        scan = await scans.run(
          null,
          () => inspectWorktree(workspaceReader, worktreePath, requested),
          lifetime.signal
        );
      } catch (error) {
        lifetime.abort();
        throw error;
      }
      if (!scan.inspection) {
        if (requested !== undefined || scan.apps.length === 0) {
          lifetime.abort();
          return { status: "no-app" as const };
        }
        if (scan.apps.length > 1) {
          lifetime.abort();
          return { status: "ambiguous" as const, appRoots: scan.apps.map((app) => app.appRoot) };
        }
        // One app on a scan that hit its budget. Discovery will not call it
        // "the only app", and neither does this: it opens the one it found and
        // says the list may be incomplete.
        const only = scan.apps[0]!;
        try {
          scan = await scans.run(
            null,
            () => inspectWorktree(workspaceReader, worktreePath, only.appRoot),
            lifetime.signal
          );
        } catch (error) {
          lifetime.abort();
          throw error;
        }
        if (!scan.inspection) {
          lifetime.abort();
          return { status: "no-app" as const };
        }
        warnIssue(
          "APP_SCAN_TRUNCATED",
          "This worktree is too large to scan completely. Opened the one SvelteKit app found; pick another app root if this is the wrong one.",
          args.previewPanelId
        );
      }

      const { appRoot, support } = scan.inspection.model;
      const id = randomUUID();
      const workspace: Workspace = {
        id,
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        previewPanelId: args.previewPanelId,
        worktreePath,
        appRoot,
        support,
        fs: workspaceFs,
        lifetime,
        tracker: new SourceTracker({
          fs: workspaceFs,
          workspaceSessionId: id,
          push: (payload) =>
            post(
              PUSH_CHANNELS.sourceChanged,
              SourceChangedPushSchema.parse(payload),
              args.previewPanelId
            ),
          warn: (message, detail) => host.logger.warn(message, detail),
        }),
      };
      registry.add(workspace);
      return { status: "ready" as const, workspaceSessionId: id, appRoot, support };
    }
  );

  // Cheap enough to ask for every dev preview: discovery reads manifests, it
  // does not parse the app or open a workspace.
  await host.registerHandler(
    CHANNELS.detectApps,
    { args: DetectAppsArgsSchema, result: DetectAppsResultSchema, requires: ["fs:project-read"] },
    async (ctx, args) => {
      if (args.projectId !== ctx.projectId) throw workspaceForbidden();
      const { discoverSvelteKitApps } = await import("../shared/project/index.js");
      // Scoped like a workspace even though discovery opens none: the answer
      // decides whether the button appears, and the ambient handle would deny
      // the read — reporting "no app" — for any worktree outside the focused
      // window's roots.
      const scopedReader = projectReader(
        host.fsForWorkspace({ projectId: args.projectId, worktreeId: args.worktreeId })
      );
      const worktreePath = path.resolve(args.worktreePath);
      // Every preview in a worktree asks the same question and wants the same
      // answer, so concurrent askers share one walk rather than each starting
      // their own. There is no workspace yet, hence no signal: the gate is the
      // bound here.
      const discovery = await scans.run(
        `detect:${args.projectId}:${args.worktreeId}:${worktreePath}`,
        () => discoverSvelteKitApps(scopedReader, worktreePath)
      );
      return { appCount: discovery.apps.length };
    }
  );

  await host.registerHandler(
    CHANNELS.workspaceClose,
    { args: WorkspaceCloseArgsSchema, result: WorkspaceCloseResultSchema },
    (ctx, { workspaceSessionId }) => ({
      closed:
        ownedWorkspace(registry, ctx, workspaceSessionId) !== undefined &&
        registry.close(workspaceSessionId),
    })
  );

  await host.registerHandler(
    CHANNELS.selectionResolve,
    {
      args: SelectionResolveArgsSchema,
      result: SelectionResolveResultSchema,
      requires: ["fs:project-read"],
    },
    async (ctx, args) => {
      const workspace = ownedWorkspace(registry, ctx, args.workspaceSessionId);
      if (!workspace) throw workspaceClosed();
      return resolveSelection(workspace, args);
    }
  );

  await host.registerHandler(
    CHANNELS.sourceRevisions,
    {
      args: SourceRevisionsArgsSchema,
      result: SourceRevisionsResultSchema,
      requires: ["fs:project-read"],
    },
    async (ctx, { workspaceSessionId, files }) => {
      const workspace = ownedWorkspace(registry, ctx, workspaceSessionId);
      if (!workspace) throw workspaceClosed();
      const { isGeneratedSourceFile } = await import("@daintreehq/svelte-source-model");
      // One read at a time, each file once, and nothing larger than a source
      // file may be: the list is the renderer's to choose.
      const byFile = new Map<string, string | null>();
      for (const file of new Set(files)) {
        byFile.set(file, await revisionOf(file));
      }
      const revisions = files.map((file) => ({ file, revision: byFile.get(file) ?? null }));

      async function revisionOf(file: string): Promise<string | null> {
        const target = resolveReportedPath(workspace!, file);
        if (!target.ok || isGeneratedPath(isGeneratedSourceFile, target.appRelative)) return null;
        if (!(await containsRealPath(workspace!.appRoot, target.absolute))) return null;
        const size = await workspace!.fs
          .stat(target.absolute)
          .then((stat) => (stat.isFile ? stat.size : null))
          .catch(() => null);
        if (size === null || size > MAX_SOURCE_BYTES) return null;
        const read = await readSource(workspace!.fs, target.absolute, workspace!.lifetime.signal);
        return read.status === "ok" || read.status === "not-utf8" ? read.revision : null;
      }
      return { revisions };
    }
  );

  await host.registerHandler(
    CHANNELS.componentDefinitions,
    {
      args: ComponentDefinitionsArgsSchema,
      result: ComponentDefinitionsResultSchema,
      requires: ["fs:project-read"],
    },
    async (ctx, { workspaceSessionId, callSites }) => {
      const workspace = ownedWorkspace(registry, ctx, workspaceSessionId);
      if (!workspace) throw workspaceClosed();
      const [parse, model, { resolveComponentDefinitions }] = await Promise.all([
        loadParse(),
        loadSourceModel(),
        import("./components.js"),
      ]);
      const definitions = await resolveComponentDefinitions(
        workspace,
        callSites,
        parse,
        model.lineColumnToOffset,
        model.isGeneratedSourceFile
      );
      return { definitions };
    }
  );

  await host.registerHandler(
    CHANNELS.projectModel,
    {
      args: ProjectModelArgsSchema,
      result: ProjectModelResultSchema,
      requires: ["fs:project-read"],
    },
    async (ctx, { workspaceSessionId }) => {
      const workspace = ownedWorkspace(registry, ctx, workspaceSessionId);
      if (!workspace) throw workspaceClosed();
      const { inspectProject } = await import("../shared/project/index.js");
      // Read fresh: routes are exactly what an agent adds while the panel is open.
      const { model } = await scans.run(
        null,
        () =>
          inspectProject(projectReader(workspace.fs, workspace.lifetime.signal), {
            worktreeRoot: workspace.worktreePath,
            appRoot: workspace.appRoot,
          }),
        workspace.lifetime.signal
      );
      return model;
    }
  );

  return () => registry.closeAll();
}
