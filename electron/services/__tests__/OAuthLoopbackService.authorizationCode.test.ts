import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";

vi.mock("electron", () => ({
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  app: {
    on: vi.fn(),
  },
}));

import { cancelOAuthLoopback, startAuthorizationCodeLoopback } from "../OAuthLoopbackService.js";
import { shell } from "electron";

const SESSION = "plugin-account\u0000acme.tracker";
const STATE = "s".repeat(43);

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

async function start(): Promise<{
  promise: ReturnType<typeof startAuthorizationCodeLoopback>;
  redirectUri: string;
  opened: string;
}> {
  let redirectUri = "";
  const promise = startAuthorizationCodeLoopback(SESSION, STATE, (uri) => {
    redirectUri = uri;
    return `https://auth.example.com/authorize?redirect_uri=${encodeURIComponent(uri)}`;
  });
  await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(1));
  const opened = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
  return { promise, redirectUri, opened };
}

describe("startAuthorizationCodeLoopback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cancelOAuthLoopback(SESSION);
  });

  it("binds before building the URL, so the browser is sent to the real loopback redirect", async () => {
    const { redirectUri, opened } = await start();
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    expect(new URL(opened).searchParams.get("redirect_uri")).toBe(redirectUri);
  });

  it("returns the code for a callback carrying the expected state", async () => {
    const { promise, redirectUri } = await start();
    const res = await get(`${redirectUri}?code=abc&state=${STATE}`);
    expect(res.status).toBe(200);
    expect(await promise).toEqual({ success: true, code: "abc", redirectUri });
  });

  it("refuses a callback with the wrong state or none, without settling", async () => {
    const { promise, redirectUri } = await start();
    expect((await get(`${redirectUri}?code=abc&state=wrong`)).status).toBe(400);
    expect((await get(`${redirectUri}?code=abc`)).status).toBe(400);
    const res = await get(`${redirectUri}?code=real&state=${STATE}`);
    expect(res.status).toBe(200);
    expect(await promise).toMatchObject({ success: true, code: "real" });
  });

  it("reports an authorization error as denied", async () => {
    const { promise, redirectUri } = await start();
    await get(`${redirectUri}?error=access_denied&state=${STATE}`);
    expect(await promise).toEqual({ success: false, cause: "denied", error: "access_denied" });
  });

  it("settles as cancelled when cancelled", async () => {
    const { promise } = await start();
    cancelOAuthLoopback(SESSION);
    expect(await promise).toEqual({ success: false, cause: "cancelled" });
  });

  it("refuses an empty state before binding anything", async () => {
    const result = await startAuthorizationCodeLoopback(SESSION, "", () => "https://x.example/");
    expect(result).toEqual({ success: false, cause: "server-error" });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
