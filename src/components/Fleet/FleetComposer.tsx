import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetComposerStore } from "@/store/fleetComposerStore";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useNotificationStore } from "@/store/notificationStore";
import { useProjectStore } from "@/store/projectStore";
import { logWarn } from "@/utils/logger";
import {
  getFleetBroadcastHistoryKey,
  getFleetBroadcastWarnings,
  needsFleetBroadcastConfirmation,
  resolveFleetBroadcastTargetIds,
} from "./fleetBroadcast";
import { executeFleetBroadcast } from "./fleetExecution";
import { FleetDryRunDialog } from "./FleetDryRunDialog";
import { registerFleetComposerFocusHandler } from "./fleetComposerFocus";

interface WarningReason {
  key: "destructive" | "overByteLimit" | "multiline";
  label: string;
}

/** Default threshold for quorum confirmation (number of targets). */
const DEFAULT_QUORUM_THRESHOLD = 5;

function getQuorumThreshold(): number {
  try {
    return useFleetComposerStore.getState().quorumThreshold;
  } catch {
    return DEFAULT_QUORUM_THRESHOLD;
  }
}

function describeWarnings(text: string): WarningReason[] {
  const w = getFleetBroadcastWarnings(text);
  const reasons: WarningReason[] = [];
  if (w.destructive) reasons.push({ key: "destructive", label: "destructive command detected" });
  if (w.overByteLimit) reasons.push({ key: "overByteLimit", label: "payload exceeds 512 bytes" });
  if (w.multiline) reasons.push({ key: "multiline", label: "multi-line payload" });
  return reasons;
}

export function FleetComposer(): ReactElement | null {
  const armedCount = useFleetArmingStore((s) => s.armedIds.size);
  const { draft, setDraft, clearDraft } = useFleetComposerStore(
    useShallow((s) => ({
      draft: s.draft,
      setDraft: s.setDraft,
      clearDraft: s.clearDraft,
    }))
  );

  const dryRunRequested = useFleetComposerStore((s) => s.dryRunRequested);
  const clearDryRunRequest = useFleetComposerStore((s) => s.clearDryRunRequest);
  const projectId = useProjectStore((s) => s.currentProject?.id);

  const historyKey = getFleetBroadcastHistoryKey(projectId);

  const lastFailedIds = useFleetComposerStore((s) => s.lastFailedIds);
  const setLastFailed = useFleetComposerStore((s) => s.setLastFailed);
  const clearLastFailed = useFleetComposerStore((s) => s.clearLastFailed);

  const historyEntries = useCommandHistoryStore(useShallow((s) => s.getProjectHistory(historyKey)));

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const historySnapshotRef = useRef<string>("");
  const submittingRef = useRef<boolean>(false);

  const [isConfirming, setIsConfirming] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isDryRunOpen, setIsDryRunOpen] = useState(false);

  useEffect(() => {
    const unregister = registerFleetComposerFocusHandler(() => {
      textareaRef.current?.focus();
    });
    return () => {
      unregister();
    };
  }, []);

  useEffect(() => {
    if (isConfirming) {
      cancelButtonRef.current?.focus();
    }
  }, [isConfirming]);

  useEffect(() => {
    if (dryRunRequested && draft.trim().length > 0) {
      clearDryRunRequest();
      setIsDryRunOpen(true);
    } else if (dryRunRequested) {
      clearDryRunRequest();
    }
  }, [dryRunRequested, draft, clearDryRunRequest]);

  const warningReasons = useMemo(() => describeWarnings(draft), [draft]);

  const handleSubmit = useCallback(
    async (options: { force?: boolean; targetIds?: string[] } = {}) => {
      const { force = false, targetIds } = options;
      if (submittingRef.current) return;

      const currentDraft = useFleetComposerStore.getState().draft;
      if (currentDraft.trim() === "") return;

      // alwaysPreview: when enabled, Enter opens the dry-run dialog instead of sending directly.
      if (!force && !isConfirming && useFleetComposerStore.getState().alwaysPreview) {
        setIsDryRunOpen(true);
        return;
      }

      // Quorum confirmation: when >=N targets, require explicit confirmation
      // even if the payload itself isn't flagged as dangerous.
      const resolvedTargetIds = targetIds ?? resolveFleetBroadcastTargetIds();
      if (
        !force &&
        !isConfirming &&
        resolvedTargetIds.length >= getQuorumThreshold() &&
        !needsFleetBroadcastConfirmation(currentDraft)
      ) {
        setIsConfirming(true);
        return;
      }

      if (!force && needsFleetBroadcastConfirmation(currentDraft)) {
        setIsConfirming(true);
        return;
      }

      submittingRef.current = true;
      setIsConfirming(false);
      setIsSubmitting(true);

      try {
        const actualTargetIds = targetIds ?? resolveFleetBroadcastTargetIds();
        if (actualTargetIds.length === 0) {
          useNotificationStore.getState().addNotification({
            type: "warning",
            priority: "low",
            message: "No armed agents available to send to",
          });
          return;
        }

        const result = await executeFleetBroadcast(currentDraft, actualTargetIds);

        if (result.failureCount > 0) {
          logWarn("[FleetComposer] broadcast submit had rejections", {
            failureCount: result.failureCount,
            failedIds: result.failedIds,
          });
          setLastFailed(result.failedIds, currentDraft);
        } else {
          clearLastFailed();
        }

        useNotificationStore.getState().addNotification({
          type: result.successCount > 0 ? "success" : "warning",
          priority: "low",
          message:
            result.failureCount > 0
              ? `Sent to ${result.successCount} agent${result.successCount === 1 ? "" : "s"} (${result.failureCount} failed)`
              : `Sent to ${result.successCount} agent${result.successCount === 1 ? "" : "s"}`,
          actions:
            result.failureCount > 0
              ? [
                  {
                    label: "Retry failed",
                    onClick: () => {
                      const failed = useFleetComposerStore.getState().lastFailedIds;
                      if (failed.length === 0) return;
                      useFleetArmingStore.getState().armIds(failed);
                      if (useFleetComposerStore.getState().draft.trim() === "") {
                        const lastPrompt = useFleetComposerStore.getState().lastBroadcastPrompt;
                        useFleetComposerStore.getState().setDraft(lastPrompt);
                      }
                    },
                    variant: "primary" as const,
                  },
                ]
              : undefined,
        });

        if (result.successCount > 0) {
          const armedIds = Array.from(useFleetArmingStore.getState().armedIds);
          useCommandHistoryStore
            .getState()
            .recordPrompt(historyKey, currentDraft, null, { armedIds });
          if (useFleetComposerStore.getState().draft === currentDraft) {
            clearDraft();
          }
          setHistoryIndex(-1);
          historySnapshotRef.current = "";
        }
      } catch (e) {
        useNotificationStore.getState().addNotification({
          type: "error",
          priority: "high",
          message: "Broadcast failed unexpectedly",
        });
        throw e;
      } finally {
        submittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [clearDraft, clearLastFailed, historyKey, isConfirming, setLastFailed]
  );

  const handleRetryFailed = useCallback(() => {
    const failed = useFleetComposerStore.getState().lastFailedIds;
    if (failed.length === 0) return;
    useFleetArmingStore.getState().armIds(failed);
    if (draft.trim() === "") {
      const lastPrompt = useFleetComposerStore.getState().lastBroadcastPrompt;
      if (lastPrompt) setDraft(lastPrompt);
    }
  }, [draft, setDraft]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;

      if (e.key === "Escape") {
        if (isDryRunOpen) {
          e.preventDefault();
          e.stopPropagation();
          setIsDryRunOpen(false);
          return;
        }
        if (draft.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          clearDraft();
          setHistoryIndex(-1);
          historySnapshotRef.current = "";
        }
        return;
      }

      if (e.key === "Enter") {
        // Cmd/Ctrl+Shift+Enter → dry-run preview (check before shift passthrough)
        if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
          e.preventDefault();
          if (draft.trim().length > 0) {
            setIsDryRunOpen(true);
          }
          return;
        }
        if (e.shiftKey) return; // newline passthrough
        e.preventDefault();
        const force = e.metaKey || e.ctrlKey;
        void handleSubmit({ force });
        return;
      }

      if (e.key === "ArrowUp") {
        if (historyEntries.length === 0) return;
        const target = e.currentTarget;
        if (historyIndex === -1 && (target.selectionStart !== 0 || target.selectionEnd !== 0))
          return;
        e.preventDefault();
        if (historyIndex === -1) {
          historySnapshotRef.current = draft;
        }
        const next = Math.min(historyIndex + 1, historyEntries.length - 1);
        setHistoryIndex(next);
        const entry = historyEntries[next]!;
        setDraft(entry.prompt);
        // Shift+ArrowUp: also recall the armed IDs from this history entry
        if (e.shiftKey && entry.armedIds && entry.armedIds.length > 0) {
          useFleetArmingStore.getState().armIds(entry.armedIds);
        }
        return;
      }

      if (e.key === "ArrowDown") {
        if (historyIndex < 0) return;
        e.preventDefault();
        const next = historyIndex - 1;
        setHistoryIndex(next);
        if (next < 0) {
          setDraft(historySnapshotRef.current);
          historySnapshotRef.current = "";
        } else {
          setDraft(historyEntries[next]!.prompt);
        }
      }
    },
    [clearDraft, draft, handleSubmit, historyEntries, historyIndex, isDryRunOpen, setDraft]
  );

  const handleConfirmStripKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setIsConfirming(false);
      textareaRef.current?.focus();
    }
  }, []);

  const handleDryRunSend = useCallback(
    (failedIds?: string[]) => {
      setIsDryRunOpen(false);
      if (failedIds && failedIds.length > 0) {
        const currentDraft =
          useFleetComposerStore.getState().draft ||
          useFleetComposerStore.getState().lastBroadcastPrompt;
        setLastFailed(failedIds, currentDraft);
      }
    },
    [setLastFailed]
  );

  if (armedCount === 0) return null;

  const sendLabel = isSubmitting ? "Sending…" : "Send";
  const placeholderBase =
    armedCount === 1
      ? "Broadcast to 1 armed agent (Enter to send)"
      : `Broadcast to ${armedCount} armed agents (Enter to send)`;

  return (
    <>
      <div
        className="flex flex-col gap-1 border-b border-daintree-accent/40 bg-daintree-accent/5 px-3 py-1.5"
        data-testid="fleet-composer"
      >
        <div className="flex items-start gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (historyIndex !== -1) {
                setHistoryIndex(-1);
                historySnapshotRef.current = "";
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholderBase}
            rows={1}
            inert={isConfirming ? true : undefined}
            aria-label="Broadcast to armed agents"
            data-testid="fleet-composer-textarea"
            className={cn(
              "flex-1 resize-none rounded-[var(--radius-md)] border border-daintree-border bg-daintree-sidebar px-2 py-1 text-[12px] text-daintree-text",
              "placeholder:italic placeholder:text-daintree-text/40",
              "focus:border-daintree-accent focus:outline-none focus:ring-1 focus:ring-daintree-accent/30",
              "min-h-[28px] max-h-[140px] overflow-y-auto"
            )}
          />
          <div className="flex shrink-0 flex-col gap-1">
            <button
              type="button"
              onClick={() => void handleSubmit({ force: false })}
              disabled={draft.trim().length === 0 || isSubmitting}
              data-testid="fleet-composer-send"
              className="rounded-[var(--radius-md)] bg-daintree-accent px-2.5 py-1 text-[11px] text-text-inverse transition-colors hover:bg-daintree-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send broadcast"
            >
              {sendLabel}
            </button>
            {lastFailedIds.length > 0 && !isSubmitting && (
              <button
                type="button"
                onClick={handleRetryFailed}
                data-testid="fleet-composer-retry-failed"
                className="rounded-[var(--radius-md)] bg-amber-500/20 px-2.5 py-1 text-[11px] text-amber-100 transition-colors hover:bg-amber-500/30"
              >
                Retry failed
              </button>
            )}
          </div>
        </div>
        {isConfirming && (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="fleet-composer-confirm"
            onKeyDown={handleConfirmStripKeyDown}
            className="flex items-center gap-2 rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200"
          >
            <span className="flex-1">
              Send to {armedCount} agent{armedCount === 1 ? "" : "s"} —{" "}
              {warningReasons.map((r) => r.label).join(", ")}?
            </span>
            <button
              type="button"
              ref={cancelButtonRef}
              onClick={() => {
                setIsConfirming(false);
                textareaRef.current?.focus();
              }}
              data-testid="fleet-composer-confirm-cancel"
              className="rounded-[var(--radius-md)] px-2 py-0.5 text-daintree-text/70 transition-colors hover:bg-tint/[0.08] hover:text-daintree-text"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => void handleSubmit({ force: true })}
              data-testid="fleet-composer-confirm-send"
              className="rounded-[var(--radius-md)] bg-amber-500/20 px-2 py-0.5 text-amber-100 transition-colors hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send anyway
            </button>
          </div>
        )}
      </div>
      {isDryRunOpen && (
        <FleetDryRunDialog
          draft={draft}
          onSend={handleDryRunSend}
          onClose={() => setIsDryRunOpen(false)}
        />
      )}
    </>
  );
}
