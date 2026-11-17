import { create } from "zustand";
import type { DeclaredProjectLink } from "@shared/types";
import { projectClient } from "@/clients/projectClient";
import { logDebug } from "@/utils/logger";

interface DeclaredProjectLinksState {
  /** The project `links` were last read for; a reader shows them only for that one. */
  projectId: string | null;
  /** What that project's package.json declared at the last read that came back. */
  links: readonly DeclaredProjectLink[];
}

/** The links this view's project declares in its package.json (#17252); never persisted. */
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
        link.field === other.field &&
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
 * keeps what was shown, since the file may only be slow to reach.
 */
export async function refreshDeclaredProjectLinks(projectId: string): Promise<void> {
  if (current?.projectId === projectId) {
    current.again = true;
    return;
  }
  const read: Read = { projectId, again: false };
  current = read;
  try {
    do {
      read.again = false;
      let links: DeclaredProjectLink[];
      try {
        links = await projectClient.getDeclaredLinks(projectId);
      } catch (error) {
        logDebug("Couldn't read the project's package.json links", {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (current !== read) return;
      const state = useDeclaredProjectLinksStore.getState();
      if (state.projectId === projectId && sameLinks(state.links, links)) continue;
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
