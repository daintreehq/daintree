import type {
  AuthValidation,
  PushErrorClassification,
  Issue,
  PR,
  Page,
  RepoMetadata,
  ListOptions,
} from "@shared/types/forge";

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

  listIssues: (cwd: string, opts?: ListOptions): Promise<Page<Issue>> => {
    return window.electron.forge.listIssues({ cwd, opts });
  },

  listPRs: (cwd: string, opts?: ListOptions): Promise<Page<PR>> => {
    return window.electron.forge.listPRs({ cwd, opts });
  },

  getIssue: (cwd: string, issueNumber: number): Promise<Issue | null> => {
    return window.electron.forge.getIssue({ cwd, issueNumber });
  },

  getPR: (cwd: string, prNumber: number): Promise<PR | null> => {
    return window.electron.forge.getPR({ cwd, prNumber });
  },

  getRepoMetadata: (cwd: string): Promise<RepoMetadata> => {
    return window.electron.forge.getRepoMetadata({ cwd });
  },

  classifyPushError: (
    cwd: string,
    stderr: string
  ): Promise<{ providerId: string; classification: PushErrorClassification | null } | null> => {
    return window.electron.forge.classifyPushError({ cwd, stderr });
  },
} as const;
