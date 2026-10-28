// The system actions' run bodies, loaded on first dispatch by `runSystemAction`
// in systemActions.ts, which keeps the metadata every view registers at boot
// (#14274). Nothing here may import systemActions.ts at runtime.
import type { ActionContext } from "@shared/types/actions";
import type { z } from "zod";
import type { CopyTreeOptionsSchema, FileSearchPayloadSchema } from "./schemas";
import {
  requireWorktreePath,
  requireWorktreeId,
  requireExplicitWorktreeForAgentDispatch,
  resolveProjectLocation,
  type ProjectLocationArgs,
  type WorktreeLocationArgs,
} from "./locationArgs";
import { copiesWorkspaceRoot } from "./workspaceRootCopyTarget";
import { notify } from "@/lib/notify";
import { announceCopyTreeCopy } from "@/lib/copyTreeFeedback";
import { panelNotificationAddress } from "@/lib/notificationAddress";
import { useCopyTreeRunStore } from "@/store/copyTreeRunStore";
import { formatCopyResultMessage } from "@/lib/formatCopyResult";
import { resolveCopyTreeRunSource } from "@/lib/copyTreeRunSource";
import { resolveCopyTreeRunName } from "@shared/utils/copyTreeHistory";
import {
  artifactClient,
  cliAvailabilityClient,
  copyTreeClient,
  filesClient,
  slashCommandsClient,
  systemClient,
} from "@/clients";
import { cancelContextInjection } from "@/hooks/useContextInjection";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { CopyTreeResult } from "@shared/types";

type CopyTreeOptions = z.infer<typeof CopyTreeOptionsSchema>;

/** The args every copy-tree generation shares, as their `argsSchema`s declare them. */
interface CopyTreeRunArgs {
  options?: CopyTreeOptions;
  name?: string;
}

function projectCopyTreeStats(stats: NonNullable<CopyTreeResult["stats"]>) {
  return {
    totalSize: stats.totalSize,
    duration: stats.duration,
    ...(stats.estimatedTokens !== undefined && { estimatedTokens: stats.estimatedTokens }),
    ...(stats.noFilesMatched !== undefined && { noFilesMatched: stats.noFilesMatched }),
    ...(stats.unmatchedSelector !== undefined && { unmatchedSelector: stats.unmatchedSelector }),
    ...(stats.truncated !== undefined && { truncated: stats.truncated }),
    ...(stats.truncatedCount !== undefined && { truncatedCount: stats.truncatedCount }),
    ...(stats.truncatedBy !== undefined && { truncatedBy: stats.truncatedBy }),
    ...(stats.budgetExceeded !== undefined && { budgetExceeded: stats.budgetExceeded }),
  };
}

/**
 * Turn an error-shaped CopyTree result into a thrown error.
 *
 * A returned value is serialized by the MCP bridge as a SUCCESSFUL tool result,
 * so a failure reported in an `error` field beside an empty dump is invisible to
 * an agent checking `isError` (#11543). Throwing routes it through
 * EXECUTION_ERROR, which the bridge reports as a tool error. `generate` already
 * did this; the other two returned their failures as success data.
 */
function throwOnCopyTreeFailure(result: CopyTreeResult): void {
  const failure =
    result && typeof result === "object" ? (result as { error?: string }).error : undefined;
  if (failure) throw new Error(failure);
}

/**
 * Narrow a file-backed result to the pair the schema declares as required.
 *
 * `filePath` and `outputBytes` are optional on `CopyTreeResult` — the inline
 * paths never set them — and only the handler's own check ties them to a
 * successful generation. Now that dispatch parses results (#11539) an unset one
 * would surface as RESULT_VALIDATION_ERROR, which tells a caller nothing. Assert
 * the invariant where it is used so the same condition reads as a plain failure.
 */
function requireGeneratedFile(result: CopyTreeResult): { filePath: string; outputBytes: number } {
  if (typeof result.filePath !== "string" || typeof result.outputBytes !== "number") {
    throw new Error("Failed to generate context");
  }
  return { filePath: result.filePath, outputBytes: result.outputBytes };
}

/**
 * The completion title for a copy-tree run, labelled when the caller named it.
 *
 * Only a *supplied* name is appended, never the derived fallback. The fallback
 * exists so every history row stays navigable, and it is a heuristic — a path
 * basename, a raw pattern, or "Full context" — which reads as noise in a
 * headline that already says what happened ("Context copied — Full context")
 * and as a riddle when it is a bare basename. It can also disagree with the
 * stored row outright: a deduped unnamed run keeps whatever explicit name is
 * already on the entry, so a freshly derived label would name the run something
 * the history does not. An explicit name is caller intent and worth promoting;
 * the fallback is not. This also keeps every existing caller's title
 * byte-identical — nothing but an explicitly named run changes.
 *
 * Resolved through the helper the main process persists with, so the label the
 * user sees is the one stored in history, trimmed and truncated alike. Options
 * are not passed: the derive branch is unreachable for a non-blank name, and
 * feeding them in would imply the fallback can surface here, which is the one
 * thing this must not do.
 */
function copyTreeRunTitle(base: string, suppliedName: string | undefined): string {
  const trimmed = suppliedName?.trim();
  return trimmed ? `${base} — ${resolveCopyTreeRunName(trimmed, undefined)}` : base;
}

/**
 * Each run's args, as the `argsSchema` beside it in systemActions.ts declares
 * them. The runner there is typed against this table, so a schema that drifts
 * from what its run reads fails to compile at the `run:` call site.
 */
interface SystemActionRunArgsTable {
  "system.openExternal": { url: string };
  "system.openPath": { path: string };
  "system.checkCommand": { command: string };
  "system.checkDirectory": { path: string };
  "system.getHomeDir": unknown;
  "system.getResourceProfileSnapshot": unknown;
  "cliAvailability.get": unknown;
  "cliAvailability.refresh": unknown;
  "files.search": z.infer<typeof FileSearchPayloadSchema>;
  "slashCommands.list": (ProjectLocationArgs & { agentId?: BuiltInAgentId }) | undefined;
  "artifact.saveToFile": { content: string; suggestedFilename?: string; cwd?: string };
  "artifact.applyPatch": WorktreeLocationArgs & { patchContent: string };
  "copyTree.isAvailable": unknown;
  "copyTree.generate":
    (WorktreeLocationArgs & CopyTreeRunArgs & { includeContent?: boolean }) | undefined;
  "copyTree.generateAndCopyFile": (WorktreeLocationArgs & CopyTreeRunArgs) | undefined;
  "copyTree.injectToTerminal": CopyTreeRunArgs & { terminalId: string; worktreeId?: string };
  "copyTree.cancel": unknown;
  "copyTree.getFileTree": { worktreeId: string; dirPath?: string; includeExcluded?: boolean };
}

export type SystemActionRunId = keyof SystemActionRunArgsTable;

export type SystemActionRunArgs<Id extends SystemActionRunId> = SystemActionRunArgsTable[Id];

export const systemActionRuns: {
  [Id in SystemActionRunId]: (
    args: SystemActionRunArgs<Id>,
    ctx: ActionContext
  ) => Promise<unknown>;
} = {
  "system.openExternal": async ({ url }) => {
    await systemClient.openExternal(url);
  },

  "system.openPath": async ({ path }) => {
    await systemClient.openPath(path);
  },

  "system.checkCommand": async ({ command }) => {
    const result = await systemClient.checkCommand(command);
    return { available: result };
  },

  "system.checkDirectory": async ({ path }) => {
    const result = await systemClient.checkDirectory(path);
    return { exists: result };
  },

  "system.getHomeDir": async () => {
    const result = await systemClient.getHomeDir();
    return { path: result };
  },

  "system.getResourceProfileSnapshot": async () => {
    return await systemClient.getResourceProfileSnapshot();
  },

  "cliAvailability.get": async () => {
    return await cliAvailabilityClient.get();
  },

  "cliAvailability.refresh": async () => {
    return await cliAvailabilityClient.refresh();
  },

  "files.search": async (payload, ctx) => {
    const resolvedCwd = payload.cwd ?? ctx.activeWorktreePath;
    if (!resolvedCwd) throw new Error("No active worktree");
    return await filesClient.search({ ...payload, cwd: resolvedCwd });
  },

  "slashCommands.list": async (payload, ctx) => {
    const agentId = payload?.agentId ?? "claude";
    const result = await slashCommandsClient.list({
      agentId,
      projectPath: resolveProjectLocation(payload, ctx).projectPath,
    });
    return { commands: result };
  },

  "artifact.saveToFile": async (args) => {
    return await artifactClient.saveToFile(args);
  },

  "artifact.applyPatch": async ({ patchContent, ...location }, ctx) => {
    return await artifactClient.applyPatch({
      patchContent,
      cwd: requireWorktreePath(location, ctx),
    });
  },

  "copyTree.isAvailable": async () => {
    const result = await copyTreeClient.isAvailable();
    return { available: result };
  },

  "copyTree.generate": async (args, ctx) => {
    // Deliberately NOT bracketed into the shared run store, unlike the two
    // clipboard siblings. That store drives the toolbar button's spinner,
    // and the button also goes aria-disabled while it spins — so bracketing
    // an assistant's background bundle would take the user's own control
    // away for the seconds the agent is working, which is the "hostage UI"
    // anti-pattern (NN/g "user control and freedom"). This endpoint has no
    // human route at all, so the in-flight signal belongs where the work is
    // visible — the assistant panel that started it — and only the
    // COMPLETION comes back to the button below.
    const worktreeId = requireWorktreeId(args, ctx);
    const result = await copyTreeClient.generate(
      worktreeId,
      args?.options,
      args?.includeContent,
      resolveCopyTreeRunSource(ctx.dispatchSource, ctx.copyTreeRunSource),
      args?.name
    );
    throwOnCopyTreeFailure(result);
    const { filePath, outputBytes } = requireGeneratedFile(result);
    // "generated"/"bundled", never "copied": this writes a temp file and
    // never touches the clipboard, so the clipboard wording would be false.
    // Ordered after both failure checks so a bundle that never landed can't
    // announce success.
    //
    // Announced through the same button-anchored presenter as the two
    // clipboard siblings rather than the inbox-only notify it used to
    // raise. The old gate reasoned from "nothing the user owns changes",
    // which is true of the temp file but wrong about the event: this is the
    // endpoint the in-app assistant lands on by default, so inbox-only made
    // its most common context action one the user had to go looking for.
    // The inbox row does survive a restart (notificationHistorySlice
    // persists `entries`), so what was missing was never durability — it
    // was any surface at the moment it happened.
    //
    // Degrades the way its siblings do: the presenter takes it when the
    // button can carry it, otherwise `announceCopyTreeCopy` re-routes to
    // notify(). Note that is a toast only while the window is FOCUSED —
    // notify() sends a blurred high-priority event to the inbox instead
    // (`shouldToast` in lib/notify.ts) — which is the same condition the
    // presenter declines on, so a completion that lands on a blurred
    // window is inbox-only by design at both layers.
    announceCopyTreeCopy(
      {
        // Names the actor rather than reporting the change passively: an
        // unattributed autonomous state change is a transparency failure
        // under every current human-AI guideline (MS HAX G1/G11, Google
        // PAIR "mental models", IBM Carbon's AI labelling), and passive
        // "Context generated" reads as the user's own earlier click
        // landing late.
        //
        // "Agent", not "Assistant", and deliberately so. `dispatchSource`
        // cannot identify WHICH agent: useMcpBridge dispatches every MCP
        // origin as "agent", and this action sits in the `full` tool set,
        // which a normal Claude pane reaches through its own per-pane
        // bearer token (terminal/lifecycle.ts mints one for every Claude
        // launch when the project's MCP tier is on). Naming the in-app
        // assistant here would misattribute any grid agent's bundle to it —
        // the exact failure the attribution exists to prevent. The trusted
        // signal is `McpSessionOrigin`, which main already computes but
        // does not thread into ActionContext; until it does, "Agent" is the
        // most specific thing that is true.
        title: copyTreeRunTitle(
          ctx.dispatchSource === "agent" ? "Agent generated context" : "Context generated",
          args?.name
        ),
        message: formatCopyResultMessage(
          {
            fileCount: result.fileCount,
            stats: result.stats,
            format: args?.options?.format,
          },
          "temporary-file"
        ),
      },
      "copyTree.generate",
      worktreeId
    );
    // Projected explicitly rather than passed through. Dispatch does parse
    // results against `resultSchema` now (#11539), but building the result
    // here is still what keeps the bundle off the wire: a parse would reject
    // an oversized `content`, not drop it.
    return {
      filePath,
      fileCount: result.fileCount,
      outputBytes,
      ...(result.outputFormatVersion !== undefined
        ? { outputFormatVersion: result.outputFormatVersion }
        : {}),
      // Gated on what was ASKED for, not on what came back: keying off the
      // response would forward a bundle to a caller who never opted in if
      // the layer below ever returned one.
      ...(args?.includeContent
        ? { content: result.content, contentTruncated: result.contentTruncated === true }
        : {}),
      ...(result.stats ? { stats: projectCopyTreeStats(result.stats) } : {}),
    };
  },

  "copyTree.generateAndCopyFile": async (args, ctx) => {
    // Nothing named and provably no worktree to inherit is a non-git
    // project or a scratch, whose root is its one copyable folder — main
    // resolves it from the dispatching view (#13210). An agent is only made
    // to name a worktree when there is one it could inherit by accident.
    const rootCopy = !args?.worktreeId && !args?.worktreePath && (await copiesWorkspaceRoot(ctx));
    let worktreeId: string | undefined;
    if (!rootCopy) {
      requireExplicitWorktreeForAgentDispatch("copyTree.generateAndCopyFile", args, ctx);
      worktreeId = requireWorktreeId(args, ctx);
    }
    // Bracketed for the toolbar's Copy context spinner — this is the action
    // MCP clipboard copies and the recents replay land on, and both should
    // spin the button exactly like a direct click (the other clipboard
    // route, worktree.copyTree, brackets itself the same way). The
    // temp-file and terminal-injection siblings deliberately don't: the
    // button advertises a clipboard copy, and neither touches the clipboard.
    const runStore = useCopyTreeRunStore.getState();
    runStore.beginRun();
    let result: CopyTreeResult;
    try {
      result = await copyTreeClient.generateAndCopyFile(
        worktreeId,
        args?.options,
        resolveCopyTreeRunSource(ctx.dispatchSource, ctx.copyTreeRunSource),
        args?.name
      );
    } finally {
      runStore.endRun();
    }
    throwOnCopyTreeFailure(result);
    const { filePath, outputBytes } = requireGeneratedFile(result);
    // Announced for every dispatch source, not just agents. The old
    // agent-only gate assumed a person who triggered this already knows
    // their clipboard changed — true of a button with inline feedback, but
    // this action's other human routes (palette, recents replay) leave
    // nothing on screen at all (#11735). The announcement is a transient
    // tooltip on the toolbar's Copy context button, with a toast fallback
    // when that button isn't visible. Ordered after the failure checks so a
    // failed generate or a failed clipboard write can never announce
    // success.
    announceCopyTreeCopy(
      {
        // Matches the title every other copy-tree completion uses for this
        // artifact ("context", never "reference file"), paired with the
        // same formatCopyResultMessage body — see worktreeContextActions.impl.ts.
        title: copyTreeRunTitle("Context copied", args?.name),
        message: formatCopyResultMessage({
          fileCount: result.fileCount,
          stats: result.stats,
          format: args?.options?.format,
        }),
      },
      "copyTree.generateAndCopyFile",
      worktreeId
    );
    return {
      filePath,
      fileCount: result.fileCount,
      outputBytes,
      ...(result.stats ? { stats: projectCopyTreeStats(result.stats) } : {}),
    };
  },

  "copyTree.injectToTerminal": async ({ terminalId, worktreeId, options, name }, ctx) => {
    const resolvedWorktreeId = worktreeId ?? ctx.activeWorktreeId;
    if (!resolvedWorktreeId) throw new Error("No active worktree");
    const notifyAddress = {
      worktreeId: resolvedWorktreeId,
      ...panelNotificationAddress(terminalId),
    };
    const result = await copyTreeClient.injectToTerminal(
      terminalId,
      resolvedWorktreeId,
      options,
      undefined,
      resolveCopyTreeRunSource(ctx.dispatchSource, ctx.copyTreeRunSource),
      name
    );
    throwOnCopyTreeFailure(result);
    // "injected … into terminal", not "copied": the bundle streams into a
    // PTY and never reaches the clipboard. Ordered after the failure check.
    // The renderer's own injection path (`useContextInjection`) calls the
    // client directly and carries its own key, so the two never stack
    // (#11735).
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({
      type: "success",
      title: copyTreeRunTitle("Context injected", name),
      message: formatCopyResultMessage(
        {
          fileCount: result.fileCount,
          stats: result.stats,
          format: options?.format,
        },
        "terminal"
      ),
      rateLimitKey: "copyTree.injectToTerminal",
      context: { eventKind: "agent", ...notifyAddress },
    });
    return {
      fileCount: result.fileCount,
      ...(result.stats ? { stats: projectCopyTreeStats(result.stats) } : {}),
    };
  },

  "copyTree.cancel": async () => {
    // Clears renderer injection state and cancels the active injection by
    // UUID, then sweeps any other in-flight CopyTree operations
    // (generate/copy-file). An injection started between these two calls
    // would be swept too — accepted: both are user-initiated cancels and
    // the window is a single microtask turn.
    cancelContextInjection();
    await copyTreeClient.cancel();
  },

  "copyTree.getFileTree": async ({ worktreeId, dirPath, includeExcluded }) => {
    const result = await copyTreeClient.getFileTree(worktreeId, dirPath, includeExcluded);
    return { nodes: result };
  },
};
