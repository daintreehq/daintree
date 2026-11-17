import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElectronNet } from "../../../../../electron/utils/__tests__/helpers/fakeElectronNet.js";

const BASE = "https://example.com/jira";
const fakeNet = vi.hoisted(() => ({ current: null as null | { request: unknown } }));

vi.mock("electron", () => ({
  net: {
    request: (options: unknown) => (fakeNet.current!.request as (o: unknown) => unknown)(options),
  },
}));

import { clearJiraCooldown, jiraRequest, setJiraTransport } from "../JiraClient.js";

let net: FakeElectronNet;

beforeEach(() => {
  setJiraTransport(null);
  clearJiraCooldown();
});

afterEach(() => {
  fakeNet.current = null;
});

function serve(routes: ConstructorParameters<typeof FakeElectronNet>[0]) {
  net = new FakeElectronNet(routes);
  fakeNet.current = net;
}

describe("Jira's default transport", () => {
  it("goes through Chromium with no session cookies or cache, carrying the token and body", async () => {
    serve({ [`${BASE}/rest/api/2/search`]: { status: 200, body: '{"total":3}' } });

    await expect(
      jiraRequest({ deployment: "dataCenter", siteUrl: BASE, token: "pat" }, "/search", {
        method: "POST",
        body: { jql: 'project = "ENG"', maxResults: 0 },
      })
    ).resolves.toEqual({ total: 3 });

    const [request] = net.requests;
    expect(request.options).toMatchObject({
      url: `${BASE}/rest/api/2/search`,
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
    });
    expect(request.headers.authorization).toBe("Bearer pat");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request.body!)).toEqual({ jql: 'project = "ENG"', maxResults: 0 });
  });

  it("answers a redirect itself, without connecting to where it points", async () => {
    serve({
      [`${BASE}/rest/api/2/myself`]: { redirect: "https://elsewhere.example/login", status: 302 },
    });

    await expect(
      jiraRequest({ deployment: "dataCenter", siteUrl: BASE, token: "pat" }, "/myself")
    ).rejects.toMatchObject({ status: 302 });
    expect(net.connected).toEqual([`${BASE}/rest/api/2/myself`]);
  });
});
