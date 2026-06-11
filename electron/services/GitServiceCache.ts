import { GitService } from "./GitService.js";

class GitServiceCache {
  private cache = new Map<string, GitService>();

  getGitService(path: string): GitService {
    let service = this.cache.get(path);
    if (!service) {
      service = new GitService(path);
      this.cache.set(path, service);
    }
    return service;
  }

  delete(path: string): void {
    this.cache.delete(path);
  }

  clear(): void {
    this.cache.clear();
  }
}

export const gitServiceCache = new GitServiceCache();
