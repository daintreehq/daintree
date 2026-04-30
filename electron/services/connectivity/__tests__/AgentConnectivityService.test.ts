import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  AgentConnectivityServiceImpl,
  AGENT_CONNECTIVITY_FOCUS_COOLDOWN_MS,
  type AgentConnectivityChange,
} from "../AgentConnectivityService.js";

function buildResponse(status: number): Response {
  return new Response("{}", { status });
}

describe("AgentConnectivityService", () => {
  let service: AgentConnectivityServiceImpl;
  let fetchMock: Mock;
  let listener: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    listener = vi.fn();
    service = new AgentConnectivityServiceImpl({
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });
    service.onStateChange(listener as (change: AgentConnectivityChange) => void);
  });

  afterEach(() => {
    service.dispose();
  });

  describe("refresh()", () => {
    it("marks every provider reachable on a 2xx probe response", async () => {
      fetchMock.mockResolvedValue(buildResponse(200));

      await service.refresh({ force: true });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/models",
        expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) })
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "https://generativelanguage.googleapis.com/v1beta/models",
        expect.any(Object)
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.openai.com/v1/models",
        expect.any(Object)
      );

      expect(service.getProviderState("claude").status).toBe("reachable");
      expect(service.getProviderState("gemini").status).toBe("reachable");
      expect(service.getProviderState("codex").status).toBe("reachable");
    });

    it("treats a 401 response as reachable (auth state is not a network signal)", async () => {
      fetchMock.mockResolvedValue(buildResponse(401));

      await service.refresh({ force: true });

      expect(service.getProviderState("claude").status).toBe("reachable");
    });

    it("treats a 5xx response as reachable (host responded)", async () => {
      fetchMock.mockResolvedValue(buildResponse(503));

      await service.refresh({ force: true });

      expect(service.getProviderState("claude").status).toBe("reachable");
    });

    it("marks providers unreachable on network failures (DNS, timeout, abort)", async () => {
      fetchMock.mockRejectedValue(new Error("ENOTFOUND api.anthropic.com"));

      await service.refresh({ force: true });

      expect(service.getProviderState("claude").status).toBe("unreachable");
      expect(service.getProviderState("gemini").status).toBe("unreachable");
      expect(service.getProviderState("codex").status).toBe("unreachable");
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "claude", status: "unreachable" })
      );
    });

    it("coalesces concurrent probes for the same provider into one in-flight request", async () => {
      const resolvers: Array<(value: Response) => void> = [];
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          })
      );

      const first = service.refresh({ force: true });
      const second = service.refresh({ force: true });

      // Three providers, but each provider's refresh should coalesce — so
      // exactly three fetches even though refresh was called twice.
      expect(fetchMock).toHaveBeenCalledTimes(3);

      for (const resolve of resolvers) {
        resolve(buildResponse(200));
      }
      await Promise.all([first, second]);

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("respects the per-provider focus cooldown by default", async () => {
      let now = 1_000_000;
      service._setNowForTests(() => now);
      fetchMock.mockResolvedValue(buildResponse(200));

      await service.refresh({ force: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);

      now += AGENT_CONNECTIVITY_FOCUS_COOLDOWN_MS - 1_000;
      await service.refresh();
      expect(fetchMock).toHaveBeenCalledTimes(3);

      now += 2_000;
      await service.refresh();
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it("force refresh bypasses the cooldown", async () => {
      const now = 1_000_000;
      service._setNowForTests(() => now);
      fetchMock.mockResolvedValue(buildResponse(200));

      await service.refresh({ force: true });
      await service.refresh({ force: true });

      expect(fetchMock).toHaveBeenCalledTimes(6);
    });
  });

  describe("transitions", () => {
    it("emits exactly once per real state change", async () => {
      fetchMock.mockResolvedValue(buildResponse(200));

      await service.refresh({ force: true });
      // unknown → reachable for each of the three providers.
      expect(listener).toHaveBeenCalledTimes(3);
      listener.mockClear();

      await service.refresh({ force: true });
      // No transitions on the second probe — already reachable.
      expect(listener).not.toHaveBeenCalled();
    });

    it("emits when a provider transitions from reachable back to unreachable", async () => {
      fetchMock.mockResolvedValue(buildResponse(200));
      await service.refresh({ force: true });
      listener.mockClear();

      fetchMock.mockReset();
      fetchMock.mockRejectedValue(new Error("ETIMEDOUT"));
      await service.refresh({ force: true });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "claude", status: "unreachable" })
      );
    });
  });

  describe("dispose()", () => {
    it("clears listeners and resets state", () => {
      service.dispose();
      expect(service.getProviderState("claude").status).toBe("unknown");
    });

    it("does not let an in-flight probe overwrite reset state after dispose()", async () => {
      const resolvers: Array<(value: Response) => void> = [];
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          })
      );

      const probe = service.refresh({ force: true });
      service.dispose();
      // Resolve the in-flight fetches AFTER dispose. Without the disposed
      // guard in transitionTo(), these would overwrite the reset state.
      for (const resolve of resolvers) {
        resolve(buildResponse(200));
      }
      await probe;

      expect(service.getProviderState("claude").status).toBe("unknown");
      expect(service.getProviderState("gemini").status).toBe("unknown");
      expect(service.getProviderState("codex").status).toBe("unknown");
      expect(listener).not.toHaveBeenCalled();
    });

    it("classifies each provider independently when one resolves and another rejects", async () => {
      fetchMock.mockImplementation((url: string) => {
        if (url.includes("anthropic")) return Promise.resolve(buildResponse(200));
        if (url.includes("googleapis")) return Promise.reject(new Error("ENOTFOUND"));
        return Promise.resolve(buildResponse(200));
      });

      await service.refresh({ force: true });

      expect(service.getProviderState("claude").status).toBe("reachable");
      expect(service.getProviderState("gemini").status).toBe("unreachable");
      expect(service.getProviderState("codex").status).toBe("reachable");
    });
  });
});
