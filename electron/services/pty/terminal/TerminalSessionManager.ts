/**
 * TerminalSessionManager - Handles terminal session persistence.
 *
 * Extracted from TerminalProcess to separate session persistence concerns:
 * - Session snapshot debouncing
 * - Filesystem persistence with atomic writes
 * - Session restoration on spawn
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SESSION_SNAPSHOT_DEBOUNCE_MS = 5000;
const SESSION_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;

function getSessionDir(): string | null {
  const userData = process.env.CANOPY_USER_DATA;
  if (!userData) return null;
  return path.join(userData, "terminal-sessions");
}

function getSessionPath(id: string): string | null {
  const dir = getSessionDir();
  if (!dir) return null;
  return path.join(dir, `${id}.restore`);
}

export interface SessionManagerOptions {
  /** Terminal ID */
  id: string;
  /** Whether this is an agent terminal (agents don't persist) */
  isAgentTerminal: boolean;
  /** Whether persistence is enabled globally */
  persistenceEnabled: boolean;
  /** Function to get serialized state */
  getSerializedState: () => Promise<string | null>;
  /** Function to get serialized state synchronously */
  getSerializedStateSync: () => string | null;
  /** Function to write state to headless terminal for restoration */
  writeToHeadless?: (data: string) => void;
}

export class TerminalSessionManager {
  private persistTimer: NodeJS.Timeout | null = null;
  private persistDirty = false;
  private persistInFlight = false;
  private wasKilled = false;

  constructor(private options: SessionManagerOptions) {}

  /**
   * Attempt to restore session from disk.
   * Should be called during terminal spawn.
   */
  restoreSessionIfPresent(explicitlyDisabled: boolean = false): void {
    if (!this.options.persistenceEnabled) return;
    if (this.options.isAgentTerminal) return;
    if (explicitlyDisabled) return;

    const sessionPath = getSessionPath(this.options.id);
    if (!sessionPath) return;

    try {
      if (!existsSync(sessionPath)) return;
      const content = readFileSync(sessionPath, "utf8");
      if (Buffer.byteLength(content, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) {
        return;
      }
      this.options.writeToHeadless?.(content);
    } catch (error) {
      console.warn(`[TerminalSessionManager] Failed to restore session for ${this.options.id}:`, error);
    }
  }

  /**
   * Schedule a session snapshot to be persisted.
   * Debounces multiple calls.
   */
  scheduleSessionPersist(): void {
    if (!this.options.persistenceEnabled) return;
    if (this.options.isAgentTerminal) return;
    if (this.wasKilled) return;

    this.persistDirty = true;
    if (this.persistTimer) return;

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistSessionSnapshot();
    }, SESSION_SNAPSHOT_DEBOUNCE_MS);
  }

  /**
   * Mark the terminal as killed to prevent further persistence.
   */
  markKilled(): void {
    this.wasKilled = true;
    this.clearTimer();
  }

  /**
   * Clear the persist timer.
   */
  clearTimer(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  /**
   * Check if there are dirty changes that haven't been persisted.
   */
  get isDirty(): boolean {
    return this.persistDirty;
  }

  /**
   * Persist session snapshot synchronously.
   * Used during shutdown for best-effort persistence.
   */
  persistSync(): void {
    if (!this.options.persistenceEnabled) return;
    if (this.options.isAgentTerminal) return;
    if (this.wasKilled) return;
    if (!this.persistDirty) return;

    try {
      const state = this.options.getSerializedStateSync();
      if (!state) return;
      if (Buffer.byteLength(state, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) return;
      this.persistSessionSnapshotSync(state);
      this.persistDirty = false;
    } catch {
      // best-effort only
    }
  }

  private async persistSessionSnapshot(): Promise<void> {
    if (!this.options.persistenceEnabled) return;
    if (this.options.isAgentTerminal) return;
    if (this.wasKilled) return;
    if (!this.persistDirty) return;
    if (this.persistInFlight) return;

    this.persistInFlight = true;
    try {
      this.persistDirty = false;
      const state = await this.options.getSerializedState();
      if (!state) return;
      if (Buffer.byteLength(state, "utf8") > SESSION_SNAPSHOT_MAX_BYTES) return;
      await this.persistSessionSnapshotAsync(state);
    } catch (error) {
      console.warn(`[TerminalSessionManager] Failed to persist session for ${this.options.id}:`, error);
    } finally {
      this.persistInFlight = false;
      if (this.persistDirty) {
        this.scheduleSessionPersist();
      }
    }
  }

  private persistSessionSnapshotSync(state: string): void {
    const sessionPath = getSessionPath(this.options.id);
    const dir = getSessionDir();
    if (!sessionPath || !dir) return;

    mkdirSync(dir, { recursive: true });

    const tmpPath = `${sessionPath}.tmp`;
    writeFileSync(tmpPath, state, "utf8");
    renameSync(tmpPath, sessionPath);
  }

  private async persistSessionSnapshotAsync(state: string): Promise<void> {
    const sessionPath = getSessionPath(this.options.id);
    const dir = getSessionDir();
    if (!sessionPath || !dir) return;

    await mkdir(dir, { recursive: true });

    const tmpPath = `${sessionPath}.tmp`;
    await writeFile(tmpPath, state, "utf8");
    await rename(tmpPath, sessionPath);
  }
}
