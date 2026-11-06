import { pluralize } from "@/lib/pluralize";
import { InlineStatusBanner } from "../InlineStatusBanner";
import {
  getHeldBackAttachments,
  takeHeldBackAttachments,
  useHeldBackAttachments,
  type PreparedAttachment,
} from "./pendingUploads";

function attachmentName(attachment: PreparedAttachment): string {
  if (attachment.type === "file") return attachment.fileName;
  return attachment.filePath.split(/[/\\]/).filter(Boolean).pop() || attachment.filePath;
}

/**
 * Attachments that were ready only after the draft they were meant for had
 * been sent or replaced. Added to the draft shown now only when asked.
 */
export function HeldBackAttachmentsBanner({
  surface,
  onAdd,
  disabled = false,
  className,
}: {
  surface: string;
  /** Inserts what was held back into the draft shown now; false when it couldn't. */
  onAdd: (attachments: readonly PreparedAttachment[]) => boolean;
  disabled?: boolean;
  className?: string;
}) {
  const held = useHeldBackAttachments(surface);
  const [only] = held;
  if (!only) return null;
  const single = held.length === 1;
  return (
    <InlineStatusBanner
      severity="warning"
      layout="inline"
      inset
      animated={false}
      role="status"
      ariaLive="polite"
      className={className}
      data-testid="held-back-attachments"
      title={
        single
          ? `${attachmentName(only)} wasn't added`
          : `${pluralize(held.length, "attachment")} weren't added`
      }
      description={
        single ? "Its draft was sent or replaced first" : "Their draft was sent or replaced first"
      }
      action={{
        id: "add",
        label: "Add to draft",
        variant: "primary",
        disabled,
        onClick: () => {
          if (onAdd(getHeldBackAttachments(surface))) takeHeldBackAttachments(surface);
        },
      }}
      closeAriaLabel={single ? `Discard ${attachmentName(only)}` : "Discard attachments"}
      onClose={() => {
        takeHeldBackAttachments(surface);
      }}
    />
  );
}
