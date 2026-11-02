import type { PluginQuickPickItem } from "../../../../shared/types/plugin.js";
import type { ConversionRecord } from "./catalog.js";
import { currentProjectId, type PluginContext } from "./context.js";
import { launchById } from "./continueFlow.js";
import { AGENT_LABELS } from "./handoff.js";
import { deleteConversions, pruneRemovedProjects } from "./retention.js";

const SHARE_ID = "share";
const UNSHARE_ID = "unshare";
const DELETE_ALL_ID = "delete-all";

/**
 * The project pill's "Converted sessions…": this project's converted
 * sessions with what each costs on disk, the per-project switch that lets
 * every agent in it search them, and deletion.
 */
export async function manageConversions(ctx: PluginContext, args: unknown): Promise<void> {
  const { host, catalog, store } = ctx;
  const projectId = readProjectId(args) ?? (await currentProjectId(host));
  if (!projectId) {
    await host.showToast({
      message: "Open a project to see its converted sessions.",
      type: "info",
    });
    return;
  }
  await pruneRemovedProjects(ctx);

  const records = (await catalog.list())
    .filter((record) => record.projectId === projectId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const shared = (await catalog.sharedProjects()).has(projectId);
  const sizes = await Promise.all(records.map((record) => store.sizeOf(record.id)));

  const items: PluginQuickPickItem[] = records.map((record, index) => ({
    id: record.id,
    label: `${AGENT_LABELS[record.sourceAgent]} → ${AGENT_LABELS[record.targetAgent]}`,
    description: `${new Date(record.createdAt).toLocaleString()} · ${formatBytes(sizes[index] ?? null)}`,
    detail: record.terminalId ? "Searchable by the agent that continued it" : "Not continued yet",
  }));
  items.push(
    shared
      ? {
          id: UNSHARE_ID,
          label: "Stop sharing with every agent in this project",
          detail: "Only the agent that continued a session can search it",
        }
      : {
          id: SHARE_ID,
          label: "Share with every agent in this project",
          detail: "Any agent here, and in other projects that share theirs, can search them",
        }
  );
  if (records.length > 0) {
    items.push({ id: DELETE_ALL_ID, label: "Delete all converted sessions in this project" });
  }

  const pick = await host.showQuickPick(items, {
    title: records.length > 0 ? "Converted sessions" : "No converted sessions in this project yet",
    placeholder: "Pick a session, or what to change",
    matchOnDescription: true,
  });
  if (!pick) return;

  if (pick.id === SHARE_ID) {
    const ok = await host.showConfirm({
      title: "Share converted sessions with every agent in this project?",
      message:
        "Every agent in this project that has the plugin's agent tools can search this project's converted sessions, and those of every other project that shares its own. Sessions converted before now are included.",
      confirmLabel: "Share sessions",
    });
    if (ok) await catalog.setShared(projectId, true);
    return;
  }
  if (pick.id === UNSHARE_ID) {
    await catalog.setShared(projectId, false);
    return;
  }
  if (pick.id === DELETE_ALL_ID) {
    const ok = await host.showConfirm({
      title: "Delete this project's converted sessions?",
      message:
        "Their indexes are removed from this machine and no agent can search them any more. The original session files aren't touched.",
      confirmLabel: "Delete sessions",
      destructive: true,
    });
    if (ok) await deleteConversions(ctx, records);
    return;
  }

  const record = records.find((candidate) => candidate.id === pick.id);
  if (record) await manageOne(ctx, record);
}

async function manageOne(ctx: PluginContext, record: ConversionRecord): Promise<void> {
  const { host } = ctx;
  const target = AGENT_LABELS[record.targetAgent];
  const pick = await host.showQuickPick(
    [
      {
        id: "launch",
        label: `Continue in ${target} again`,
        detail: "Starts a new pane with the same hand-off",
      },
      { id: "delete", label: "Delete converted session" },
    ],
    { title: `${AGENT_LABELS[record.sourceAgent]} session ${record.sourceSessionId}` }
  );
  if (pick?.id === "launch") {
    await launchById(ctx, { conversionId: record.id });
  } else if (pick?.id === "delete") {
    const ok = await host.showConfirm({
      title: `Delete the converted ${AGENT_LABELS[record.sourceAgent]} session?`,
      message:
        "Its index is removed from this machine and no agent can search it any more. The original session file isn't touched.",
      confirmLabel: "Delete session",
      destructive: true,
    });
    if (ok) await deleteConversions(ctx, [record]);
  }
}

function readProjectId(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>).projectId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "index missing";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
