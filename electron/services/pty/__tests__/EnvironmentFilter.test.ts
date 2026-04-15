import { describe, it, expect } from "vitest";
import {
  isSensitiveVar,
  filterEnvironment,
  injectDaintreeMetadata,
  ensureUtf8Locale,
} from "../EnvironmentFilter.js";

describe("isSensitiveVar", () => {
  describe("exact blocklist", () => {
    it("blocks DATABASE_URL", () => expect(isSensitiveVar("DATABASE_URL")).toBe(true));
    it("blocks ANTHROPIC_API_KEY", () => expect(isSensitiveVar("ANTHROPIC_API_KEY")).toBe(true));
    it("blocks OPENAI_API_KEY", () => expect(isSensitiveVar("OPENAI_API_KEY")).toBe(true));
    it("blocks GOOGLE_API_KEY", () => expect(isSensitiveVar("GOOGLE_API_KEY")).toBe(true));
    it("blocks GEMINI_API_KEY", () => expect(isSensitiveVar("GEMINI_API_KEY")).toBe(true));
    it("blocks AWS_SECRET_ACCESS_KEY", () =>
      expect(isSensitiveVar("AWS_SECRET_ACCESS_KEY")).toBe(true));
    it("blocks AWS_SESSION_TOKEN", () => expect(isSensitiveVar("AWS_SESSION_TOKEN")).toBe(true));
    it("blocks GITHUB_TOKEN", () => expect(isSensitiveVar("GITHUB_TOKEN")).toBe(true));
    it("blocks GH_TOKEN", () => expect(isSensitiveVar("GH_TOKEN")).toBe(true));
    it("blocks POSTGRES_PASSWORD", () => expect(isSensitiveVar("POSTGRES_PASSWORD")).toBe(true));
    it("blocks STRIPE_SECRET_KEY", () => expect(isSensitiveVar("STRIPE_SECRET_KEY")).toBe(true));
    it("blocks AZURE_CLIENT_SECRET", () =>
      expect(isSensitiveVar("AZURE_CLIENT_SECRET")).toBe(true));
  });

  describe("pattern blocklist — user-invented secrets", () => {
    it("blocks MY_SECRET_VALUE", () => expect(isSensitiveVar("MY_SECRET_VALUE")).toBe(true));
    it("blocks APP_TOKEN", () => expect(isSensitiveVar("APP_TOKEN")).toBe(true));
    it("blocks SERVICE_PASSWORD", () => expect(isSensitiveVar("SERVICE_PASSWORD")).toBe(true));
    it("blocks CUSTOM_API_KEY", () => expect(isSensitiveVar("CUSTOM_API_KEY")).toBe(true));
    it("blocks MY_ACCESS_KEY", () => expect(isSensitiveVar("MY_ACCESS_KEY")).toBe(true));
    it("blocks DB_CREDENTIAL", () => expect(isSensitiveVar("DB_CREDENTIAL")).toBe(true));
    it("blocks VAULT_TOKEN", () => expect(isSensitiveVar("VAULT_TOKEN")).toBe(true));
    it("blocks SIGNING_KEY_PROD", () => expect(isSensitiveVar("SIGNING_KEY_PROD")).toBe(true));
    it("blocks ENCRYPTION_KEY", () => expect(isSensitiveVar("ENCRYPTION_KEY")).toBe(true));
    it("blocks JWT_SECRET", () => expect(isSensitiveVar("JWT_SECRET")).toBe(true));
  });

  describe("safe vars — must NOT be blocked", () => {
    it("allows PATH", () => expect(isSensitiveVar("PATH")).toBe(false));
    it("allows HOME", () => expect(isSensitiveVar("HOME")).toBe(false));
    it("allows USER", () => expect(isSensitiveVar("USER")).toBe(false));
    it("allows SHELL", () => expect(isSensitiveVar("SHELL")).toBe(false));
    it("allows LANG", () => expect(isSensitiveVar("LANG")).toBe(false));
    it("allows TERM", () => expect(isSensitiveVar("TERM")).toBe(false));
    it("allows SSH_AUTH_SOCK", () => expect(isSensitiveVar("SSH_AUTH_SOCK")).toBe(false));
    it("allows NVM_DIR", () => expect(isSensitiveVar("NVM_DIR")).toBe(false));
    it("allows PYENV_ROOT", () => expect(isSensitiveVar("PYENV_ROOT")).toBe(false));
    it("allows GOPATH", () => expect(isSensitiveVar("GOPATH")).toBe(false));
    it("allows HOMEBREW_PREFIX", () => expect(isSensitiveVar("HOMEBREW_PREFIX")).toBe(false));
    it("allows COLORTERM", () => expect(isSensitiveVar("COLORTERM")).toBe(false));
    it("allows TMPDIR", () => expect(isSensitiveVar("TMPDIR")).toBe(false));
    it("allows XDG_CONFIG_HOME", () => expect(isSensitiveVar("XDG_CONFIG_HOME")).toBe(false));
    it("allows GIT_AUTHOR_NAME", () => expect(isSensitiveVar("GIT_AUTHOR_NAME")).toBe(false));
    it("allows DOCKER_HOST", () => expect(isSensitiveVar("DOCKER_HOST")).toBe(false));
    it("allows NODE_ENV", () => expect(isSensitiveVar("NODE_ENV")).toBe(false));
    it("allows FORCE_COLOR", () => expect(isSensitiveVar("FORCE_COLOR")).toBe(false));
    it("allows PWD", () => expect(isSensitiveVar("PWD")).toBe(false));
    it("allows SHLVL", () => expect(isSensitiveVar("SHLVL")).toBe(false));
  });
});

describe("filterEnvironment", () => {
  it("removes sensitive vars and keeps safe vars", () => {
    const env = {
      PATH: "/usr/bin:/usr/local/bin",
      HOME: "/Users/test",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      DATABASE_URL: "postgres://user:pass@host/db",
      GITHUB_TOKEN: "ghp_abc123",
      NVM_DIR: "/Users/test/.nvm",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
    };

    const result = filterEnvironment(env);

    expect(result.PATH).toBe("/usr/bin:/usr/local/bin");
    expect(result.HOME).toBe("/Users/test");
    expect(result.NVM_DIR).toBe("/Users/test/.nvm");
    expect(result.SSH_AUTH_SOCK).toBe("/tmp/ssh.sock");

    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.GITHUB_TOKEN).toBeUndefined();
  });

  it("strips undefined values", () => {
    const env: Record<string, string | undefined> = {
      VALID: "yes",
      UNDEFINED_VAR: undefined,
    };
    const result = filterEnvironment(env);
    expect(result.VALID).toBe("yes");
    expect("UNDEFINED_VAR" in result).toBe(false);
  });

  it("strips DAINTREE_* vars from inherited env (anti-spoofing)", () => {
    const env = {
      PATH: "/usr/bin",
      DAINTREE_PANE_ID: "spoofed-id",
      DAINTREE_PROJECT_ID: "spoofed-project",
    };
    const result = filterEnvironment(env);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.DAINTREE_PANE_ID).toBeUndefined();
    expect(result.DAINTREE_PROJECT_ID).toBeUndefined();
  });

  it("handles empty input", () => {
    expect(filterEnvironment({})).toEqual({});
  });

  it("does not mutate the input object", () => {
    const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret" };
    filterEnvironment(env);
    expect(env.ANTHROPIC_API_KEY).toBe("secret");
  });
});

describe("injectDaintreeMetadata", () => {
  it("injects paneId and cwd always", () => {
    const env = { PATH: "/usr/bin" };
    const result = injectDaintreeMetadata(env, {
      paneId: "pane-123",
      cwd: "/Users/test/project",
    });

    expect(result.DAINTREE_PANE_ID).toBe("pane-123");
    expect(result.DAINTREE_CWD).toBe("/Users/test/project");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("injects optional projectId and worktreeId when provided", () => {
    const result = injectDaintreeMetadata(
      {},
      {
        paneId: "p1",
        cwd: "/cwd",
        projectId: "proj-abc",
        worktreeId: "wt-xyz",
      }
    );

    expect(result.DAINTREE_PROJECT_ID).toBe("proj-abc");
    expect(result.DAINTREE_WORKTREE_ID).toBe("wt-xyz");
  });

  it("omits projectId and worktreeId keys when undefined", () => {
    const result = injectDaintreeMetadata({}, { paneId: "p1", cwd: "/cwd" });

    expect("DAINTREE_PROJECT_ID" in result).toBe(false);
    expect("DAINTREE_WORKTREE_ID" in result).toBe(false);
  });

  it("does not mutate the input env", () => {
    const env = { PATH: "/usr/bin" };
    injectDaintreeMetadata(env, { paneId: "x", cwd: "/c" });
    expect("DAINTREE_PANE_ID" in env).toBe(false);
  });
});

describe("ensureUtf8Locale", () => {
  it("preserves LANG when already UTF-8 (standard format)", () => {
    expect(ensureUtf8Locale({ LANG: "fr_FR.UTF-8" }).LANG).toBe("fr_FR.UTF-8");
  });

  it("preserves LANG with lowercase utf8 variant", () => {
    expect(ensureUtf8Locale({ LANG: "ja_JP.utf8" }).LANG).toBe("ja_JP.utf8");
  });

  it("preserves LANG with no-hyphen UTF8 variant", () => {
    expect(ensureUtf8Locale({ LANG: "de_DE.UTF8" }).LANG).toBe("de_DE.UTF8");
  });

  it("falls back to en_US.UTF-8 when LANG is missing", () => {
    expect(ensureUtf8Locale({}).LANG).toBe("en_US.UTF-8");
  });

  it("falls back to en_US.UTF-8 when LANG is empty", () => {
    expect(ensureUtf8Locale({ LANG: "" }).LANG).toBe("en_US.UTF-8");
  });

  it("falls back to en_US.UTF-8 when LANG is C", () => {
    expect(ensureUtf8Locale({ LANG: "C" }).LANG).toBe("en_US.UTF-8");
  });

  it("falls back to en_US.UTF-8 when LANG is POSIX", () => {
    expect(ensureUtf8Locale({ LANG: "POSIX" }).LANG).toBe("en_US.UTF-8");
  });

  it("falls back when LANG has non-UTF-8 encoding", () => {
    expect(ensureUtf8Locale({ LANG: "en_US.ISO-8859-1" }).LANG).toBe("en_US.UTF-8");
  });

  it("preserves C.UTF-8 (common Linux locale)", () => {
    expect(ensureUtf8Locale({ LANG: "C.UTF-8" }).LANG).toBe("C.UTF-8");
  });

  it("does not add or remove LC_ALL", () => {
    const withLcAll = ensureUtf8Locale({ LANG: "C", LC_ALL: "ja_JP.UTF-8" });
    expect(withLcAll.LC_ALL).toBe("ja_JP.UTF-8");

    const withoutLcAll = ensureUtf8Locale({ LANG: "en_US.UTF-8" });
    expect("LC_ALL" in withoutLcAll).toBe(false);
  });

  it("does not mutate the input object", () => {
    const env = { LANG: "C", PATH: "/usr/bin" };
    ensureUtf8Locale(env);
    expect(env.LANG).toBe("C");
  });

  it("preserves other env vars", () => {
    const result = ensureUtf8Locale({ PATH: "/usr/bin", HOME: "/home/test" });
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/test");
    expect(result.LANG).toBe("en_US.UTF-8");
  });
});

describe("filterEnvironment + injectDaintreeMetadata integration", () => {
  it("produces a clean env with metadata for a typical developer shell", () => {
    const shellEnv = {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/Users/dev",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      NVM_DIR: "/Users/dev/.nvm",
      PYENV_ROOT: "/Users/dev/.pyenv",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      HOMEBREW_PREFIX: "/opt/homebrew",
      ANTHROPIC_API_KEY: "sk-ant-real-key",
      OPENAI_API_KEY: "sk-openai-real-key",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG",
      DATABASE_URL: "postgres://localhost/dev",
      MY_CUSTOM_TOKEN: "tok_abc123",
      // Pre-existing DAINTREE_ vars should be stripped
      DAINTREE_PANE_ID: "old-id",
    };

    const filtered = filterEnvironment(shellEnv);
    const final = injectDaintreeMetadata(filtered, {
      paneId: "new-pane-id",
      cwd: "/Users/dev/project",
      projectId: "proj-1",
    });

    // Essential vars preserved
    expect(final.PATH).toBeTruthy();
    expect(final.HOME).toBe("/Users/dev");
    expect(final.NVM_DIR).toBeTruthy();
    expect(final.SSH_AUTH_SOCK).toBeTruthy();
    expect(final.HOMEBREW_PREFIX).toBeTruthy();

    // Sensitive vars blocked
    expect(final.ANTHROPIC_API_KEY).toBeUndefined();
    expect(final.OPENAI_API_KEY).toBeUndefined();
    expect(final.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(final.DATABASE_URL).toBeUndefined();
    expect(final.MY_CUSTOM_TOKEN).toBeUndefined();

    // DAINTREE_* freshly injected (not spoofed)
    expect(final.DAINTREE_PANE_ID).toBe("new-pane-id");
    expect(final.DAINTREE_CWD).toBe("/Users/dev/project");
    expect(final.DAINTREE_PROJECT_ID).toBe("proj-1");
  });
});
