import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import type { HandlerDependencies } from "../types.js";
import type { WorktreeConfig } from "../../../shared/types/index.js";
import {
  validatePathPattern,
  DEFAULT_WORKTREE_PATH_PATTERN,
} from "../../../shared/utils/pathPattern.js";
import { typedHandle } from "../utils.js";

function getWorktreeConfig(): WorktreeConfig {
  const raw = store.get("worktreeConfig");
  if (!raw || typeof raw !== "object") {
    return { pathPattern: DEFAULT_WORKTREE_PATH_PATTERN };
  }
  return {
    pathPattern:
      typeof raw.pathPattern === "string" && raw.pathPattern.trim()
        ? raw.pathPattern
        : DEFAULT_WORKTREE_PATH_PATTERN,
  };
}

function readWslGitMap(): Record<string, { enabled: boolean; dismissed: boolean }> {
  const raw = store.get("wslGitByWorktree");
  if (!raw || typeof raw !== "object") return {};
  return raw as Record<string, { enabled: boolean; dismissed: boolean }>;
}

function writeWslGitEntry(
  worktreeId: string,
  entry: { enabled: boolean; dismissed: boolean }
): void {
  const map = { ...readWslGitMap(), [worktreeId]: entry };
  store.set("wslGitByWorktree", map);
}

export function registerWorktreeConfigHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleGetConfig = async (): Promise<WorktreeConfig> => {
    return getWorktreeConfig();
  };
  handlers.push(typedHandle(CHANNELS.WORKTREE_CONFIG_GET, handleGetConfig));

  const handleSetPattern = async (payload: { pattern: string }): Promise<WorktreeConfig> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid worktree config payload");
    }

    const { pattern } = payload;

    if (typeof pattern !== "string") {
      throw new Error("Invalid pattern: must be a string");
    }

    const trimmedPattern = pattern.trim();
    const validation = validatePathPattern(trimmedPattern);

    if (!validation.valid) {
      throw new Error(validation.error);
    }

    store.set("worktreeConfig.pathPattern", trimmedPattern);
    return getWorktreeConfig();
  };
  handlers.push(typedHandle(CHANNELS.WORKTREE_CONFIG_SET_PATTERN, handleSetPattern));

  const handleSetWslGit = async (payload: {
    worktreeId: string;
    enabled: boolean;
  }): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid set-wsl-git payload");
    }
    const { worktreeId, enabled } = payload;
    if (typeof worktreeId !== "string" || !worktreeId.trim()) {
      throw new Error("Invalid worktreeId: must be a non-empty string");
    }
    if (typeof enabled !== "boolean") {
      throw new Error("Invalid enabled: must be a boolean");
    }

    // Opting in implies the banner is no longer needed; opting out leaves
    // dismissed alone (so the banner won't pop back unexpectedly).
    const existing = readWslGitMap()[worktreeId];
    const dismissed = enabled ? true : Boolean(existing?.dismissed);
    writeWslGitEntry(worktreeId, { enabled, dismissed });
    deps.worktreeService?.setWslOptIn(worktreeId, enabled, dismissed);
  };
  handlers.push(typedHandle(CHANNELS.WORKTREE_CONFIG_SET_WSL_GIT, handleSetWslGit));

  const handleDismissWslBanner = async (payload: { worktreeId: string }): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid dismiss-wsl-banner payload");
    }
    const { worktreeId } = payload;
    if (typeof worktreeId !== "string" || !worktreeId.trim()) {
      throw new Error("Invalid worktreeId: must be a non-empty string");
    }

    const existing = readWslGitMap()[worktreeId];
    const enabled = Boolean(existing?.enabled);
    writeWslGitEntry(worktreeId, { enabled, dismissed: true });
    deps.worktreeService?.setWslOptIn(worktreeId, enabled, true);
  };
  handlers.push(typedHandle(CHANNELS.WORKTREE_CONFIG_DISMISS_WSL_BANNER, handleDismissWslBanner));

  return () => handlers.forEach((cleanup) => cleanup());
}
