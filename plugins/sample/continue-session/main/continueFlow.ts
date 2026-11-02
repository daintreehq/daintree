import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import type { ConversionRecord } from "./catalog.js";
import { currentProjectId, MANIFEST_NAME, type PluginContext } from "./context.js";
import { convertSession, SessionMismatchError } from "./convert.js";
import { AGENT_LABELS, buildHandoffPrompt } from "./handoff.js";
import { pruneRemovedProjects } from "./retention.js";
import type { SessionAgentId } from "./sessionRecords.js";

/** What `terminal.sessionFile.get` answers (docs/plugins/host-api.md). */
type SessionFileAnswer =
  | {
      status: "observed";
      agentId: SessionAgentId;
      sessionId: string;
      path: string;
      observedBy: string;
    }
  | { status: "unknown"; reason: string };

export type ContinueOutcome =
  | { status: "launched"; conversionId: string; terminalId: string }
  | { status: "not-launched"; conversionId: string; reason: string }
  | { status: "declined" }
  | { status: "unavailable"; reason: string }
  | { status: "cancelled" }
  | { status: "failed"; reason: string };

const UNKNOWN_REASONS: Readonly<Record<string, string>> = {
  "terminal-unavailable": "This pane isn't a terminal in this project.",
  "no-live-agent": "No agent is running in this pane.",
  "unsupported-agent": "Only Codex and Claude Code sessions can be continued.",
  "unsupported-platform": "Session files can't be located on Windows yet.",
  "remote-pane": "This pane runs on a remote host, where its session file can't be read.",
  "session-id-unknown":
    "Daintree didn't record this pane's session. A Claude Code session started by hand in the pane can't be located.",
  "store-unknown": "Daintree isn't sure which Claude Code store this pane uses.",
  "not-observed":
    "The session file wasn't seen. Codex opens it a few seconds into a session, so try again shortly.",
  ambiguous: "More than one session file could be this pane's, so none was taken.",
  unverified: "A session file was found but failed a check.",
  "probe-failed": "Looking for the session file failed.",
  "pane-changed": "The pane restarted while its session file was being located.",
  busy: "Daintree is already locating other session files. Try again in a moment.",
};

/**
 * The pane menu's "Continue in another agent…": locate the pane's session
 * file, explain the trade-off, convert the session, then start the other CLI
 * in the same worktree with the hand-off.
 */
export async function continueFromPane(
  ctx: PluginContext,
  args: unknown
): Promise<ContinueOutcome> {
  const { host } = ctx;
  const terminalId = readString(args, "panelId") ?? readString(args, "terminalId");
  if (!terminalId) return unavailable(host, "No pane was named.");

  const front = await currentProjectId(host);
  if (!front) return unavailable(host, "No project is open.");

  const info = await host.dispatch("terminal.info.get", { terminalId });
  if (!info.ok) return unavailable(host, "This pane's details couldn't be read.");
  const terminal = info.result as { cwd?: unknown; worktreeId?: unknown; projectId?: unknown };
  // The pane's own record names its project when it can; the session is filed
  // under that, and a pane outside the project in front isn't one dispatch reaches.
  const projectId = typeof terminal.projectId === "string" ? terminal.projectId : front;
  if (projectId !== front) return unavailable(host, "This pane isn't in the project in front.");

  const located = await host.dispatch("terminal.sessionFile.get", { terminalId });
  if (!located.ok) return unavailable(host, "This pane's session file couldn't be located.");
  const file = located.result as SessionFileAnswer;
  if (file.status !== "observed") {
    return unavailable(
      host,
      UNKNOWN_REASONS[file.reason] ?? "This pane's session file is unknown."
    );
  }

  const sourceAgent = file.agentId;
  const targetAgent: SessionAgentId = sourceAgent === "codex" ? "claude" : "codex";
  const source = AGENT_LABELS[sourceAgent];
  const target = AGENT_LABELS[targetAgent];
  const confirmed = await host.showConfirm({
    title: `Continue in ${target}?`,
    message:
      `Daintree reads this ${source} session once and turns it into a searchable index on this machine. ${target} starts in the same worktree with a short hand-off: your last few requests and ${source}'s last message. ` +
      `It doesn't get the conversation as history: it searches it with a tool when it needs something. The hand-off and what it finds go to its model like any other context. ` +
      `The session file isn't changed. The index stays until you delete it from the project's Converted sessions menu.`,
    confirmLabel: `Continue in ${target}`,
  });
  if (!confirmed) return { status: "declined" };

  const conversionId = ctx.newId();
  const controller = new AbortController();
  ctx.running.add(controller);
  const task = await host.tasks.start({
    title: `Converting the ${source} session`,
    detail: "Reading the session file",
    cancellable: true,
    fraction: 0,
    retry: { actionId: `${MANIFEST_NAME}.continue`, args: { panelId: terminalId } },
  });
  const signal = AbortSignal.any([controller.signal, task.signal]);

  let record: ConversionRecord;
  let prompt: string;
  try {
    const converted = await convertSession(ctx.store, {
      id: conversionId,
      agentId: sourceAgent,
      sessionId: file.sessionId,
      path: file.path,
      signal,
      onProgress: (fraction) => task.report({ fraction }),
    });
    record = {
      id: conversionId,
      projectId,
      worktreeId: typeof terminal.worktreeId === "string" ? terminal.worktreeId : null,
      cwd: typeof terminal.cwd === "string" ? terminal.cwd : "",
      sourceAgent,
      targetAgent,
      sourceSessionId: file.sessionId,
      sourcePath: file.path,
      sourceBytes: converted.sourceBytes,
      fragments: converted.fragments,
      skippedLines: converted.skippedLines,
      createdAt: Date.now(),
      terminalIds: [],
    };
    prompt = buildHandoffPrompt({
      sourceAgent,
      sourceSessionId: file.sessionId,
      sourcePath: file.path,
      conversionId,
      prompts: converted.prompts,
      lastReply: converted.lastReply,
    });
    await ctx.store.writeHandoff(conversionId, prompt);
    // A cancel that lands while the index is published still wins: nothing
    // is kept and nothing launches.
    signal.throwIfAborted();
    await ctx.catalog.put(record);
  } catch (error) {
    await ctx.catalog.remove([conversionId]).catch(() => undefined);
    await ctx.store.delete(conversionId).catch(() => undefined);
    if (signal.aborted) {
      await task.finish({ outcome: "cancelled" });
      return { status: "cancelled" };
    }
    const reason =
      error instanceof SessionMismatchError
        ? error.message
        : `The session couldn't be read or indexed (${errorName(error)}).`;
    await task.finish({ outcome: "failed", message: reason });
    return { status: "failed", reason };
  } finally {
    ctx.running.delete(controller);
  }

  await task.finish({ outcome: "succeeded" });
  await pruneRemovedProjects(ctx, projectId).catch(() => undefined);
  return launchConversion(ctx, record, prompt);
}

/**
 * Starts the continuing agent for a converted session. The terminal id is
 * chosen up front and granted before the launch, so the agent can search
 * from its very first turn; a launch that doesn't happen takes back its own
 * grant and no other.
 *
 * The project check sits right before the launch, with nothing awaited
 * between them but the check itself, because an installed plugin's dispatch
 * runs in whichever project is in front. A pane in a worktree is also safe
 * from a switch in that gap: the launcher refuses a worktree id the project
 * in front doesn't have.
 */
export async function launchConversion(
  ctx: PluginContext,
  record: ConversionRecord,
  prompt: string
): Promise<ContinueOutcome> {
  const { host } = ctx;
  const target = AGENT_LABELS[record.targetAgent];
  const requestedId = `continue-${ctx.newId()}`;
  const notLaunched = async (reason: string): Promise<ContinueOutcome> => {
    await ctx.catalog.revoke(record.id, requestedId);
    await host.notify({
      title: `Couldn't start ${target}`,
      body: `${reason} The converted session is kept.`,
      severity: "error",
      actions: [
        {
          id: "retry",
          label: "Retry",
          actionId: `${MANIFEST_NAME}.launch`,
          args: { conversionId: record.id },
        },
      ],
    });
    return { status: "not-launched", conversionId: record.id, reason };
  };

  await ctx.catalog.grant(record.id, requestedId);
  if ((await currentProjectId(host)) !== record.projectId) {
    return notLaunched("The project this session belongs to isn't the one in front.");
  }
  const launch = await host.dispatch("agent.launch", {
    agentId: record.targetAgent,
    ...(record.worktreeId ? { worktreeId: record.worktreeId } : {}),
    ...(record.cwd ? { cwd: record.cwd } : {}),
    prompt,
    interactive: true,
    requestedId,
    focusPolicy: "take",
  });
  if (!launch.ok) return notLaunched(launch.error.message);
  const result = launch.result as {
    launched?: unknown;
    terminalId?: unknown;
    spawnStatus?: unknown;
  };
  if (result.launched !== true || typeof result.terminalId !== "string") {
    return notLaunched(launchRefusal(result.spawnStatus, target));
  }
  if (result.terminalId !== requestedId) {
    await ctx.catalog.revoke(record.id, requestedId, result.terminalId);
  }
  return { status: "launched", conversionId: record.id, terminalId: result.terminalId };
}

/** The "Retry" on a failed launch, and "Continue again" in the Converted sessions menu. */
export async function launchById(ctx: PluginContext, args: unknown): Promise<ContinueOutcome> {
  const id = readString(args, "conversionId");
  const record = id ? await ctx.catalog.get(id) : null;
  if (!record) return unavailable(ctx.host, "That converted session was deleted.");
  const prompt = await ctx.store.readHandoff(record.id).catch(() => null);
  if (!prompt) {
    return unavailable(
      ctx.host,
      "That converted session's index is missing. Convert the session again from its pane's menu."
    );
  }
  return launchConversion(ctx, record, prompt);
}

function launchRefusal(spawnStatus: unknown, target: string): string {
  switch (spawnStatus) {
    case "missing-cli":
      return `${target} isn't installed or can't be found, so Daintree opened its setup instead.`;
    case "panel-limit":
      return "The grid is full.";
    case "already-launching":
    case "presets-loading":
      return "Daintree was busy starting another agent.";
    default:
      return `${target} didn't start.`;
  }
}

async function unavailable(host: PluginHostApi, reason: string): Promise<ContinueOutcome> {
  await host.showToast({ message: `Can't continue this session. ${reason}`, type: "warning" });
  return { status: "unavailable", reason };
}

function readString(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown error";
}
