import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InlineError } from "@/components/ui/field";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { pluralize } from "@/lib/pluralize";
import type { IssuePromptContextState, IssuePromptRead } from "../hooks/useIssuePromptContext";

interface IssuePromptToggleProps {
  /** How the issue is named: `#42`, `ENG-123`. */
  issueRef: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Nothing would be sent: the layout starts its own agent, or another host creates it. */
  disabled: boolean;
  state: IssuePromptContextState;
  onRetry: () => void;
}

type ReadyRead = Extract<IssuePromptRead, { status: "ready" }>;

/** What goes to the agent, said before Create so nothing is sent unseen. */
function readyStatus({ context, comments }: ReadyRead): string {
  let text = "Goes ahead of your prompt";
  if (comments === "read" && context.commentsIncluded > 0) {
    text += `, with its newest ${pluralize(context.commentsIncluded, "comment")}`;
  } else if (comments === "failed") {
    text += ", without its comments, which couldn't be read";
  } else if (comments === "too-long") {
    text += ", without its comments, which are too many to read";
  }
  return context.truncated ? `${text} (shortened to fit)` : text;
}

/**
 * The Prompt row's option to quote the issue the worktree is for ahead of the
 * first agent's prompt, with what that will send. A checkbox, not a switch: like
 * the rest of the form it takes effect at Create.
 */
export function IssuePromptToggle({
  issueRef,
  checked,
  onCheckedChange,
  disabled,
  state,
  onRetry,
}: IssuePromptToggleProps) {
  const statusId = useId();
  const previewId = useId();
  const [previewOpen, setPreviewOpen] = useState(false);
  const showLoading = useDeferredLoading(state.status === "loading", UI_INLINE_LOADING_GATE_MS);
  const active = checked && !disabled;
  const ready = active && state.status === "ready" ? state : null;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-text-secondary hover:text-text-primary">
          <Checkbox
            checked={checked}
            onCheckedChange={(value) => onCheckedChange(value === true)}
            disabled={disabled}
            aria-describedby={active ? statusId : undefined}
            data-testid="include-issue-in-prompt"
          />
          <span>Include {issueRef}</span>
        </label>
        {active && state.status !== "error" && (
          <span className="flex min-w-0 items-center gap-2 text-text-secondary">
            <span id={statusId} role="status" className="min-w-0" data-testid="issue-prompt-status">
              {ready ? readyStatus(ready) : showLoading ? `Loading ${issueRef}…` : null}
            </span>
            {ready?.comments === "failed" && (
              <Button variant="outline" size="xs" onClick={onRetry} className="-my-1 shrink-0">
                Retry
              </Button>
            )}
            {ready && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setPreviewOpen((open) => !open)}
                aria-expanded={previewOpen}
                // Only while it exists: an id that resolves to nothing is a broken relation.
                aria-controls={previewOpen ? previewId : undefined}
                className="-my-1 shrink-0"
                data-testid="issue-prompt-preview-toggle"
              >
                Preview
              </Button>
            )}
          </span>
        )}
      </div>
      {active && state.status === "error" && (
        <InlineError
          id={statusId}
          role="alert"
          data-testid="issue-prompt-error"
          action={
            <Button variant="outline" size="xs" onClick={onRetry} className="-my-1 shrink-0">
              Retry
            </Button>
          }
        >
          Couldn&apos;t load {issueRef}, so it won&apos;t be sent — {state.reason}
        </InlineError>
      )}
      {ready && previewOpen && (
        <pre
          id={previewId}
          // Scrollable, so it takes focus: a keyboard user can read all of it.
          tabIndex={0}
          aria-label={`${issueRef} as the agent gets it`}
          className="max-h-48 overflow-auto rounded-[var(--radius-md)] border border-border-subtle bg-surface-input p-2 font-mono text-2xs whitespace-pre-wrap break-words text-text-secondary select-text"
          data-testid="issue-prompt-preview"
        >
          {ready.context.text}
        </pre>
      )}
    </div>
  );
}
