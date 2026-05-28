import { dialog } from "electron";
import { writeFile } from "node:fs/promises";
import { defineIpcNamespace, op } from "../define.js";
import { FORGE_AUDIT_METHOD_CHANNELS } from "./forgeAudit.preload.js";
import { forgeAuditService } from "../../services/forge/forgeAuditService.js";
import type { ForgeAuditRecord, ForgeAuditStats } from "../../../shared/types/ipc/forge.js";

export const forgeAuditNamespace = defineIpcNamespace({
  name: "forgeAudit",
  ops: {
    getRecords: op(
      FORGE_AUDIT_METHOD_CHANNELS.getRecords,
      async (): Promise<ForgeAuditRecord[]> => forgeAuditService.getRecords()
    ),
    getConfig: op(
      FORGE_AUDIT_METHOD_CHANNELS.getConfig,
      async (): Promise<{ enabled: boolean; maxRecords: number }> =>
        forgeAuditService.getAuditConfig()
    ),
    getStats: op(
      FORGE_AUDIT_METHOD_CHANNELS.getStats,
      async (): Promise<ForgeAuditStats> => forgeAuditService.getAuditStats()
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
      async (records: ForgeAuditRecord[]): Promise<boolean> => {
        if (!Array.isArray(records)) throw new Error("records must be an array");
        const ndjson = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
        const now = Date.now();
        const defaultFilename = `forge-audit-log-${new Date(now)
          .toISOString()
          .replace(/[:.]/g, "-")}.ndjson`;
        const { filePath, canceled } = await dialog.showSaveDialog({
          title: "Export forge audit log",
          defaultPath: defaultFilename,
          filters: [{ name: "NDJSON Files", extensions: ["ndjson"] }],
        });
        if (canceled || !filePath) return false;
        await writeFile(filePath, ndjson, "utf-8");
        return true;
      }
    ),
  },
});

export function registerForgeAuditHandlers(): () => void {
  return forgeAuditNamespace.register();
}
