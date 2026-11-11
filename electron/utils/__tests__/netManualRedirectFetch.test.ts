import { describe, it, expect } from "vitest";
import { getEventListeners } from "node:events";
import { createManualRedirectFetch } from "../netManualRedirectFetch.js";
import { FakeElectronNet } from "./helpers/fakeElectronNet.js";

const START = "https://github.com/acme/plugin/releases/download/v1/p.dntr";
const ASSET = "https://release-assets.githubusercontent.com/p.dntr?sig=x";

describe("createManualRedirectFetch", () => {
  it("answers a manual-mode redirect with its status and resolved Location instead of rejecting", async () => {
    const net = new FakeElectronNet({
      [START]: { redirect: ASSET, status: 302, headers: { "x-hop": ["one"] } },
      [ASSET]: { status: 200, body: "PK" },
    });

    const response = await createManualRedirectFetch(net.request)(START, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(ASSET);
    expect(response.headers.get("x-hop")).toBe("one");
    expect(response.body).toBeNull();
    // Aborted inside the event, so nothing reached the next hop and no error fired.
    expect(net.requests).toHaveLength(1);
    expect(net.requests[0]!.aborted).toBe(true);
    expect(net.connected).toEqual([START]);
  });

  it("reports a relative Location as the URL Electron resolved", async () => {
    const net = new FakeElectronNet({ [START]: { redirect: "https://github.com/next.dntr" } });

    const response = await createManualRedirectFetch(net.request)(START, { redirect: "manual" });

    expect(response.headers.get("location")).toBe("https://github.com/next.dntr");
  });

  it("leaves following to Electron when the caller didn't ask for manual mode", async () => {
    const net = new FakeElectronNet({
      [START]: { redirect: ASSET },
      [ASSET]: { status: 200, body: "PK" },
    });

    const response = await createManualRedirectFetch(net.request)(START);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("PK");
    expect(net.connected).toEqual([START, ASSET]);
  });

  it("streams a final response's status, headers and body", async () => {
    const net = new FakeElectronNet({
      [START]: {
        status: 206,
        statusMessage: "Partial Content",
        headers: { "content-type": "application/zip", "content-range": "bytes 2-3/4" },
        body: "zz",
      },
    });

    const response = await createManualRedirectFetch(net.request)(START, { redirect: "manual" });

    expect(response.status).toBe(206);
    expect(response.statusText).toBe("Partial Content");
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-range")).toBe("bytes 2-3/4");
    expect(await response.text()).toBe("zz");
  });

  it.each([
    ["HEAD", 200],
    ["GET", 204],
  ])("gives a %s %i response no body", async (method, status) => {
    const net = new FakeElectronNet({ [START]: { status, body: "" } });

    const response = await createManualRedirectFetch(net.request)(START, { method });

    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it("passes the request's options and headers to net.request the way net.fetch does", async () => {
    const net = new FakeElectronNet({ [START]: { status: 200 } });
    const fetch = createManualRedirectFetch(net.request);

    await fetch(START, {
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: { Range: "bytes=10-", "If-Range": '"abc"' },
    });
    await fetch(START);

    const [explicit, defaults] = net.requests;
    expect(explicit!.options).toMatchObject({
      method: "GET",
      url: START,
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
    });
    expect(explicit!.headers).toEqual({ range: "bytes=10-", "if-range": '"abc"' });
    // `same-origin` without an Origin is sent as `include`, as net.fetch does.
    expect(defaults!.options).toMatchObject({ credentials: "include", redirect: "follow" });
  });

  it("rejects with an already-aborted signal's reason without creating a request", async () => {
    const net = new FakeElectronNet({ [START]: { status: 200 } });
    const reason = new Error("cancelled");

    await expect(
      createManualRedirectFetch(net.request)(START, { signal: AbortSignal.abort(reason) })
    ).rejects.toBe(reason);
    expect(net.requests).toHaveLength(0);
  });

  it("rejects with the signal's reason and aborts the request when it fires before headers", async () => {
    const net = new FakeElectronNet({ [START]: { hang: true } });
    const controller = new AbortController();
    const reason = new Error("deadline");

    const pending = createManualRedirectFetch(net.request)(START, { signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(net.requests[0]!.aborted).toBe(true);
  });

  it("tears the body down when the signal fires mid-stream", async () => {
    const net = new FakeElectronNet({ [START]: { hang: true } });
    const controller = new AbortController();
    const pending = createManualRedirectFetch(net.request)(START, { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    const request = net.requests[0]!;
    const message = Object.assign(
      new (await import("node:stream")).Readable({ read() {} }),
      { statusCode: 200, statusMessage: "", headers: {} }
    );
    request.response = message;
    request.emit("response", message);
    message.push(Buffer.from("partial"));
    const response = await pending;
    const reader = response.body!.getReader();
    await reader.read();

    controller.abort(new Error("cancelled"));

    await expect(reader.read()).rejects.toBeDefined();
    expect(request.aborted).toBe(true);
  });

  it("rejects with the request's error", async () => {
    const net = new FakeElectronNet({ [START]: { error: "net::ERR_CONNECTION_RESET" } });

    await expect(createManualRedirectFetch(net.request)(START)).rejects.toThrow(
      "net::ERR_CONNECTION_RESET"
    );
  });

  it("refuses a request body, which a redirect hop couldn't resend", async () => {
    const net = new FakeElectronNet({ [START]: { status: 200 } });

    await expect(
      createManualRedirectFetch(net.request)(START, { method: "POST", body: "x" })
    ).rejects.toThrow(TypeError);
    expect(net.requests).toHaveLength(0);
  });

  it("leaves no abort listener on the signal once an exchange is over", async () => {
    const controller = new AbortController();
    const net = new FakeElectronNet({
      [START]: { redirect: ASSET },
      [ASSET]: { status: 200, body: "PK" },
    });
    const fetch = createManualRedirectFetch(net.request);

    await fetch(START, { redirect: "manual", signal: controller.signal });
    const final = await fetch(ASSET, { redirect: "manual", signal: controller.signal });
    await final.text();
    await new Promise((resolve) => setImmediate(resolve));

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
