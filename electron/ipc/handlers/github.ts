import { ipcMain, shell } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type {
  RepositoryStats,
  GitHubCliStatus,
  GitHubTokenConfig,
  GitHubTokenValidation,
} from "../../types/index.js";
import { getWorkspaceClient } from "../../services/WorkspaceClient.js";

export function registerGithubHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleGitHubGetRepoStats = async (
    _event: Electron.IpcMainInvokeEvent,
    cwd: string,
    bypassCache = false
  ): Promise<RepositoryStats> => {
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }

    const fs = await import("fs/promises");
    const pathModule = await import("path");
    const { getRepoStats } = await import("../../services/GitHubService.js");
    const { getCommitCount } = await import("../../utils/git.js");

    try {
      const resolved = pathModule.resolve(cwd);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        return {
          commitCount: 0,
          issueCount: null,
          prCount: null,
          loading: false,
          ghError: "Path is not a directory",
        };
      }

      const statsResult = await getRepoStats(resolved, bypassCache);

      const commitCount = await getCommitCount(resolved).catch(() => 0);

      return {
        commitCount,
        issueCount: statsResult.stats?.issueCount ?? null,
        prCount: statsResult.stats?.prCount ?? null,
        loading: false,
        ghError: statsResult.error,
        stale: statsResult.stats?.stale,
        lastUpdated: statsResult.stats?.lastUpdated,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        commitCount: 0,
        issueCount: null,
        prCount: null,
        loading: false,
        ghError: message,
      };
    }
  };
  ipcMain.handle(CHANNELS.GITHUB_GET_REPO_STATS, handleGitHubGetRepoStats);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_GET_REPO_STATS));

  const handleGitHubOpenIssues = async (_event: Electron.IpcMainInvokeEvent, cwd: string) => {
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    const { getRepoUrl } = await import("../../services/GitHubService.js");
    const repoUrl = await getRepoUrl(cwd);
    if (!repoUrl) {
      throw new Error("Not a GitHub repository");
    }
    await shell.openExternal(`${repoUrl}/issues`);
  };
  ipcMain.handle(CHANNELS.GITHUB_OPEN_ISSUES, handleGitHubOpenIssues);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_OPEN_ISSUES));

  const handleGitHubOpenPRs = async (_event: Electron.IpcMainInvokeEvent, cwd: string) => {
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    const { getRepoUrl } = await import("../../services/GitHubService.js");
    const repoUrl = await getRepoUrl(cwd);
    if (!repoUrl) {
      throw new Error("Not a GitHub repository");
    }
    await shell.openExternal(`${repoUrl}/pulls`);
  };
  ipcMain.handle(CHANNELS.GITHUB_OPEN_PRS, handleGitHubOpenPRs);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_OPEN_PRS));

  const handleGitHubOpenIssue = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { cwd: string; issueNumber: number }
  ) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    if (typeof payload.cwd !== "string" || !payload.cwd) {
      throw new Error("Invalid working directory");
    }
    if (typeof payload.issueNumber !== "number" || payload.issueNumber <= 0) {
      throw new Error("Invalid issue number");
    }
    const { getIssueUrl } = await import("../../services/GitHubService.js");
    const issueUrl = await getIssueUrl(payload.cwd, payload.issueNumber);
    if (!issueUrl) {
      throw new Error("Not a GitHub repository");
    }
    await shell.openExternal(issueUrl);
  };
  ipcMain.handle(CHANNELS.GITHUB_OPEN_ISSUE, handleGitHubOpenIssue);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_OPEN_ISSUE));

  const handleGitHubOpenPR = async (_event: Electron.IpcMainInvokeEvent, prUrl: string) => {
    if (typeof prUrl !== "string" || !prUrl) {
      throw new Error("Invalid PR URL");
    }
    try {
      const url = new URL(prUrl);
      if (!["https:", "http:"].includes(url.protocol)) {
        throw new Error(`Only https:// or http:// PR URLs are allowed, got ${url.protocol}`);
      }
    } catch (error) {
      throw new Error(`Invalid PR URL: ${error instanceof Error ? error.message : String(error)}`);
    }
    await shell.openExternal(prUrl);
  };
  ipcMain.handle(CHANNELS.GITHUB_OPEN_PR, handleGitHubOpenPR);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_OPEN_PR));

  const handleGitHubCheckCli = async (): Promise<GitHubCliStatus> => {
    const { hasGitHubToken } = await import("../../services/GitHubService.js");
    if (hasGitHubToken()) {
      return { available: true };
    }
    return { available: false, error: "GitHub token not configured. Set up in Settings." };
  };
  ipcMain.handle(CHANNELS.GITHUB_CHECK_CLI, handleGitHubCheckCli);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_CHECK_CLI));

  const handleGitHubGetConfig = async (): Promise<GitHubTokenConfig> => {
    const { getGitHubConfig } = await import("../../services/GitHubService.js");
    return getGitHubConfig();
  };
  ipcMain.handle(CHANNELS.GITHUB_GET_CONFIG, handleGitHubGetConfig);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_GET_CONFIG));

  const handleGitHubSetToken = async (
    _event: Electron.IpcMainInvokeEvent,
    token: string
  ): Promise<GitHubTokenValidation> => {
    if (typeof token !== "string" || !token.trim()) {
      return { valid: false, scopes: [], error: "Token is required" };
    }

    const { validateGitHubToken, setGitHubToken } = await import("../../services/GitHubService.js");

    const validation = await validateGitHubToken(token.trim());

    if (validation.valid) {
      setGitHubToken(token.trim());

      try {
        const workspaceClient = getWorkspaceClient();
        workspaceClient.updateGitHubToken(token.trim());
      } catch {
        // WorkspaceClient may not be initialized yet
      }
    }

    return validation;
  };
  ipcMain.handle(CHANNELS.GITHUB_SET_TOKEN, handleGitHubSetToken);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_SET_TOKEN));

  const handleGitHubClearToken = async (): Promise<void> => {
    const { clearGitHubToken } = await import("../../services/GitHubService.js");
    clearGitHubToken();

    try {
      const workspaceClient = getWorkspaceClient();
      workspaceClient.updateGitHubToken(null);
    } catch {
      // WorkspaceClient may not be initialized yet
    }
  };
  ipcMain.handle(CHANNELS.GITHUB_CLEAR_TOKEN, handleGitHubClearToken);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_CLEAR_TOKEN));

  const handleGitHubValidateToken = async (
    _event: Electron.IpcMainInvokeEvent,
    token: string
  ): Promise<GitHubTokenValidation> => {
    if (typeof token !== "string" || !token.trim()) {
      return { valid: false, scopes: [], error: "Token is required" };
    }

    const { validateGitHubToken } = await import("../../services/GitHubService.js");
    return validateGitHubToken(token.trim());
  };
  ipcMain.handle(CHANNELS.GITHUB_VALIDATE_TOKEN, handleGitHubValidateToken);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_VALIDATE_TOKEN));

  const handleGitHubListIssues = async (
    _event: Electron.IpcMainInvokeEvent,
    options: { cwd: string; search?: string; state?: "open" | "closed" | "all"; cursor?: string }
  ) => {
    if (!options || typeof options.cwd !== "string" || !options.cwd) {
      throw new Error("Invalid options: cwd is required");
    }

    const { listIssues } = await import("../../services/GitHubService.js");
    return listIssues(options);
  };
  ipcMain.handle(CHANNELS.GITHUB_LIST_ISSUES, handleGitHubListIssues);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_LIST_ISSUES));

  const handleGitHubListPRs = async (
    _event: Electron.IpcMainInvokeEvent,
    options: {
      cwd: string;
      search?: string;
      state?: "open" | "closed" | "merged" | "all";
      cursor?: string;
    }
  ) => {
    if (!options || typeof options.cwd !== "string" || !options.cwd) {
      throw new Error("Invalid options: cwd is required");
    }

    const { listPullRequests } = await import("../../services/GitHubService.js");
    return listPullRequests(options);
  };
  ipcMain.handle(CHANNELS.GITHUB_LIST_PRS, handleGitHubListPRs);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_LIST_PRS));

  const handleGitHubAssignIssue = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { cwd: string; issueNumber: number; username: string }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
      throw new Error("Invalid working directory");
    }
    if (
      typeof payload.issueNumber !== "number" ||
      !Number.isInteger(payload.issueNumber) ||
      payload.issueNumber <= 0
    ) {
      throw new Error("Invalid issue number");
    }
    const trimmedUsername = payload.username?.trim();
    if (typeof payload.username !== "string" || !trimmedUsername) {
      throw new Error("Invalid username");
    }

    const { assignIssue } = await import("../../services/GitHubService.js");
    await assignIssue(payload.cwd.trim(), payload.issueNumber, trimmedUsername);
  };
  ipcMain.handle(CHANNELS.GITHUB_ASSIGN_ISSUE, handleGitHubAssignIssue);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GITHUB_ASSIGN_ISSUE));

  return () => handlers.forEach((cleanup) => cleanup());
}
