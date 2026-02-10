import { graphql } from "@octokit/graphql";

export interface GitHubTokenConfig {
  hasToken: boolean;
  scopes?: string[];
  username?: string;
  avatarUrl?: string;
}

export interface GitHubTokenValidation {
  valid: boolean;
  scopes: string[];
  username?: string;
  avatarUrl?: string;
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
  private static cachedUsername: string | null = null;
  private static cachedAvatarUrl: string | null = null;
  private static cachedScopes: string[] = [];
  private static tokenVersion = 0;

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
    const normalized = token?.trim() ?? null;
    this.memoryToken = normalized && normalized.length > 0 ? normalized : null;
    this.tokenVersion++;
    this.pendingValidation = null;
    this.cachedUsername = null;
    this.cachedAvatarUrl = null;
    this.cachedScopes = [];
  }

  static hasToken(): boolean {
    return !!GitHubAuth.getToken();
  }

  static getTokenVersion(): number {
    return this.tokenVersion;
  }

  static setToken(token: string): void {
    this.memoryToken = token.trim();
    this.storage.set(token.trim());
    this.tokenVersion++;
    this.pendingValidation = null;
    this.cachedUsername = null;
    this.cachedAvatarUrl = null;
    this.cachedScopes = [];
  }

  static clearToken(): void {
    this.memoryToken = null;
    this.cachedUsername = null;
    this.cachedAvatarUrl = null;
    this.cachedScopes = [];
    this.tokenVersion++;
    this.pendingValidation = null;
    this.storage.delete();
  }

  private static pendingValidation: Promise<void> | null = null;

  static getConfig(): GitHubTokenConfig {
    const hasToken = GitHubAuth.hasToken();
    return {
      hasToken,
      username: hasToken ? (this.cachedUsername ?? undefined) : undefined,
      avatarUrl: hasToken ? (this.cachedAvatarUrl ?? undefined) : undefined,
      scopes: hasToken && this.cachedScopes.length > 0 ? this.cachedScopes : undefined,
    };
  }

  /**
   * Get config, ensuring user info is fetched if token exists but info is missing.
   * Use this instead of getConfig() when you need guaranteed user info.
   */
  static async getConfigAsync(): Promise<GitHubTokenConfig> {
    // If we have a token but no cached username, validate to get user info
    if (this.hasToken() && !this.cachedUsername) {
      // Reuse pending validation to avoid duplicate requests
      if (!this.pendingValidation) {
        const token = this.getToken();
        if (token) {
          const versionAtStart = this.tokenVersion;
          this.pendingValidation = this.validate(token)
            .then((validation) => {
              if (validation.valid && validation.username) {
                this.setValidatedUserInfo(
                  validation.username,
                  validation.avatarUrl,
                  validation.scopes,
                  versionAtStart
                );
              }
            })
            .catch(() => {
              // Ignore validation errors - user info will remain undefined
            })
            .finally(() => {
              this.pendingValidation = null;
            });
        }
      }
      if (this.pendingValidation) {
        await this.pendingValidation;
      }
    }
    return this.getConfig();
  }

  static setValidatedUserInfo(
    username: string,
    avatarUrl: string | undefined,
    scopes: string[],
    expectedVersion?: number
  ): void {
    if (expectedVersion !== undefined && this.tokenVersion !== expectedVersion) {
      return;
    }
    this.cachedUsername = username;
    this.cachedAvatarUrl = avatarUrl ?? null;
    this.cachedScopes = scopes;
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

      const userData = (await response.json()) as { login?: string; avatar_url?: string };
      const scopesHeader = response.headers.get("x-oauth-scopes");
      const scopes = scopesHeader ? scopesHeader.split(",").map((s) => s.trim()) : [];

      return {
        valid: true,
        scopes,
        username: userData.login,
        avatarUrl: userData.avatar_url,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("ENOTFOUND") ||
        message.includes("ETIMEDOUT") ||
        message.includes("ECONNREFUSED") ||
        message.includes("ECONNRESET") ||
        message.includes("EAI_AGAIN") ||
        message.includes("network") ||
        message.includes("fetch failed")
      ) {
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
