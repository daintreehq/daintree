import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testUserData = vi.hoisted(
  () => `${process.cwd()}/.vitest-mcp-pane-${Math.random().toString(36).slice(2)}`
);

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") {
        throw new Error(`Unexpected getPath: ${name}`);
      }
      return testUserData;
    },
  },
}));

import { McpPaneConfigService } from "../McpPaneConfigService.js";

describe("McpPaneConfigService", () => {
  let service: McpPaneConfigService;

  beforeEach(async () => {
    await fs.rm(testUserData, { recursive: true, force: true });
    service = new McpPaneConfigService();
  });

  afterEach(async () => {
    await service.revokeAll();
    await fs.rm(testUserData, { recursive: true, force: true });
  });

  it("writes a per-pane MCP config file with the literal token in the Authorization header", async () => {
    const { configPath, token } = await service.preparePaneConfig({
      paneId: "pane-001",
      port: 45454,
    });

    expect(configPath).toBe(path.join(testUserData, "mcp-pane-configs", "pane-001.json"));
    expect(token).toMatch(/^[0-9a-f-]{36}$/);

    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.mcpServers.daintree.type).toBe("sse");
    expect(parsed.mcpServers.daintree.url).toBe("http://127.0.0.1:45454/sse");
    expect(parsed.mcpServers.daintree.headers.Authorization).toBe(`Bearer ${token}`);
    // Token must NOT be ${VAR}-style — Claude's env substitution is buggy.
    expect(parsed.mcpServers.daintree.headers.Authorization).not.toContain("${");
  });

  it("creates the pane config directory with mode 0700 on POSIX", async () => {
    if (process.platform === "win32") return;

    await service.preparePaneConfig({ paneId: "pane-002", port: 45454 });
    const stat = await fs.stat(path.join(testUserData, "mcp-pane-configs"));
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("creates the config file with mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;

    const { configPath } = await service.preparePaneConfig({ paneId: "pane-003", port: 45454 });
    const stat = await fs.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("registers the token as valid and rejects unknown tokens", async () => {
    const { token } = await service.preparePaneConfig({ paneId: "pane-004", port: 45454 });

    expect(service.isValidPaneToken(token)).toBe(true);
    expect(service.isValidPaneToken("not-a-real-token")).toBe(false);
    expect(service.isValidPaneToken("")).toBe(false);
  });

  it("revokes the token and deletes the config file on revokePaneConfig", async () => {
    const { configPath, token } = await service.preparePaneConfig({
      paneId: "pane-005",
      port: 45454,
    });

    expect(service.isValidPaneToken(token)).toBe(true);
    await service.revokePaneConfig("pane-005");

    expect(service.isValidPaneToken(token)).toBe(false);
    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent — revokePaneConfig tolerates missing files and unknown panes", async () => {
    await expect(service.revokePaneConfig("never-existed")).resolves.toBeUndefined();

    await service.preparePaneConfig({ paneId: "pane-006", port: 45454 });
    await service.revokePaneConfig("pane-006");
    // second call against an already-revoked pane must not throw
    await expect(service.revokePaneConfig("pane-006")).resolves.toBeUndefined();
  });

  it("re-preparing the same paneId rotates the token and overwrites the file", async () => {
    const first = await service.preparePaneConfig({ paneId: "pane-007", port: 45454 });
    const second = await service.preparePaneConfig({ paneId: "pane-007", port: 45454 });

    expect(second.token).not.toBe(first.token);
    expect(service.isValidPaneToken(first.token)).toBe(false);
    expect(service.isValidPaneToken(second.token)).toBe(true);

    const raw = await fs.readFile(second.configPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.daintree.headers.Authorization).toBe(`Bearer ${second.token}`);
  });

  it("rejects invalid ports", async () => {
    await expect(service.preparePaneConfig({ paneId: "pane-008", port: 0 })).rejects.toThrow(
      /Invalid MCP port/
    );
    await expect(service.preparePaneConfig({ paneId: "pane-009", port: 70000 })).rejects.toThrow(
      /Invalid MCP port/
    );
    await expect(
      service.preparePaneConfig({ paneId: "pane-010", port: -1 as unknown as number })
    ).rejects.toThrow(/Invalid MCP port/);
  });

  it("rejects empty pane IDs", async () => {
    await expect(service.preparePaneConfig({ paneId: "", port: 45454 })).rejects.toThrow(
      /paneId is required/
    );
  });

  it("rejects path-traversal pane IDs", async () => {
    await expect(service.preparePaneConfig({ paneId: "../escape", port: 45454 })).rejects.toThrow(
      /Invalid paneId/
    );
    await expect(
      service.preparePaneConfig({ paneId: "../../etc/passwd", port: 45454 })
    ).rejects.toThrow(/Invalid paneId/);
    await expect(service.preparePaneConfig({ paneId: "subdir/leak", port: 45454 })).rejects.toThrow(
      /Invalid paneId/
    );

    // Confirm no file was written outside the base directory.
    const escapeCandidate = path.join(testUserData, "escape.json");
    await expect(fs.stat(escapeCandidate)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revokeAll clears all tokens and files", async () => {
    const a = await service.preparePaneConfig({ paneId: "pane-a", port: 45454 });
    const b = await service.preparePaneConfig({ paneId: "pane-b", port: 45454 });

    expect(service.isValidPaneToken(a.token)).toBe(true);
    expect(service.isValidPaneToken(b.token)).toBe(true);

    await service.revokeAll();

    expect(service.isValidPaneToken(a.token)).toBe(false);
    expect(service.isValidPaneToken(b.token)).toBe(false);
    await expect(fs.stat(a.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(b.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
