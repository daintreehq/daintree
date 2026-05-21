import { GitHubAuth } from "./GitHubAuth.js";
import { clearGitHubCaches } from "./GitHubCaches.js";

export function getGitHubToken(): string | undefined {
  return GitHubAuth.getToken();
}

export function hasGitHubToken(): boolean {
  return GitHubAuth.hasToken();
}

export function setGitHubToken(token: string): void {
  GitHubAuth.setToken(token);
  clearGitHubCaches();
}

export function clearGitHubToken(): void {
  GitHubAuth.clearToken();
  clearGitHubCaches();
}

export function getGitHubConfig() {
  return GitHubAuth.getConfig();
}

export async function getGitHubConfigAsync() {
  return GitHubAuth.getConfigAsync();
}

export async function validateGitHubToken(token: string) {
  return GitHubAuth.validate(token);
}
