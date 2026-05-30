import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runValidate } from "../commands/validate.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-validate-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeManifest(obj: unknown): Promise<void> {
  await fs.writeFile(path.join(tmpDir, "plugin.json"), JSON.stringify(obj), "utf8");
}

describe("runValidate", () => {
  it("passes a valid manifest", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: "^0.11.0" },
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("reports schema errors for an invalid name", async () => {
    await writeManifest({ name: "NoDotName", version: "1.0.0" });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/name/);
  });

  it("fails when plugin.json is missing", async () => {
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/Couldn't read plugin\.json/);
  });

  it("warns when engines.daintree is omitted", async () => {
    await writeManifest({ name: "acme.demo", version: "1.0.0" });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/engines\.daintree omitted/);
  });

  it("warns when a command has no keywords", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: "^0.11.0" },
      contributes: {
        commands: [
          {
            id: "run",
            title: "Run",
            description: "Run it",
            category: "Demo",
            kind: "command",
            danger: "safe",
          },
        ],
      },
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/keywords is empty/);
  });

  it("--env errors when a ${settings:…} token has no value", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: "^0.11.0" },
      contributes: {
        experimental_mcpServers: [
          {
            id: "main",
            name: "Server",
            command: "node",
            args: ["server.js"],
            env: { TOKEN: "${settings:apiToken}" },
          },
        ],
      },
    });
    const result = await runValidate({ dir: tmpDir, env: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/apiToken/);
  });

  it("--env resolves tokens present in .daintree-plugin-env", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: "^0.11.0" },
      contributes: {
        experimental_mcpServers: [
          {
            id: "main",
            name: "Server",
            command: "node",
            args: ["server.js"],
            env: { TOKEN: "${settings:apiToken}" },
          },
        ],
      },
    });
    await fs.writeFile(
      path.join(tmpDir, ".daintree-plugin-env"),
      "# comment\napiToken=secret-value\n",
      "utf8"
    );
    const result = await runValidate({ dir: tmpDir, env: true });
    expect(result.ok).toBe(true);
  });
});
