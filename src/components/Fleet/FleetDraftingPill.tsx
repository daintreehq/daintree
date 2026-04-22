import { useCallback, useMemo, useState, type ReactElement } from "react";
import { RadioTower, AlertTriangle, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { useNotificationStore } from "@/store/notificationStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { logWarn } from "@/utils/logger";
import {
  buildFleetTargetPreviews,
  executeFleetBroadcast,
  type FleetTargetPreview,
} from "./fleetExecution";
import { getFleetBroadcastWarnings, resolveFleetBroadcastTargetIds } from "./fleetBroadcast";

interface FleetDraftingPillProps {
  /** The primary armed terminal (the one this pill is attached to). */
  terminalId: string;
  /** Current draft text in the editor — kept in sync via mirror effect. */
  draft: string;
  /** Optional project id used to scope draft cleanup after a broadcast. */
  projectId: string | undefined;
  /**
   * Reset the editor's local doc after a successful broadcast. The pill
   * uses `clearDraftInput` to wipe persisted state, but the editor's
   * CodeMirror doc is owned by the parent and must be cleared explicitly
   * to keep them in sync.
   */
  onResetEditor: () => void;
}

/**
 * Visible affordance for "this draft is mirrored to N peers" plus an
 * explicit "Send to all" button. Without this, hybrid-input mirroring is
 * silent — users have no signal that their composition is appearing in
 * other panes' input bars, and submitting on Enter only fires the primary
 * pane (followers' bars clear via the mirror effect when primary's draft
 * goes empty). The button surfaces existing infrastructure
 * (`buildFleetTargetPreviews`, `executeFleetBroadcast`) so the user can
 * fan out the draft as one atomic action with per-target recipe-variable
 * resolution.
 *
 * Submission gating mirrors the paste path: destructive-regex / multi-line
 * / over-byte-limit payloads, OR any target with unresolved {{variables}},
 * trigger an inline confirmation before sending.
 */
export function FleetDraftingPill({
  terminalId,
  draft,
  projectId,
  onResetEditor,
}: FleetDraftingPillProps): ReactElement | null {
  const armedIds = useFleetArmingStore((s) => s.armedIds);
  const armOrder = useFleetArmingStore((s) => s.armOrder);
  const fleetSize = armedIds.size;
  const peerCount = fleetSize - 1;
  const clearDraftInput = useTerminalInputStore((s) => s.clearDraftInput);

  const [open, setOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<
    | { kind: "idle" }
    | {
        kind: "pending";
        previews: FleetTargetPreview[];
        unresolvedTargets: FleetTargetPreview[];
        warningReasons: string[];
      }
  >({ kind: "idle" });
  const [isSending, setIsSending] = useState(false);

  const previews = useMemo(() => buildFleetTargetPreviews(draft), [draft]);

  const trimmedDraft = draft.trim();
  const hasDraft = trimmedDraft.length > 0;

  const broadcastNow = useCallback(
    async (targets: string[]) => {
      if (targets.length === 0) return;
      setIsSending(true);
      try {
        const result = await executeFleetBroadcast(draft, targets);
        if (result.failureCount > 0) {
          logWarn("[FleetDraftingPill] fleet broadcast had rejections", {
            failureCount: result.failureCount,
            failedIds: result.failedIds,
          });
          useFleetFailureStore.getState().recordFailure(draft, result.failedIds);
        } else {
          // Successful broadcast clears stale failure dots on the targets we
          // just hit — same retry-clears-stale invariant as in the ribbon.
          for (const id of targets) useFleetFailureStore.getState().dismissId(id);
        }
        useNotificationStore.getState().addNotification({
          type: result.failureCount === 0 ? "success" : "warning",
          priority: "low",
          message:
            result.failureCount === 0
              ? `Sent to ${result.successCount} agent${result.successCount === 1 ? "" : "s"}`
              : `Sent to ${result.successCount} agent${result.successCount === 1 ? "" : "s"} (${result.failureCount} failed)`,
        });
        // Reset both the persisted draft and the local editor doc on
        // success. Followers' bars clear automatically via the mirror
        // effect when our draft becomes empty.
        clearDraftInput(terminalId, projectId);
        onResetEditor();
      } finally {
        setIsSending(false);
        setConfirmState({ kind: "idle" });
        setOpen(false);
      }
    },
    [clearDraftInput, draft, onResetEditor, projectId, terminalId]
  );

  const handleSendAll = useCallback(() => {
    if (!hasDraft || isSending) return;

    const targets = resolveFleetBroadcastTargetIds();
    if (targets.length === 0) return;

    const unresolvedTargets = previews.filter((p) => !p.excluded && p.unresolvedVars.length > 0);
    const warnings = getFleetBroadcastWarnings(draft);
    const warningReasons: string[] = [];
    if (warnings.destructive) warningReasons.push("destructive command detected");
    if (warnings.overByteLimit) warningReasons.push("payload exceeds 512 bytes");
    if (warnings.multiline) warningReasons.push("multi-line payload");

    if (unresolvedTargets.length > 0 || warningReasons.length > 0) {
      setConfirmState({
        kind: "pending",
        previews,
        unresolvedTargets,
        warningReasons,
      });
      setOpen(true);
      return;
    }

    void broadcastNow(targets);
  }, [broadcastNow, draft, hasDraft, isSending, previews]);

  const sendOnlyResolved = useCallback(() => {
    if (confirmState.kind !== "pending") return;
    const skipIds = new Set(confirmState.unresolvedTargets.map((t) => t.terminalId));
    const targets = resolveFleetBroadcastTargetIds().filter((id) => !skipIds.has(id));
    void broadcastNow(targets);
  }, [broadcastNow, confirmState]);

  const sendAnyway = useCallback(() => {
    if (confirmState.kind !== "pending") return;
    void broadcastNow(resolveFleetBroadcastTargetIds());
  }, [broadcastNow, confirmState]);

  const cancelConfirm = useCallback(() => {
    setConfirmState({ kind: "idle" });
  }, []);

  // Hide the pill entirely on a 1-pane fleet — there's no peer to fan out
  // to, so the affordance would be misleading.
  if (peerCount < 1) return null;

  return (
    <div data-testid="fleet-drafting-pill" className="mb-1.5 flex items-center gap-1.5 text-[11px]">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Drafting for ${fleetSize} agents — show per-target preview`}
            data-testid="fleet-drafting-pill-trigger"
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors",
              "bg-category-amber-subtle text-category-amber-text",
              "hover:bg-amber-500/20"
            )}
          >
            <RadioTower className="h-3 w-3" aria-hidden="true" />
            <span>
              Mirroring to {peerCount} {peerCount === 1 ? "peer" : "peers"}
            </span>
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={6}
          className="max-h-[360px] w-[420px] overflow-y-auto p-2"
          data-testid="fleet-drafting-pill-popover"
        >
          {confirmState.kind === "pending" ? (
            <ConfirmPanel
              previews={confirmState.previews}
              unresolvedTargets={confirmState.unresolvedTargets}
              warningReasons={confirmState.warningReasons}
              isSending={isSending}
              onSendAnyway={sendAnyway}
              onSendOnlyResolved={sendOnlyResolved}
              onCancel={cancelConfirm}
            />
          ) : (
            <PreviewPanel previews={previews} armOrder={armOrder} />
          )}
        </PopoverContent>
      </Popover>

      <button
        type="button"
        disabled={!hasDraft || isSending}
        onClick={handleSendAll}
        aria-label={`Send draft to all ${fleetSize} agents at once`}
        data-testid="fleet-drafting-pill-send-all"
        className={cn(
          "inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors",
          "bg-tint/[0.10] text-daintree-text/80 hover:bg-tint/[0.18] hover:text-daintree-text",
          "disabled:cursor-not-allowed disabled:opacity-50"
        )}
      >
        Send to all
      </button>

      <span className="text-daintree-text/50">Enter sends here only</span>
    </div>
  );
}

interface PreviewPanelProps {
  previews: FleetTargetPreview[];
  armOrder: string[];
}

function PreviewPanel({ previews, armOrder }: PreviewPanelProps): ReactElement {
  // Re-sort previews by armOrder so the popover matches the ribbon's count
  // chip ordering (most-recently-added at the bottom).
  const ordered = useMemo(() => {
    const byId = new Map(previews.map((p) => [p.terminalId, p]));
    const out: FleetTargetPreview[] = [];
    for (const id of armOrder) {
      const p = byId.get(id);
      if (p) out.push(p);
    }
    return out;
  }, [armOrder, previews]);

  if (ordered.length === 0) {
    return <div className="px-2 py-1 text-[12px] text-daintree-text/60">No armed agents</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-daintree-text/50">
        Per-target preview
      </div>
      <ul className="flex flex-col gap-1.5">
        {ordered.map((p) => (
          <li
            key={p.terminalId}
            className="flex flex-col gap-0.5 rounded border border-daintree-border/60 bg-tint/[0.04] px-2 py-1.5"
            data-testid={`fleet-target-preview-${p.terminalId}`}
          >
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate font-medium text-daintree-text">{p.title}</span>
              {p.excluded ? (
                <span className="shrink-0 rounded bg-tint/[0.08] px-1 py-0.5 text-[10px] text-daintree-text/60">
                  Skipped — {p.exclusionReason ?? "ineligible"}
                </span>
              ) : p.unresolvedVars.length > 0 ? (
                <span className="shrink-0 inline-flex items-center gap-1 rounded bg-status-warning/15 px-1 py-0.5 text-[10px] text-status-warning">
                  <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
                  {p.unresolvedVars.length} unresolved
                </span>
              ) : null}
            </div>
            {!p.excluded && (
              <pre className="max-h-[80px] overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-tight text-daintree-text/80">
                {p.resolvedPayload || <span className="italic text-daintree-text/40">(empty)</span>}
              </pre>
            )}
            {p.unresolvedVars.length > 0 && (
              <div className="text-[10px] text-status-warning/85">
                Missing: {p.unresolvedVars.map((v) => `{{${v}}}`).join(", ")}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ConfirmPanelProps {
  previews: FleetTargetPreview[];
  unresolvedTargets: FleetTargetPreview[];
  warningReasons: string[];
  isSending: boolean;
  onSendAnyway: () => void;
  onSendOnlyResolved: () => void;
  onCancel: () => void;
}

function ConfirmPanel({
  previews,
  unresolvedTargets,
  warningReasons,
  isSending,
  onSendAnyway,
  onSendOnlyResolved,
  onCancel,
}: ConfirmPanelProps): ReactElement {
  const total = previews.filter((p) => !p.excluded).length;
  const skipCount = unresolvedTargets.length;
  const validCount = total - skipCount;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-daintree-accent">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        Review before fan-out
      </div>

      {warningReasons.length > 0 && (
        <div className="rounded bg-status-warning/10 px-2 py-1 text-[11px] text-status-warning">
          Payload flagged: {warningReasons.join(", ")}
        </div>
      )}

      {skipCount > 0 && (
        <div className="rounded bg-status-warning/10 px-2 py-1 text-[11px] text-daintree-text">
          <div className="font-medium">
            {skipCount} of {total} {total === 1 ? "agent has" : "agents have"} unresolved variables
          </div>
          <ul className="mt-1 flex flex-col gap-0.5 text-[10px] text-daintree-text/80">
            {unresolvedTargets.map((t) => (
              <li
                key={t.terminalId}
                className="flex items-center justify-between gap-2"
                data-testid={`fleet-confirm-unresolved-${t.terminalId}`}
              >
                <span className="truncate">{t.title}</span>
                <span className="shrink-0 font-mono text-status-warning">
                  {t.unresolvedVars.map((v) => `{{${v}}}`).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {skipCount > 0 && validCount > 0 && (
          <button
            type="button"
            disabled={isSending}
            onClick={onSendOnlyResolved}
            data-testid="fleet-confirm-send-resolved"
            className={cn(
              "rounded bg-tint/[0.14] px-2 py-1 text-[11px] text-daintree-text",
              "hover:bg-tint/[0.22] disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            Send to {validCount} ({skipCount} skipped)
          </button>
        )}
        <button
          type="button"
          disabled={isSending}
          onClick={onSendAnyway}
          data-testid="fleet-confirm-send-anyway"
          className={cn(
            "rounded bg-status-warning/20 px-2 py-1 text-[11px] text-status-warning",
            "hover:bg-status-warning/30 disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        >
          Send to all {total} anyway
        </button>
        <button
          type="button"
          onClick={onCancel}
          data-testid="fleet-confirm-cancel"
          className="ml-auto rounded px-2 py-1 text-[11px] text-daintree-text/70 hover:bg-tint/[0.08] hover:text-daintree-text"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
