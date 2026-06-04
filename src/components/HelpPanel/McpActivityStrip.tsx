import { useCallback, useEffect, useRef, useState } from "react";
import { Activity } from "@/components/icons";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { logWarn } from "@/utils/logger";
import type { McpAuditRecord } from "@shared/types";
import { RecentCallsPopover } from "./RecentCallsPopover";

const MAX_RECENT_CALLS = 20;

interface McpActivityStripProps {
  /** Current assistant session. Empty/null means hibernated — strip is hidden. */
  sessionId: string | null;
  onOpenSettings: () => void;
}

export function McpActivityStrip({ sessionId, onOpenSettings }: McpActivityStripProps) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<McpAuditRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Monotonic token: discard any fetch that resolves after a newer open/session
  // change so a slow response can't overwrite fresher state.
  const fetchSeq = useRef(0);

  // A session change invalidates the open popover — its calls belong to the old
  // session. Close it, drop the stale list, and bump the fetch token so any
  // in-flight request from the previous session can't land its results.
  useEffect(() => {
    fetchSeq.current++;
    setOpen(false);
    setRecords([]);
    setLoading(false);
    setError(false);
  }, [sessionId]);

  useEffect(() => {
    if (!open || !sessionId) return;

    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(false);

    void (async () => {
      try {
        const all = await window.electron.mcpServer.getAuditRecords();
        if (fetchSeq.current !== seq) return;
        const mine = all.filter((r) => r.sessionId === sessionId).slice(0, MAX_RECENT_CALLS);
        setRecords(mine);
        setLoading(false);
      } catch (err) {
        if (fetchSeq.current !== seq) return;
        logWarn("[McpActivityStrip] Failed to load audit records", { error: err });
        setError(true);
        setLoading(false);
      }
    })();
  }, [open, sessionId]);

  const handleViewFullAuditLog = useCallback(() => {
    setOpen(false);
    onOpenSettings();
  }, [onOpenSettings]);

  if (!sessionId) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 hover:text-daintree-text/60 transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
        >
          <Activity className="w-3.5 h-3.5 shrink-0" />
          Recent activity
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        aria-label="Recent tool calls"
        className="w-72"
      >
        <RecentCallsPopover
          records={records}
          loading={loading}
          error={error}
          onViewFullAuditLog={handleViewFullAuditLog}
        />
      </PopoverContent>
    </Popover>
  );
}
