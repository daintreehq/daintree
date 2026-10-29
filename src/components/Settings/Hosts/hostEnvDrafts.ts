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
  /** The first host with an unsaved edit, which a close shows instead of closing. */
  firstUnsaved: (): string | undefined => drafts.keys().next().value,
  clear: (): void => {
    drafts.clear();
  },
};
