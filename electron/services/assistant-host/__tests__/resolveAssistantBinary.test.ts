import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveAssistantBinary, ASSISTANT_BIN_ENV } from "../resolveAssistantBinary.js";

// Hoisted: `vi.mock` runs before module-level consts would be initialised.
const appMock = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: (): string => "/nonexistent-app",
}));
vi.mock("electron", () => ({ app: appMock }));

/**
 * The engine that answers is the engine whose SHA `scripts/afterPack.cjs` matched
 * against the gitlink — unless something outranked it. Nothing asserted that before:
 * this file's resolution order shipped untested, which is how an inherited
 * `DAINTREE_ASSISTANT_BIN` could substitute an unknown build into a packaged
 * acceptance run and leave the run certifying an artifact it never executed.
 *
 * The filenames come from the PACKAGING contract, not from re-deriving the resolver's
 * own expressions: `electron-builder.config.cjs` drops the platform/arch suffix at pack
 * time, and `scripts/build-assistant.mjs` keeps it in the repo. Copying the resolver's
 * conditional instead is what hid a missing `.exe` here until Windows CI found it.
 */
const WINDOWS = process.platform === "win32";
/** What `extraResources` renames the engine to inside the package. */
const PACKAGED_NAME = WINDOWS ? "daintree-assistant.exe" : "daintree-assistant";
/** What `build-assistant.mjs` leaves in `resources/assistant/`. */
const REPO_NAME =
  `daintree-assistant-${process.platform}-${process.arch}` + (WINDOWS ? ".exe" : "");

/** Awaits a call expected to fail, and hands back the Error it threw. */
async function rejection(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the resolver to reject, but it resolved");
}

describe("resolveAssistantBinary", () => {
  let dir: string;

  /** Writes a runnable file and returns its absolute path. */
  async function makeExecutable(...segments: string[]): Promise<string> {
    const full = path.join(dir, ...segments);
    await writeFile(full, "#!/bin/sh\nexit 0\n");
    // A no-op on Windows, which is why the resolver checks R_OK there instead.
    await chmod(full, 0o755);
    return full;
  }

  /** Present and readable, but not runnable. Meaningless on Windows. */
  async function makeUnrunnable(...segments: string[]): Promise<string> {
    const full = path.join(dir, ...segments);
    await writeFile(full, "not an engine\n");
    await chmod(full, 0o600);
    return full;
  }

  /** The two layouts the resolver knows: a package's Resources, and the repo. */
  function layout() {
    return { resourcesPath: path.join(dir, "packaged"), appPath: dir };
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "resolve-assistant-"));
    await mkdir(path.join(dir, "resources", "assistant"), { recursive: true });
    await mkdir(path.join(dir, "packaged", "assistant"), { recursive: true });
    appMock.isPackaged = false;
  });

  afterEach(async () => {
    // Restored BEFORE the removal, so a failed rmdir cannot strand a spy.
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  describe("resolution order", () => {
    it("prefers the packaged copy over the repo build output", async () => {
      const packaged = await makeExecutable("packaged", "assistant", PACKAGED_NAME);
      await makeExecutable("resources", "assistant", REPO_NAME);

      expect(await resolveAssistantBinary({ env: {}, ...layout() })).toEqual({
        path: packaged,
        source: "packaged",
      });
    });

    it("falls back to the repo build output when nothing is bundled", async () => {
      const repo = await makeExecutable("resources", "assistant", REPO_NAME);

      expect(await resolveAssistantBinary({ env: {}, ...layout() })).toEqual({
        path: repo,
        source: "repo",
      });
    });

    it("finds the repo copy when there is no Resources directory at all", async () => {
      const repo = await makeExecutable("resources", "assistant", REPO_NAME);

      expect(
        await resolveAssistantBinary({ env: {}, resourcesPath: undefined, appPath: dir })
      ).toEqual({ path: repo, source: "repo" });
    });

    it("lets the override outrank the packaged copy", async () => {
      const override = await makeExecutable("override-engine");
      await makeExecutable("packaged", "assistant", PACKAGED_NAME);

      expect(
        await resolveAssistantBinary({ env: { [ASSISTANT_BIN_ENV]: override }, ...layout() })
      ).toEqual({ path: override, source: "override" });
    });

    it.skipIf(WINDOWS)(
      "skips a candidate that exists but cannot be run, rather than returning it",
      async () => {
        await makeUnrunnable("packaged", "assistant", PACKAGED_NAME);
        const repo = await makeExecutable("resources", "assistant", REPO_NAME);

        expect(await resolveAssistantBinary({ env: {}, ...layout() })).toEqual({
          path: repo,
          source: "repo",
        });
      }
    );
  });

  describe("the override", () => {
    it("is anchored, so the file checked is the file that gets spawned", async () => {
      // The child runs with the PROJECT as its cwd while this check runs against
      // main's, so a relative value must not survive as one.
      const override = await makeExecutable("override-engine");
      const relative = path.relative(process.cwd(), override);

      const resolved = await resolveAssistantBinary({
        env: { [ASSISTANT_BIN_ENV]: relative },
        ...layout(),
      });

      expect(path.isAbsolute(resolved.path)).toBe(true);
      expect(resolved).toEqual({ path: override, source: "override" });
    });

    it("is trimmed before it is used", async () => {
      const override = await makeExecutable("override-engine");

      expect(
        await resolveAssistantBinary({
          env: { [ASSISTANT_BIN_ENV]: `  ${override}  ` },
          ...layout(),
        })
      ).toEqual({ path: override, source: "override" });
    });

    it.each([
      ["empty", ""],
      ["whitespace only", "   "],
    ])("is ignored when %s, falling through to the packaged copy", async (_label, value) => {
      const packaged = await makeExecutable("packaged", "assistant", PACKAGED_NAME);

      expect(
        await resolveAssistantBinary({ env: { [ASSISTANT_BIN_ENV]: value }, ...layout() })
      ).toEqual({ path: packaged, source: "packaged" });
    });

    it("is refused when it points at nothing, and does not fall back", async () => {
      const packaged = await makeExecutable("packaged", "assistant", PACKAGED_NAME);
      const missing = path.join(dir, "not-built");

      // The bundled copy is RIGHT THERE and is still not used: someone set the
      // variable to test a specific build, and running a different one silently
      // would make the test a lie.
      const error = await rejection(
        resolveAssistantBinary({ env: { [ASSISTANT_BIN_ENV]: missing }, ...layout() })
      );

      expect(error.message).toContain(ASSISTANT_BIN_ENV);
      expect(error.message).toContain(missing);
      expect(error.message).not.toContain(packaged);
    });

    it("is refused when it points at a directory rather than a binary", async () => {
      // A directory satisfies X_OK when searchable and R_OK when readable, so the
      // access check alone would hand a folder back as the engine.
      await mkdir(path.join(dir, "a-directory"));
      await makeExecutable("packaged", "assistant", PACKAGED_NAME);

      await expect(
        resolveAssistantBinary({
          env: { [ASSISTANT_BIN_ENV]: path.join(dir, "a-directory") },
          ...layout(),
        })
      ).rejects.toThrow(ASSISTANT_BIN_ENV);
    });
  });

  describe("what it refuses to look at", () => {
    it("never binds to a copy on the real PATH", async () => {
      // On the actual PATH, with no injected env, so this would catch a fallback
      // implemented through process.env, a `which` helper, or a subprocess lookup.
      const realPath = process.env.PATH;
      await makeExecutable(PACKAGED_NAME);
      process.env.PATH = `${dir}${path.delimiter}${realPath ?? ""}`;
      try {
        await expect(
          resolveAssistantBinary({ resourcesPath: path.join(dir, "packaged"), appPath: dir })
        ).rejects.toThrow(/submodule/);
      } finally {
        if (realPath === undefined) delete process.env.PATH;
        else process.env.PATH = realPath;
      }
    });

    it("names the submodule AND the build, and never an install command", async () => {
      const error = await rejection(resolveAssistantBinary({ env: {}, ...layout() }));

      expect(error.message).toContain("git submodule update");
      expect(error.message).toContain("npm run build:assistant");
      // The engine is not separately installable; suggesting otherwise sends
      // someone hunting for a command that does not exist.
      expect(error.message).not.toMatch(/npm install|brew install|go install/);
    });
  });

  describe("production defaults", () => {
    it("reads the real process.env when no env is injected", async () => {
      const override = await makeExecutable("override-engine");
      const prior = process.env[ASSISTANT_BIN_ENV];
      process.env[ASSISTANT_BIN_ENV] = override;
      try {
        expect(await resolveAssistantBinary(layout())).toEqual({
          path: override,
          source: "override",
        });
      } finally {
        if (prior === undefined) delete process.env[ASSISTANT_BIN_ENV];
        else process.env[ASSISTANT_BIN_ENV] = prior;
      }
    });

    it("reads the real process.resourcesPath when none is injected", async () => {
      const packaged = await makeExecutable("packaged", "assistant", PACKAGED_NAME);
      const prior = process.resourcesPath;
      Object.defineProperty(process, "resourcesPath", {
        value: path.join(dir, "packaged"),
        configurable: true,
      });
      try {
        expect(await resolveAssistantBinary({ env: {}, appPath: dir })).toEqual({
          path: packaged,
          source: "packaged",
        });
      } finally {
        Object.defineProperty(process, "resourcesPath", {
          value: prior,
          configurable: true,
        });
      }
    });

    it("falls back to app.getAppPath() when no appPath is injected", async () => {
      const repo = await makeExecutable("resources", "assistant", REPO_NAME);
      const spy = vi.spyOn(appMock, "getAppPath").mockReturnValue(dir);

      expect(
        await resolveAssistantBinary({ env: {}, resourcesPath: path.join(dir, "packaged") })
      ).toEqual({ path: repo, source: "repo" });
      expect(spy).toHaveBeenCalled();
    });
  });
});
