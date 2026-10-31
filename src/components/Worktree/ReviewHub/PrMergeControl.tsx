import { useEffect, useId, useRef, useState } from "react";
import {
  ExternalLink,
  GitPullRequestClosed,
  GitPullRequestDraft,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import type { PR, PRMergeMethod, PRMergeStatus } from "@shared/types/forge";
import { GitMerge } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useDohertyGate, useSkeletonFloor } from "@/hooks/useDeferredLoading";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { forgeClient } from "@/clients/forgeClient";
import {
  AUTO_MERGE_OFF_DETAIL,
  AUTO_MERGE_OFF_REASON,
  CANNOT_CANCEL_DETAIL,
  MERGE_SETTINGS_UNREAD_REASON,
  derivePrMergeControl,
  mergeActionLabel,
  type PrMergeControlModel,
  type PrMergeRequest,
} from "./prMergeModel";

type ControlState =
  | { kind: "loading" }
  | {
      kind: "ready";
      model: PrMergeControlModel;
      pr: PR | null;
      /** The provider's display name, when the repository read carried it. */
      forgeName: string | null;
    }
  | { kind: "error" };

const METHOD_SEGMENT_LABEL: Record<PRMergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash",
  rebase: "Rebase",
};

type Tone = "neutral" | "warning" | "error";

interface RowStatus {
  Icon: LucideIcon;
  tone: Tone;
  title: string;
  detail?: string;
  /** The row's only way forward is to read again. */
  retry?: boolean;
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: "text-text-secondary",
  warning: "text-status-warning",
  error: "text-status-error",
};

interface PrMergeControlProps {
  worktreePath: string;
  prNumber: number;
  /** Bumped by the popover's Refresh so both reads restart together. */
  reloadKey: number;
  onRequest: (request: PrMergeRequest) => void;
  onOpenExternal: (url: string) => void;
  /** What the row says, for the popover's single polite status region. */
  onStatusChange?: (text: string) => void;
}

/**
 * The checks popover's merge row. Reads the pull request and the repository's
 * merge settings each time the popover opens — the poll's view can be a
 * minute old, and a PR moves from blocked to clean, or armed to queued, in
 * between. It only decides what to offer; the confirm owns the write.
 *
 * The row is always there once the PR is known. A PR that can't merge says
 * why in the same place a mergeable one offers the button, and the read holds
 * the row's shape while it is in flight, so the footer below never moves.
 */
export function PrMergeControl({
  worktreePath,
  prNumber,
  reloadKey,
  onRequest,
  onOpenExternal,
  onStatusChange,
}: PrMergeControlProps) {
  const [state, setState] = useState<ControlState>({ kind: "loading" });
  const [method, setMethod] = useState<PRMergeMethod | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const requestIdRef = useRef(0);
  // A Retry re-reads in place: the row keeps what it last said, and the
  // Retry stays mounted (busy) so focus has somewhere to be.
  const retryInPlaceRef = useRef(false);
  // Retry still held focus when its read came back; the row's next control
  // takes it over. Checked at that moment, not at the press, so a user who
  // tabbed away while it ran isn't pulled back.
  const refocusActionRef = useRef(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const statusId = useId();

  const retryOwnsFocus = () => {
    const active = document.activeElement;
    return (
      active instanceof HTMLElement &&
      active.dataset.testid === "pr-merge-control-retry" &&
      rowRef.current?.contains(active) === true
    );
  };

  useEffect(() => {
    const requestId = (requestIdRef.current += 1);
    if (retryInPlaceRef.current) {
      retryInPlaceRef.current = false;
      setRetrying(true);
    } else {
      setState({ kind: "loading" });
    }
    Promise.all([
      // Fresh: the labels this row offers are decided by this read.
      forgeClient.getPR(worktreePath, prNumber, { fresh: true }),
      forgeClient.getRepoMetadata(worktreePath),
    ]).then(
      ([pr, metadata]) => {
        if (requestIdRef.current !== requestId) return;
        const model = derivePrMergeControl(pr, metadata);
        refocusActionRef.current = retryOwnsFocus();
        setRetrying(false);
        setState({ kind: "ready", model, pr, forgeName: metadata?.providerName || null });
        setMethod(model.kind === "arm" || model.kind === "merge" ? model.defaultMethod : null);
      },
      () => {
        if (requestIdRef.current !== requestId) return;
        refocusActionRef.current = retryOwnsFocus();
        setRetrying(false);
        setState({ kind: "error" });
      }
    );
    return () => void (requestIdRef.current += 1);
  }, [worktreePath, prNumber, reloadKey, retryKey]);

  useEffect(() => {
    if (retrying || !refocusActionRef.current) return;
    refocusActionRef.current = false;
    // An enabled action if there is one; otherwise the status line, so the
    // explanation for a disabled action is where focus lands.
    const row = rowRef.current;
    const target =
      row?.querySelector<HTMLElement>("[data-row-action]:not([disabled])") ??
      row?.querySelector<HTMLElement>("[data-row-status]");
    target?.focus();
  }, [retrying, state]);

  const showRetrySpinner = useDohertyGate(retrying);

  // The shape is held from the first frame; the bones only show past the
  // Doherty gate, and once shown they stay for the floor so a read landing
  // just after the gate doesn't flash them for a frame.
  const loading = state.kind === "loading";
  const holdSkeleton = useSkeletonFloor(useDohertyGate(loading));
  const status = state.kind === "ready" ? rowStatus(state.model, state.forgeName) : null;
  const statusText =
    loading || holdSkeleton
      ? "Reading merge options"
      : state.kind === "error"
        ? "Couldn't check whether it can merge"
        : status
          ? [status.title, status.detail].filter(Boolean).join(". ")
          : "";

  useEffect(() => {
    onStatusChange?.(statusText);
  }, [statusText, onStatusChange]);

  if (loading || holdSkeleton) {
    return (
      <div ref={rowRef} data-testid="pr-merge-control" className={ROW_CLASS}>
        {/* `inert`: the popover's region announces the wait, so the skeleton
            must not add an `aria-busy` region of its own. */}
        <Skeleton
          inert
          data-testid="pr-merge-control-loading"
          label="Reading merge options"
          className="flex flex-col gap-2"
        >
          <div className="flex items-start gap-2.5">
            <SkeletonBone className="h-3.5 w-3.5 rounded-full" />
            <div className="flex flex-col justify-center gap-1.5 min-h-[2lh]">
              <SkeletonBone className="h-3 w-48 rounded-sm" />
              <SkeletonBone className="h-3 w-64 rounded-sm" />
            </div>
          </div>
          <div className={ACTION_ROW_CLASS}>
            <SkeletonBone className="h-6 w-52 rounded-md" />
            <SkeletonBone className="h-7 w-36 rounded-md ml-auto" />
          </div>
        </Skeleton>
      </div>
    );
  }

  const retry = () => {
    if (retrying) return;
    retryInPlaceRef.current = true;
    setRetryKey((key) => key + 1);
  };
  const retryButton = (
    <RetryButton onRetry={retry} retrying={retrying} showSpinner={showRetrySpinner} />
  );

  if (state.kind === "error") {
    return (
      <div ref={rowRef} data-testid="pr-merge-control" className={ROW_CLASS}>
        <StatusLine
          id={statusId}
          testId="pr-merge-control-error"
          status={{
            Icon: SEVERITY_GLYPH.error,
            tone: "error",
            title: "Couldn't check whether it can merge",
            // Neither read landed, so which forge this is isn't known here.
            detail: "The forge didn't answer when the pull request was read",
          }}
        />
        <div className={ACTION_ROW_CLASS}>{retryButton}</div>
      </div>
    );
  }

  const { model, pr, forgeName } = state;
  if (model.kind === "hidden" || !status || !pr) return null;

  const statusLine = (
    <StatusLine
      id={statusId}
      testId={model.kind === "cancel" ? "pr-merge-control-intent" : "pr-merge-control-status"}
      detailTestId={
        model.kind !== "unavailable" && model.disabledReason ? "pr-merge-control-reason" : undefined
      }
      status={status}
    />
  );

  if (model.kind === "unavailable" || status.retry) {
    return (
      <div
        ref={rowRef}
        data-testid="pr-merge-control"
        data-merge-state={model.kind === "unavailable" ? model.reason : "settings-unread"}
        className={ROW_CLASS}
      >
        {statusLine}
        <div className={ACTION_ROW_CLASS}>
          {status.retry ? (
            retryButton
          ) : (
            // Whatever is in the way is settled on the forge: marking it
            // ready, resolving conflicts there, merging it, or just looking.
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-row-action=""
              data-testid="pr-merge-open-pr"
              onClick={() => onOpenExternal(pr.url)}
              className="ml-auto transition-colors"
            >
              <ExternalLink aria-hidden="true" />
              {model.kind === "unavailable" && model.reason === "unsupported" && forgeName
                ? `Open on ${forgeName}`
                : "Open pull request"}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const mode = model.kind;
  const queue = model.kind !== "cancel" && model.queue;
  const label = mergeActionLabel(mode, {
    queue,
    intent: model.kind === "cancel" ? model.intent : null,
  });
  const disabled = model.disabledReason !== null;

  return (
    <div ref={rowRef} data-testid="pr-merge-control" data-merge-state={mode} className={ROW_CLASS}>
      {statusLine}
      <div className={ACTION_ROW_CLASS}>
        {/* No method to pick while the action itself is unavailable. */}
        {model.kind !== "cancel" &&
          !disabled &&
          (model.methods.length > 0 && method !== null ? (
            <SegmentedRadioGroup
              aria-label="Merge method"
              density="compact"
              testId="pr-merge-method"
              value={method}
              onChange={setMethod}
              options={model.methods.map((value) => ({
                value,
                label: METHOD_SEGMENT_LABEL[value],
              }))}
            />
          ) : model.queue ? (
            <span className="pl-1 text-text-secondary" data-testid="pr-merge-method-fixed">
              Method set by the merge queue
            </span>
          ) : method !== null ? (
            <span className="pl-1 text-text-secondary" data-testid="pr-merge-method-fixed">
              Method: <span className="text-text-primary">{METHOD_SEGMENT_LABEL[method]}</span>
            </span>
          ) : null)}
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="pr-merge-action"
          data-row-action=""
          disabled={disabled}
          aria-describedby={statusId}
          onClick={() =>
            onRequest({
              mode,
              method: model.kind === "cancel" ? null : method,
              title: pr.title,
              baseRef: pr.baseRef,
              queue,
              intent: model.kind === "cancel" ? model.intent : null,
            })
          }
          className="ml-auto transition-colors"
        >
          {label}
        </Button>
      </div>
    </div>
  );
}

const ROW_CLASS = "flex flex-col gap-2 px-3 py-2.5 border-t border-divider";

// Every state keeps an action row, so the row is one height whatever it says.
// Pulled out to the footer's inset so the two rows of buttons share an edge.
const ACTION_ROW_CLASS = "flex items-center gap-2 min-h-7 -mx-1";

function StatusLine({
  id,
  status,
  testId,
  detailTestId,
}: {
  id: string;
  status: RowStatus;
  testId: string;
  detailTestId?: string;
}) {
  const { Icon } = status;
  return (
    // Same column as a check row above it: glyph, then a primary line and a
    // secondary one, so the row reads as one more fact about this PR.
    <div
      id={id}
      data-testid={testId}
      data-row-status=""
      // Programmatic focus only: where a Retry hands focus when what it
      // resolved to offers no enabled action.
      tabIndex={-1}
      className="flex items-start gap-2.5 rounded-sm"
    >
      <Icon
        className={cn("w-3.5 h-3.5 shrink-0 mt-px", TONE_CLASS[status.tone])}
        aria-hidden="true"
      />
      {/* Two lines held whether or not there is a detail, so a one-line state
          and a two-line state leave the footer in the same place. */}
      <span className="min-w-0 flex-1 min-h-[2lh]">
        <span className="block font-medium text-text-primary break-words">{status.title}</span>
        {status.detail && (
          <span className="block text-text-secondary break-words" data-testid={detailTestId}>
            {status.detail}
          </span>
        )}
      </span>
    </div>
  );
}

function RetryButton({
  onRetry,
  retrying,
  showSpinner,
}: {
  onRetry: () => void;
  retrying: boolean;
  showSpinner: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-row-action=""
      data-testid="pr-merge-control-retry"
      // Busy, not disabled: the read runs with focus still here.
      loading={showSpinner}
      aria-disabled={retrying || undefined}
      onClick={onRetry}
      className="ml-auto transition-colors"
    >
      <RefreshCw aria-hidden="true" />
      Retry
    </Button>
  );
}

function waitingTitle(mergeStatus: PRMergeStatus | null, baseRef: string, forge: string): string {
  if (mergeStatus === "blocked") return "Waiting on required checks or reviews";
  if (mergeStatus === "behind") return `Behind ${baseRef}`;
  if (mergeStatus === "unknown") return `${forge} is still checking whether it can merge`;
  return "Not ready to merge yet";
}

/**
 * What the row says about the PR, from the model and the forge's name. With
 * no name the copy stays forge-neutral rather than guessing one.
 */
function rowStatus(model: PrMergeControlModel, forgeName: string | null): RowStatus | null {
  const forge = forgeName ?? "The forge";
  const onForge = forgeName ? ` on ${forgeName}` : "";
  switch (model.kind) {
    case "hidden":
      return null;
    case "unavailable":
      switch (model.reason) {
        case "merged":
          return {
            Icon: GitMerge,
            tone: "neutral",
            title: `Merged into ${model.baseRef}`,
            detail: "Nothing left to merge",
          };
        case "closed":
          return {
            Icon: GitPullRequestClosed,
            tone: "neutral",
            title: "Closed without merging",
            detail: `Reopen it${onForge} to merge it`,
          };
        case "draft":
          return {
            Icon: GitPullRequestDraft,
            tone: "neutral",
            title: "Draft pull request",
            detail: `Mark it ready for review${onForge} to merge it`,
          };
        case "conflicts":
          return {
            Icon: SEVERITY_GLYPH.warning,
            tone: "warning",
            title: `Conflicts with ${model.baseRef}`,
            detail: "Resolve them before it can merge",
          };
        case "settings-unread":
          return {
            Icon: SEVERITY_GLYPH.error,
            tone: "error",
            title: "Couldn't read merge settings",
            detail: "They decide what this pull request can do here",
            retry: true,
          };
        case "unreported":
          return {
            Icon: SEVERITY_GLYPH.warning,
            tone: "warning",
            title: "Merge status not reported",
            detail: `${forge} didn't say whether it can merge yet`,
            retry: true,
          };
        case "unsupported":
          // Permanent for this provider, so no Retry: the way forward is the forge.
          return {
            Icon: GitMerge,
            tone: "neutral",
            title: forgeName
              ? `Merging isn't available here for ${forgeName}`
              : "Merging isn't available here",
            detail: `Open it${onForge || " on the forge"} to merge it`,
          };
        case "no-auto-merge":
          return {
            Icon: GitMerge,
            tone: "neutral",
            title: waitingTitle(model.mergeStatus, model.baseRef, forge),
            detail: "Auto-merge isn't available for this repository",
          };
      }
      return null;
    case "cancel": {
      const { intent } = model;
      const cannotCancel = model.disabledReason !== null;
      if (intent.kind === "queued") {
        return {
          Icon: GitMerge,
          tone: "neutral",
          title:
            intent.position !== null
              ? `Queued at position ${intent.position}`
              : "In the merge queue",
          detail: cannotCancel
            ? CANNOT_CANCEL_DETAIL_SENTENCE
            : `${forge} merges it into ${model.baseRef} when it reaches the front`,
        };
      }
      const how = intent.method ? `${METHOD_SEGMENT_LABEL[intent.method]} · ` : "";
      return {
        Icon: GitMerge,
        tone: "neutral",
        title: intent.enabledBy
          ? `Auto-merge enabled by ${intent.enabledBy}`
          : "Auto-merge enabled",
        detail: cannotCancel
          ? CANNOT_CANCEL_DETAIL_SENTENCE
          : `${how}merges into ${model.baseRef} once requirements pass`,
      };
    }
    case "arm":
    case "merge": {
      if (model.disabledReason === MERGE_SETTINGS_UNREAD_REASON) {
        return {
          Icon: SEVERITY_GLYPH.error,
          tone: "error",
          title: "Couldn't read merge settings",
          detail: "The merge methods are needed to preview what lands",
          retry: true,
        };
      }
      if (model.disabledReason === AUTO_MERGE_OFF_REASON) {
        return {
          Icon: GitMerge,
          tone: "neutral",
          title: AUTO_MERGE_OFF_REASON,
          detail: AUTO_MERGE_OFF_DETAIL,
        };
      }
      if (model.queue) {
        return {
          Icon: GitMerge,
          tone: "neutral",
          title: "Merge queue required",
          detail: `${forge} queues it for ${model.baseRef} once requirements pass`,
        };
      }
      if (model.kind === "merge") {
        return {
          Icon: GitMerge,
          tone: "neutral",
          title: `Ready to merge into ${model.baseRef}`,
          detail:
            model.mergeStatus === "unstable"
              ? "Some checks that aren't required failed"
              : `${forge} reports nothing left blocking it`,
        };
      }
      return {
        Icon: GitMerge,
        tone: "neutral",
        title: waitingTitle(model.mergeStatus, model.baseRef, forge),
        detail:
          model.mergeStatus === "blocked"
            ? "Auto-merge can merge it once they pass"
            : model.mergeStatus === "behind"
              ? `It needs the latest ${model.baseRef} before it can merge`
              : "Auto-merge can wait for the answer",
      };
    }
  }
}

const CANNOT_CANCEL_DETAIL_SENTENCE = `${CANNOT_CANCEL_DETAIL} cancel it`;
