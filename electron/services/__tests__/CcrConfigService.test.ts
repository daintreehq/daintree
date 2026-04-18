import { describe, it, expect, beforeEach, vi } from "vitest";
import { CcrConfigService } from "../CcrConfigService.js";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
}));

vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: { AGENT_FLAVORS_UPDATED: "agent-flavors:updated" },
}));

vi.mock("../config/agentRegistry.js", () => ({
  setAgentFlavors: vi.fn(),
}));

import { readFile } from "fs/promises";

const mockReadFile = vi.mocked(readFile);

describe("CcrConfigService", () => {
  let service: CcrConfigService;

  beforeEach(() => {
    service = new CcrConfigService();
    vi.clearAllMocks();
  });

  describe("discoverFlavors", () => {
    it("returns empty array when config file does not exist", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const flavors = await service.discoverFlavors();
      expect(flavors).toEqual([]);
    });

    it("returns empty array when config has no models", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({}));
      const flavors = await service.discoverFlavors();
      expect(flavors).toEqual([]);
    });

    it("returns empty array when models array is empty", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ models: [] }));
      const flavors = await service.discoverFlavors();
      expect(flavors).toEqual([]);
    });

    it("maps CCR model entries to AgentFlavor objects", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [
            {
              id: "deepseek",
              name: "DeepSeek V3",
              model: "deepseek-v3",
              baseUrl: "https://router.local/v1",
            },
            { id: "gpt5", model: "gpt-5.4" },
          ],
        })
      );

      const flavors = await service.discoverFlavors();

      expect(flavors).toHaveLength(2);

      expect(flavors[0]).toEqual({
        id: "ccr-deepseek",
        name: "CCR: DeepSeek V3",
        description: "Routed via Claude Code Router (deepseek)",
        env: {
          ANTHROPIC_MODEL: "deepseek-v3",
          ANTHROPIC_BASE_URL: "https://router.local/v1",
        },
      });

      expect(flavors[1]).toEqual({
        id: "ccr-gpt5",
        name: "CCR: gpt-5.4",
        description: "Routed via Claude Code Router (gpt5)",
        env: {
          ANTHROPIC_MODEL: "gpt-5.4",
        },
      });
    });

    it("uses model as fallback when id is missing", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [{ model: "custom-model" }],
        })
      );

      const flavors = await service.discoverFlavors();
      expect(flavors).toHaveLength(1);
      expect(flavors[0].id).toBe("ccr-custom-model");
      expect(flavors[0].name).toBe("CCR: custom-model");
    });

    it("filters out entries with neither id nor model", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [{ name: "bad entry" }, { id: "valid", model: "valid-model" }],
        })
      );

      const flavors = await service.discoverFlavors();
      expect(flavors).toHaveLength(1);
      expect(flavors[0].id).toBe("ccr-valid");
    });

    it("handles invalid JSON", async () => {
      mockReadFile.mockResolvedValue("not json at all");
      const flavors = await service.discoverFlavors();
      expect(flavors).toEqual([]);
    });

    it("includes apiKeyEnv as template in env", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [{ id: "test", model: "test-model", apiKeyEnv: "MY_API_KEY" }],
        })
      );

      const flavors = await service.discoverFlavors();
      expect(flavors[0].env?.ANTHROPIC_API_KEY).toBe("${MY_API_KEY}");
    });
  });

  describe("getFlavors", () => {
    it("returns empty array before loading", () => {
      expect(service.getFlavors()).toEqual([]);
    });

    it("returns cached flavors after loadAndApply", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [{ id: "test", model: "test-model" }],
        })
      );

      await service.loadAndApply();
      expect(service.getFlavors()).toHaveLength(1);
    });
  });

  describe("startWatching / stopWatching", () => {
    it("does not throw on stop when not started", () => {
      expect(() => service.stopWatching()).not.toThrow();
    });
  });

  describe("getInstance", () => {
    it("returns a singleton instance", () => {
      const a = CcrConfigService.getInstance();
      const b = CcrConfigService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe("change detection (regression: env/baseUrl edits must broadcast)", () => {
    it("broadcasts when the model id/name changes", async () => {
      const { broadcastToRenderer } = await import("../../ipc/utils.js");
      const broadcastMock = vi.mocked(broadcastToRenderer);

      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ models: [{ id: "one", model: "claude-3-sonnet" }] })
      );
      await service.loadAndApply();
      const initialCalls = broadcastMock.mock.calls.length;

      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ models: [{ id: "two", model: "claude-3-sonnet" }] })
      );
      await service.loadAndApply();
      expect(broadcastMock.mock.calls.length).toBeGreaterThan(initialCalls);
    });

    it("broadcasts when env-only fields change (baseUrl edit)", async () => {
      const { broadcastToRenderer } = await import("../../ipc/utils.js");
      const broadcastMock = vi.mocked(broadcastToRenderer);

      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          models: [{ id: "one", model: "claude-3-sonnet", baseUrl: "https://a.example.com" }],
        })
      );
      await service.loadAndApply();
      const initialCalls = broadcastMock.mock.calls.length;

      // Same id and same name (name is derived from id when unspecified) —
      // only baseUrl differs. The old field-by-field check missed this.
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          models: [{ id: "one", model: "claude-3-sonnet", baseUrl: "https://b.example.com" }],
        })
      );
      await service.loadAndApply();
      expect(broadcastMock.mock.calls.length).toBeGreaterThan(initialCalls);
    });

    it("broadcasts when apiKeyEnv changes", async () => {
      const { broadcastToRenderer } = await import("../../ipc/utils.js");
      const broadcastMock = vi.mocked(broadcastToRenderer);

      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ models: [{ id: "one", model: "m", apiKeyEnv: "KEY_A" }] })
      );
      await service.loadAndApply();
      const initialCalls = broadcastMock.mock.calls.length;

      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ models: [{ id: "one", model: "m", apiKeyEnv: "KEY_B" }] })
      );
      await service.loadAndApply();
      expect(broadcastMock.mock.calls.length).toBeGreaterThan(initialCalls);
    });

    it("does NOT broadcast when flavors are fully unchanged", async () => {
      const { broadcastToRenderer } = await import("../../ipc/utils.js");
      const broadcastMock = vi.mocked(broadcastToRenderer);
      const config = JSON.stringify({
        models: [{ id: "one", model: "m", baseUrl: "https://a.example.com" }],
      });

      mockReadFile.mockResolvedValueOnce(config);
      await service.loadAndApply();
      const initialCalls = broadcastMock.mock.calls.length;

      // Second load with identical config — no-op, no rebroadcast.
      mockReadFile.mockResolvedValueOnce(config);
      await service.loadAndApply();
      expect(broadcastMock.mock.calls.length).toBe(initialCalls);
    });
  });
});
