import { create } from "zustand";
import type { DeclaredProjectLink } from "@shared/types";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { projectClient } from "@/clients/projectClient";
import { logDebug } from "@/utils/logger";

interface DeclaredProjectLinksState {
  /** The project `links` were last read for; a reader shows them only for that one. */
  projectId: string | null;
  /** What that project's manifests declared at the last read that came back. */
  links: readonly DeclaredProjectLink[];
}

/** The links this view's project declares in its manifests (#17252, #17254); never persisted. */
export const useDeclaredProjectLinksStore = create<DeclaredProjectLinksState>(() => ({
  projectId: null,
  links: [],
}));

function sameLinks(a: readonly DeclaredProjectLink[], b: readonly DeclaredProjectLink[]): boolean {
  return (
    a.length === b.length &&
    a.every((link, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        link.source === other.source &&
        link.title === other.title &&
        link.url === other.url
      );
    })
  );
}

interface Read {
  projectId: string;
  again: boolean;
}

let current: Read | null = null;

/**
 * Read `projectId`'s declared links from the machine that holds it. One read
 * at a time: a request for the same project while one is out runs once more
 * after it, so a burst of edits costs two reads, not one per edit. A read for
 * another project supersedes it, and its answer is dropped. A failed read
 * keeps what was shown, since the file may only be slow to reach. An empty
 * answer that would clear a list while another read is already queued waits
 * for that read: an editor saving the file can be caught between truncating
 * and writing it, and clearing the list would take the toolbar button, and an
 * open launcher with it, away for a moment. If that read fails, the empty
 * answer stands, since it is the last thing the file said.
 */
export async function refreshDeclaredProjectLinks(projectId: string): Promise<void> {
  if (current?.projectId === projectId) {
    current.again = true;
    return;
  }
  const read: Read = { projectId, again: false };
  current = read;
  try {
    let held: DeclaredProjectLink[] | null = null;
    do {
      read.again = false;
      let links: DeclaredProjectLink[];
      try {
        links = await projectClient.getDeclaredLinks(projectId);
      } catch (error) {
        logDebug("Couldn't read the project's declared links", {
          error: formatErrorMessage(error, "unknown error"),
        });
        if (held !== null && !read.again && current === read) {
          useDeclaredProjectLinksStore.setState({ projectId, links: held });
        }
        continue;
      }
      if (current !== read) return;
      held = null;
      const state = useDeclaredProjectLinksStore.getState();
      const shown = state.projectId === projectId;
      if (shown && sameLinks(state.links, links)) continue;
      if (shown && links.length === 0 && state.links.length > 0 && read.again) {
        held = links;
        continue;
      }
      useDeclaredProjectLinksStore.setState({ projectId, links });
    } while (read.again && current === read);
  } finally {
    if (current === read) current = null;
  }
}

export function _resetDeclaredProjectLinksForTests(): void {
  current = null;
  useDeclaredProjectLinksStore.setState({ projectId: null, links: [] });
}
