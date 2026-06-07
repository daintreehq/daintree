import { TriangleAlert } from "lucide-react";
import { actionService } from "@/services/ActionService";
import { useMcpAnomalyStore } from "@/store/mcpAnomalyStore";

/**
 * Tier 1 ambient footer link for MCP audit anomaly signals (#10022). The
 * anomaly detail itself lives in Settings → MCP Server → Audit Log; this is the
 * quiet, in-context shortcut to it that surfaces alongside the assistant's
 * recent-activity strip. Renders nothing until {@link useMcpAnomalyStore}
 * reports an anomaly, so it's safe to mount unconditionally inside the footer.
 *
 * Deliberately never calls `notify()` — anomalies are background diagnostics,
 * and the surrounding UI (this link plus the toolbar pip) is the entire signal.
 */
export function McpAnomalyFooterLink() {
  const hasAnomaly = useMcpAnomalyStore((s) => s.hasAnomaly);
  const anomalyCount = useMcpAnomalyStore((s) => s.anomalyCount);

  if (!hasAnomaly) return null;

  return (
    <button
      type="button"
      onClick={() =>
        void actionService.dispatch("app.settings.openTab", { tab: "mcp" }, { source: "user" })
      }
      className="flex items-center gap-1 min-w-0 shrink-0 text-status-warning transition-colors duration-150 ease-out hover:text-status-warning/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
      title="Open MCP audit log to review anomaly signals"
    >
      <TriangleAlert aria-hidden className="w-3 h-3 shrink-0" />
      <span className="truncate">
        {anomalyCount === 1 ? "1 anomaly signal" : `${anomalyCount} anomaly signals`}
      </span>
    </button>
  );
}
