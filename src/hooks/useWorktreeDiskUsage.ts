import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { WorktreeDiskUsageResult } from "@shared/types/ipc/worktreeDiskUsage";
import { worktreeDiskUsageClient } from "@/clients/worktreeDiskUsageClient";

/** A worktree's size as the overview shows it: still measuring, measured, or unknown. */
export type WorktreeDiskUsage = { status: "pending" } | WorktreeDiskUsageResult;

const PENDING: WorktreeDiskUsage = { status: "pending" };
const UNKNOWN: WorktreeDiskUsageResult = { status: "unknown" };

interface Session {
  id: string;
  /** Worktree id → the path its measurement was asked for. */
  requested: Map<string, string>;
}

interface Measured {
  path: string;
  result: WorktreeDiskUsageResult;
}

/**
 * Each worktree's size on disk, measured only while `isOpen`. Opening starts a
 * fresh pass; closing cancels it in main, which drops queued scans and kills
 * running ones, and forgets every figure, so the next opening measures again.
 *
 * A worktree is asked for once per opening, keyed by id and path: status
 * updates and filtering never re-measure, while a worktree added (or moved)
 * while the overview is open is measured on its own without restarting the
 * rest. Anything not answered yet reads as pending; a failed request reads as
 * unknown, never zero.
 */
export function useWorktreeDiskUsage(
  isOpen: boolean,
  worktrees: readonly { id: string; path: string }[]
): ReadonlyMap<string, WorktreeDiskUsage> {
  const sessionRef = useRef<Session | null>(null);
  const [measured, setMeasured] = useState<ReadonlyMap<string, Measured>>(() => new Map());

  useEffect(() => {
    if (!isOpen) return;
    const session: Session = { id: crypto.randomUUID(), requested: new Map() };
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
      setMeasured(new Map());
      void Promise.resolve()
        .then(() => worktreeDiskUsageClient.cancel({ sessionId: session.id }))
        .catch(() => {});
    };
  }, [isOpen]);

  const requestUnmeasured = useEffectEvent(() => {
    const session = sessionRef.current;
    if (!session) return;
    for (const { id, path } of worktrees) {
      if (session.requested.get(id) === path) continue;
      session.requested.set(id, path);
      void Promise.resolve()
        .then(() => worktreeDiskUsageClient.measure({ sessionId: session.id, worktreeId: id }))
        .catch((): WorktreeDiskUsageResult => UNKNOWN)
        .then((result) => {
          if (sessionRef.current !== session || session.requested.get(id) !== path) return;
          setMeasured((prev) => new Map(prev).set(id, { path, result }));
        });
    }
  });

  // Membership and paths only: a status update replaces every worktree object
  // without changing what there is to measure.
  const membership = worktrees.map((w) => `${w.id}\u0000${w.path}`).join("\n");
  useEffect(() => {
    if (isOpen) requestUnmeasured();
  }, [isOpen, membership]);

  return useMemo(() => {
    const usage = new Map<string, WorktreeDiskUsage>();
    for (const { id, path } of worktrees) {
      const entry = measured.get(id);
      usage.set(id, entry && entry.path === path ? entry.result : PENDING);
    }
    return usage;
  }, [worktrees, measured]);
}
