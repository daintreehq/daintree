import { GitService } from "./GitService.js";

export class TaskWorktreeService {
  private taskWorktreeMap = new Map<string, Map<string, Set<string>>>();
  private gitServiceCache = new Map<string, GitService>();

  getProjectTaskMap(projectId: string): Map<string, Set<string>> {
    if (!this.taskWorktreeMap.has(projectId)) {
      this.taskWorktreeMap.set(projectId, new Map());
    }
    return this.taskWorktreeMap.get(projectId)!;
  }

  addTaskWorktreeMapping(projectId: string, taskId: string, worktreeId: string): void {
    const projectMap = this.getProjectTaskMap(projectId);
    if (!projectMap.has(taskId)) {
      projectMap.set(taskId, new Set());
    }
    projectMap.get(taskId)!.add(worktreeId);
  }

  removeTaskWorktreeMapping(projectId: string, taskId: string, worktreeId: string): void {
    const projectMap = this.getProjectTaskMap(projectId);
    const worktrees = projectMap.get(taskId);
    if (worktrees) {
      worktrees.delete(worktreeId);
      if (worktrees.size === 0) {
        projectMap.delete(taskId);
      }
    }
  }

  getWorktreeIdsForTask(projectId: string, taskId: string): string[] {
    const projectMap = this.getProjectTaskMap(projectId);
    const worktrees = projectMap.get(taskId);
    return worktrees ? Array.from(worktrees) : [];
  }

  getGitService(path: string): GitService {
    let service = this.gitServiceCache.get(path);
    if (!service) {
      service = new GitService(path);
      this.gitServiceCache.set(path, service);
    }
    return service;
  }

  onProjectSwitch(): void {
    this.taskWorktreeMap.clear();
    this.gitServiceCache.clear();
  }
}

export const taskWorktreeService = new TaskWorktreeService();
