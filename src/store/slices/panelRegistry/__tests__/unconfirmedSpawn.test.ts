import { describe, it, expect, vi } from "vitest";
import type { TerminalReconnectResult } from "@shared/types/ipc/terminal";
import { ClientAppError } from "@/utils/clientAppError";
import {
  findSpawnOnHost,
  isLostSpawnReply,
  isSpawnUnconfirmed,
  markSpawnUnconfirmed,
} from "../unconfirmedSpawn";

const linkError = (code: "HOST_DISCONNECTED" | "OUTCOME_UNKNOWN") =>
  new ClientAppError(code, `link: ${code}`);

describe("isLostSpawnReply", () => {
  it("is a written request whose answer the link lost, not one that never left", () => {
    expect(isLostSpawnReply(linkError("OUTCOME_UNKNOWN"))).toBe(true);
    expect(isLostSpawnReply(linkError("HOST_DISCONNECTED"))).toBe(false);
    expect(isLostSpawnReply(new Error("spawn boom"))).toBe(false);
  });

  it("reads the code off an error that crossed the preload", () => {
    expect(isLostSpawnReply(new Error("[AppError|OUTCOME_UNKNOWN] Link closed"))).toBe(true);
  });
});

describe("markSpawnUnconfirmed", () => {
  it("holds the id until settled", () => {
    const settle = markSpawnUnconfirmed("t-held");
    expect(isSpawnUnconfirmed("t-held")).toBe(true);
    settle();
    expect(isSpawnUnconfirmed("t-held")).toBe(false);
  });

  it("is never released by an earlier check of the same id", () => {
    const settleOld = markSpawnUnconfirmed("t-reused");
    const settleNew = markSpawnUnconfirmed("t-reused");

    settleOld();
    expect(isSpawnUnconfirmed("t-reused")).toBe(true);

    settleNew();
    expect(isSpawnUnconfirmed("t-reused")).toBe(false);
  });
});

describe("findSpawnOnHost", () => {
  const started = (id: string): TerminalReconnectResult => ({ exists: true, id, hasPty: true });

  it("waits for the link before asking the host", async () => {
    const order: string[] = [];
    let connect!: () => void;
    const connected = new Promise<void>((resolve) => {
      connect = resolve;
    });
    const probe = vi.fn(async (id: string) => {
      order.push("probe");
      return started(id);
    });

    const found = findSpawnOnHost("t-1", {
      probe,
      waitForConnected: async () => {
        await connected;
        order.push("connected");
      },
    });
    await Promise.resolve();
    expect(probe).not.toHaveBeenCalled();

    connect();
    await expect(found).resolves.toEqual({ status: "started", record: started("t-1") });
    expect(order).toEqual(["connected", "probe"]);
  });

  it("waits the link out again when it drops mid-check, without counting it as an answer", async () => {
    const waitForConnected = vi.fn(async () => {});
    const probe = vi
      .fn<(id: string) => Promise<TerminalReconnectResult>>()
      .mockRejectedValueOnce(linkError("HOST_DISCONNECTED"))
      .mockRejectedValueOnce(linkError("OUTCOME_UNKNOWN"))
      .mockResolvedValueOnce(started("t-2"));

    const found = await findSpawnOnHost("t-2", {
      probe,
      waitForConnected,
      recheckDelaysMs: [],
    });

    expect(found.status).toBe("started");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(waitForConnected).toHaveBeenCalledTimes(3);
  });

  it("asks again while the host doesn't list the terminal, and finds it once it starts", async () => {
    const probe = vi
      .fn<(id: string) => Promise<TerminalReconnectResult>>()
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce(started("t-3"));

    const found = await findSpawnOnHost("t-3", {
      probe,
      waitForConnected: async () => {},
      recheckDelaysMs: [0, 0, 0],
    });

    expect(found.status).toBe("started");
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("is absent once every recheck has passed without the host listing it", async () => {
    const probe = vi.fn(async (): Promise<TerminalReconnectResult> => ({ exists: false }));

    const found = await findSpawnOnHost("t-4", {
      probe,
      waitForConnected: async () => {},
      recheckDelaysMs: [0, 0],
    });

    expect(found).toEqual({ status: "absent" });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("is absent at once for a live terminal another workspace owns", async () => {
    const probe = vi.fn(async (): Promise<TerminalReconnectResult> => ({
      exists: false,
      conflict: true,
    }));

    const found = await findSpawnOnHost("t-5", {
      probe,
      waitForConnected: async () => {},
      recheckDelaysMs: [0, 0],
    });

    expect(found).toEqual({ status: "absent" });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("throws any other failure to ask rather than calling it an answer", async () => {
    const probe = vi.fn(async (): Promise<TerminalReconnectResult> => {
      throw new Error("Failed to reconnect to terminal: bad id");
    });

    await expect(
      findSpawnOnHost("t-6", { probe, waitForConnected: async () => {}, recheckDelaysMs: [0] })
    ).rejects.toThrow("bad id");
  });
});
