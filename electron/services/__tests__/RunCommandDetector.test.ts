import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { RunCommandDetector } from "../RunCommandDetector.js";

describe("RunCommandDetector", () => {
  let tempDir: string;
  let detector: RunCommandDetector;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-run-cmd-"));
    detector = new RunCommandDetector();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("filters npm scripts with unsafe names", async () => {
    const scripts: Record<string, string> = {
      dev: "vite",
      "lint:fix": "eslint . --fix",
      "evil;rm -rf /": "echo nope",
      "space name": "echo nope",
    };

    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "test", scripts }, null, 2),
      "utf-8"
    );

    const commands = await detector.detect(tempDir);
    const npmCommands = commands.filter((cmd) => cmd.id.startsWith("npm-"));

    expect(npmCommands.map((cmd) => cmd.name)).toEqual(["dev", "lint:fix"]);
    expect(npmCommands.some((cmd) => cmd.command.includes(";"))).toBe(false);
  });

  it("filters composer scripts with unsafe names", async () => {
    const scripts: Record<string, string> = {
      test: "phpunit",
      "post-install-cmd": "echo lifecycle",
      "danger|script": "echo nope",
    };

    await fs.writeFile(
      path.join(tempDir, "composer.json"),
      JSON.stringify({ scripts }, null, 2),
      "utf-8"
    );

    const commands = await detector.detect(tempDir);
    const composerCommands = commands.filter((cmd) => cmd.id.startsWith("composer-"));

    expect(composerCommands).toEqual([
      expect.objectContaining({
        id: "composer-test",
        name: "composer test",
        command: "composer run-script test",
      }),
    ]);
  });

  it("ignores Makefile variable assignment lines that are not real targets", async () => {
    await fs.writeFile(
      path.join(tempDir, "Makefile"),
      [
        "VERSION := 1.2.3",
        "WITH_SPACES := value",
        "build: ## build app",
        "\t@echo build",
        "test: build",
        "\t@echo test",
      ].join("\n"),
      "utf-8"
    );

    const commands = await detector.detect(tempDir);
    const makeCommands = commands.filter((cmd) => cmd.id.startsWith("make-"));

    expect(makeCommands.map((cmd) => cmd.id)).toEqual(["make-build", "make-test"]);
  });

  it("detects each target in multi-target Makefile rules", async () => {
    await fs.writeFile(
      path.join(tempDir, "Makefile"),
      ["build test: deps", "\t@echo run", ".PHONY: build test"].join("\n"),
      "utf-8"
    );

    const commands = await detector.detect(tempDir);
    const makeCommands = commands.filter((cmd) => cmd.id.startsWith("make-"));

    expect(makeCommands.map((cmd) => cmd.id)).toEqual(["make-build", "make-test"]);
  });

  it("detects Makefile targets containing path separators", async () => {
    await fs.writeFile(
      path.join(tempDir, "Makefile"),
      ["build/app: deps", "\t@echo app"].join("\n"),
      "utf-8"
    );

    const commands = await detector.detect(tempDir);
    const makeCommands = commands.filter((cmd) => cmd.id.startsWith("make-"));

    expect(makeCommands).toEqual([
      expect.objectContaining({
        id: "make-build/app",
        command: "make build/app",
      }),
    ]);
  });

  describe("Justfile detection", () => {
    it("detects basic recipes", async () => {
      await fs.writeFile(
        path.join(tempDir, "justfile"),
        ["build:", "  echo building", "", "test:", "  echo testing"].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const justCommands = commands.filter((cmd) => cmd.id.startsWith("just-"));

      expect(justCommands).toEqual([
        expect.objectContaining({ id: "just-build", name: "build", command: "just build" }),
        expect.objectContaining({ id: "just-test", name: "test", command: "just test" }),
      ]);
    });

    it("extracts description from doc comment above recipe", async () => {
      await fs.writeFile(
        path.join(tempDir, "Justfile"),
        ["# Compile the project", "build:", "  echo building"].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const justCommands = commands.filter((cmd) => cmd.id.startsWith("just-"));

      expect(justCommands[0]).toEqual(
        expect.objectContaining({
          id: "just-build",
          description: "Compile the project",
        })
      );
    });

    it("extracts recipe name ignoring parameters", async () => {
      await fs.writeFile(
        path.join(tempDir, "justfile"),
        ["build target:", "  echo {{ target }}"].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const justCommands = commands.filter((cmd) => cmd.id.startsWith("just-"));

      expect(justCommands).toEqual([
        expect.objectContaining({ id: "just-build", name: "build", command: "just build" }),
      ]);
    });

    it("skips doc comment through attribute lines", async () => {
      await fs.writeFile(
        path.join(tempDir, "justfile"),
        ["# Run all tests", "[group('ci')]", "test:", "  echo testing"].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const justCommands = commands.filter((cmd) => cmd.id.startsWith("just-"));

      expect(justCommands[0]).toEqual(
        expect.objectContaining({ id: "just-test", description: "Run all tests" })
      );
    });

    it("skips private recipes prefixed with _", async () => {
      await fs.writeFile(
        path.join(tempDir, "justfile"),
        ["_helper:", "  echo helper", "build:", "  echo build"].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const justCommands = commands.filter((cmd) => cmd.id.startsWith("just-"));

      expect(justCommands.map((cmd) => cmd.id)).toEqual(["just-build"]);
    });

    it("skips alias, set, import, mod, and export lines", async () => {
      await fs.writeFile(
        path.join(tempDir, "justfile"),
        [
          "alias b := build",
          "set shell := ['bash', '-c']",
          "import 'other.just'",
          "mod utils",
          "export FOO := 'bar'",
          "build:",
          "  echo build",
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const justCommands = commands.filter((cmd) => cmd.id.startsWith("just-"));

      expect(justCommands.map((cmd) => cmd.id)).toEqual(["just-build"]);
    });

    it("skips variable assignment lines with :=", async () => {
      await fs.writeFile(
        path.join(tempDir, "justfile"),
        ["version := '1.0.0'", "build:", "  echo build"].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const justCommands = commands.filter((cmd) => cmd.id.startsWith("just-"));

      expect(justCommands.map((cmd) => cmd.id)).toEqual(["just-build"]);
    });

    it("returns empty for empty justfile", async () => {
      await fs.writeFile(path.join(tempDir, "justfile"), "", "utf-8");

      const commands = await detector.detect(tempDir);
      const justCommands = commands.filter((cmd) => cmd.id.startsWith("just-"));

      expect(justCommands).toEqual([]);
    });
  });

  describe("Taskfile detection", () => {
    it("detects tasks with desc field", async () => {
      await fs.writeFile(
        path.join(tempDir, "Taskfile.yml"),
        [
          "version: '3'",
          "tasks:",
          "  build:",
          "    desc: Compile the application",
          "    cmds:",
          "      - go build .",
          "  test:",
          "    desc: Run tests",
          "    cmds:",
          "      - go test ./...",
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const taskCommands = commands.filter((cmd) => cmd.id.startsWith("task-"));

      expect(taskCommands).toEqual([
        expect.objectContaining({
          id: "task-build",
          name: "build",
          command: "task build",
          description: "Compile the application",
        }),
        expect.objectContaining({
          id: "task-test",
          name: "test",
          command: "task test",
          description: "Run tests",
        }),
      ]);
    });

    it("excludes tasks without desc field", async () => {
      await fs.writeFile(
        path.join(tempDir, "Taskfile.yml"),
        [
          "version: '3'",
          "tasks:",
          "  build:",
          "    desc: Compile",
          "    cmds:",
          "      - go build .",
          "  helper:",
          "    cmds:",
          "      - echo helper",
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const taskCommands = commands.filter((cmd) => cmd.id.startsWith("task-"));

      expect(taskCommands.map((cmd) => cmd.id)).toEqual(["task-build"]);
    });

    it("excludes _-prefixed tasks", async () => {
      await fs.writeFile(
        path.join(tempDir, "Taskfile.yml"),
        [
          "version: '3'",
          "tasks:",
          "  _internal:",
          "    desc: Internal task",
          "    cmds:",
          "      - echo internal",
          "  build:",
          "    desc: Build",
          "    cmds:",
          "      - go build .",
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const taskCommands = commands.filter((cmd) => cmd.id.startsWith("task-"));

      expect(taskCommands.map((cmd) => cmd.id)).toEqual(["task-build"]);
    });

    it("excludes tasks with internal: true", async () => {
      await fs.writeFile(
        path.join(tempDir, "Taskfile.yml"),
        [
          "version: '3'",
          "tasks:",
          "  setup:",
          "    desc: Setup dependencies",
          "    internal: true",
          "    cmds:",
          "      - npm install",
          "  build:",
          "    desc: Build",
          "    cmds:",
          "      - npm run build",
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const taskCommands = commands.filter((cmd) => cmd.id.startsWith("task-"));

      expect(taskCommands.map((cmd) => cmd.id)).toEqual(["task-build"]);
    });

    it("excludes string shorthand tasks", async () => {
      await fs.writeFile(
        path.join(tempDir, "Taskfile.yml"),
        [
          "version: '3'",
          "tasks:",
          '  quick: "echo hello"',
          "  build:",
          "    desc: Build app",
          "    cmds:",
          "      - go build .",
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const taskCommands = commands.filter((cmd) => cmd.id.startsWith("task-"));

      expect(taskCommands.map((cmd) => cmd.id)).toEqual(["task-build"]);
    });

    it("detects Taskfile.yaml variant", async () => {
      await fs.writeFile(
        path.join(tempDir, "Taskfile.yaml"),
        [
          "version: '3'",
          "tasks:",
          "  lint:",
          "    desc: Run linter",
          "    cmds:",
          "      - golangci-lint run",
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const taskCommands = commands.filter((cmd) => cmd.id.startsWith("task-"));

      expect(taskCommands).toEqual([
        expect.objectContaining({
          id: "task-lint",
          command: "task lint",
          description: "Run linter",
        }),
      ]);
    });

    it("returns empty for empty tasks object", async () => {
      await fs.writeFile(
        path.join(tempDir, "Taskfile.yml"),
        ["version: '3'", "tasks: {}"].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const taskCommands = commands.filter((cmd) => cmd.id.startsWith("task-"));

      expect(taskCommands).toEqual([]);
    });

    it("returns empty for empty file", async () => {
      await fs.writeFile(path.join(tempDir, "Taskfile.yml"), "", "utf-8");

      const commands = await detector.detect(tempDir);
      const taskCommands = commands.filter((cmd) => cmd.id.startsWith("task-"));

      expect(taskCommands).toEqual([]);
    });

    it("returns empty for malformed YAML", async () => {
      await fs.writeFile(path.join(tempDir, "Taskfile.yml"), "{{invalid yaml: [}", "utf-8");

      const commands = await detector.detect(tempDir);
      const taskCommands = commands.filter((cmd) => cmd.id.startsWith("task-"));

      expect(taskCommands).toEqual([]);
    });
  });

  describe("devcontainer detection", () => {
    it("detects string postStartCommand", async () => {
      const devcontainerDir = path.join(tempDir, ".devcontainer");
      await fs.mkdir(devcontainerDir);
      await fs.writeFile(
        path.join(devcontainerDir, "devcontainer.json"),
        JSON.stringify({ postStartCommand: "npm run dev" }),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const dc = commands.filter((cmd) => cmd.id === "devcontainer-poststart");

      expect(dc).toEqual([
        expect.objectContaining({
          id: "devcontainer-poststart",
          name: "postStartCommand",
          command: "npm run dev",
          description: "from .devcontainer/devcontainer.json",
        }),
      ]);
    });

    it("joins array postStartCommand with spaces", async () => {
      const devcontainerDir = path.join(tempDir, ".devcontainer");
      await fs.mkdir(devcontainerDir);
      await fs.writeFile(
        path.join(devcontainerDir, "devcontainer.json"),
        JSON.stringify({ postStartCommand: ["npm", "run", "dev"] }),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const dc = commands.filter((cmd) => cmd.id === "devcontainer-poststart");

      expect(dc[0]?.command).toBe("npm run dev");
    });

    it("picks highest-priority key from object postStartCommand", async () => {
      const devcontainerDir = path.join(tempDir, ".devcontainer");
      await fs.mkdir(devcontainerDir);
      await fs.writeFile(
        path.join(devcontainerDir, "devcontainer.json"),
        JSON.stringify({
          postStartCommand: {
            app: "npm start",
            server: "npm run dev",
            watcher: "npm run watch",
          },
        }),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const dc = commands.filter((cmd) => cmd.id === "devcontainer-poststart");

      expect(dc[0]?.command).toBe("npm run dev");
    });

    it("falls back to first valid key when no priority keys match", async () => {
      const devcontainerDir = path.join(tempDir, ".devcontainer");
      await fs.mkdir(devcontainerDir);
      await fs.writeFile(
        path.join(devcontainerDir, "devcontainer.json"),
        JSON.stringify({
          postStartCommand: {
            watcher: "npm run watch",
            db: "docker-compose up",
          },
        }),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const dc = commands.filter((cmd) => cmd.id === "devcontainer-poststart");

      expect(dc[0]?.command).toBe("npm run watch");
    });

    it("strips nohup bash -c wrapper", async () => {
      const devcontainerDir = path.join(tempDir, ".devcontainer");
      await fs.mkdir(devcontainerDir);
      await fs.writeFile(
        path.join(devcontainerDir, "devcontainer.json"),
        JSON.stringify({
          postStartCommand: "nohup bash -c 'npm run dev &'",
        }),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const dc = commands.filter((cmd) => cmd.id === "devcontainer-poststart");

      expect(dc[0]?.command).toBe("npm run dev");
    });

    it("strips sh -c wrapper", async () => {
      const devcontainerDir = path.join(tempDir, ".devcontainer");
      await fs.mkdir(devcontainerDir);
      await fs.writeFile(
        path.join(devcontainerDir, "devcontainer.json"),
        JSON.stringify({
          postStartCommand: "sh -c 'python manage.py runserver'",
        }),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const dc = commands.filter((cmd) => cmd.id === "devcontainer-poststart");

      expect(dc[0]?.command).toBe("python manage.py runserver");
    });

    it("returns empty for missing devcontainer.json", async () => {
      const commands = await detector.detect(tempDir);
      const dc = commands.filter((cmd) => cmd.id === "devcontainer-poststart");
      expect(dc).toEqual([]);
    });

    it("returns empty for devcontainer.json without postStartCommand", async () => {
      const devcontainerDir = path.join(tempDir, ".devcontainer");
      await fs.mkdir(devcontainerDir);
      await fs.writeFile(
        path.join(devcontainerDir, "devcontainer.json"),
        JSON.stringify({ image: "node:20" }),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const dc = commands.filter((cmd) => cmd.id === "devcontainer-poststart");
      expect(dc).toEqual([]);
    });

    it("returns empty for malformed JSON", async () => {
      const devcontainerDir = path.join(tempDir, ".devcontainer");
      await fs.mkdir(devcontainerDir);
      await fs.writeFile(path.join(devcontainerDir, "devcontainer.json"), "{invalid json", "utf-8");

      const commands = await detector.detect(tempDir);
      const dc = commands.filter((cmd) => cmd.id === "devcontainer-poststart");
      expect(dc).toEqual([]);
    });

    it("returns empty for null postStartCommand", async () => {
      const devcontainerDir = path.join(tempDir, ".devcontainer");
      await fs.mkdir(devcontainerDir);
      await fs.writeFile(
        path.join(devcontainerDir, "devcontainer.json"),
        JSON.stringify({ postStartCommand: null }),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const dc = commands.filter((cmd) => cmd.id === "devcontainer-poststart");
      expect(dc).toEqual([]);
    });

    it("does not outrank npm dev script in full detect", async () => {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "test", scripts: { dev: "vite" } }),
        "utf-8"
      );
      const devcontainerDir = path.join(tempDir, ".devcontainer");
      await fs.mkdir(devcontainerDir);
      await fs.writeFile(
        path.join(devcontainerDir, "devcontainer.json"),
        JSON.stringify({ postStartCommand: "npm run start" }),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const npmIds = commands.filter((cmd) => cmd.id.startsWith("npm-")).map((cmd) => cmd.id);
      expect(npmIds).toContain("npm-dev");
    });
  });

  describe("caching", () => {
    it("returns cached results on second call without re-reading files", async () => {
      await fs.writeFile(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "test", scripts: { dev: "vite" } }),
        "utf-8"
      );

      const first = await detector.detect(tempDir);
      expect(first).toHaveLength(1);

      const readSpy = vi.spyOn(fs, "readFile");
      const second = await detector.detect(tempDir);
      expect(second).toEqual(first);
      expect(readSpy).not.toHaveBeenCalled();
      readSpy.mockRestore();
    });

    it("caches independently per project path", async () => {
      const tempDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-run-cmd-2-"));
      try {
        await fs.writeFile(
          path.join(tempDir, "package.json"),
          JSON.stringify({ name: "a", scripts: { dev: "vite" } }),
          "utf-8"
        );
        await fs.writeFile(
          path.join(tempDir2, "package.json"),
          JSON.stringify({ name: "b", scripts: { build: "tsc", test: "vitest" } }),
          "utf-8"
        );

        const first = await detector.detect(tempDir);
        const second = await detector.detect(tempDir2);
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(2);
      } finally {
        await fs.rm(tempDir2, { recursive: true, force: true });
      }
    });

    it("re-scans after TTL expires", async () => {
      vi.useFakeTimers();
      try {
        await fs.writeFile(
          path.join(tempDir, "package.json"),
          JSON.stringify({ name: "test", scripts: { dev: "vite" } }),
          "utf-8"
        );

        const first = await detector.detect(tempDir);
        expect(first).toHaveLength(1);

        vi.advanceTimersByTime(61_000);

        const readSpy = vi.spyOn(fs, "readFile");
        await detector.detect(tempDir);
        expect(readSpy).toHaveBeenCalled();
        readSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
