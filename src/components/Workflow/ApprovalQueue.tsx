import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";

interface PendingApproval {
  runId: string;
  nodeId: string;
  workflowId: string;
  workflowName: string;
  prompt: string;
  requestedAt: number;
  timeoutMs?: number;
  timeoutAt?: number;
}

export function ApprovalQueue() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<Set<string>>(new Set());

  useEffect(() => {
    void window.electron.workflow.listPendingApprovals().then((list) => {
      setApprovals(list);
    });
  }, []);

  useEffect(() => {
    const cleanupRequested = window.electron.workflow.onApprovalRequested((payload) => {
      setApprovals((prev) => {
        const key = `${payload.runId}::${payload.nodeId}`;
        const exists = prev.some((a) => `${a.runId}::${a.nodeId}` === key);
        if (exists) return prev;
        return [...prev, payload];
      });
    });

    const cleanupCleared = window.electron.workflow.onApprovalCleared((payload) => {
      const key = `${payload.runId}::${payload.nodeId}`;
      setApprovals((prev) => prev.filter((a) => `${a.runId}::${a.nodeId}` !== key));
      setFeedbackMap((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setSubmitting((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    });

    return () => {
      cleanupRequested();
      cleanupCleared();
    };
  }, []);

  const handleResolve = useCallback(
    async (approval: PendingApproval, approved: boolean) => {
      const key = `${approval.runId}::${approval.nodeId}`;
      setSubmitting((prev) => new Set(prev).add(key));
      try {
        await window.electron.workflow.resolveApproval({
          runId: approval.runId,
          nodeId: approval.nodeId,
          approved,
          feedback: feedbackMap[key] || undefined,
        });
      } catch {
        setSubmitting((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [feedbackMap]
  );

  if (approvals.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {approvals.map((approval) => (
        <ApprovalCard
          key={`${approval.runId}::${approval.nodeId}`}
          approval={approval}
          feedback={feedbackMap[`${approval.runId}::${approval.nodeId}`] ?? ""}
          onFeedbackChange={(val) =>
            setFeedbackMap((prev) => ({
              ...prev,
              [`${approval.runId}::${approval.nodeId}`]: val,
            }))
          }
          onApprove={() => handleResolve(approval, true)}
          onReject={() => handleResolve(approval, false)}
          isSubmitting={submitting.has(`${approval.runId}::${approval.nodeId}`)}
        />
      ))}
    </div>
  );
}

interface ApprovalCardProps {
  approval: PendingApproval;
  feedback: string;
  onFeedbackChange: (val: string) => void;
  onApprove: () => void;
  onReject: () => void;
  isSubmitting: boolean;
}

function ApprovalCard({
  approval,
  feedback,
  onFeedbackChange,
  onApprove,
  onReject,
  isSubmitting,
}: ApprovalCardProps) {
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (!approval.timeoutAt) return;

    const update = () => {
      const remaining = approval.timeoutAt! - Date.now();
      setTimeLeft(Math.max(0, remaining));
    };
    update();
    intervalRef.current = setInterval(update, 1000);
    return () => clearInterval(intervalRef.current);
  }, [approval.timeoutAt]);

  const formatTime = (ms: number) => {
    const seconds = Math.ceil(ms / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  return (
    <div className="rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-lg">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="text-xs font-medium text-neutral-400">{approval.workflowName}</span>
        {timeLeft !== null && (
          <span className="ml-auto flex items-center gap-1 text-xs text-neutral-500">
            <Clock className="h-3 w-3" />
            {formatTime(timeLeft)}
          </span>
        )}
      </div>

      <p className="mb-3 text-sm text-neutral-200">{approval.prompt}</p>

      <textarea
        className="mb-3 w-full rounded border border-neutral-700 bg-neutral-800 p-2 text-xs text-neutral-300 placeholder-neutral-500 focus:border-neutral-500 focus:outline-none"
        placeholder="Optional feedback..."
        rows={2}
        value={feedback}
        onChange={(e) => onFeedbackChange(e.target.value)}
        disabled={isSubmitting}
      />

      <div className="flex gap-2">
        <button
          className="flex flex-1 items-center justify-center gap-1.5 rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50"
          onClick={onApprove}
          disabled={isSubmitting}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Approve
        </button>
        <button
          className="flex flex-1 items-center justify-center gap-1.5 rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
          onClick={onReject}
          disabled={isSubmitting}
        >
          <XCircle className="h-3.5 w-3.5" />
          Reject
        </button>
      </div>
    </div>
  );
}
