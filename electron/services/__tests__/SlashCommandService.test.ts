import { describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { SlashCommandService } from "../SlashCommandService.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "canopy-slash-commands-"));
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

describe("SlashCommandService", () => {
  it("merges project commands over built-ins and parses frontmatter description", async () => {
    const root = await makeTempDir();
    const service = new SlashCommandService();

    await fs.mkdir(path.join(root, ".git"));

    await writeFile(
      path.join(root, ".claude", "commands", "clear.md"),
      `---
description: "Custom clear description"
---

# clear
`
    );

    const commands = await service.list("claude", path.join(root, "nested", "dir"));
    const clear = commands.find((c) => c.label === "/clear");

    expect(clear).toBeTruthy();
    expect(clear?.scope).toBe("project");
    expect(clear?.description).toBe("Custom clear description");

    await fs.rm(root, { recursive: true, force: true });
  });

  it("supports nested commands using colon prefixes", async () => {
    const root = await makeTempDir();
    const service = new SlashCommandService();

    await fs.mkdir(path.join(root, ".git"));

    await writeFile(
      path.join(root, ".claude", "commands", "git", "work-issue.md"),
      `---
description: "Create a branch for an issue"
---

Do the thing.
`
    );

    const commands = await service.list("claude", root);
    const cmd = commands.find((c) => c.label === "/git:work-issue");

    expect(cmd).toBeTruthy();
    expect(cmd?.scope).toBe("project");
    expect(cmd?.description).toBe("Create a branch for an issue");

    await fs.rm(root, { recursive: true, force: true });
  });
});
