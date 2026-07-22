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

  it("accepts a deprecated experimental_* alias but warns to rename it (#10466)", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: "^0.11.0" },
      contributes: {
        experimental_mcpServers: [{ id: "main", name: "Server", command: "node" }],
      },
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(
      /contributes\.experimental_mcpServers is deprecated.*contributes\.mcpServers/
    );
  });

  it("does not warn about deprecated aliases when the stable key is used (#10466)", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: "^0.11.0" },
      contributes: {
        mcpServers: [{ id: "main", name: "Server", command: "node" }],
      },
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).not.toMatch(/deprecated/);
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
        mcpServers: [
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
        // The token must reference a declared setting now (#10620), else the
        // schema rejects the manifest before --env resolution runs.
        settings: [{ id: "apiToken", type: "secret" }],
        mcpServers: [
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

  it("suggests the open-ended engine range in the omitted-engines warning (#10513)", async () => {
    await writeManifest({ name: "acme.demo", version: "1.0.0" });
    const result = await runValidate({ dir: tmpDir });
    expect(result.warnings.join("\n")).toMatch(/>=0\.11\.0/);
    // The old caret suggestion would be rejected by the host past 0.11.x.
    expect(result.warnings.join("\n")).not.toMatch(/\^0\.11\.0/);
  });

  it("warns (non-fatally) on an unrecognized panel iconId (#10513)", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "not-a-real-icon", color: "var(--x)" }],
      },
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/iconId "not-a-real-icon".*terminal icon/);
  });

  it("does not warn on a recognized panel iconId (#10513)", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "puzzle", color: "var(--x)" }],
      },
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).not.toMatch(/iconId/);
  });

  it("warns (non-fatally) on an unrecognized toolbar button iconId (#11298)", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      contributes: {
        toolbarButtons: [
          { id: "plan", label: "Plan", iconId: "not-a-real-icon", actionId: "acme.demo.plan" },
        ],
      },
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/toolbarButtons\[0\].iconId.*package icon/);
  });

  it("does not warn on a recognized toolbar button iconId (#11298)", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      contributes: {
        toolbarButtons: [
          { id: "plan", label: "Plan", iconId: "list", actionId: "acme.demo.plan" },
        ],
      },
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    // Stronger than a substring miss: this fixture should be warning-free.
    expect(result.warnings).toEqual([]);
  });

  it("warns on a toolbar iconId that is only an agent brand id (#11298)", async () => {
    // The agent-id exemption is panel-only — toolbar buttons never resolve
    // brand marks, so `claude` really would render the package fallback there.
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      contributes: {
        toolbarButtons: [
          { id: "plan", label: "Plan", iconId: "claude", actionId: "acme.demo.plan" },
        ],
      },
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/toolbarButtons\[0\].iconId "claude"/);
  });

  it.each(["not-a-real-icon", "puzzle"])(
    "tells the author a view iconId is ignored, even a recognized one like %s (#11298)",
    async (iconId) => {
      // A recognized-but-ignored id is the more misleading case — it looks like
      // it works — so presence, not membership, drives the warning.
      await writeManifest({
        name: "acme.demo",
        version: "1.0.0",
        engines: { daintree: ">=0.11.0" },
        contributes: {
          panels: [{ id: "main", name: "Main", iconId: "puzzle", color: "var(--x)" }],
          views: [{ id: "main", componentPath: "./dist/main.js", location: "panel", iconId }],
        },
      });
      const result = await runValidate({ dir: tmpDir });
      expect(result.ok).toBe(true);
      expect(result.warnings.join("\n")).toMatch(/views\[0\].iconId.*ignored at runtime/);
    }
  );

  it("stays quiet when a view omits iconId (#11298)", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "puzzle", color: "var(--x)" }],
        views: [{ id: "main", componentPath: "./dist/main.js", location: "panel" }],
      },
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.warnings.join("\n")).not.toMatch(/iconId/);
  });

  it("rejects a setting id outside the safe-id grammar (#10513)", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      contributes: {
        settings: [{ id: "bad id", type: "string" }],
      },
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/settings\.0\.id/);
  });

  it("rejects a ${settings:…} token whose key breaks the safe-id grammar (#10620)", async () => {
    // #10513 chose to silently ignore a malformed token here; #10620 tightens
    // the manifest schema so a token the host could never resolve (`bad key`
    // with a space) is a hard error (settings_token_malformed). The validator
    // imports the same schema, so it now reports the malformed token rather
    // than passing the literal through to exec at runtime.
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      contributes: {
        mcpServers: [{ id: "main", name: "S", command: "node", env: { T: "${settings:bad key}" } }],
      },
    });
    const result = await runValidate({ dir: tmpDir, env: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/Malformed settings token/);
  });

  it("warns when main points at a missing file whose dir exists (#10513)", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      main: "src/missing.js",
    });
    await fs.mkdir(path.join(tmpDir, "src"));
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/main "src\/missing\.js" doesn't exist/);
  });

  it("stays quiet about an unbuilt dist/ main (#10513)", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      main: "dist/index.js",
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).not.toMatch(/doesn't exist/);
  });

  it("stays quiet about a ./-prefixed unbuilt dist/ main (#10513)", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      main: "./dist/index.js",
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).not.toMatch(/doesn't exist/);
  });

  it("warns when a view componentPath is missing but its dir exists (#10513)", async () => {
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "puzzle", color: "var(--x)" }],
        views: [{ id: "main", componentPath: "src/missing-panel.js", location: "panel" }],
      },
    });
    await fs.mkdir(path.join(tmpDir, "src"));
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(
      /views\[0\]\.componentPath "src\/missing-panel\.js" doesn't exist/
    );
  });

  it("does not warn when a panel iconId is a built-in agent id (#10513)", async () => {
    // `claude` resolves to the agent brand icon via getAgentConfig, so the
    // "renders as terminal" advisory would be wrong — it must be suppressed.
    await writeManifest({
      name: "acme.demo",
      version: "1.0.0",
      engines: { daintree: ">=0.11.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "claude", color: "var(--x)" }],
      },
    });
    const result = await runValidate({ dir: tmpDir });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).not.toMatch(/iconId/);
  });
});
