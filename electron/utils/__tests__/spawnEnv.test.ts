import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInstallEnv, buildProbeEnv } from "../spawnEnv.js";

const originalEnv = process.env;
const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p });
}

function setEnv(env: Record<string, string | undefined>): void {
  process.env = { ...env } as NodeJS.ProcessEnv;
}

describe("spawnEnv", () => {
  beforeEach(() => {
    setEnv({});
    setPlatform("linux");
  });

  afterEach(() => {
    process.env = originalEnv;
    setPlatform(originalPlatform);
  });

  describe("buildProbeEnv", () => {
    it("forces TERM=dumb so CLIs do not emit ANSI escapes into captured stdout", () => {
      setEnv({ TERM: "xterm-256color" });
      expect(buildProbeEnv().TERM).toBe("dumb");
    });

    it("passes PATH through from process.env", () => {
      setEnv({ PATH: "/custom/bin:/usr/bin" });
      expect(buildProbeEnv().PATH).toBe("/custom/bin:/usr/bin");
    });

    it("supplies a sane default PATH when process.env.PATH is unset", () => {
      setEnv({});
      const env = buildProbeEnv();
      expect(env.PATH).toBeTruthy();
      expect(env.PATH).toContain("/usr/bin");
    });

    it("includes HOME on POSIX so CLIs can locate user config", () => {
      setEnv({ HOME: "/home/alice" });
      expect(buildProbeEnv().HOME).toBe("/home/alice");
    });

    it("excludes ANTHROPIC_API_KEY", () => {
      setEnv({ ANTHROPIC_API_KEY: "sk-ant-secret" });
      expect(buildProbeEnv().ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("excludes OPENAI_API_KEY, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, NPM_TOKEN", () => {
      setEnv({
        OPENAI_API_KEY: "sk-x",
        GITHUB_TOKEN: "ghp_x",
        AWS_SECRET_ACCESS_KEY: "secret",
        NPM_TOKEN: "npm_x",
      });
      const env = buildProbeEnv();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.NPM_TOKEN).toBeUndefined();
    });

    it("excludes loader/injection vars (LD_PRELOAD, DYLD_INSERT_LIBRARIES, NODE_OPTIONS, ELECTRON_RUN_AS_NODE)", () => {
      setEnv({
        LD_PRELOAD: "/evil.so",
        DYLD_INSERT_LIBRARIES: "/evil.dylib",
        NODE_OPTIONS: "--require /evil.js",
        ELECTRON_RUN_AS_NODE: "1",
        LD_LIBRARY_PATH: "/evil",
        DYLD_LIBRARY_PATH: "/evil",
      });
      const env = buildProbeEnv();
      expect(env.LD_PRELOAD).toBeUndefined();
      expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(env.LD_LIBRARY_PATH).toBeUndefined();
      expect(env.DYLD_LIBRARY_PATH).toBeUndefined();
    });

    it("excludes proxy and version-manager vars (those are install-only)", () => {
      setEnv({
        HTTPS_PROXY: "http://proxy",
        NVM_DIR: "/home/u/.nvm",
        VOLTA_HOME: "/home/u/.volta",
        XDG_CONFIG_HOME: "/home/u/.config",
      });
      const env = buildProbeEnv();
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(env.NVM_DIR).toBeUndefined();
      expect(env.VOLTA_HOME).toBeUndefined();
      expect(env.XDG_CONFIG_HOME).toBeUndefined();
    });

    it("preserves LC_* prefix vars for locale-correct help output", () => {
      setEnv({ LC_ALL: "en_US.UTF-8", LC_MESSAGES: "en_US.UTF-8", LANG: "en_US.UTF-8" });
      const env = buildProbeEnv();
      expect(env.LC_ALL).toBe("en_US.UTF-8");
      expect(env.LC_MESSAGES).toBe("en_US.UTF-8");
      expect(env.LANG).toBe("en_US.UTF-8");
    });

    it("preserves DAINTREE_* prefix vars", () => {
      setEnv({ DAINTREE_PROJECT_ID: "abc", DAINTREE_RECIPE_ID: "xyz" });
      const env = buildProbeEnv();
      expect(env.DAINTREE_PROJECT_ID).toBe("abc");
      expect(env.DAINTREE_RECIPE_ID).toBe("xyz");
    });

    it("on Windows, includes SystemRoot, USERPROFILE, TEMP, TMP, PATHEXT", () => {
      setPlatform("win32");
      setEnv({
        SystemRoot: "C:\\Windows",
        USERPROFILE: "C:\\Users\\alice",
        TEMP: "C:\\Temp",
        TMP: "C:\\Tmp",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        Path: "C:\\Windows\\System32",
      });
      const env = buildProbeEnv();
      expect(env.SystemRoot).toBe("C:\\Windows");
      expect(env.USERPROFILE).toBe("C:\\Users\\alice");
      expect(env.TEMP).toBe("C:\\Temp");
      expect(env.TMP).toBe("C:\\Tmp");
      expect(env.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
      // Original casing is preserved (Windows uses `Path`, not `PATH`)
      expect(env.Path).toBe("C:\\Windows\\System32");
    });

    it("on Windows, supplies defaults for missing SystemRoot/PATHEXT", () => {
      setPlatform("win32");
      setEnv({});
      const env = buildProbeEnv();
      expect(env.SystemRoot).toBeTruthy();
      expect(env.PATHEXT).toContain(".EXE");
    });

    it("skips undefined values without inserting empty strings", () => {
      setEnv({ PATH: undefined, HOME: "/h" });
      const env = buildProbeEnv();
      // PATH was undefined, so we fall back to default
      expect(env.PATH).toBeTruthy();
      expect(env.HOME).toBe("/h");
    });
  });

  describe("buildInstallEnv", () => {
    it("includes everything in the probe env plus install-only keys", () => {
      setEnv({
        PATH: "/usr/bin",
        HOME: "/home/u",
        HTTPS_PROXY: "http://proxy:8080",
        NVM_DIR: "/home/u/.nvm",
        XDG_CONFIG_HOME: "/home/u/.config",
        PIPX_HOME: "/home/u/.local/pipx",
      });
      const env = buildInstallEnv();
      expect(env.PATH).toBe("/usr/bin");
      expect(env.HOME).toBe("/home/u");
      expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
      expect(env.NVM_DIR).toBe("/home/u/.nvm");
      expect(env.XDG_CONFIG_HOME).toBe("/home/u/.config");
      expect(env.PIPX_HOME).toBe("/home/u/.local/pipx");
    });

    it("still excludes credential-shaped keys", () => {
      setEnv({ HOME: "/h", ANTHROPIC_API_KEY: "sk-ant-x", AWS_ACCESS_KEY_ID: "AKIA..." });
      const env = buildInstallEnv();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    });

    it("preserves NODE_EXTRA_CA_CERTS and SSL_CERT_FILE for corporate TLS interception", () => {
      setEnv({
        HOME: "/h",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem",
        SSL_CERT_FILE: "/etc/ssl/cert.pem",
      });
      const env = buildInstallEnv();
      expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp-ca.pem");
      expect(env.SSL_CERT_FILE).toBe("/etc/ssl/cert.pem");
    });

    it("preserves lowercase http_proxy via case-insensitive matching", () => {
      setEnv({ HOME: "/h", http_proxy: "http://proxy", https_proxy: "http://proxy" });
      const env = buildInstallEnv();
      // Case-insensitive lookup: lowercase keys also pass the allowlist;
      // original casing is preserved on output.
      expect(env.http_proxy).toBe("http://proxy");
      expect(env.https_proxy).toBe("http://proxy");
    });

    it("on Windows includes APPDATA and LOCALAPPDATA for npm global install paths", () => {
      setPlatform("win32");
      setEnv({
        SystemRoot: "C:\\Windows",
        APPDATA: "C:\\Users\\u\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        Path: "C:\\Windows",
      });
      const env = buildInstallEnv();
      expect(env.APPDATA).toBe("C:\\Users\\u\\AppData\\Roaming");
      expect(env.LOCALAPPDATA).toBe("C:\\Users\\u\\AppData\\Local");
    });

    it("forces TERM=dumb (install runners stream output verbatim to renderer)", () => {
      setEnv({ HOME: "/h", TERM: "xterm" });
      expect(buildInstallEnv().TERM).toBe("dumb");
    });

    it("HOME is always present on POSIX so npm/.npmrc lookup succeeds", () => {
      setEnv({});
      const env = buildInstallEnv();
      expect(env.HOME).toBeTruthy();
    });
  });
});
