import { formatBytes } from "@/lib/formatBytes";
import { pluralize } from "@/lib/pluralize";
import type { FolderUploadPathProblem } from "@shared/types/folderUpload";
import type { FolderUploadCheck, FolderUploadSummary } from "@shared/types/ipc/fileTransfer";

/** What stopped a folder: one of its own limits or names, or the walk giving up. */
export type RefusalProblem = Extract<FolderUploadCheck, { status: "refused" }>["problem"];

export function atLeast(lowerBound: boolean, text: string): string {
  return lowerBound ? `at least ${text}` : text;
}

/**
 * What is wrong with a name or a path, said after its subject. A name problem
 * is fixed by renaming; a path problem is the walk's own, with nothing to rename.
 */
const PATH_PROBLEM: Record<FolderUploadPathProblem, { what: string; isName: boolean }> = {
  "empty-name": { what: "is empty", isName: true },
  "dot-name": { what: "is '.' or '..'", isName: true },
  separator: { what: "has a slash or backslash in it", isName: true },
  "control-character": { what: "has a control character in it", isName: true },
  "malformed-unicode": { what: "isn't valid Unicode", isName: true },
  // Only a name can start this way: every entry's path starts with the folder's.
  "drive-letter": { what: "starts like a Windows drive, such as 'C:'", isName: true },
  absolute: { what: "leads outside the folder", isName: false },
  "outside-root": { what: "leads outside the folder", isName: false },
  "entry-form": { what: "doesn't match whether it's a file or a folder", isName: false },
};

const SEND_LESS = "Send a smaller folder, or the folders inside it one at a time.";
const RENAME = "Rename it, then drop the folder again.";
const RENAME_FOLDER = "Rename the folder, then drop it again.";

export interface FolderRefusal {
  title: string;
  detail: string;
  /** What the listed paths are, for the section that names them. */
  pathsLabel: string;
  paths: string[];
}

/** What the question says about the limit or names that stopped a folder. */
export function folderRefusal(
  problem: RefusalProblem,
  summary: FolderUploadSummary
): FolderRefusal {
  if (problem.kind === "walk-limit") {
    // The walk stopped looking, so its count is always as far as it got.
    return {
      title: `More than ${pluralize(problem.maximum, "item")} to look through`,
      detail: `It has at least ${pluralize(problem.actual, "item")}, counting links and other entries that aren't copied. ${SEND_LESS}`,
      pathsLabel: "Largest contributors",
      paths: problem.paths,
    };
  }
  if (problem.kind === "clash") {
    return {
      title: "Two names clash",
      detail:
        "A host's disk can't keep these two apart, for example names that differ only in letter case. Rename one, then drop the folder again.",
      pathsLabel: "Names that clash",
      paths: [...problem.paths],
    };
  }
  if (problem.kind === "path") {
    const { what, isName } = PATH_PROBLEM[problem.problem];
    // The dropped folder's own name is checked on its own and named bare.
    const isRoot = problem.path === summary.rootName;
    const subject = isRoot ? "The folder's name" : isName ? "An item's name" : "An item's path";
    return {
      title: isName ? "A name the host can't take" : "A path the host can't take",
      detail: `${subject} ${what}.${isName ? ` ${isRoot ? RENAME_FOLDER : RENAME}` : ""}`,
      pathsLabel: isRoot ? "Folder" : "Item",
      paths: [problem.path],
    };
  }
  const { maximum, actual, paths } = problem;
  const counted = (text: string) => atLeast(summary.lowerBound, text);
  const contributors = { pathsLabel: "Largest contributors", paths };
  switch (problem.limit) {
    case "files":
      return {
        title: `Over the limit of ${pluralize(maximum, "file")}`,
        detail: `It holds ${counted(pluralize(actual, "file"))}. ${SEND_LESS}`,
        ...contributors,
      };
    case "folders":
      return {
        title: `Over the limit of ${pluralize(maximum, "folder")}`,
        detail: `It holds ${counted(pluralize(actual, "folder"))}. ${SEND_LESS}`,
        ...contributors,
      };
    case "bytes":
      return {
        title: `Over the ${formatBytes(maximum)} limit`,
        detail: `Its files come to ${counted(formatBytes(actual))}. ${SEND_LESS}`,
        ...contributors,
      };
    case "archive-bytes":
      return {
        title: `Over the ${formatBytes(maximum)} limit for a packed folder`,
        detail: `Packed, it comes to ${counted(formatBytes(actual))}. ${SEND_LESS}`,
        ...contributors,
      };
    // A depth or a length belongs to one entry and is measured exactly.
    case "depth":
      return {
        title: `Nested deeper than ${pluralize(maximum, "level")}`,
        detail: `An item in it sits ${pluralize(actual, "level")} below the folder. Move it higher, then drop the folder again.`,
        pathsLabel: "Too deep",
        paths,
      };
    case "name-bytes":
      return {
        title: `A name longer than ${pluralize(maximum, "byte")}`,
        detail:
          paths[0] === summary.rootName
            ? `The folder's name takes ${pluralize(actual, "byte")}. ${RENAME_FOLDER}`
            : `One name in it takes ${pluralize(actual, "byte")}. ${RENAME}`,
        pathsLabel: "Name too long",
        paths,
      };
    case "path-bytes":
      return {
        title: `A path longer than ${pluralize(maximum, "byte")}`,
        detail: `One path in it takes ${pluralize(actual, "byte")}, the folder's own name included. Shorten it, then drop the folder again.`,
        pathsLabel: "Path too long",
        paths,
      };
  }
}
