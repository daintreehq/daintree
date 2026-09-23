import React, { useId, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { SeverityMark } from "@/lib/statusSeverity";
import { SettingsEmptyRow, SettingsGroup } from "./SettingsGroup";
import { type McpLogRecord, isAuditRecord } from "@shared/types";

interface McpAuditLatencyTableProps {
  records: McpLogRecord[];
  /**
   * Predicate applied before stats are computed — used by the Privacy
   * section to hide `external` MCP traffic, mirroring the row viewer.
   */
  includeRecord?: (record: McpLogRecord) => boolean;
}

interface ToolLatencyBlock {
  p50: number;
  p95: number;
  count: number;
}

interface ToolLatencyStats {
  toolId: string;
  success: ToolLatencyBlock;
  /**
   * Everything that didn't succeed — errors, but also dedup hits, pending
   * confirmations and rate limits, whose timings measure the gate, not the tool.
   */
  other: ToolLatencyBlock;
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

/** Speed band for a p95. Only "Slow" carries a mark; the rest is plain text. */
function sloBand(p95: number): { label: string; slow: boolean } | null {
  if (p95 <= 0) return null;
  if (p95 < 200) return { label: "Instant", slow: false };
  if (p95 < 1000) return { label: "Fast", slow: false };
  if (p95 <= 5000) return { label: "Standard", slow: false };
  return { label: "Slow", slow: true };
}

const TH = "py-1.5 font-medium text-text-secondary";
const TD_NUM = "py-1.5 text-right tabular-nums";

export function McpAuditLatencyTable({ records, includeRecord }: McpAuditLatencyTableProps) {
  const [isOpen, setIsOpen] = useState(true);
  const panelId = useId();

  const stats = useMemo<ToolLatencyStats[]>(() => {
    const successBuckets = new Map<string, number[]>();
    const otherBuckets = new Map<string, number[]>();
    for (const record of records) {
      // Grant-lifecycle records have no `result`/`durationMs`; skip them
      // — the latency table is a dispatch-only surface.
      if (!isAuditRecord(record)) continue;
      if (includeRecord && !includeRecord(record)) continue;
      const map = record.result === "success" ? successBuckets : otherBuckets;
      const list = map.get(record.toolId);
      if (list) list.push(record.durationMs);
      else map.set(record.toolId, [record.durationMs]);
    }
    const allToolIds = new Set([...successBuckets.keys(), ...otherBuckets.keys()]);
    const out: ToolLatencyStats[] = [];
    for (const toolId of allToolIds) {
      out.push({
        toolId,
        success: computeBlock(successBuckets.get(toolId) ?? []),
        other: computeBlock(otherBuckets.get(toolId) ?? []),
      });
    }
    out.sort((a, b) => Math.max(b.success.p95, b.other.p95) - Math.max(a.success.p95, a.other.p95));
    return out;
  }, [records, includeRecord]);

  const hasRecords = stats.length > 0;

  const renderBlock = (block: ToolLatencyBlock, blockLabel: string) => {
    if (block.count === 0) return null;
    const band = sloBand(block.p95);
    return (
      <tr className="text-text-secondary">
        <th scope="row" className="py-1.5 pl-4 pr-2 text-left font-normal">
          {blockLabel}
        </th>
        <td className={cn(TD_NUM, "px-2")}>{block.count}</td>
        <td className={cn(TD_NUM, "px-2")}>{block.p50}</td>
        <td className={cn(TD_NUM, "px-2 text-text-primary")}>{block.p95}</td>
        <td className="py-1.5 pl-2">
          {band && (
            <span className="inline-flex items-center gap-1">
              {band.slow && (
                <SeverityMark severity="warning" label="Slow" className="h-3 w-3" decorative />
              )}
              {band.label}
            </span>
          )}
        </td>
      </tr>
    );
  };

  return (
    <SettingsGroup>
      <div>
        <button
          type="button"
          onClick={() => setIsOpen((v) => !v)}
          aria-expanded={isOpen}
          aria-controls={panelId}
          className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-text-primary hover:bg-overlay-soft transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
        >
          <ChevronRight
            data-animated-chevron
            aria-hidden="true"
            className={cn(
              "w-3.5 h-3.5 shrink-0 text-text-secondary transition-transform duration-150",
              isOpen && "rotate-90"
            )}
          />
          <span className="flex-1">Latency by tool</span>
          {hasRecords && (
            <span className="text-xs font-normal text-text-secondary">
              {stats.length === 1 ? "1 tool" : `${stats.length} tools`}
            </span>
          )}
        </button>
        {isOpen && hasRecords && (
          <div id={panelId} className="px-4 pb-3 pl-9">
            <table className="w-full table-fixed text-xs">
              <caption className="sr-only">Latency by tool, in milliseconds</caption>
              <thead>
                <tr className="border-b border-border-subtle">
                  <th scope="col" className={cn(TH, "text-left pr-2")}>
                    Tool
                  </th>
                  <th scope="col" className={cn(TH, "text-right px-2 w-16")}>
                    Calls
                  </th>
                  <th scope="col" className={cn(TH, "text-right px-2 w-20")}>
                    p50 (ms)
                  </th>
                  <th scope="col" className={cn(TH, "text-right px-2 w-20")}>
                    p95 (ms)
                  </th>
                  <th scope="col" className={cn(TH, "text-left pl-2 w-24")}>
                    <span className="sr-only">Speed</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {stats.map((row) => (
                  <React.Fragment key={row.toolId}>
                    <tr>
                      <th
                        scope="row"
                        className="py-1.5 pr-2 text-left font-mono font-normal text-text-primary truncate"
                      >
                        {row.toolId}
                      </th>
                      <td className={cn(TD_NUM, "px-2 text-text-primary")}>
                        {row.success.count + row.other.count}
                      </td>
                      <td />
                      <td />
                      <td />
                    </tr>
                    {renderBlock(row.success, "Success")}
                    {renderBlock(row.other, "Other results")}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {isOpen && !hasRecords && (
        <SettingsEmptyRow>Timings show up here once the assistant calls a tool</SettingsEmptyRow>
      )}
    </SettingsGroup>
  );
}
