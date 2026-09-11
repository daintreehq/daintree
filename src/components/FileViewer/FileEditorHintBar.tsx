import { Pencil, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";

export interface FileEditorHintBarProps {
  /** The owning plugin's display name, as the plugin runtime reports it. */
  pluginName: string;
  /** `disabled` means the plugin has to be turned on before it can open the file. */
  state: "ready" | "disabled";
  /** An enable-and-open round trip is in flight. */
  pending: boolean;
  /** The failure text from the last attempt, or null. */
  error: string | null;
  onAction: () => void;
  onDismiss: () => void;
}

/**
 * The strip offering plugin-backed editing above a file the reader opened to read.
 *
 * Two tiers, not one. The offer is T1 — ambient pane chrome, in the sense
 * `user-signals.md` means it: nothing is wrong, nothing needs attention, and a
 * reader scanning the panel should be able to skip it. A failed attempt is T3,
 * which is what `InlineStatusBanner` is for, so the error branch keeps it.
 *
 * The offer used to be T2 (`severity="warning"`), which put an amber band and
 * amber body text above every Markdown file in the project. Warning colour
 * means risk — data loss, deprecation, a missing prerequisite that breaks
 * something — and spending it on "you could edit this if you like" is what
 * teaches people to skip the amber bands that do matter.
 *
 * Geometry is the file-viewer chrome family's, not a banner's: `h-8`, `text-xs`
 * and a bottom hairline, so it stacks cleanly under the toolbar and above the
 * metadata strip (`fileMetadataStrip.ts`, `h-7`) that renders directly below it
 * in Source mode. One pixel taller than that strip on purpose — at equal
 * heights and with the border as the only separator the two rows read as one
 * slab, which is the same collapse the warning fill used to paper over.
 */
export function FileEditorHintBar({
  pluginName,
  state,
  pending,
  error,
  onAction,
  onDismiss,
}: FileEditorHintBarProps) {
  if (error) {
    return (
      <InlineStatusBanner
        severity="error"
        // Not the pencil: tinting the edit affordance red says "editing, but
        // angry" rather than "that didn't work".
        icon={XCircle}
        title={`Couldn't open ${pluginName}`}
        description={error}
        role="status"
        ariaLive="polite"
        animated={false}
        action={{ id: "edit-file", label: "Retry", onClick: onAction, disabled: pending }}
        onClose={onDismiss}
        closeAriaLabel="Dismiss editing tip"
      />
    );
  }

  const disabled = state === "disabled";
  // The prerequisite belongs in the message. Leaving it to the button label
  // asks the reader to infer "the plugin is off" from being handed an
  // administrative command in answer to an offer to edit.
  const message = pending
    ? `Opening ${pluginName}…`
    : disabled
      ? `Enable ${pluginName} to edit this file`
      : `Edit this file with ${pluginName}`;
  // Stays constant while pending so the row does not resize under the cursor;
  // `loading` dims it behind a spinner rather than swapping it out.
  const actionLabel = disabled ? "Enable and edit" : "Start editing";

  return (
    <div
      data-testid="file-editor-hint"
      className="flex h-8 shrink-0 items-center gap-2 border-b border-border-default bg-overlay-subtle px-3 text-xs text-text-secondary"
    >
      <Pencil aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      {/* The message yields first under width pressure: the action has to stay
          whole to be clickable, and the full text is on the title attribute. */}
      <span className="min-w-0 flex-1 truncate" title={message}>
        {message}
      </span>
      <Button
        variant="subtle"
        size="xs"
        // `xs` ships `text-3xs`, which is a chip size. This row is `text-xs`
        // and the action reads as part of it.
        className="text-xs"
        onClick={onAction}
        loading={pending}
        data-testid="file-editor-hint-action"
      >
        {actionLabel}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onDismiss}
        aria-label="Dismiss editing tip"
        data-testid="file-editor-hint-dismiss"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
