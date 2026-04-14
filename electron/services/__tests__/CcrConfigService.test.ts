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
});
