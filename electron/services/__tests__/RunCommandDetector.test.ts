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

  it("uses bun runner when bun.lock (text format) is present", async () => {
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { dev: "vite" } }),
      "utf-8"
    );
    await fs.writeFile(path.join(tempDir, "bun.lock"), "", "utf-8");

    const commands = await detector.detect(tempDir);
    const npmCommands = commands.filter((cmd) => cmd.id.startsWith("npm-"));

    expect(npmCommands).toEqual([
      expect.objectContaining({ id: "npm-dev", command: "bun run dev" }),
    ]);
  });

  it("prefers bun.lock over bun.lockb when both exist", async () => {
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { dev: "vite" } }),
      "utf-8"
    );
    await fs.writeFile(path.join(tempDir, "bun.lock"), "", "utf-8");
    await fs.writeFile(path.join(tempDir, "bun.lockb"), "", "utf-8");

    const commands = await detector.detect(tempDir);
    const npmCommands = commands.filter((cmd) => cmd.id.startsWith("npm-"));

    expect(npmCommands).toEqual([
      expect.objectContaining({ id: "npm-dev", command: "bun run dev" }),
    ]);
  });

  it("prefers bun.lock over pnpm-lock.yaml when both exist", async () => {
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { dev: "vite" } }),
      "utf-8"
    );
    await fs.writeFile(path.join(tempDir, "bun.lock"), "", "utf-8");
    await fs.writeFile(path.join(tempDir, "pnpm-lock.yaml"), "", "utf-8");

    const commands = await detector.detect(tempDir);
    const npmCommands = commands.filter((cmd) => cmd.id.startsWith("npm-"));

    expect(npmCommands).toEqual([
      expect.objectContaining({ id: "npm-dev", command: "bun run dev" }),
    ]);
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

    it("detects Taskfile.dist.yml variant", async () => {
      await fs.writeFile(
        path.join(tempDir, "Taskfile.dist.yml"),
        [
          "version: '3'",
          "tasks:",
          "  ci:",
          "    desc: Run CI checks",
          "    cmds:",
          "      - go test ./...",
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const taskCommands = commands.filter((cmd) => cmd.id.startsWith("task-"));

      expect(taskCommands).toEqual([
        expect.objectContaining({
          id: "task-ci",
          command: "task ci",
          description: "Run CI checks",
        }),
      ]);
    });

    it("prefers Taskfile.yml over Taskfile.dist.yml when both exist", async () => {
      await fs.writeFile(
        path.join(tempDir, "Taskfile.yml"),
        [
          "version: '3'",
          "tasks:",
          "  build:",
          "    desc: Local build",
          "    cmds:",
          "      - go build .",
        ].join("\n"),
        "utf-8"
      );
      await fs.writeFile(
        path.join(tempDir, "Taskfile.dist.yml"),
        [
          "version: '3'",
          "tasks:",
          "  ci:",
          "    desc: CI checks",
          "    cmds:",
          "      - go test ./...",
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const taskCommands = commands.filter((cmd) => cmd.id.startsWith("task-"));

      expect(taskCommands.map((cmd) => cmd.id)).toEqual(["task-build"]);
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

  describe("Procfile detection", () => {
    it("detects web process", async () => {
      await fs.writeFile(
        path.join(tempDir, "Procfile"),
        "web: npm run dev\nworker: npm run worker\n",
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const procCommands = commands.filter((cmd) => cmd.id.startsWith("procfile-"));

      expect(procCommands).toEqual([
        expect.objectContaining({
          id: "procfile-web",
          name: "web",
          command: "npm run dev",
          icon: "terminal",
        }),
        expect.objectContaining({
          id: "procfile-worker",
          name: "worker",
          command: "npm run worker",
          icon: "terminal",
        }),
      ]);
    });

    it("skips comment lines", async () => {
      await fs.writeFile(
        path.join(tempDir, "Procfile"),
        "# This is a comment\nweb: npm run dev\n# Another comment\n",
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const procCommands = commands.filter((cmd) => cmd.id.startsWith("procfile-"));

      expect(procCommands.map((cmd) => cmd.id)).toEqual(["procfile-web"]);
    });

    it("skips blank lines", async () => {
      await fs.writeFile(
        path.join(tempDir, "Procfile"),
        "\n\nweb: npm run dev\n\nrelease: npm run migrate\n",
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const procCommands = commands.filter((cmd) => cmd.id.startsWith("procfile-"));

      expect(procCommands.map((cmd) => cmd.id)).toEqual(["procfile-web", "procfile-release"]);
    });

    it("deduplicates duplicate process names", async () => {
      await fs.writeFile(
        path.join(tempDir, "Procfile"),
        "web: npm run dev\nweb: npm run start\n",
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const procCommands = commands.filter((cmd) => cmd.id.startsWith("procfile-"));

      expect(procCommands).toHaveLength(1);
      expect(procCommands[0]?.command).toBe("npm run dev");
    });

    it("skips lines without colon separator", async () => {
      await fs.writeFile(
        path.join(tempDir, "Procfile"),
        "web: npm run dev\ninvalid line\nworker: npm run worker\n",
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const procCommands = commands.filter((cmd) => cmd.id.startsWith("procfile-"));

      expect(procCommands.map((cmd) => cmd.id)).toEqual(["procfile-web", "procfile-worker"]);
    });

    it("skips empty command body", async () => {
      await fs.writeFile(path.join(tempDir, "Procfile"), "web:\nworker: npm run worker\n", "utf-8");

      const commands = await detector.detect(tempDir);
      const procCommands = commands.filter((cmd) => cmd.id.startsWith("procfile-"));

      expect(procCommands.map((cmd) => cmd.id)).toEqual(["procfile-worker"]);
    });

    it("returns empty when no Procfile exists", async () => {
      const commands = await detector.detect(tempDir);
      const procCommands = commands.filter((cmd) => cmd.id.startsWith("procfile-"));
      expect(procCommands).toEqual([]);
    });
  });

  describe("mise.toml detection", () => {
    it("detects tasks with string run", async () => {
      await fs.writeFile(
        path.join(tempDir, "mise.toml"),
        [
          "[tasks.build]",
          'run = "npm run build"',
          'description = "Build the project"',
          "",
          "[tasks.test]",
          'run = "npm test"',
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const miseCommands = commands.filter((cmd) => cmd.id.startsWith("mise-"));

      expect(miseCommands).toEqual([
        expect.objectContaining({
          id: "mise-build",
          name: "build",
          command: "mise run build",
          description: "Build the project",
        }),
        expect.objectContaining({
          id: "mise-test",
          name: "test",
          command: "mise run test",
        }),
      ]);
    });

    it("detects task with array run", async () => {
      await fs.writeFile(
        path.join(tempDir, "mise.toml"),
        [
          "[tasks.dev]",
          'run = ["npm run dev", "npm run css"]',
          'description = "Start dev servers"',
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const miseCommands = commands.filter((cmd) => cmd.id.startsWith("mise-"));

      expect(miseCommands).toEqual([
        expect.objectContaining({
          id: "mise-dev",
          command: "mise run dev",
          description: "Start dev servers",
        }),
      ]);
    });

    it("detects string shorthand task", async () => {
      await fs.writeFile(
        path.join(tempDir, "mise.toml"),
        'tasks.build = "npm run build"\n',
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const miseCommands = commands.filter((cmd) => cmd.id.startsWith("mise-"));

      expect(miseCommands).toEqual([
        expect.objectContaining({
          id: "mise-build",
          command: "mise run build",
          description: "npm run build",
        }),
      ]);
    });

    it("skips hidden tasks", async () => {
      await fs.writeFile(
        path.join(tempDir, "mise.toml"),
        [
          "[tasks.setup]",
          'run = "npm install"',
          "hide = true",
          "",
          "[tasks.build]",
          'run = "npm run build"',
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const miseCommands = commands.filter((cmd) => cmd.id.startsWith("mise-"));

      expect(miseCommands.map((cmd) => cmd.id)).toEqual(["mise-build"]);
    });

    it("skips _-prefixed tasks", async () => {
      await fs.writeFile(
        path.join(tempDir, "mise.toml"),
        [
          "[tasks._internal]",
          'run = "echo internal"',
          "",
          "[tasks.build]",
          'run = "npm run build"',
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const miseCommands = commands.filter((cmd) => cmd.id.startsWith("mise-"));

      expect(miseCommands.map((cmd) => cmd.id)).toEqual(["mise-build"]);
    });

    it("skips tasks without run field", async () => {
      await fs.writeFile(
        path.join(tempDir, "mise.toml"),
        [
          "[tasks.incomplete]",
          'description = "Missing run"',
          "",
          "[tasks.build]",
          'run = "npm run build"',
        ].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const miseCommands = commands.filter((cmd) => cmd.id.startsWith("mise-"));

      expect(miseCommands.map((cmd) => cmd.id)).toEqual(["mise-build"]);
    });

    it("returns empty when no mise.toml exists", async () => {
      const commands = await detector.detect(tempDir);
      const miseCommands = commands.filter((cmd) => cmd.id.startsWith("mise-"));
      expect(miseCommands).toEqual([]);
    });

    it("returns empty when mise.toml has no [tasks]", async () => {
      await fs.writeFile(path.join(tempDir, "mise.toml"), '[tools]\nnode = "22"\n', "utf-8");

      const commands = await detector.detect(tempDir);
      const miseCommands = commands.filter((cmd) => cmd.id.startsWith("mise-"));
      expect(miseCommands).toEqual([]);
    });

    it("returns empty for malformed TOML", async () => {
      await fs.writeFile(path.join(tempDir, "mise.toml"), "[[invalid toml [}", "utf-8");

      const commands = await detector.detect(tempDir);
      const miseCommands = commands.filter((cmd) => cmd.id.startsWith("mise-"));

      expect(miseCommands).toEqual([]);
    });

    it("detects task with quoted name containing special chars", async () => {
      await fs.writeFile(
        path.join(tempDir, "mise.toml"),
        ['[tasks."dev:app"]', 'run = "npm run dev"', 'description = "Dev server"'].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const miseCommands = commands.filter((cmd) => cmd.id.startsWith("mise-"));

      expect(miseCommands).toEqual([
        expect.objectContaining({
          id: "mise-dev:app",
          name: "dev:app",
          command: "mise run dev:app",
          description: "Dev server",
        }),
      ]);
    });

    it("skips task with empty array run", async () => {
      await fs.writeFile(
        path.join(tempDir, "mise.toml"),
        ["[tasks.empty]", "run = []", "", "[tasks.build]", 'run = "npm run build"'].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const miseCommands = commands.filter((cmd) => cmd.id.startsWith("mise-"));

      expect(miseCommands.map((cmd) => cmd.id)).toEqual(["mise-build"]);
    });

    it("skips task with non-string array run elements", async () => {
      await fs.writeFile(
        path.join(tempDir, "mise.toml"),
        ["[tasks.bad]", "run = [1, 2]", "", "[tasks.build]", 'run = "npm run build"'].join("\n"),
        "utf-8"
      );

      const commands = await detector.detect(tempDir);
      const miseCommands = commands.filter((cmd) => cmd.id.startsWith("mise-"));

      expect(miseCommands.map((cmd) => cmd.id)).toEqual(["mise-build"]);
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

    it("skips empty-string priority key in object postStartCommand", async () => {
      const devcontainerDir = path.join(tempDir, ".devcontainer");
      await fs.mkdir(devcontainerDir);
      await fs.writeFile(
        path.join(devcontainerDir, "devcontainer.json"),
        JSON.stringify({
          postStartCommand: {
            server: "",
            dev: "npm run dev",
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
