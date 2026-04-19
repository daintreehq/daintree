import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentPreset } from "../../../shared/config/agentRegistry.js";
import { CcrConfigService } from "../CcrConfigService.js";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
}));

vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: { AGENT_PRESETS_UPDATED: "agent-presets:updated" },
}));

vi.mock("../config/agentRegistry.js", () => ({
  setAgentPresets: vi.fn(),
}));

import { readFile } from "fs/promises";

const mockReadFile = vi.mocked(readFile);

describe("CcrConfigService", () => {
  let service: CcrConfigService;

  beforeEach(() => {
    service = new CcrConfigService();
    vi.clearAllMocks();
  });

  describe("discoverPresets", () => {
    it("returns empty array when config file does not exist", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const presets = await service.discoverPresets();
      expect(presets).toEqual([]);
    });

    it("returns empty array when config has no models", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({}));
      const presets = await service.discoverPresets();
      expect(presets).toEqual([]);
    });

    it("returns empty array when models array is empty", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ models: [] }));
      const presets = await service.discoverPresets();
      expect(presets).toEqual([]);
    });

    it("maps CCR model entries to AgentPreset objects", async () => {
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

      const presets = await service.discoverPresets();

      expect(presets).toHaveLength(2);

      expect(presets[0]).toEqual({
        id: "ccr-deepseek",
        name: "CCR: DeepSeek V3",
        description: "Routed via Claude Code Router (deepseek)",
        env: {
          ANTHROPIC_MODEL: "deepseek-v3",
          ANTHROPIC_BASE_URL: "https://router.local/v1",
        },
      });

      expect(presets[1]).toEqual({
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

      const presets = await service.discoverPresets();
      expect(presets).toHaveLength(1);
      expect(presets[0].id).toBe("ccr-custom-model");
      expect(presets[0].name).toBe("CCR: custom-model");
    });

    it("filters out entries with neither id nor model", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [{ name: "bad entry" }, { id: "valid", model: "valid-model" }],
        })
      );

      const presets = await service.discoverPresets();
      expect(presets).toHaveLength(1);
      expect(presets[0].id).toBe("ccr-valid");
    });

    it("handles invalid JSON", async () => {
      mockReadFile.mockResolvedValue("not json at all");
      const presets = await service.discoverPresets();
      expect(presets).toEqual([]);
    });

    it("includes apiKeyEnv as template in env", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [{ id: "test", model: "test-model", apiKeyEnv: "MY_API_KEY" }],
        })
      );

      const presets = await service.discoverPresets();
      expect(presets[0].env?.ANTHROPIC_API_KEY).toBe("${MY_API_KEY}");
    });
  });

  describe("getPresets", () => {
    it("returns empty array before loading", () => {
      expect(service.getPresets()).toEqual([]);
    });

    it("returns cached presets after loadAndApply", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [{ id: "test", model: "test-model" }],
        })
      );

      await service.loadAndApply();
      expect(service.getPresets()).toHaveLength(1);
    });
  });

  describe("startWatching / stopWatching", () => {
    it("does not throw on stop when not started", async () => {
      await expect(service.stopWatching()).resolves.toBeUndefined();
    });
  });

  describe("startWatching / stopWatching — async teardown", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(async () => {
      await service.stopWatching().catch(() => {});
      vi.useRealTimers();
    });

    it("stopWatching awaits in-flight loadAndApply before resolving", async () => {
      let resolveLoad: (() => void) | null = null;
      const loadSpy = vi.spyOn(service, "loadAndApply").mockImplementation(
        () =>
          new Promise<AgentPreset[]>((resolve) => {
            resolveLoad = () => resolve([]);
          })
      );

      service.startWatching();
      // Enter the poll loop and trigger the first iteration (loadAndApply starts
      // but does not resolve — we control it via resolveLoad).
      await vi.advanceTimersByTimeAsync(30_000);
      expect(loadSpy).toHaveBeenCalledTimes(1);

      const stopped = service.stopWatching();
      let settled = false;
      void stopped.then(() => {
        settled = true;
      });

      // Microtasks drain but loadAndApply is still pending, so stop must not resolve.
      await Promise.resolve();
      expect(settled).toBe(false);

      // Releasing loadAndApply lets the loop observe the abort and exit.
      resolveLoad?.();
      await stopped;
      expect(settled).toBe(true);

      loadSpy.mockRestore();
    });

    it("poll loop does not call loadAndApply after stopWatching resolves", async () => {
      const loadSpy = vi.spyOn(service, "loadAndApply").mockResolvedValue([]);

      service.startWatching();
      await vi.advanceTimersByTimeAsync(30_000);
      const callsBeforeStop = loadSpy.mock.calls.length;

      await service.stopWatching();

      // Fast-forward well past subsequent scheduled polls — none may fire.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(loadSpy.mock.calls.length).toBe(callsBeforeStop);

      loadSpy.mockRestore();
    });

    it("stopWatching called twice is safe", async () => {
      const loadSpy = vi.spyOn(service, "loadAndApply").mockResolvedValue([]);

      service.startWatching();
      await service.stopWatching();
      await expect(service.stopWatching()).resolves.toBeUndefined();

      loadSpy.mockRestore();
    });

    it("startWatching called twice does not create a second concurrent loop", async () => {
      const loadSpy = vi.spyOn(service, "loadAndApply").mockResolvedValue([]);

      service.startWatching();
      service.startWatching();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(loadSpy).toHaveBeenCalledTimes(1);

      loadSpy.mockRestore();
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

    it("does NOT broadcast when presets are fully unchanged", async () => {
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
