import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { RunCommandDetector } from "../RunCommandDetector.js";

describe("RunCommandDetector", () => {
  let tempDir: string;
  let detector: RunCommandDetector;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-run-cmd-"));
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
});
