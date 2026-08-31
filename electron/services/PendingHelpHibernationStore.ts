import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import { rebaseAbsolutePath } from "../../shared/utils/projectPathRelocation.js";
import {
  DEFAULT_ASSISTANT_SLOT,
  assistantSlotKey,
  projectIdFromSlotKey,
} from "../../shared/config/assistantSlots.js";

const FILE_NAME = "help-pending-hibernation.json";
// v2 keys entries by `assistantSlotKey(projectId, slot)` instead of bare
// projectId (#12108). v1 files are migrated on read rather than dropped —
// `load()` discards anything whose version it doesn't recognize, so skipping
// the migration would silently destroy every existing user's resume tokens.
const FILE_VERSION = 2;
const LEGACY_UNSLOTTED_FILE_VERSION = 1;
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
      const legacyUnslotted = parsed.version === LEGACY_UNSLOTTED_FILE_VERSION;
      if (parsed.version !== FILE_VERSION && !legacyUnslotted) return;
      const entries = parsed.entries;
      if (!entries || typeof entries !== "object") return;
      const cutoff = Date.now() - STALE_AFTER_MS;
      for (const [rawKey, entry] of Object.entries(entries)) {
        if (!rawKey) continue;
        // A v1 key is a bare project id, which by definition described the one
        // lane that existed then — slot 0.
        const key = legacyUnslotted ? assistantSlotKey(rawKey, DEFAULT_ASSISTANT_SLOT) : rawKey;
        if (!this.isValid(entry)) continue;
        if (entry.capturedAt < cutoff) continue;
        // Defensively strip any `panelWasOpen` that reached disk (manual edit,
        // corruption, or a regression in `persist()`): the field is in-memory
        // only and a disk-loaded `true` would auto-resume a prior-session token
        // on app restart — the exact invariant this feature must never break.
        const { panelWasOpen: _panelWasOpen, ...safeEntry } = entry as PendingHelpHibernation;
        this.entries.set(key, safeEntry);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      console.warn("[PendingHelpHibernationStore] Failed to load:", err);
    }
  }

  /** `slotKey` is `assistantSlotKey(projectId, slot)` — see #12108. */
  get(slotKey: string): PendingHelpHibernation | null {
    return this.entries.get(slotKey) ?? null;
  }

  set(slotKey: string, entry: PendingHelpHibernation): Promise<void> {
    this.entries.set(slotKey, entry);
    return this.persist();
  }

  clear(slotKey: string): Promise<void> {
    if (!this.entries.has(slotKey)) return Promise.resolve();
    this.entries.delete(slotKey);
    return this.persist();
  }

  /**
   * Rebase a project's captured Assistant cwd after a folder move/rename
   * (#11282, phase 2), so the hibernated conversation resumes in the moved
   * folder rather than the vanished old one. No-op when the project has no
   * entry or its cwd is unaffected by the move.
   */
  async rewriteProjectPath(projectId: string, oldRoot: string, newRoot: string): Promise<void> {
    await this.load();
    // Every lane of the project, not one key (#12108): each lane captured its
    // own cwd under the old root, and leaving a sibling behind would resume it
    // in a folder that no longer exists.
    let changed = false;
    for (const [slotKey, entry] of this.entries) {
      if (projectIdFromSlotKey(slotKey) !== projectId) continue;
      const nextCwd = rebaseAbsolutePath(entry.cwd, oldRoot, newRoot);
      if (nextCwd === entry.cwd) continue;
      this.entries.set(slotKey, { ...entry, cwd: nextCwd });
      changed = true;
    }
    if (changed) await this.persist();
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
    for (const [slotKey, entry] of this.entries.entries()) {
      const { panelWasOpen: _panelWasOpen, ...persisted } = entry;
      persistedEntries[slotKey] = persisted;
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
