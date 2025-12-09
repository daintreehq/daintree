import { graphql } from "@octokit/graphql";
import { secureStorage } from "../SecureStorage.js";

export interface GitHubTokenConfig {
  hasToken: boolean;
  scopes?: string[];
  username?: string;
}

export interface GitHubTokenValidation {
  valid: boolean;
  scopes: string[];
  username?: string;
  error?: string;
}

export class GitHubAuth {
  private static memoryToken: string | null = null;
  private static useMemoryOnly: boolean = false;

  static getToken(): string | undefined {
    if (this.useMemoryOnly) {
      return this.memoryToken ?? undefined;
    }
    if (this.memoryToken) {
      return this.memoryToken;
    }
    return secureStorage.get("userConfig.githubToken");
  }

  static setMemoryToken(token: string | null): void {
    this.memoryToken = token;
    this.useMemoryOnly = true;
  }

  static hasToken(): boolean {
    return !!GitHubAuth.getToken();
  }

  static setToken(token: string): void {
    secureStorage.set("userConfig.githubToken", token.trim());
  }

  static clearToken(): void {
    secureStorage.delete("userConfig.githubToken");
  }

  static getConfig(): GitHubTokenConfig {
    return {
      hasToken: GitHubAuth.hasToken(),
    };
  }

  static createClient(): typeof graphql | null {
    const token = GitHubAuth.getToken();
    if (!token) return null;

    return graphql.defaults({
      headers: {
        authorization: `token ${token}`,
      },
    });
  }

  static async validate(token: string): Promise<GitHubTokenValidation> {
    if (!token || token.trim() === "") {
      return { valid: false, scopes: [], error: "Token is empty" };
    }

    if (
      !token.startsWith("ghp_") &&
      !token.startsWith("github_pat_") &&
      !token.startsWith("gho_")
    ) {
      if (token.length < 40) {
        return { valid: false, scopes: [], error: "Invalid token format" };
      }
    }

    try {
      const response = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          return { valid: false, scopes: [], error: "Invalid or expired token" };
        }
        if (response.status === 403) {
          return { valid: false, scopes: [], error: "Token lacks required permissions" };
        }
        return { valid: false, scopes: [], error: `GitHub API error: ${response.statusText}` };
      }

      const userData = (await response.json()) as { login?: string };
      const scopesHeader = response.headers.get("x-oauth-scopes");
      const scopes = scopesHeader ? scopesHeader.split(",").map((s) => s.trim()) : [];

      return {
        valid: true,
        scopes,
        username: userData.login,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOTFOUND") || message.includes("ETIMEDOUT")) {
        return {
          valid: false,
          scopes: [],
          error: "Cannot reach GitHub. Check your internet connection.",
        };
      }
      return { valid: false, scopes: [], error: message };
    }
  }
}
