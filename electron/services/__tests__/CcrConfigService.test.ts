import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentPreset } from "../../../shared/config/agentRegistry.js";
import { CcrConfigService } from "../CcrConfigService.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
}));

vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: { AGENT_PRESETS_UPDATED: "agent-presets:updated" },
}));

vi.mock("../../../shared/config/agentRegistry.js", () => ({
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
    it("returns empty array silently when config file does not exist (ENOENT)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockReadFile.mockRejectedValue(
        Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
      );
      const presets = await service.discoverPresets();
      expect(presets).toEqual([]);
      // ENOENT is the expected case (CCR not installed) — must NOT warn.
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("warns and returns empty array on permission error (EACCES)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockReadFile.mockRejectedValue(
        Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
      );
      const presets = await service.discoverPresets();
      expect(presets).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("[CcrConfigService]");
      expect(warnSpy.mock.calls[0][0]).toContain("Failed to read config");
      warnSpy.mockRestore();
    });

    it("returns empty array when config has no models", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({}));
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

    it("warns and returns empty array on malformed JSON", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockReadFile.mockResolvedValue("not json at all");
      const presets = await service.discoverPresets();
      expect(presets).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("[CcrConfigService]");
      expect(warnSpy.mock.calls[0][0]).toContain("Failed to parse config");
      warnSpy.mockRestore();
    });

    it("does not log raw config contents on parse error (avoid leaking inline keys)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // A user pastes their literal API key inline by mistake, then breaks the JSON.
      const leakySnippet = "sk-ant-api03-SECRET-DO-NOT-LOG";
      mockReadFile.mockResolvedValue(`{ "models": [{ "id": "x", "apiKey": "${leakySnippet}" }`);
      await service.discoverPresets();
      const allLoggedText = warnSpy.mock.calls
        .flatMap((call) =>
          call.map((arg) =>
            arg instanceof Error ? formatErrorMessage(arg, "parse error") : String(arg)
          )
        )
        .join(" ");
      expect(allLoggedText).not.toContain(leakySnippet);
      warnSpy.mockRestore();
    });

    it("filters entries with non-string id (e.g. object) — no ccr-[object Object] preset", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [
            { id: { nested: "object" }, name: "bad" },
            { id: 42, name: "also bad" },
            { id: "valid", model: "valid-model" },
          ],
        })
      );

      const presets = await service.discoverPresets();
      expect(presets).toHaveLength(1);
      expect(presets[0].id).toBe("ccr-valid");
      expect(presets.every((p) => !p.id.includes("[object Object]"))).toBe(true);
      warnSpy.mockRestore();
    });

    it("filters entries with empty-string id when no model fallback — no ccr- preset", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [
            { id: "", name: "empty id" },
            { id: "", model: "" },
            { id: "valid", model: "valid-model" },
          ],
        })
      );

      const presets = await service.discoverPresets();
      expect(presets).toHaveLength(1);
      expect(presets[0].id).toBe("ccr-valid");
      expect(presets.every((p) => p.id !== "ccr-")).toBe(true);
    });

    it("falls back to model when id is non-string but model is valid", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [{ id: { foo: "bar" }, model: "real-model" }],
        })
      );

      const presets = await service.discoverPresets();
      expect(presets).toHaveLength(1);
      expect(presets[0].id).toBe("ccr-real-model");
      expect(presets[0].id).not.toContain("[object Object]");
    });

    it("filters entries with non-string model and no valid id", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [
            { model: 42 },
            { model: { nested: true } },
            { id: "valid", model: "valid-model" },
          ],
        })
      );

      const presets = await service.discoverPresets();
      expect(presets).toHaveLength(1);
      expect(presets[0].id).toBe("ccr-valid");
    });

    it("returns empty array (without throwing) when top-level JSON is null", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockReadFile.mockResolvedValue("null");
      const presets = await service.discoverPresets();
      expect(presets).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("not an object");
      warnSpy.mockRestore();
    });

    it("returns empty array (without throwing) when top-level JSON is an array", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockReadFile.mockResolvedValue('[{"id":"x"}]');
      const presets = await service.discoverPresets();
      expect(presets).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it("skips null entries in models array and still maps remaining valid ones", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: [null, { id: "valid", model: "valid-model" }, undefined],
        })
      );
      const presets = await service.discoverPresets();
      expect(presets).toHaveLength(1);
      expect(presets[0].id).toBe("ccr-valid");
    });

    it("skips primitive entries in models array (e.g. strings/numbers)", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          models: ["just-a-string", 42, { id: "valid", model: "valid-model" }],
        })
      );
      const presets = await service.discoverPresets();
      expect(presets).toHaveLength(1);
      expect(presets[0].id).toBe("ccr-valid");
    });

    it("warns on non-Error read rejection (e.g. raw string thrown)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockReadFile.mockRejectedValue("boom");
      const presets = await service.discoverPresets();
      expect(presets).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("Failed to read config");
      warnSpy.mockRestore();
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

  describe("startWatching / stopWatching — async teardown", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(async () => {
      await service.stopWatching().catch(() => {});
      vi.useRealTimers();
    });

    it("stopWatching awaits in-flight loadAndApply before resolving", async () => {
      const resolveRef: { fn: (() => void) | null } = { fn: null };
      const loadSpy = vi.spyOn(service, "loadAndApply").mockImplementation(
        () =>
          new Promise<AgentPreset[]>((resolve) => {
            resolveRef.fn = () => resolve([]);
          })
      );

      service.startWatching();
      // Enter the poll loop and trigger the first iteration (loadAndApply starts
      // but does not resolve — we control it via resolveRef.fn).
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
      resolveRef.fn?.();
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

    it("stopWatching resolves immediately during the sleep phase (no 30s wait)", async () => {
      const loadSpy = vi.spyOn(service, "loadAndApply").mockResolvedValue([]);

      service.startWatching();
      // Loop is parked in abortableSleep; stopWatching() must wake it without
      // advancing real or fake timers.
      await service.stopWatching();

      expect(loadSpy).not.toHaveBeenCalled();
      loadSpy.mockRestore();
    });

    it("transient loadAndApply failure does not kill subsequent polls", async () => {
      const loadSpy = vi
        .spyOn(service, "loadAndApply")
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue([]);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      service.startWatching();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(loadSpy).toHaveBeenCalledTimes(1);

      // Next iteration must still run despite prior failure.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(loadSpy).toHaveBeenCalledTimes(2);

      loadSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("start → stop → start does not orphan the new watcher", async () => {
      const firstRef: { fn: (() => void) | null } = { fn: null };
      const loadSpy = vi.spyOn(service, "loadAndApply").mockImplementationOnce(
        () =>
          new Promise<AgentPreset[]>((resolve) => {
            firstRef.fn = () => resolve([]);
          })
      );
      loadSpy.mockResolvedValue([]);

      service.startWatching();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(loadSpy).toHaveBeenCalledTimes(1);

      // stop in-flight; new start races while old teardown is pending
      const stopped = service.stopWatching();
      service.startWatching();

      // Release the first iteration so the old loop can exit.
      firstRef.fn?.();
      await stopped;

      // The second watcher (newly started) must still be live and firing polls.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(loadSpy).toHaveBeenCalledTimes(2);
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

    it("clears stale presets after a previously-good config goes malformed", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ models: [{ id: "alpha", model: "alpha-model" }] })
      );
      await service.loadAndApply();
      expect(service.getPresets()).toHaveLength(1);

      // User edits config and breaks the JSON. The next poll iteration must
      // reset cached presets to [] so the renderer doesn't keep launching
      // with stale routing.
      mockReadFile.mockResolvedValueOnce("not json at all");
      await service.loadAndApply();
      expect(service.getPresets()).toEqual([]);

      warnSpy.mockRestore();
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
