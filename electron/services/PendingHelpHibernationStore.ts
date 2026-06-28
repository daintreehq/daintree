import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { resilientAtomicWriteFile } from "../utils/fs.js";

const FILE_NAME = "help-pending-hibernation.json";
const FILE_VERSION = 1;
// Anything older than this on read is treated as stale and dropped. The
// hibernation token is the agent's resume ID; stale tokens point at a
// transcript file the agent may have rotated or pruned, so resume would
// likely fail anyway. Two weeks is generous enough to cover real "I forgot
// about that project" gaps without indefinitely growing the file.
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export interface PendingHelpHibernation {
  agentId: string;
  agentSessionId: string;
  cwd: string;
  capturedAt: number;
  // In-memory only — whether the assistant panel was open when this token was
  // captured this session. Drives auto-reopen + auto-resume on cold
  // switch-back. Deliberately stripped before persisting (see `persist()`):
  // tokens reloaded from disk on app restart are prior-session entries and
  // must NOT auto-resume — only this-session eviction/crash captures do.
  panelWasOpen?: boolean;
}

// Persisted shape excludes `panelWasOpen` — it is an in-memory-only field.
type PersistedHelpHibernation = Omit<PendingHelpHibernation, "panelWasOpen">;

interface FileShape {
  version: number;
  entries: Record<string, PersistedHelpHibernation>;
}

/**
 * Persists assistant resume tokens captured by main on LRU eviction / window
 * close, so the next time the user reopens the project the renderer can
 * resume the conversation. Owned by main because the renderer being evicted
 * has no reliable lifetime to capture and persist itself.
 *
 * Renderer-local `helpPanelStore.hibernateSessions` remains the primary
 * resume source for graceful close. This store is the fallback for the
 * eviction path the renderer can't cover.
 */
export class PendingHelpHibernationStore {
  private entries = new Map<string, PendingHelpHibernation>();
  private loaded = false;
  private filePath: string;
  // Serialize writes so a rapid capture-then-clear can't race on disk.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(app.getPath("userData"), FILE_NAME);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      if (!parsed || typeof parsed !== "object") return;
      if (parsed.version !== FILE_VERSION) return;
      const entries = parsed.entries;
      if (!entries || typeof entries !== "object") return;
      const cutoff = Date.now() - STALE_AFTER_MS;
      for (const [projectId, entry] of Object.entries(entries)) {
        if (!projectId) continue;
        if (!this.isValid(entry)) continue;
        if (entry.capturedAt < cutoff) continue;
        // Defensively strip any `panelWasOpen` that reached disk (manual edit,
        // corruption, or a regression in `persist()`): the field is in-memory
        // only and a disk-loaded `true` would auto-resume a prior-session token
        // on app restart — the exact invariant this feature must never break.
        const { panelWasOpen: _panelWasOpen, ...safeEntry } = entry as PendingHelpHibernation;
        this.entries.set(projectId, safeEntry);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      console.warn("[PendingHelpHibernationStore] Failed to load:", err);
    }
  }

  get(projectId: string): PendingHelpHibernation | null {
    return this.entries.get(projectId) ?? null;
  }

  set(projectId: string, entry: PendingHelpHibernation): Promise<void> {
    this.entries.set(projectId, entry);
    return this.persist();
  }

  clear(projectId: string): Promise<void> {
    if (!this.entries.has(projectId)) return Promise.resolve();
    this.entries.delete(projectId);
    return this.persist();
  }

  private isValid(value: unknown): value is PendingHelpHibernation {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    // An empty `agentSessionId` is the valid resume-latest sentinel (#9639):
    // it routes the renderer down `buildResumeLatestCommand` rather than a
    // fresh launch. Only the field's type is required, not non-emptiness.
    return (
      typeof v.agentId === "string" &&
      v.agentId !== "" &&
      typeof v.agentSessionId === "string" &&
      typeof v.cwd === "string" &&
      v.cwd !== "" &&
      typeof v.capturedAt === "number" &&
      Number.isFinite(v.capturedAt) &&
      // Reject far-future timestamps (corruption / clock skew): the staleness
      // cutoff is `capturedAt < now - 14d`, so a future stamp would never age
      // out and would pin a dead resume entry permanently.
      v.capturedAt <= Date.now()
    );
  }

  private persist(): Promise<void> {
    // Strip `panelWasOpen` (in-memory only) so reloaded entries on app restart
    // are treated as prior-session tokens that never auto-resume.
    const persistedEntries: Record<string, PersistedHelpHibernation> = {};
    for (const [projectId, entry] of this.entries.entries()) {
      const { panelWasOpen: _panelWasOpen, ...persisted } = entry;
      persistedEntries[projectId] = persisted;
    }
    const snapshot: FileShape = {
      version: FILE_VERSION,
      entries: persistedEntries,
    };
    const work = this.writeChain
      .catch(() => undefined)
      .then(() =>
        resilientAtomicWriteFile(this.filePath, JSON.stringify(snapshot, null, 2) + "\n", "utf-8", {
          mode: 0o600,
        }).catch((err) => {
          console.warn("[PendingHelpHibernationStore] Failed to persist:", err);
        })
      );
    this.writeChain = work;
    return work;
  }
}

let instance: PendingHelpHibernationStore | null = null;

export function getPendingHelpHibernationStore(): PendingHelpHibernationStore {
  if (!instance) {
    instance = new PendingHelpHibernationStore();
  }
  return instance;
}

export function __resetPendingHelpHibernationStoreForTests(): void {
  instance = null;
}
