import type { SpawnError, SpawnErrorCode } from "@shared/types/pty-host";
import { boundedErrorText } from "@/utils/errorText";

export interface SpawnErrorBannerCopy {
  title: string;
  description: (error: SpawnError, cwd?: string) => string;
}

export const SPAWN_ERROR_BANNER_COPY = {
  ENOENT: {
    title: "Couldn't find shell or command",
    description: (error) => {
      const safePath = error.path ? boundedErrorText(error.path) : "";
      return safePath ? `Couldn't find: ${safePath}` : boundedErrorText(error.message);
    },
  },
  EACCES: {
    title: "Couldn't execute shell",
    description: (error) => {
      const safePath = error.path ? boundedErrorText(error.path) : "";
      return `Couldn't execute ${safePath || "the shell"} — check permissions`;
    },
  },
  ENOTDIR: {
    title: "Invalid working directory",
    description: (_error, cwd) => {
      const safeCwd = cwd ? boundedErrorText(cwd) : "";
      return `The working directory isn't valid: ${safeCwd || "(unknown)"}`;
    },
  },
  EIO: {
    title: "Couldn't allocate terminal",
    description: () =>
      "Couldn't allocate a terminal session. The system may be running low on resources.",
  },
  EMFILE: {
    title: "File descriptor limit reached",
    description: () =>
      "The per-process file descriptor limit was reached. Try closing some terminals to free up descriptors.",
  },
  EAGAIN: {
    title: "Process limit reached",
    description: () =>
      "The system process limit was hit (fork failed). Wait a moment and retry, or close some terminals.",
  },
  ENOMEM: {
    title: "Out of memory",
    description: () =>
      "The system is out of memory. Try closing other applications to free up memory.",
  },
  ENXIO: {
    title: "PTY pool exhausted",
    description: () =>
      "The pseudo-terminal pool is exhausted. Try closing some terminals and retrying.",
  },
  EBUSY: {
    title: "Terminal device busy",
    description: () => "The terminal device is busy. Retry or close the conflicting terminal.",
  },
  DISCONNECTED: {
    title: "Terminal disconnected",
    description: () => "The terminal process is no longer running.",
  },
  PENDING_SPAWNS_CAPPED: {
    title: "Too many pending restarts",
    description: () =>
      "Restart requests are being throttled to prevent a restart storm. Wait a moment and retry.",
  },
  TERMINAL_ALREADY_LIVE: {
    title: "Terminal already running",
    description: () =>
      "This terminal already has a running process, so the existing one was kept. Retry to restart it.",
  },
  UNKNOWN: {
    title: "Couldn't start terminal",
    description: (error) => boundedErrorText(error.message),
  },
} as const satisfies Record<SpawnErrorCode, SpawnErrorBannerCopy>;
