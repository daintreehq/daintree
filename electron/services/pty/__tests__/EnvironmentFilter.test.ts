import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  isSensitiveVar,
  filterEnvironment,
  filterSensitiveOnly,
  injectDaintreeMetadata,
  ensureUtf8Locale,
  shouldInjectForceColor,
  getEnvVar,
  hasEnvVar,
  mergeEnvVars,
  setEnvVar,
} from "../EnvironmentFilter.js";

describe("shouldInjectForceColor", () => {
  const realPlatform = process.platform;
  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  };

  afterEach(() => setPlatform(realPlatform));

  it("injects when the env states no colour preference", () => {
    setPlatform("darwin");
    expect(shouldInjectForceColor({ TERM: "xterm-256color" })).toBe(true);
  });

  it("yields to NO_COLOR", () => {
    setPlatform("darwin");
    expect(shouldInjectForceColor({ NO_COLOR: "1" })).toBe(false);
  });

  it("yields to an empty NO_COLOR, which is still present", () => {
    setPlatform("darwin");
    expect(shouldInjectForceColor({ NO_COLOR: "" })).toBe(false);
  });

  it("leaves an explicit FORCE_COLOR for the caller to own", () => {
    setPlatform("darwin");
    expect(shouldInjectForceColor({ FORCE_COLOR: "0" })).toBe(false);
  });

  it("folds case on Windows, where the child resolves env names case-insensitively", () => {
    setPlatform("win32");
    expect(shouldInjectForceColor({ no_color: "1" })).toBe(false);
    expect(shouldInjectForceColor({ Force_Color: "1" })).toBe(false);
  });

  it("keeps POSIX case-sensitive, where no_color is a different variable", () => {
    setPlatform("linux");
    expect(shouldInjectForceColor({ no_color: "1" })).toBe(true);
  });
});

describe("isSensitiveVar", () => {
  describe("exact blocklist", () => {
    it("blocks DATABASE_URL", () => expect(isSensitiveVar("DATABASE_URL")).toBe(true));
  });

  describe("pattern blocklist — user-invented secrets", () => {
    it("blocks MY_SECRET_VALUE", () => expect(isSensitiveVar("MY_SECRET_VALUE")).toBe(true));
    it("blocks APP_TOKEN", () => expect(isSensitiveVar("APP_TOKEN")).toBe(true));
    it("blocks SERVICE_PASSWORD", () => expect(isSensitiveVar("SERVICE_PASSWORD")).toBe(true));
    it("blocks CUSTOM_API_KEY", () => expect(isSensitiveVar("CUSTOM_API_KEY")).toBe(true));
    it("blocks MY_ACCESS_KEY", () => expect(isSensitiveVar("MY_ACCESS_KEY")).toBe(true));
    it("blocks DB_CREDENTIAL", () => expect(isSensitiveVar("DB_CREDENTIAL")).toBe(true));
    it("blocks SIGNING_KEY_PROD", () => expect(isSensitiveVar("SIGNING_KEY_PROD")).toBe(true));
    it("blocks ENCRYPTION_KEY", () => expect(isSensitiveVar("ENCRYPTION_KEY")).toBe(true));
    it("blocks JWT_SECRET", () => expect(isSensitiveVar("JWT_SECRET")).toBe(true));
  });

  describe("pattern blocklist — APIKEY (no underscore) variants", () => {
    it("blocks OPENAI_APIKEY", () => expect(isSensitiveVar("OPENAI_APIKEY")).toBe(true));
    it("blocks APIKEY (bare)", () => expect(isSensitiveVar("APIKEY")).toBe(true));
  });

  describe("safe vars — must NOT be blocked", () => {
    it("allows PATH", () => expect(isSensitiveVar("PATH")).toBe(false));
    it("allows SSH_AUTH_SOCK", () => expect(isSensitiveVar("SSH_AUTH_SOCK")).toBe(false));
    it("allows GIT_AUTHOR_NAME", () => expect(isSensitiveVar("GIT_AUTHOR_NAME")).toBe(false));
  });
});

describe("filterEnvironment on Linux", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  const mount = "/tmp/.mount_DaintrA1b2C3";
  // What electron-builder's AppRun and the AppImage runtime hand Daintree.
  const appImageEnv = {
    HOME: "/home/u",
    APPDIR: mount,
    APPIMAGE: "/home/u/Applications/Daintree.AppImage",
    ARGV0: "/home/u/Applications/Daintree.AppImage",
    OWD: "/home/u",
    CHROME_DESKTOP: "daintree.desktop",
    PATH: `${mount}:${mount}/usr/sbin:/home/u/.local/bin:/usr/bin`,
    LD_LIBRARY_PATH: `${mount}/usr/lib:/opt/cuda/lib64`,
    XDG_DATA_DIRS: `${mount}/usr/share/:/usr/local/share:/usr/share:/usr/share/gnome:/usr/local/share/:/usr/share/`,
    GSETTINGS_SCHEMA_DIR: `${mount}/usr/share/glib-2.0/schemas`,
  };

  it("leaves nothing of the AppImage's mount or runtime in a terminal", () => {
    const result = filterEnvironment(appImageEnv);
    expect(result).toEqual({
      HOME: "/home/u",
      PATH: "/home/u/.local/bin:/usr/bin",
      LD_LIBRARY_PATH: "/opt/cuda/lib64",
      XDG_DATA_DIRS: "/usr/local/share:/usr/share:/usr/share/gnome:/usr/local/share/:/usr/share/",
    });
  });

  it("drops a path list the mount filled entirely", () => {
    const result = filterEnvironment({ ...appImageEnv, LD_LIBRARY_PATH: `${mount}/usr/lib` });
    expect(result).not.toHaveProperty("LD_LIBRARY_PATH");
    expect(result).not.toHaveProperty("GSETTINGS_SCHEMA_DIR");
  });

  it("cleans an extracted image run through its AppRun, which exports no APPIMAGE", () => {
    const dir = "/home/u/squashfs-root";
    const result = filterEnvironment({
      APPDIR: dir,
      PATH: `${dir}:${dir}/usr/sbin:/usr/bin`,
      LD_LIBRARY_PATH: `${dir}/usr/lib`,
    });
    expect(result).toEqual({ PATH: "/usr/bin" });
  });

  it("drops only CHROME_DESKTOP outside an AppImage", () => {
    const result = filterEnvironment({
      PATH: "/usr/bin",
      CHROME_DESKTOP: "daintree.desktop",
      OWD: "/home/u/kept",
      LD_LIBRARY_PATH: "/opt/lib",
    });
    expect(result).toEqual({ PATH: "/usr/bin", OWD: "/home/u/kept", LD_LIBRARY_PATH: "/opt/lib" });
  });
});

describe("filterEnvironment", () => {
  it("drops the host's NODE_ENV so project tools run in their own mode", () => {
    const result = filterEnvironment({ PATH: "/usr/bin", NODE_ENV: "production" });

    expect(result).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps a differently-cased variable on POSIX, where it is a different variable", () => {
    if (process.platform === "win32") return;
    expect(filterEnvironment({ node_env: "custom" })).toEqual({ node_env: "custom" });
  });

  it("leaves a caller-supplied NODE_ENV alone", () => {
    expect(filterSensitiveOnly({ NODE_ENV: "test" })).toEqual({ NODE_ENV: "test" });
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
    expect(ensureUtf8Locale({}, "darwin").LANG).toBe("en_US.UTF-8");
  });

  it.each(["", "C", "POSIX", "en_US.ISO-8859-1"])(
    "falls back to C.UTF-8 on Linux, the one UTF-8 locale every tested distribution ships, for LANG=%j",
    (lang) => {
      expect(ensureUtf8Locale({ LANG: lang }, "linux").LANG).toBe("C.UTF-8");
    }
  );

  it("keeps a UTF-8 LANG the user set on Linux", () => {
    expect(ensureUtf8Locale({ LANG: "de_DE.UTF-8" }, "linux").LANG).toBe("de_DE.UTF-8");
  });

  it("falls back when LANG has non-UTF-8 encoding", () => {
    expect(ensureUtf8Locale({ LANG: "en_US.ISO-8859-1" }, "darwin").LANG).toBe("en_US.UTF-8");
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
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer",
      ANTHROPIC_AUTH_TOKEN: "ant-auth",
      OPENAI_WEBHOOK_SECRET: "whsec_xyz",
      COPILOT_CLI_TOKEN: "copilot-tok",
      SRC_ACCESS_TOKEN: "sgp_abc",
      GH_ENTERPRISE_TOKEN: "ghe-tok",
      GITHUB_ENTERPRISE_TOKEN: "github-ent-tok",
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
    expect(final.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(final.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(final.OPENAI_WEBHOOK_SECRET).toBeUndefined();
    expect(final.COPILOT_CLI_TOKEN).toBeUndefined();
    expect(final.SRC_ACCESS_TOKEN).toBeUndefined();
    expect(final.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(final.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();

    // DAINTREE_* freshly injected (not spoofed)
    expect(final.DAINTREE_PANE_ID).toBe("new-pane-id");
    expect(final.DAINTREE_CWD).toBe("/Users/dev/project");
    expect(final.DAINTREE_PROJECT_ID).toBe("proj-1");
  });
});

describe("case-aware environment primitives", () => {
  const realPlatform = process.platform;
  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  };

  afterEach(() => setPlatform(realPlatform));

  describe("on Windows, where env names are case-insensitive", () => {
    beforeEach(() => setPlatform("win32"));

    it("collapses a case-variant override onto the existing key", () => {
      const merged = mergeEnvVars({ Path: "C:\\Windows" }, { PATH: "C:\\Windows;C:\\Python313" });

      expect(Object.keys(merged)).toEqual(["Path"]);
      expect(merged.Path).toBe("C:\\Windows;C:\\Python313");
    });

    it("leaves exactly one key per name however many spellings arrive", () => {
      const merged = mergeEnvVars({ Path: "a", Temp: "t" }, { PATH: "b", TEMP: "u", path: "c" });

      expect(
        Object.keys(merged)
          .map((k) => k.toUpperCase())
          .sort()
      ).toEqual(["PATH", "TEMP"]);
      expect(merged.Path).toBe("c");
      expect(merged.Temp).toBe("u");
    });

    it("collapses a base that already carries two spellings of one name", () => {
      // Seeding with `{ ...base }` would normalize only the overrides and leave
      // the stale `Path` in place beside the updated `PATH`.
      const merged = mergeEnvVars({ Path: "old", PATH: "older" }, { PATH: "new" });

      expect(Object.keys(merged)).toEqual(["Path"]);
      expect(merged.Path).toBe("new");
    });

    it("collapses duplicates while filtering an inherited environment", () => {
      const filtered = filterEnvironment({ Path: "first", PATH: "second" });

      expect(Object.keys(filtered)).toEqual(["Path"]);
      expect(filtered.Path).toBe("second");
    });

    it("mutates neither input", () => {
      const base = { Path: "C:\\Windows" };
      const overrides = { PATH: "C:\\Python313" };

      mergeEnvVars(base, overrides);

      expect(base).toEqual({ Path: "C:\\Windows" });
      expect(overrides).toEqual({ PATH: "C:\\Python313" });
    });

    it("finds a value stored under different casing", () => {
      expect(getEnvVar({ Path: "C:\\Windows" }, "PATH")).toBe("C:\\Windows");
      expect(hasEnvVar({ Path: "C:\\Windows" }, "PATH")).toBe(true);
    });

    it("treats an explicitly empty value as present", () => {
      expect(hasEnvVar({ Path: "" }, "PATH")).toBe(true);
    });

    it("reports a genuinely absent name as absent", () => {
      expect(hasEnvVar({ Temp: "t" }, "PATH")).toBe(false);
      expect(getEnvVar({ Temp: "t" }, "PATH")).toBeUndefined();
    });

    it("writes through the existing key rather than adding a second", () => {
      const env = { Path: "C:\\Windows" };

      setEnvVar(env, "PATH", "C:\\Python313");

      expect(env).toEqual({ Path: "C:\\Python313" });
    });

    it("adds the name as spelled when nothing matches it", () => {
      const env: Record<string, string> = { Temp: "t" };

      setEnvVar(env, "PATH", "C:\\Windows");

      expect(env.PATH).toBe("C:\\Windows");
    });

    it("strips a lower-cased DAINTREE_ var that would survive the spoofing guard", () => {
      const filtered = filterEnvironment({ daintree_pane_id: "spoofed", Path: "C:\\Windows" });

      expect(filtered.daintree_pane_id).toBeUndefined();
      expect(filtered.Path).toBe("C:\\Windows");
    });

    it("overwrites case-variant metadata in place instead of duplicating it", () => {
      const injected = injectDaintreeMetadata(
        { daintree_pane_id: "stale" },
        { paneId: "fresh", cwd: "C:\\repo" }
      );

      expect(injected.daintree_pane_id).toBe("fresh");
      expect(injected.DAINTREE_PANE_ID).toBeUndefined();
    });

    it("recognises a mixed-case LANG that already states UTF-8", () => {
      const result = ensureUtf8Locale({ Lang: "en_GB.UTF-8" });

      expect(result).toEqual({ Lang: "en_GB.UTF-8" });
    });

    it("replaces a mixed-case non-UTF-8 LANG under its own key", () => {
      const result = ensureUtf8Locale({ Lang: "C" });

      expect(result).toEqual({ Lang: "en_US.UTF-8" });
    });
  });

  describe("on POSIX, where env names are case-sensitive", () => {
    beforeEach(() => setPlatform("darwin"));

    it("keeps differently-cased names as the distinct variables they are", () => {
      const merged = mergeEnvVars({ Path: "/a" }, { PATH: "/b" });

      expect(merged).toEqual({ Path: "/a", PATH: "/b" });
    });

    it("does not resolve a name through another casing", () => {
      expect(hasEnvVar({ Path: "/a" }, "PATH")).toBe(false);
      expect(getEnvVar({ Path: "/a" }, "PATH")).toBeUndefined();
    });

    it("keeps a lower-cased daintree_ var, which is not the reserved prefix", () => {
      const filtered = filterEnvironment({ daintree_pane_id: "mine" });

      expect(filtered.daintree_pane_id).toBe("mine");
    });

    it("leaves a mixed-case Lang alone and sets LANG separately", () => {
      const result = ensureUtf8Locale({ Lang: "C" });

      expect(result).toEqual({ Lang: "C", LANG: "en_US.UTF-8" });
    });
  });
});
