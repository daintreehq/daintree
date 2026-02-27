import type {
  Project,
  ProjectSettings,
  RunCommand,
  ProjectCloseResult,
  ProjectStats,
  TerminalRecipe,
  TerminalSnapshot,
  TabGroup,
} from "@shared/types";
import type {
  GitInitOptions,
  GitInitResult,
  GitInitProgressEvent,
} from "@shared/types/ipc/gitInit";

/**
 * @example
 * ```typescript
 * import { projectClient } from "@/clients/projectClient";
 *
 * const projects = await projectClient.getAll();
 * const cleanup = projectClient.onSwitch(({ project, switchId }) => console.log(project, switchId));
 * ```
 */
export const projectClient = {
  getAll: (): Promise<Project[]> => {
    return window.electron.project.getAll();
  },

  getCurrent: (): Promise<Project | null> => {
    return window.electron.project.getCurrent();
  },

  add: (path: string): Promise<Project> => {
    return window.electron.project.add(path);
  },

  remove: (projectId: string): Promise<void> => {
    return window.electron.project.remove(projectId);
  },

  update: (projectId: string, updates: Partial<Project>): Promise<Project> => {
    return window.electron.project.update(projectId, updates);
  },

  switch: (projectId: string): Promise<Project> => {
    return window.electron.project.switch(projectId);
  },

  openDialog: (): Promise<string | null> => {
    return window.electron.project.openDialog();
  },

  onSwitch: (callback: (payload: { project: Project; switchId: string }) => void): (() => void) => {
    return window.electron.project.onSwitch(callback);
  },

  getSettings: (projectId: string): Promise<ProjectSettings> => {
    return window.electron.project.getSettings(projectId);
  },

  saveSettings: (projectId: string, settings: ProjectSettings): Promise<void> => {
    return window.electron.project.saveSettings(projectId, settings);
  },

  detectRunners: (projectId: string): Promise<RunCommand[]> => {
    return window.electron.project.detectRunners(projectId);
  },

  close: (
    projectId: string,
    options?: { killTerminals?: boolean }
  ): Promise<ProjectCloseResult> => {
    return window.electron.project.close(projectId, options);
  },

  reopen: (projectId: string): Promise<Project> => {
    return window.electron.project.reopen(projectId);
  },

  getStats: (projectId: string): Promise<ProjectStats> => {
    return window.electron.project.getStats(projectId);
  },

  createFolder: (parentPath: string, folderName: string): Promise<string> => {
    return window.electron.project.createFolder(parentPath, folderName);
  },

  initGit: (directoryPath: string): Promise<void> => {
    return window.electron.project.initGit(directoryPath);
  },

  initGitGuided: (options: GitInitOptions): Promise<GitInitResult> => {
    return window.electron.project.initGitGuided(options);
  },

  onInitGitProgress: (callback: (event: GitInitProgressEvent) => void): (() => void) => {
    return window.electron.project.onInitGitProgress(callback);
  },

  getRecipes: (projectId: string): Promise<TerminalRecipe[]> => {
    return window.electron.project.getRecipes(projectId);
  },

  saveRecipes: (projectId: string, recipes: TerminalRecipe[]): Promise<void> => {
    return window.electron.project.saveRecipes(projectId, recipes);
  },

  addRecipe: (projectId: string, recipe: TerminalRecipe): Promise<void> => {
    return window.electron.project.addRecipe(projectId, recipe);
  },

  updateRecipe: (
    projectId: string,
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> => {
    return window.electron.project.updateRecipe(projectId, recipeId, updates);
  },

  deleteRecipe: (projectId: string, recipeId: string): Promise<void> => {
    return window.electron.project.deleteRecipe(projectId, recipeId);
  },

  getTerminals: (projectId: string): Promise<TerminalSnapshot[]> => {
    return window.electron.project.getTerminals(projectId);
  },

  setTerminals: (projectId: string, terminals: TerminalSnapshot[]): Promise<void> => {
    return window.electron.project.setTerminals(projectId, terminals);
  },

  getTerminalSizes: (
    projectId: string
  ): Promise<Record<string, { cols: number; rows: number }>> => {
    return window.electron.project.getTerminalSizes(projectId);
  },

  setTerminalSizes: (
    projectId: string,
    terminalSizes: Record<string, { cols: number; rows: number }>
  ): Promise<void> => {
    return window.electron.project.setTerminalSizes(projectId, terminalSizes);
  },

  getTabGroups: (projectId: string): Promise<TabGroup[]> => {
    return window.electron.project.getTabGroups(projectId);
  },

  setTabGroups: (projectId: string, tabGroups: TabGroup[]): Promise<void> => {
    return window.electron.project.setTabGroups(projectId, tabGroups);
  },
} as const;
