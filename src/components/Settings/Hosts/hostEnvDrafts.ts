import type { EnvVarDraft } from "../EnvVarRow";

/**
 * Unsaved edits to hosts' environment variables, by host, for one open of
 * Settings: picking another machine or going back to this one unmounts a
 * host's page, and its draft waits here for it. Closing Settings with one
 * still unsaved shows it instead of closing; the dialog clears the rest
 * once it has closed.
 */
export interface HostEnvDraft {
  rows: EnvVarDraft[];
  /** The set the edit started from, and the revision a Save is made against. */
  base: { record: Record<string, string> | null; revision?: string };
  /** The host's set changed under the edit; the next Save replaces it. */
  movedUnder: boolean;
}

const drafts = new Map<string, HostEnvDraft>();

export const hostEnvDrafts = {
  get: (hostId: string): HostEnvDraft | undefined => drafts.get(hostId),
  set: (hostId: string, draft: HostEnvDraft): void => {
    drafts.set(hostId, draft);
  },
  /** Saved or discarded: nothing left to keep. */
  delete: (hostId: string): void => {
    drafts.delete(hostId);
  },
  /**
   * The first host still offered with an unsaved edit, which a close shows
   * instead of closing. One that is no longer offered can't be shown, and
   * must not stand in front of another that can.
   */
  firstUnsaved: (offered: (hostId: string) => boolean): string | undefined => {
    for (const hostId of drafts.keys()) if (offered(hostId)) return hostId;
    return undefined;
  },
  clear: (): void => {
    drafts.clear();
  },
};
