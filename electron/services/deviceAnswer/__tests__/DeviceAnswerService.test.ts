import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceAnswerSettings } from "../../../../shared/types/ipc/deviceAnswer.js";
import { DeviceAnswerService, type DeviceAnswerServiceDeps } from "../DeviceAnswerService.js";
import { defaultDeviceAnswerSettings } from "../deviceAnswerSettings.js";
import type { WaitingRunView } from "../deviceAnswerRuns.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => Record<string, unknown>;
}

function request(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          Host: `localhost:${port}`,
          ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body) as Record<string, unknown>,
          });
        });
      }
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const RUN: WaitingRunView = {
  runId: "run-1",
  spawnedAt: 100,
  project: "daintree",
  title: "Claude",
  agentId: "claude",
  agentState: "waiting",
  waitingReason: "approval",
  since: 1,
  parked: false,
  snoozed: false,
  screen: "❯ 1. Yes\n  2. No",
  choices: ["Yes", "No"],
};

const services: DeviceAnswerService[] = [];

async function setup(overrides: Partial<DeviceAnswerSettings> = {}) {
  const port = await freePort();
  let settings: DeviceAnswerSettings = { ...defaultDeviceAnswerSettings(), port, ...overrides };
  const answer = vi.fn<DeviceAnswerServiceDeps["answer"]>(async () => {});
  const listWaiting = vi.fn(async () => [RUN]);
  const onStatusChanged = vi.fn();
  const service = new DeviceAnswerService({
    readSettings: () => settings,
    writeSettings: (next) => {
      settings = next;
    },
    listWaiting,
    answer,
    onStatusChanged,
  });
  services.push(service);
  const api = { "X-Daintree-Device": "1" };
  const pair = async (): Promise<string> => {
    const { pairing } = service.createPairingCode();
    const reply = await request(port, "POST", "/api/pair", {
      headers: api,
      body: { code: pairing!.code, deviceName: "Greg's phone" },
    });
    expect(reply.status).toBe(200);
    return reply.json().token as string;
  };
  return {
    service,
    port,
    answer,
    listWaiting,
    onStatusChanged,
    api,
    pair,
    settings: () => settings,
  };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
});

describe("DeviceAnswerService", () => {
  it("listens on nothing until it is turned on, and stops listening when turned off", async () => {
    const { service, port } = await setup();
    await service.init();
    await expect(request(port, "GET", "/")).rejects.toThrow();

    const on = await service.setEnabled({ enabled: true });
    expect(on.listening).toBe(true);
    expect((await request(port, "GET", "/")).status).toBe(200);

    await service.setEnabled({ enabled: false });
    await expect(request(port, "GET", "/")).rejects.toThrow();
  });

  it("serves the page with a script-hash CSP and no caching", async () => {
    const { service, port } = await setup();
    await service.setEnabled({ enabled: true });
    const page = await request(port, "GET", "/");
    expect(page.headers["content-security-policy"]).toMatch(/script-src 'sha256-[^']+'/);
    expect(page.headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("Pair with Daintree");
  });

  it("refuses a Host it doesn't serve before anything else, the page included", async () => {
    const { service, port } = await setup();
    await service.setEnabled({ enabled: true });
    const rebound = await request(port, "GET", "/", { headers: { Host: "attacker.example" } });
    expect(rebound.status).toBe(421);

    await service.setEnabled({ enabled: true, tailnetHost: "mac.tail1234.ts.net" });
    const tailnet = await request(port, "GET", "/", { headers: { Host: "mac.tail1234.ts.net" } });
    expect(tailnet.status).toBe(200);
  });

  it("refuses API calls from another site or without the page's header", async () => {
    const { service, port, api } = await setup();
    await service.setEnabled({ enabled: true });
    const crossSite = await request(port, "GET", "/api/waiting", {
      headers: { ...api, "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    const foreignOrigin = await request(port, "POST", "/api/pair", {
      headers: { ...api, Origin: "http://evil.example" },
      body: { code: "x" },
    });
    expect(foreignOrigin.status).toBe(403);
    const bare = await request(port, "GET", "/api/waiting");
    expect(bare.status).toBe(403);
  });

  it("pairs a device with the open code, keeps only its token's digest, and lists waiting runs to it", async () => {
    const { service, port, api, pair, settings } = await setup();
    await service.setEnabled({ enabled: true });
    expect((await request(port, "GET", "/api/waiting", { headers: api })).status).toBe(401);

    const token = await pair();
    const [device] = settings().devices;
    expect(device?.name).toBe("Greg's phone");
    expect(JSON.stringify(settings())).not.toContain(token);
    expect(JSON.stringify(service.getStatus())).not.toContain(device!.tokenHash);

    const waiting = await request(port, "GET", "/api/waiting", {
      headers: { ...api, Authorization: `Bearer ${token}` },
    });
    expect(waiting.status).toBe(200);
    expect(waiting.json().runs).toEqual([RUN]);
  });

  it("refuses a wrong code, and a code that was used", async () => {
    const { service, port, api, pair } = await setup();
    await service.setEnabled({ enabled: true });
    service.createPairingCode();
    const wrong = await request(port, "POST", "/api/pair", {
      headers: api,
      body: { code: "AAAA-AAAA", deviceName: "x" },
    });
    expect(wrong.status).toBe(403);
    await pair();
    const reused = await request(port, "POST", "/api/pair", {
      headers: api,
      body: { code: "AAAA-AAAA", deviceName: "x" },
    });
    expect(reused.json().error).toContain("No pairing code is open");
  });

  it("answers by label only, for the device, and records it with the device's name", async () => {
    const { service, port, api, pair, answer, settings } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    const reply = await request(port, "POST", "/api/answer", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: { runId: "run-1", spawnedAt: 100, label: "Yes", keys: ["Enter"] },
    });
    expect(reply.status).toBe(200);
    expect(answer).toHaveBeenCalledTimes(1);
    const call = answer.mock.calls[0]![0];
    expect(call).toMatchObject({ runId: "run-1", spawnedAt: 100, label: "Yes" });
    expect(call).not.toHaveProperty("keys");
    expect(call.device.name).toBe("Greg's phone");
    expect(call.stillAllowed()).toBeNull();
    expect(settings().answers[0]).toMatchObject({
      deviceName: "Greg's phone",
      runId: "run-1",
      label: "Yes",
      outcome: "answered",
    });
  });

  it("records a refused answer with the reason the page is shown", async () => {
    const { service, port, api, pair, answer, settings } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    answer.mockRejectedValueOnce({
      userMessage: "This project is being driven from another screen. Nothing was pressed.",
    });
    const reply = await request(port, "POST", "/api/answer", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: { runId: "run-1", spawnedAt: 100, label: "Yes" },
    });
    expect(reply.status).toBe(409);
    expect(reply.json().error).toContain("driven from another screen");
    expect(settings().answers[0]).toMatchObject({ outcome: "refused" });
  });

  it("refuses a removed device at once, and mid-answer through stillAllowed", async () => {
    const { service, port, api, pair, answer, settings } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    let refusalMidAnswer: string | null = null;
    answer.mockImplementationOnce(async ({ stillAllowed }) => {
      service.revokeDevice(settings().devices[0]!.id);
      refusalMidAnswer = stillAllowed();
    });
    await request(port, "POST", "/api/answer", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: { runId: "run-1", spawnedAt: 100, label: "Yes" },
    });
    expect(refusalMidAnswer).toContain("removed");
    const after = await request(port, "GET", "/api/waiting", {
      headers: { ...api, Authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
  });

  it("lets a device unpair itself", async () => {
    const { service, port, api, pair, settings } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    const reply = await request(port, "POST", "/api/unpair", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: {},
    });
    expect(reply.status).toBe(200);
    expect(settings().devices).toEqual([]);
  });

  it("says why it isn't listening when the port is taken", async () => {
    const { service, port } = await setup();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", () => resolve()));
    try {
      const status = await service.setEnabled({ enabled: true });
      expect(status.listening).toBe(false);
      expect(status.error).toContain(String(port));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("won't open a pairing code while off, and refuses a port outside the range", async () => {
    const { service } = await setup();
    expect(() => service.createPairingCode()).toThrow();
    await expect(service.setEnabled({ enabled: true, port: 80 })).rejects.toThrow();
  });
});
