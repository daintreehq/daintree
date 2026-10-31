import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceAnswerSettings } from "../../../../shared/types/ipc/deviceAnswer.js";
import { DeviceAnswerService, type DeviceAnswerServiceDeps } from "../DeviceAnswerService.js";
import { defaultDeviceAnswerSettings } from "../deviceAnswerSettings.js";
import type {
  DeviceWaitingHost,
  DeviceWaitingList,
  DeviceWaitingRun,
} from "../deviceAnswerRuns.js";

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

const RUN: DeviceWaitingRun = {
  hostId: "local",
  host: "greg-studio",
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
  questionId: "question-of-run-1-0001",
};

/** The question a listed run's answer names, as the page sends it back. */
const QUESTION = RUN.questionId;

const services: DeviceAnswerService[] = [];

async function setup(overrides: Partial<DeviceAnswerSettings> = {}) {
  // Port 0 binds whatever is free, so parallel workers never race for one.
  let settings: DeviceAnswerSettings = {
    ...defaultDeviceAnswerSettings(),
    port: 0,
    ...overrides,
  };
  const answer = vi.fn<DeviceAnswerServiceDeps["answer"]>(async () => {});
  const hosts: DeviceWaitingHost[] = [
    { hostId: "studio-03", host: "studio-03", status: "ok" },
    { hostId: "mini", host: "Mini", status: "not-connected" },
  ];
  const listWaiting = vi.fn(
    async (
      _options: Parameters<DeviceAnswerServiceDeps["listWaiting"]>[0]
    ): Promise<DeviceWaitingList> => ({
      runs: [RUN],
      hosts,
    })
  );
  const onStatusChanged = vi.fn();
  const service = new DeviceAnswerService({
    readSettings: () => settings,
    writeSettings: (next) => {
      settings = next;
    },
    listWaiting,
    answer,
    hostName: (hostId) => (hostId === "studio-03" ? "studio-03" : null),
    onStatusChanged,
  });
  services.push(service);
  const port = (): number => {
    const bound = service.boundPort;
    if (bound === null) throw new Error("not listening");
    return bound;
  };
  const api = { "X-Daintree-Device": "1" };
  const pair = async (): Promise<string> => {
    const { pairing } = service.createPairingCode();
    const reply = await request(port(), "POST", "/api/pair", {
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
    expect(service.boundPort).toBeNull();

    const on = await service.setEnabled({ enabled: true });
    expect(on.listening).toBe(true);
    const bound = port();
    expect((await request(bound, "GET", "/")).status).toBe(200);

    await service.setEnabled({ enabled: false });
    expect(service.boundPort).toBeNull();
    await expect(request(bound, "GET", "/")).rejects.toThrow();
  });

  it("serves the page with a script-hash CSP and no caching", async () => {
    const { service, port } = await setup();
    await service.setEnabled({ enabled: true });
    const page = await request(port(), "GET", "/");
    expect(page.headers["content-security-policy"]).toMatch(/script-src 'sha256-[^']+'/);
    expect(page.headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("Pair with Daintree");
  });

  it("refuses a Host it doesn't serve before anything else, the page included", async () => {
    const { service, port } = await setup();
    await service.setEnabled({ enabled: true });
    const rebound = await request(port(), "GET", "/", { headers: { Host: "attacker.example" } });
    expect(rebound.status).toBe(421);

    await service.setEnabled({ enabled: true, tailnetHost: "mac.tail1234.ts.net" });
    const tailnet = await request(port(), "GET", "/", { headers: { Host: "mac.tail1234.ts.net" } });
    expect(tailnet.status).toBe(200);
  });

  it("refuses API calls from another site or without the page's header", async () => {
    const { service, port, api } = await setup();
    await service.setEnabled({ enabled: true });
    const crossSite = await request(port(), "GET", "/api/waiting", {
      headers: { ...api, "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    const foreignOrigin = await request(port(), "POST", "/api/pair", {
      headers: { ...api, Origin: "http://evil.example" },
      body: { code: "x" },
    });
    expect(foreignOrigin.status).toBe(403);
    const bare = await request(port(), "GET", "/api/waiting");
    expect(bare.status).toBe(403);
  });

  it("pairs a device with the open code, keeps only its token's digest, and lists waiting runs to it", async () => {
    const { service, port, api, pair, settings, listWaiting } = await setup();
    await service.setEnabled({ enabled: true });
    expect((await request(port(), "GET", "/api/waiting", { headers: api })).status).toBe(401);

    const token = await pair();
    const [device] = settings().devices;
    expect(device?.name).toBe("Greg's phone");
    expect(JSON.stringify(settings())).not.toContain(token);
    expect(JSON.stringify(service.getStatus())).not.toContain(device!.tokenHash);

    const waiting = await request(port(), "GET", "/api/waiting?hosts=1", {
      headers: { ...api, Authorization: `Bearer ${token}` },
    });
    expect(waiting.status).toBe(200);
    expect(listWaiting).toHaveBeenLastCalledWith({ hosts: true, read: null });
    expect(waiting.json().runs).toEqual([RUN]);
    expect(waiting.json().hosts).toEqual([
      { hostId: "studio-03", host: "studio-03", status: "ok" },
      { hostId: "mini", host: "Mini", status: "not-connected" },
    ]);
    expect(waiting.json().hostsUnlisted).toBe(false);

    // A host list that couldn't be read is said so, not sent as no hosts.
    listWaiting.mockResolvedValueOnce({ runs: [RUN], hosts: [], hostsUnlisted: true });
    const unlisted = await request(port(), "GET", "/api/waiting?hosts=1", {
      headers: { ...api, Authorization: `Bearer ${token}` },
    });
    expect(unlisted.json()).toEqual({
      runs: [RUN],
      omitted: [],
      coverage: [],
      hosts: [],
      hostsUnlisted: true,
    });

    // A page from before hosts were listed would answer theirs as this machine's.
    await request(port(), "GET", "/api/waiting", {
      headers: { ...api, Authorization: `Bearer ${token}` },
    });
    expect(listWaiting).toHaveBeenLastCalledWith({ hosts: false, read: null });
  });

  it("reads the run a device picked first, and refuses a pick it can't understand before reading any", async () => {
    const { service, port, api, pair, listWaiting } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    const get = (query: string) =>
      request(port(), "GET", `/api/waiting${query}`, {
        headers: { ...api, Authorization: `Bearer ${token}` },
      });
    const pick = (value: unknown) => `read=${encodeURIComponent(JSON.stringify(value))}`;

    const {
      runId: _runId,
      spawnedAt: _spawnedAt,
      screen: _s,
      choices: _c,
      questionId: _q,
      ...rest
    } = RUN;
    const omitted = [{ ...rest, runId: "run-2", spawnedAt: 100 }];
    const coverage = [{ hostId: "local", host: "greg-studio", listed: 1, waiting: 2 }];
    listWaiting.mockResolvedValueOnce({ runs: [RUN], omitted, coverage, hosts: [] });
    const picked = await get(
      `?hosts=1&${pick({ hostId: "local", runId: "run-2", spawnedAt: 100 })}`
    );
    expect(picked.status).toBe(200);
    expect(listWaiting).toHaveBeenLastCalledWith({
      hosts: true,
      read: { hostId: "local", runId: "run-2", spawnedAt: 100 },
    });
    expect(picked.json()).toMatchObject({ omitted, coverage });

    await get(`?hosts=1&${pick({ hostId: "studio-03", runId: "run-2", spawnedAt: 100 })}`);
    expect(listWaiting).toHaveBeenLastCalledWith({
      hosts: true,
      read: { hostId: "studio-03", runId: "run-2", spawnedAt: 100 },
    });
    // A page that isn't shown hosts' runs can't pick one.
    await get(`?${pick({ hostId: "studio-03", runId: "run-2", spawnedAt: 100 })}`);
    expect(listWaiting).toHaveBeenLastCalledWith({ hosts: false, read: null });

    const calls = listWaiting.mock.calls.length;
    for (const query of [
      "?hosts=1&read=not-json",
      `?hosts=1&${pick({ hostId: "local", runId: "", spawnedAt: 100 })}`,
      `?hosts=1&${pick({ hostId: "local", runId: "run-2" })}`,
      `?hosts=1&${pick({ hostId: "has:colon", runId: "run-2", spawnedAt: 100 })}`,
      `?hosts=1&${pick({ hostId: "local", runId: "x".repeat(257), spawnedAt: 100 })}`,
      `?hosts=1&${pick({ hostId: "local", runId: "a", spawnedAt: 1 })}&${pick({ hostId: "local", runId: "b", spawnedAt: 1 })}`,
    ]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(listWaiting).toHaveBeenCalledTimes(calls);
  });

  it("refuses a wrong code, and a code that was used", async () => {
    const { service, port, api, pair } = await setup();
    await service.setEnabled({ enabled: true });
    service.createPairingCode();
    const wrong = await request(port(), "POST", "/api/pair", {
      headers: api,
      body: { code: "AAAA-AAAA", deviceName: "x" },
    });
    expect(wrong.status).toBe(403);
    await pair();
    const reused = await request(port(), "POST", "/api/pair", {
      headers: api,
      body: { code: "AAAA-AAAA", deviceName: "x" },
    });
    expect(reused.json().error).toContain("No pairing code is open");
  });

  it("answers by label only, for the device, and records it with the device's name", async () => {
    const { service, port, api, pair, answer, settings } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    const reply = await request(port(), "POST", "/api/answer", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: { runId: "run-1", spawnedAt: 100, label: "Yes", keys: ["Enter"], questionId: QUESTION },
    });
    expect(reply.status).toBe(200);
    expect(answer).toHaveBeenCalledTimes(1);
    const call = answer.mock.calls[0]![0];
    // A page that names no host answers this machine's run.
    expect(call).toMatchObject({ hostId: "local", runId: "run-1", spawnedAt: 100, label: "Yes" });
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

  it("answers a connected host's run on that host, and records the host it went to", async () => {
    const { service, port, api, pair, answer, settings } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    const reply = await request(port(), "POST", "/api/answer", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: {
        hostId: "studio-03",
        runId: "run-1",
        spawnedAt: 100,
        label: "Yes",
        questionId: QUESTION,
      },
    });
    expect(reply.status).toBe(200);
    expect(answer.mock.calls[0]![0]).toMatchObject({ hostId: "studio-03", runId: "run-1" });
    expect(settings().answers[0]).toMatchObject({
      hostId: "studio-03",
      hostName: "studio-03",
      outcome: "answered",
    });

    answer.mockRejectedValueOnce({
      userMessage: "The connection to studio-03 dropped while answering. It may have been pressed.",
    });
    const dropped = await request(port(), "POST", "/api/answer", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: {
        hostId: "studio-03",
        runId: "run-1",
        spawnedAt: 100,
        label: "No",
        questionId: QUESTION,
      },
    });
    expect(dropped.status).toBe(409);
    expect(dropped.json().error).toContain("may have been pressed");
    expect(settings().answers[0]).toMatchObject({ hostId: "studio-03", outcome: "refused" });
  });

  it("records no host for this machine's own runs", async () => {
    const { service, port, api, pair, settings } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    await request(port(), "POST", "/api/answer", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: { hostId: "local", runId: "run-1", spawnedAt: 100, label: "Yes", questionId: QUESTION },
    });
    expect(settings().answers[0]).not.toHaveProperty("hostId");
    expect(settings().answers[0]).not.toHaveProperty("hostName");
  });

  it("passes on the question the device was shown, and presses nothing for an answer naming none", async () => {
    const { service, port, api, pair, answer, settings } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    const send = (body: Record<string, unknown>) =>
      request(port(), "POST", "/api/answer", {
        headers: { ...api, Authorization: `Bearer ${token}` },
        body: { runId: "run-1", spawnedAt: 100, label: "Yes", ...body },
      });

    // A page from before answers named their question would answer by label alone.
    const stale = await send({});
    expect(stale.status).toBe(409);
    expect(stale.json().error).toContain("Reload it");
    expect(stale.json().error).toContain("Nothing was pressed");
    for (const questionId of [
      null,
      "",
      7,
      "short",
      "has spaces in it, so not one",
      "x".repeat(129),
    ]) {
      expect((await send({ questionId })).status).toBe(400);
    }
    expect(answer).not.toHaveBeenCalled();
    expect(settings().answers).toEqual([]);

    expect((await send({ questionId: QUESTION })).status).toBe(200);
    expect(answer.mock.calls[0]![0]).toMatchObject({ questionId: QUESTION });
  });

  it("refuses an answer naming a host it can't be for, pressing nothing", async () => {
    const { service, port, api, pair, answer } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    for (const hostId of [null, "", 7, "x".repeat(65)]) {
      const reply = await request(port(), "POST", "/api/answer", {
        headers: { ...api, Authorization: `Bearer ${token}` },
        body: { hostId, runId: "run-1", spawnedAt: 100, label: "Yes", questionId: QUESTION },
      });
      expect(reply.status).toBe(400);
    }
    expect(answer).not.toHaveBeenCalled();
  });

  it("records a refused answer with the reason the page is shown", async () => {
    const { service, port, api, pair, answer, settings } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    answer.mockRejectedValueOnce({
      userMessage: "This project is being driven from another screen. Nothing was pressed.",
    });
    const reply = await request(port(), "POST", "/api/answer", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: { runId: "run-1", spawnedAt: 100, label: "Yes", questionId: QUESTION },
    });
    expect(reply.status).toBe(409);
    expect(reply.json().error).toContain("driven from another screen");
    expect(settings().answers[0]).toMatchObject({ outcome: "refused" });
  });

  it("keeps a secret a device sends out of the audit and the refusal", async () => {
    const { service, port, api, pair, answer, settings } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    answer.mockRejectedValueOnce({
      userMessage: 'No option "Use token=abcdef123456" is on the screen. Nothing was pressed.',
    });
    const reply = await request(port(), "POST", "/api/answer", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: {
        runId: "run-1",
        spawnedAt: 100,
        label: "Use token=abcdef123456",
        questionId: QUESTION,
      },
    });
    expect(reply.status).toBe(409);
    expect(settings().answers[0]).toMatchObject({
      label: "Use token=[redacted]",
      outcome: "refused",
    });
    expect(JSON.stringify(settings().answers)).not.toContain("abcdef123456");
    expect(reply.json().error).not.toContain("abcdef123456");
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
    await request(port(), "POST", "/api/answer", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: { runId: "run-1", spawnedAt: 100, label: "Yes", questionId: QUESTION },
    });
    expect(refusalMidAnswer).toContain("removed");
    const after = await request(port(), "GET", "/api/waiting", {
      headers: { ...api, Authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
  });

  it("lets a device unpair itself", async () => {
    const { service, port, api, pair, settings } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    const reply = await request(port(), "POST", "/api/unpair", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: {},
    });
    expect(reply.status).toBe(200);
    expect(settings().devices).toEqual([]);
  });

  it("says why it isn't listening when the port is taken", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const taken = (blocker.address() as net.AddressInfo).port;
    try {
      const { service } = await setup({ port: taken });
      const status = await service.setEnabled({ enabled: true });
      expect(status.listening).toBe(false);
      expect(status.error).toContain(String(taken));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("stops an answer begun under a listener that has since been restarted", async () => {
    const { service, port, api, pair, answer } = await setup();
    await service.setEnabled({ enabled: true });
    const token = await pair();
    let refusal: string | null = null;
    answer.mockImplementationOnce(async ({ stillAllowed }) => {
      await service.setEnabled({ enabled: false });
      await service.setEnabled({ enabled: true });
      refusal = stillAllowed();
    });
    await request(port(), "POST", "/api/answer", {
      headers: { ...api, Authorization: `Bearer ${token}` },
      body: { runId: "run-1", spawnedAt: 100, label: "Yes", questionId: QUESTION },
    }).catch(() => null);
    expect(refusal).toContain("turned off");
  });

  it("refuses an oversized body with a 413 the client receives", async () => {
    const { service, port, api } = await setup();
    await service.setEnabled({ enabled: true });
    const reply = await request(port(), "POST", "/api/pair", {
      headers: api,
      body: { code: "x".repeat(20_000) },
    });
    expect(reply.status).toBe(413);
  });

  it("starts nothing once disposed", async () => {
    const { service } = await setup({ enabled: true });
    await service.dispose();
    await service.init();
    expect(service.boundPort).toBeNull();
  });

  it("won't open a pairing code while off, and refuses a port outside the range", async () => {
    const { service } = await setup();
    expect(() => service.createPairingCode()).toThrow();
    await expect(service.setEnabled({ enabled: true, port: 80 })).rejects.toThrow();
  });
});
