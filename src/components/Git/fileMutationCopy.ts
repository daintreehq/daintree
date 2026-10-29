import type { FileDiscardPreview, FileTrashPreview } from "@shared/types/fileMutation";
import { isHostWindows } from "@/hooks/useHostPlatform";
import { isClientAppError } from "@/utils/clientAppError";
import { classifyGitError, getGitRecoveryHint } from "@shared/utils/gitOperationErrors";
import type { FileMutationKind } from "@/store/fileMutationConfirmStore";

/**
 * What the file confirm says, decided from what the operation would actually
 * do to the file (#15122) rather than from the row's status. One sentence for
 * every state was the defect: a deletion that comes back read as a permanent
 * loss, and an agent's new file never said it was going to the Trash.
 *
 * Red is kept for the one outcome that loses something git can't give back.
 * A restore loses nothing and the Trash is recoverable, so both take the
 * neutral primary: spending the warning on them is what teaches people to
 * click through it.
 */
export interface FileMutationCopy {
  /** The title's verb phrase; the file name follows it in quotes. */
  action: string;
  /** The consequence, in one or two sentences. Null until it's known. */
  description: string | null;
  confirmLabel: string;
  destructive: boolean;
}

/** The OS Trash by the name the file's host gives it. */
export function trashName(): string {
  return isHostWindows() ? "Recycle Bin" : "Trash";
}

/** Before the preview has said what the operation would do: the worst case, with no claims. */
export function pendingCopy(kind: FileMutationKind): FileMutationCopy {
  return kind === "discard"
    ? {
        action: "Discard changes to",
        description: null,
        confirmLabel: "Discard changes",
        destructive: true,
      }
    : { action: "Trash", description: null, confirmLabel: "Trash file", destructive: false };
}

export function discardCopy(preview: FileDiscardPreview, trash: string): FileMutationCopy {
  const { outcome, renamedFrom, copiedFrom, staged, unstaged } = preview;

  if (outcome === "restore") {
    return {
      action: "Restore",
      description: "The file comes back from its last commit. Nothing is lost.",
      confirmLabel: "Restore file",
      destructive: false,
    };
  }

  if (renamedFrom !== null) {
    return {
      action: "Discard rename of",
      description:
        outcome === "lose"
          ? `Its old name comes back from the last commit, and the renamed copy moves to the ${trash}. The rename's staged version differs from that copy and is lost.`
          : `Its old name comes back from the last commit, and the renamed copy moves to the ${trash}, where you can restore it.`,
      confirmLabel: "Discard rename",
      destructive: outcome === "lose",
    };
  }

  if (outcome === "trash") {
    return {
      action: "Trash",
      description: copiedFrom
        ? `It's a copy made since the last commit, so it moves to the ${trash} and leaves the index. The original stays as it is.`
        : `It's new since the last commit, so it moves to the ${trash} and leaves the index. You can restore it from the ${trash}.`,
      confirmLabel: "Trash file",
      destructive: false,
    };
  }

  if (preview.overwrites !== null) {
    return {
      action: "Discard changes to",
      description:
        "The file goes back to its last commit, writing over the file now at this path. Git has never seen that file, so it's lost and can't be recovered.",
      confirmLabel: "Discard changes",
      destructive: true,
    };
  }

  if (!preview.inLastCommit) {
    return {
      action: "Discard changes to",
      description: unstaged
        ? `It's new since the last commit, so it moves to the ${trash} and leaves the index. Its staged version differs from the copy on disk and is lost.`
        : "It's new since the last commit and only its staged version remains. That version leaves the index and is lost.",
      confirmLabel: "Discard changes",
      destructive: true,
    };
  }

  const lost =
    staged && unstaged
      ? "Its staged and unstaged changes are both"
      : staged
        ? "Its staged changes are"
        : "Its unstaged changes are";
  return {
    action: "Discard changes to",
    description: `The file goes back to its last commit. ${lost} lost and can't be recovered.`,
    confirmLabel: "Discard changes",
    destructive: true,
  };
}

export function trashCopy(preview: FileTrashPreview, trash: string): FileMutationCopy {
  let description: string;
  if (!preview.inLastCommit && !preview.inIndex) {
    description = preview.ignored
      ? `Git ignores this file and has no copy of it, so the ${trash} will hold the only one.`
      : `Git has no copy of this file, so the ${trash} will hold the only one.`;
  } else if (!preview.inLastCommit) {
    description = `It's new since the last commit. The file moves to the ${trash}, and git keeps only its staged version${preview.unstaged ? "; its unstaged changes go with the file" : ""}.`;
  } else if (preview.unstaged !== null) {
    description = `The file and its uncommitted changes move to the ${trash}, and git lists it as deleted. Git can bring back only its ${preview.staged ? "staged" : "last committed"} version.`;
  } else if (preview.staged !== null) {
    description = `The file moves to the ${trash}, and git lists it as deleted. Its staged changes stay staged.`;
  } else {
    description = `The file moves to the ${trash}, and git lists it as deleted. Restore it from the ${trash}, or bring back the committed version with Discard changes.`;
  }
  return { action: "Trash", description, confirmLabel: "Trash file", destructive: false };
}

/** What became of a confirmed mutation that failed, worded from its code. */
export type FileMutationFailure =
  | { kind: "silent" }
  | {
      kind: "notify";
      title: string;
      message: string;
      /** The one recovery the toast offers; null when nothing here can fix it. */
      recovery: "review" | "retry" | "reveal" | null;
    };

function baseName(relativePath: string): string {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? relativePath;
}

/**
 * A failure's message as a person reads it. Daintree's own refusals are
 * already sentences and pass through; git's raw output (`fatal: …`) is
 * replaced with what it means, from the shared git classifier where it knows,
 * so a toast or a notice never shows plumbing.
 */
export function plainMessage(details: unknown, message: string): string {
  const code = isClientAppError(details) ? details.code : undefined;
  if (code === "GIT_INDEX_LOCKED") {
    return "Another git process is using this worktree. Wait for it to finish, then try again.";
  }
  if (code === "PERMISSION") {
    return "Daintree isn't allowed to read or change this file. Check its permissions in your file manager.";
  }
  const text = message.replace(/^(?:Error: )+/, "").trim();
  // Git's own prefixes and Node's errno ones (`EACCES: …`) are plumbing.
  if (text !== "" && !/^(?:(?:fatal|error|warning):|E[A-Z]+:)/i.test(text)) return text;
  const hint = getGitRecoveryHint(classifyGitError(details ?? message));
  return hint ?? "Git stopped before it finished, and didn't say why in plain terms.";
}

/**
 * The failure toast for a confirmed discard or trash. Composed here from the
 * error's code and the file the row already names, not from the main
 * process's text: a packaged build scrubs that text on the way over, and its
 * wording names the operation's internals rather than what to do next.
 */
export function describeFileMutationFailure(
  kind: FileMutationKind,
  relativePath: string,
  details: unknown,
  fallbackMessage: string,
  trash: string = trashName()
): FileMutationFailure {
  const code = isClientAppError(details) ? details.code : undefined;
  const name = `'${baseName(relativePath)}'`;
  const title = kind === "discard" ? "Couldn't discard changes" : "Couldn't trash file";

  switch (code) {
    // The end state the user asked for already holds: the file has nothing
    // left to discard, or is already gone. Telling them changes nothing.
    case "NOT_FOUND":
      return { kind: "silent" };
    case "FILE_CHANGED_SINCE_REVIEW":
      return kind === "discard"
        ? {
            kind: "notify",
            title,
            message: `${name} changed after you reviewed it, so nothing was discarded. Review it as it is now before trying again.`,
            recovery: "review",
          }
        : {
            kind: "notify",
            title,
            message: `${name} changed while it was waiting to move, so nothing changed. Review it as it is now before trying again.`,
            recovery: "review",
          };
    // The Trash refused the file. The platform rarely says why in a form
    // worth repeating — no Trash on this disk, a read-only folder — so state
    // what is certain: nothing moved, and the file manager can do it.
    case "UNSUPPORTED":
      return {
        kind: "notify",
        title,
        message: `The ${trash} wouldn't take ${name}, so nothing changed.`,
        recovery: "reveal",
      };
    case "PERMISSION":
      return {
        kind: "notify",
        title,
        message: `Daintree isn't allowed to read or change ${name}, so nothing changed. Check its permissions in your file manager.`,
        recovery: "reveal",
      };
    case "GIT_INDEX_LOCKED":
      return {
        kind: "notify",
        title,
        message:
          "Another git process is using this worktree, so nothing changed. Wait for it to finish, then try again.",
        recovery: "retry",
      };
    case "NOT_A_FILE":
      return {
        kind: "notify",
        title,
        message: plainMessage(details, fallbackMessage),
        recovery: null,
      };
    case "INTERNAL":
      // A discard that trashed the file and then failed in git: say what
      // already happened, and let the user look at what's left.
      return {
        kind: "notify",
        title,
        message: plainMessage(details, fallbackMessage),
        recovery: "review",
      };
    default:
      return {
        kind: "notify",
        title,
        message: plainMessage(details, fallbackMessage),
        recovery: "retry",
      };
  }
}
