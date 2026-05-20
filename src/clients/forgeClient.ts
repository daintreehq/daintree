import type { AuthValidation } from "@shared/types/forge";

export const forgeClient = {
  openIssues: (cwd: string, query?: string, state?: string): Promise<void> => {
    return window.electron.forge.openIssues(cwd, query, state);
  },

  openPRs: (cwd: string, query?: string, state?: string): Promise<void> => {
    return window.electron.forge.openPRs(cwd, query, state);
  },

  openCommits: (cwd: string, branch?: string): Promise<void> => {
    return window.electron.forge.openCommits(cwd, branch);
  },

  openIssue: (cwd: string, issueNumber: number): Promise<void> => {
    return window.electron.forge.openIssue({ cwd, issueNumber });
  },

  getIssueUrl: (cwd: string, issueNumber: number): Promise<string> => {
    return window.electron.forge.getIssueUrl({ cwd, issueNumber });
  },

  assignIssue: (cwd: string, issueNumber: number, username: string): Promise<void> => {
    return window.electron.forge.assignIssue({ cwd, issueNumber, username });
  },

  validateToken: (token: string): Promise<AuthValidation> => {
    return window.electron.forge.validateToken(token);
  },
} as const;
