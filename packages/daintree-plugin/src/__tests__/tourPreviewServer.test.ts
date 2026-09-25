import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  parseRange,
  startTourPreviewServer,
  type TourPreviewServer,
} from "../tour/preview/server.js";

let tmpDir: string;
let outside: string;
let server: TourPreviewServer | null = null;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-tour-server-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-tour-outside-"));
  await fs.mkdir(path.join(tmpDir, "dist"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "dist", "tour.js"), "export default {};\n");
  await fs.mkdir(path.join(tmpDir, "tours", "welcome"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "tours", "welcome", "intro.ogg"), Buffer.from("0123456789"));
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
});

afterEach(async () => {
  await server?.close();
  server = null;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

async function start(onReport = vi.fn()) {
  server = await startTourPreviewServer({
    pluginDir: tmpDir,
    html: "<!doctype html><p>shell</p>",
    assets: new Map([["/_preview/app.js", { body: "export {};", type: "text/javascript" }]]),
    onReport,
  });
  return { url: server.url, onReport };
}

/** A raw request, for headers `fetch` won't let a caller set. */
function request(
  url: string,
  options: { method?: string; headers?: Record<string, string> }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += String(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("tour preview server", () => {
  it("serves the shell, its assets and the plugin's files on loopback", async () => {
    const { url } = await start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const shell = await fetch(url);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");
    expect(await shell.text()).toContain("shell");

    const asset = await fetch(new URL("/_preview/app.js", url));
    expect(asset.headers.get("content-type")).toBe("text/javascript");

    const module = await fetch(new URL("/plugin/dist/tour.js", url));
    expect(module.status).toBe(200);
    expect(module.headers.get("content-type")).toContain("text/javascript");
    expect(await module.text()).toBe("export default {};\n");
  });

  it("answers audio range requests so the player can seek", async () => {
    const { url } = await start();
    const audio = new URL("/plugin/tours/welcome/intro.ogg", url);

    const whole = await fetch(audio);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("content-type")).toBe("audio/ogg");

    const part = await fetch(audio, { headers: { Range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");

    const tail = await fetch(audio, { headers: { Range: "bytes=-3" } });
    expect(await tail.text()).toBe("789");

    const beyond = await fetch(audio, { headers: { Range: "bytes=50-" } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */10");
  });

  it("never serves a file outside the plugin", async () => {
    await fs.symlink(path.join(outside, "secret.txt"), path.join(tmpDir, "dist", "escape.txt"));
    const { url } = await start();
    for (const route of [
      "/plugin/%2e%2e/%2e%2e/etc/passwd",
      "/plugin/..%2F..%2Fsecret.txt",
      "/plugin/dist/escape.txt",
      "/plugin/dist",
      "/plugin/%00",
    ]) {
      const res = await fetch(new URL(route, url));
      expect(res.status, route).toBe(404);
    }
  });

  it("refuses a request addressed to another host name", async () => {
    const { url } = await start();
    const res = await request(url, { headers: { Host: "attacker.example:80" } });
    expect(res.status).toBe(403);
    const local = await request(url.replace("127.0.0.1", "localhost"), {});
    expect(local.status).toBe(200);
  });

  it("passes the page's reports on and rejects malformed ones", async () => {
    const { url, onReport } = await start();
    const ok = await fetch(new URL("/_preview/report", url), {
      method: "POST",
      body: JSON.stringify({ chapterId: "intro", undefinedCues: ["ghost", 3] }),
    });
    expect(ok.status).toBe(204);
    expect(onReport).toHaveBeenCalledWith({ chapterId: "intro", undefinedCues: ["ghost"] });

    const bad = await fetch(new URL("/_preview/report", url), { method: "POST", body: "{" });
    expect(bad.status).toBe(400);
    expect(onReport).toHaveBeenCalledTimes(1);

    const put = await fetch(new URL("/plugin/dist/tour.js", url), { method: "PUT" });
    expect(put.status).toBe(405);
  });

  it("stops accepting connections once closed", async () => {
    const { url } = await start();
    await server!.close();
    await expect(fetch(url)).rejects.toThrow();
  });
});

describe("parseRange", () => {
  it("reads a single satisfiable byte range", () => {
    expect(parseRange("bytes=0-", 10)).toEqual([0, 9]);
    expect(parseRange("bytes=3-100", 10)).toEqual([3, 9]);
    expect(parseRange("bytes=-4", 10)).toEqual([6, 9]);
    expect(parseRange("bytes=5-2", 10)).toBeNull();
    expect(parseRange("bytes=-", 10)).toBeNull();
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange(undefined, 10)).toBeNull();
  });
});
