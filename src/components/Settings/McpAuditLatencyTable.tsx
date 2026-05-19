import React, { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { McpAuditRecord } from "@shared/types";

interface McpAuditLatencyTableProps {
  records: McpAuditRecord[];
  /**
   * Predicate applied before stats are computed — used by the Privacy
   * section to hide `external` MCP traffic, mirroring the row viewer.
   */
  includeRecord?: (record: McpAuditRecord) => boolean;
}

interface ToolLatencyBlock {
  p50: number;
  p95: number;
  count: number;
}

interface ToolLatencyStats {
  toolId: string;
  success: ToolLatencyBlock;
  failed: ToolLatencyBlock;
}

interface SloBand {
  label: string;
  className: string;
}

/**
 * Linear-interpolation percentile. For sample sets of 1, returns the value
 * verbatim. Caller passes an ascending-sorted, non-empty array.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = p * (sortedAsc.length - 1);
  const k = Math.floor(rank);
  const f = rank - k;
  const lower = sortedAsc[k]!;
  const upper = sortedAsc[k + 1] ?? lower;
  return lower + f * (upper - lower);
}

function computeBlock(durations: number[]): ToolLatencyBlock {
  if (durations.length === 0) return { p50: 0, p95: 0, count: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    p50: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    count: sorted.length,
  };
}

function sloBand(p95: number): SloBand {
  if (p95 <= 0) return { label: "", className: "" };
  if (p95 < 200) return { label: "Instant", className: "text-status-success" };
  if (p95 < 1000) return { label: "Fast", className: "text-status-success" };
  if (p95 <= 5000) return { label: "Standard", className: "text-status-warning" };
  return { label: "Slow", className: "text-status-danger" };
}

export function McpAuditLatencyTable({ records, includeRecord }: McpAuditLatencyTableProps) {
  const [isOpen, setIsOpen] = useState(true);

  const stats = useMemo<ToolLatencyStats[]>(() => {
    const successBuckets = new Map<string, number[]>();
    const failedBuckets = new Map<string, number[]>();
    for (const record of records) {
      if (includeRecord && !includeRecord(record)) continue;
      const map = record.result === "success" ? successBuckets : failedBuckets;
      const list = map.get(record.toolId);
      if (list) list.push(record.durationMs);
      else map.set(record.toolId, [record.durationMs]);
    }
    const allToolIds = new Set([...successBuckets.keys(), ...failedBuckets.keys()]);
    const out: ToolLatencyStats[] = [];
    for (const toolId of allToolIds) {
      out.push({
        toolId,
        success: computeBlock(successBuckets.get(toolId) ?? []),
        failed: computeBlock(failedBuckets.get(toolId) ?? []),
      });
    }
    out.sort(
      (a, b) => Math.max(b.success.p95, b.failed.p95) - Math.max(a.success.p95, a.failed.p95)
    );
    return out;
  }, [records, includeRecord]);

  const hasRecords = stats.length > 0;

  const renderBlock = (block: ToolLatencyBlock, blockLabel: string) => {
    if (block.count === 0) return null;
    const band = sloBand(block.p95);
    return (
      <tr className="text-daintree-text/70">
        <td className="py-1 pl-6 pr-2 text-[10px] text-daintree-text/50 truncate">{blockLabel}</td>
        <td className="py-1 px-2 text-right text-daintree-text/50 tabular-nums">{block.count}</td>
        <td className="py-1 px-2 text-right tabular-nums">{block.p50}ms</td>
        <td className="py-1 pl-2 text-right tabular-nums">
          {block.p95}ms
          {band.label && (
            <span className={cn("ml-1.5 text-[10px]", band.className)}>{band.label}</span>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="rounded-[var(--radius-md)] border border-daintree-border bg-overlay-subtle/40">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
        className={cn(
          "w-full flex items-center justify-between gap-3 px-3 py-2 text-xs",
          "text-daintree-text/80 hover:text-daintree-text transition-colors"
        )}
      >
        <span className="flex items-center gap-2">
          <ChevronRight
            className={cn(
              "w-3.5 h-3.5 transition-transform duration-150",
              isOpen ? "rotate-90" : "rotate-0"
            )}
          />
          <span>
            Latency by tool
            {hasRecords && <span className="text-daintree-text/50"> ({stats.length} tools)</span>}
          </span>
        </span>
      </button>
      {isOpen && (
        <div className="px-3 pb-3 pt-1">
          {!hasRecords ? (
            <p className="text-xs text-daintree-text/50">No dispatches recorded yet.</p>
          ) : (
            <table className="w-full table-fixed text-xs font-mono tabular-nums">
              <thead>
                <tr className="text-daintree-text/50">
                  <th className="text-left font-medium py-1 pr-2 truncate">Tool</th>
                  <th className="text-right font-medium py-1 px-2 w-12">n</th>
                  <th className="text-right font-medium py-1 px-2 w-18">p50</th>
                  <th className="text-right font-medium py-1 pl-2 w-30">p95</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-daintree-border/50">
                {stats.map((row) => (
                  <React.Fragment key={row.toolId}>
                    <tr className="text-daintree-text/80">
                      <td className="py-1 pr-2 truncate font-medium">{row.toolId}</td>
                      <td className="py-1 px-2 text-right text-daintree-text/60 tabular-nums">
                        {row.success.count + row.failed.count}
                      </td>
                      <td />
                      <td />
                    </tr>
                    {renderBlock(row.success, "success")}
                    {renderBlock(row.failed, "failed")}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
