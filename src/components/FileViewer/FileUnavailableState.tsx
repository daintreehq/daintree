import type { LucideIcon } from "lucide-react";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * Why a file can't be shown, kept structured past the read so the unavailable
 * state can say it in words and offer the way out that fits — rather than one
 * generic "Can't show this file" over a terse code.
 */
export type UnavailableReason =
  | FileReadErrorCode
  | "UNSUPPORTED_MEDIA"
  | "MEDIA_FAILED"
  | "IMAGE_FAILED"
  | "SVG_REJECTED"
  | "PDF_FAILED"
  | "READ_FAILED";

export interface UnavailableCopy {
  title: string;
  description: string;
  /** The way out the body offers, beyond the toolbar's own actions. */
  action: "open" | "reveal" | "retry" | null;
}

/**
 * What an unavailable file says, per cause: a title naming what happened, a
 * line saying what to do instead, and the one action that does it. The open
 * action follows the toolbar's own target for the file's type, so "open" means
 * the editor for text and the OS default app for media — never the OS default
 * for a binary, which may execute it; a binary gets Reveal.
 */
export function unavailableCopy(reason: UnavailableReason, message: string): UnavailableCopy {
  switch (reason) {
    case "BINARY_FILE":
      return {
        title: "Binary file",
        description: "It can't be shown as text. Reveal it to open it with another app.",
        action: "reveal",
      };
    case "FILE_TOO_LARGE":
      return {
        title: "Too large to preview",
        description: "It's over the size this viewer opens. Open it outside Daintree instead.",
        action: "open",
      };
    case "LFS_POINTER":
      return {
        title: "Git LFS pointer",
        description: "Run `git lfs pull` to download the file's contents, then refresh.",
        action: "retry",
      };
    case "NOT_FOUND":
      return {
        title: "This file was deleted",
        description: "It's no longer on disk.",
        action: "retry",
      };
    case "PERMISSION":
      return {
        title: "No permission to read this file",
        description: "Reveal it to check its permissions.",
        action: "reveal",
      };
    case "OUTSIDE_ROOT":
      return {
        title: "Outside this worktree",
        description: "The file resolves to a location outside the folder being browsed.",
        action: "reveal",
      };
    case "NOT_A_FILE":
      return {
        title: "This is a folder",
        description: "Refresh to show its contents.",
        action: "retry",
      };
    case "INVALID_PATH":
      return {
        title: "Couldn't read this file",
        description: "Its path isn't valid.",
        action: "reveal",
      };
    case "UNSUPPORTED_MEDIA":
      return { title: "Can't play this format", description: message, action: "open" };
    case "MEDIA_FAILED":
      return {
        title: message || "Couldn't play this file",
        description: "Open it in your default app to play it.",
        action: "open",
      };
    case "IMAGE_FAILED":
      return {
        title: "Couldn't load this image",
        description: "It may be damaged, or in a format that can't be decoded here.",
        action: "open",
      };
    case "SVG_REJECTED":
      return { title: "Can't preview this SVG", description: message, action: "open" };
    case "PDF_FAILED":
      return {
        title: message || "This PDF couldn't be displayed",
        description: "Open it in your default app to read it.",
        action: "open",
      };
    case "READ_FAILED":
      return {
        title: "Couldn't read this file",
        description: "Something went wrong reading it from disk.",
        action: "retry",
      };
  }
}

/**
 * The body for every file a viewer can't show, and for a file that vanished.
 * Shared by the file browser, the file panel and the diff panel, so an
 * unavailable file reads the same — cause, next step, one way out — wherever
 * it is opened.
 * A polite status region, so the change is announced without moving focus
 * (WCAG 4.1.3): selecting a binary in the tree otherwise reads as nothing
 * having happened at all.
 */
export function FileUnavailableState({
  icon: Icon,
  title,
  description,
  action,
  "data-testid": testId = "file-unavailable",
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  "data-testid"?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-full w-full items-center justify-center p-6"
      data-testid={testId}
    >
      <EmptyState
        variant="zero-data"
        scale="canvas"
        icon={<Icon className="h-6 w-6" />}
        title={title}
        description={description}
        action={action}
        className="w-full"
      />
    </div>
  );
}
