import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { createIsolatedHome, isolatedHomeEnv, mergeEnvLayers, pathRestoreProfile } from "../launch";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isolatedHomeEnv", () => {
  it("points every home-relative location into the given HOME", () => {
    const home = "/tmp/daintree-e2e-home-x";
    const env = isolatedHomeEnv(home, "darwin");
    expect(env).toMatchObject({
      HOME: home,
      USERPROFILE: home,
      ZDOTDIR: home,
      CODEX_HOME: path.join(home, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
    });
    expect(env.APPDATA).toBeUndefined();
  });

  it("adds the Windows profile variables on win32", () => {
    const home = "C:\\Users\\x\\AppData\\Local\\Temp\\daintree-e2e-home-y";
    const env = isolatedHomeEnv(home, "win32");
    expect(env.APPDATA).toBe(`${home}\\AppData\\Roaming`);
    expect(env.LOCALAPPDATA).toBe(`${home}\\AppData\\Local`);
    expect(env.HOMEDRIVE).toBe("C:");
    expect(env.HOMEDRIVE + env.HOMEPATH).toBe(home);
  });
});

describe("createIsolatedHome", () => {
  it("seeds quiet shell profiles, a signing-off git identity and the agent dirs", () => {
    const home = createIsolatedHome();
    created.push(home);
    expect(path.basename(home)).toMatch(/^daintree-e2e-home-/);
    for (const rc of [".zshrc", ".zshenv", ".bashrc"]) {
      expect(readFileSync(path.join(home, rc), "utf8")).toBe("");
    }
    const gitconfig = readFileSync(path.join(home, ".gitconfig"), "utf8");
    expect(gitconfig).toContain("email = test@daintree.dev");
    expect(gitconfig).toMatch(/\[commit\]\n\tgpgsign = false/);
    expect(existsSync(path.join(home, ".codex"))).toBe(true);
    expect(readFileSync(path.join(home, ".claude.json"), "utf8").trim()).toBe("{}");
    expect(existsSync(path.join(home, ".claude"))).toBe(true);
  });
});

describe("pathRestoreProfile", () => {
  it.skipIf(process.platform === "win32")(
    "appends only the entries a system profile dropped, keeping its order, silently",
    () => {
      const profile = pathRestoreProfile(["/usr/bin", "/opt/it's here/bin", "/runner/node/bin"]);
      const out = execFileSync("/bin/sh", ["-c", `${profile}\nprintf '%s' "$PATH"`], {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        encoding: "utf8",
      });
      expect(out).toBe("/usr/local/bin:/usr/bin:/bin:/opt/it's here/bin:/runner/node/bin");
    }
  );

  it("is empty when there is nothing to restore", () => {
    expect(pathRestoreProfile(["", ""])).toBe("");
  });
});

describe("mergeEnvLayers", () => {
  it("lets later layers win", () => {
    expect(mergeEnvLayers([{ A: "1", B: "1" }, undefined, { B: "2" }], "linux")).toEqual({
      A: "1",
      B: "2",
    });
  });

  it("keeps case-distinct keys apart off Windows", () => {
    expect(mergeEnvLayers([{ Path: "a" }, { PATH: "b" }], "darwin")).toEqual({
      Path: "a",
      PATH: "b",
    });
  });

  it("drops an earlier case variant on Windows so the later layer's value is the only one", () => {
    const merged = mergeEnvLayers(
      [{ Path: "inherited", appdata: "real" }, { APPDATA: "isolated" }, { PATH: "fake-bin" }],
      "win32"
    );
    expect(merged).toEqual({ APPDATA: "isolated", PATH: "fake-bin" });
  });
});
