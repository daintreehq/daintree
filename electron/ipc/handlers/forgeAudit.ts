import { dialog } from "electron";
import { writeFile } from "node:fs/promises";
import { defineIpcNamespace, op } from "../define.js";
import { FORGE_AUDIT_METHOD_CHANNELS } from "./forgeAudit.preload.js";
import { forgeAuditService } from "../../services/forge/forgeAuditService.js";
import { sanitizePath } from "../../utils/pathScrubber.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import type { ForgeAuditRecord, ForgeAuditStats } from "../../../shared/types/ipc/forge.js";

export const forgeAuditNamespace = defineIpcNamespace({
  name: "forgeAudit",
  ops: {
    getRecords: op(FORGE_AUDIT_METHOD_CHANNELS.getRecords, async (): Promise<ForgeAuditRecord[]> =>
      forgeAuditService.getRecords()
    ),
    getConfig: op(
      FORGE_AUDIT_METHOD_CHANNELS.getConfig,
      async (): Promise<{ enabled: boolean; maxRecords: number }> =>
        forgeAuditService.getAuditConfig()
    ),
    getStats: op(FORGE_AUDIT_METHOD_CHANNELS.getStats, async (): Promise<ForgeAuditStats> =>
      forgeAuditService.getAuditStats()
    ),
    clearLog: op(FORGE_AUDIT_METHOD_CHANNELS.clearLog, async (): Promise<void> => {
      forgeAuditService.clear();
    }),
    setEnabled: op(
      FORGE_AUDIT_METHOD_CHANNELS.setEnabled,
      async (enabled: boolean): Promise<{ enabled: boolean; maxRecords: number }> => {
        if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
        return forgeAuditService.setEnabled(enabled);
      }
    ),
    exportLog: op(
      FORGE_AUDIT_METHOD_CHANNELS.exportLog,
      async (ctx, records: ForgeAuditRecord[]): Promise<boolean> => {
        if (!Array.isArray(records)) throw new Error("records must be an array");
        // Defense-in-depth scrub on the NDJSON before it hits disk: provider
        // error messages can carry partial tokens (e.g. "401 invalid_token ghp_…")
        // even though argsSummary is already redacted at write time.
        const ndjsonLines = records.map((rawRecord) => {
          const record = rawRecord as unknown as Record<string, unknown>;
          const cleaned: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(record)) {
            cleaned[key] = typeof value === "string" ? sanitizePath(value) : value;
          }
          return scrubSecrets(JSON.stringify(cleaned));
        });
        const ndjson = ndjsonLines.join("\n") + "\n";
        const now = Date.now();
        const defaultFilename = `forge-audit-log-${new Date(now)
          .toISOString()
          .replace(/[:.]/g, "-")}.ndjson`;
        const dialogOptions: Electron.SaveDialogOptions = {
          title: "Export forge audit log",
          defaultPath: defaultFilename,
          filters: [{ name: "NDJSON Files", extensions: ["ndjson"] }],
        };
        const win = ctx.senderWindow ?? undefined;
        const { filePath, canceled } = win
          ? await dialog.showSaveDialog(win, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions);
        if (canceled || !filePath) return false;
        await writeFile(filePath, ndjson, "utf-8");
        return true;
      },
      { withContext: true }
    ),
  },
});

export function registerForgeAuditHandlers(): () => void {
  return forgeAuditNamespace.register();
}
