import { graphql } from "@octokit/graphql";

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

// Token storage interface - allows different implementations for main vs utility process
interface TokenStorage {
  get(): string | undefined;
  set(token: string): void;
  delete(): void;
}

// Default memory-only storage (safe for utility process)
class MemoryTokenStorage implements TokenStorage {
  private token: string | null = null;
  get(): string | undefined {
    return this.token ?? undefined;
  }
  set(token: string): void {
    this.token = token;
  }
  delete(): void {
    this.token = null;
  }
}

export class GitHubAuth {
  private static storage: TokenStorage = new MemoryTokenStorage();
  private static memoryToken: string | null = null;

  /**
   * Initialize with secure storage (call from main process only).
   * Must be called before any token operations that need persistence.
   */
  static initializeStorage(storage: TokenStorage): void {
    this.storage = storage;
    // Sync memory token with storage on init
    const storedToken = storage.get();
    if (storedToken) {
      this.memoryToken = storedToken;
    }
  }

  static getToken(): string | undefined {
    // Prefer memory token (set via IPC in utility process)
    if (this.memoryToken) {
      return this.memoryToken;
    }
    return this.storage.get();
  }

  static setMemoryToken(token: string | null): void {
    this.memoryToken = token;
  }

  static hasToken(): boolean {
    return !!GitHubAuth.getToken();
  }

  static setToken(token: string): void {
    this.memoryToken = token.trim();
    this.storage.set(token.trim());
  }

  static clearToken(): void {
    this.memoryToken = null;
    this.storage.delete();
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
