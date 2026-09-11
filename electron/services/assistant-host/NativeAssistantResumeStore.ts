import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { resilientAtomicWriteFile } from "../../utils/fs.js";
import { createLogger } from "../../utils/logger.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  isValidAssistantSlot,
  projectIdFromSlotKey,
} from "../../../shared/config/assistantSlots.js";
import type { AssistantHostResumableLane } from "../../../shared/types/ipc/assistantHostIpc.js";

const logger = createLogger("main:AssistantResume");

const FILE_NAME = "assistant-native-resume.json";
const FILE_VERSION = 1;
/**
 * Older than this on read is dropped. The engine would still continue the conversation,
 * but the panel cannot show what was said in it, and picking up weeks-old context behind
 * an empty transcript is not what someone reopening a forgotten project expects. The same
 * two weeks the PTY resume tokens get.
 */
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/** The engine refuses a descriptor whose `resumeSessionId` is longer than this. */
const MAX_RESUME_ID_BYTES = 256;

export interface NativeAssistantResumeRecord {
  /** The id the engine stores this lane's conversation under. */
  resumeSessionId: string;
  capturedAt: number;
  /**
   * Whether the panel was open when the lane's engine went down with its view. In memory
   * only, like the PTY store's flag of the same name: a record read back from disk after
   * a restart describes an earlier run of the app, and must never reopen a panel.
   */
  panelWasOpen?: boolean;
}

type PersistedRecord = Omit<NativeAssistantResumeRecord, "panelWasOpen">;

interface FileShape {
  version: number;
  entries: Record<string, PersistedRecord>;
}

function isPersistedRecord(value: unknown): value is PersistedRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.resumeSessionId === "string" &&
    v.resumeSessionId !== "" &&
    Buffer.byteLength(v.resumeSessionId, "utf8") <= MAX_RESUME_ID_BYTES &&
    typeof v.capturedAt === "number" &&
    Number.isFinite(v.capturedAt) &&
    // A future stamp would never age out.
    v.capturedAt <= Date.now()
  );
}

function slotFromSlotKey(slotKey: string): number | null {
  const at = slotKey.lastIndexOf("\u0000");
  if (at === -1) return null;
  const slot = Number(slotKey.slice(at + 1));
  return isValidAssistantSlot(slot) ? slot : null;
}

/**
 * Which conversation each native assistant lane is having, by
 * `assistantSlotKey(workspaceId, slot)` (#12365).
 *
 * The engine keeps a conversation in its own database for as long as it is asked to
 * continue it, but only the host can ask — and the renderer that knew the id is the
 * thing an eviction or a crash destroys. So main keeps it, beside the service that
 * starts the engines, and on disk so an app restart does not lose it either.
 *
 * Kept apart from `PendingHelpHibernationStore` on purpose. Those entries are one-shot
 * resume tokens for a CLI agent, taken by the launch that uses them and read by paths
 * that launch whatever agent the entry names; a native record is a standing pointer that
 * every start of the lane reads and only an explicit discard removes.
 */
export class NativeAssistantResumeStore {
  private readonly entries = new Map<string, NativeAssistantResumeRecord>();
  /**
   * One read, shared. Starts on different lanes are not serialized with each other, so a
   * load that marked itself done before its read resolved would hand the second caller an
   * empty map — and it would start a fresh conversation over a recorded one.
   */
  private loading: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly explicitFilePath?: string) {}

  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  get(slotKey: string): NativeAssistantResumeRecord | null {
    return this.entries.get(slotKey) ?? null;
  }

  set(slotKey: string, resumeSessionId: string): Promise<void> {
    this.entries.set(slotKey, { resumeSessionId, capturedAt: Date.now() });
    return this.persist();
  }

  clear(slotKey: string): Promise<void> {
    if (!this.entries.delete(slotKey)) return Promise.resolve();
    return this.persist();
  }

  /** Stamps a recorded lane's panel state. In memory only; a lane with no record is left alone. */
  markPanelWasOpen(slotKey: string, panelWasOpen: boolean): void {
    const entry = this.entries.get(slotKey);
    if (entry) this.entries.set(slotKey, { ...entry, panelWasOpen });
  }

  /** The recorded lanes of one workspace, lowest slot first. */
  lanesFor(projectId: string): AssistantHostResumableLane[] {
    const lanes: AssistantHostResumableLane[] = [];
    for (const [slotKey, entry] of this.entries) {
      if (projectIdFromSlotKey(slotKey) !== projectId) continue;
      const slot = slotFromSlotKey(slotKey);
      if (slot === null) continue;
      lanes.push({ slot, panelWasOpen: entry.panelWasOpen === true });
    }
    return lanes.sort((a, b) => a.slot - b.slot);
  }

  /** Resolves once every write asked for so far has landed or failed. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private filePath(): string {
    return this.explicitFilePath ?? path.join(app.getPath("userData"), FILE_NAME);
  }

  private async read(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath(), "utf-8")) as Partial<FileShape>;
      if (!parsed || typeof parsed !== "object" || parsed.version !== FILE_VERSION) return;
      if (!parsed.entries || typeof parsed.entries !== "object") return;
      const cutoff = Date.now() - STALE_AFTER_MS;
      for (const [slotKey, entry] of Object.entries(parsed.entries)) {
        if (slotFromSlotKey(slotKey) === null || !isPersistedRecord(entry)) continue;
        if (entry.capturedAt < cutoff) continue;
        // Rebuilt field by field so nothing else on disk — a `panelWasOpen` included —
        // survives into memory.
        this.entries.set(slotKey, {
          resumeSessionId: entry.resumeSessionId,
          capturedAt: entry.capturedAt,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      logger.warn("Failed to load native assistant resume records", {
        error: formatErrorMessage(error, "unknown"),
      });
    }
  }

  private persist(): Promise<void> {
    // Snapshotted now, written in order: a clear queued behind a set must land last.
    const entries: Record<string, PersistedRecord> = {};
    for (const [slotKey, { resumeSessionId, capturedAt }] of this.entries) {
      entries[slotKey] = { resumeSessionId, capturedAt };
    }
    const body = `${JSON.stringify({ version: FILE_VERSION, entries } satisfies FileShape, null, 2)}\n`;
    const work = this.writeChain.then(async () => {
      try {
        await resilientAtomicWriteFile(this.filePath(), body, "utf-8", { mode: 0o600 });
      } catch (error) {
        logger.warn("Failed to persist native assistant resume records", {
          error: formatErrorMessage(error, "unknown"),
        });
      }
    });
    this.writeChain = work;
    return work;
  }
}

let instance: NativeAssistantResumeStore | null = null;

export function getNativeAssistantResumeStore(): NativeAssistantResumeStore {
  instance ??= new NativeAssistantResumeStore();
  return instance;
}

export function __resetNativeAssistantResumeStoreForTests(
  store: NativeAssistantResumeStore | null = null
): void {
  instance = store;
}
