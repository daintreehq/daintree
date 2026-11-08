import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  JiraApiError,
  clearJiraCooldown,
  jiraRequest,
  type JiraConnection,
} from "../JiraClient.js";

const CONNECTION: JiraConnection = {
  siteUrl: "https://acme.atlassian.net",
  email: "ada@example.com",
  token: "ATATT3xSECRET",
};

const ENCODED = Buffer.from("ada@example.com:ATATT3xSECRET").toString("base64");

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  clearJiraCooldown();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function failure(path = "/myself"): Promise<JiraApiError> {
  const error = await jiraRequest(CONNECTION, path).catch((err: unknown) => err);
  expect(error).toBeInstanceOf(JiraApiError);
  return error as JiraApiError;
}

describe("jiraRequest", () => {
  it("authenticates with Basic auth against the v3 API and follows no redirects", async () => {
    fetchMock.mockResolvedValue(json({ accountId: "abc" }));
    await expect(jiraRequest(CONNECTION, "/myself")).resolves.toEqual({ accountId: "abc" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://acme.atlassian.net/rest/api/3/myself");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Basic ${ENCODED}`);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
  });

  it("sends a JSON body", async () => {
    fetchMock.mockResolvedValue(json({ count: 1 }));
    await jiraRequest(CONNECTION, "/search/approximate-count", {
      method: "POST",
      body: { jql: 'project = "ENG"' },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ jql: 'project = "ENG"' });
  });

  it("reads a 401 as a rejected credential", async () => {
    fetchMock.mockResolvedValue(json({}, { status: 401 }));
    const error = await failure();
    expect(error.status).toBe(401);
    expect(error.message).toMatch(/rejected the email and API token/);
  });

  it.each(["AUTHENTICATED_FAILED", "AUTHENTICATION_DENIED"])(
    "reads a 200 served as anonymous after %s as a rejected credential",
    async (reason) => {
      // Otherwise a revoked token reads as a project with no issues.
      fetchMock.mockResolvedValue(
        json({ issues: [], isLast: true }, { headers: { "X-Seraph-LoginReason": reason } })
      );
      const error = await failure("/search/jql");
      expect(error.message).toMatch(/rejected the email and API token/);
    }
  );

  it("trusts a 200 with a good login verdict", async () => {
    fetchMock.mockResolvedValue(
      json({ issues: [] }, { headers: { "X-Seraph-LoginReason": "OK" } })
    );
    await expect(jiraRequest(CONNECTION, "/search/jql")).resolves.toEqual({ issues: [] });
  });

  it("names the wait on a rate limit when Jira gives one", async () => {
    fetchMock.mockResolvedValue(json({}, { status: 429, headers: { "Retry-After": "30" } }));
    const error = await failure();
    expect(error.status).toBe(429);
    expect(error.message).toBe("Jira's rate limit was reached. Try again in 30s.");
  });

  it("reports a rate limit without a usable wait", async () => {
    fetchMock.mockResolvedValue(json({}, { status: 429, headers: { "Retry-After": "soon" } }));
    expect((await failure()).message).toBe("Jira's rate limit was reached. Try again shortly.");
  });

  it("refuses a redirect rather than taking the credential somewhere else", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: "https://evil.example/" } })
    );
    const error = await failure();
    expect(error.status).toBe(302);
    expect(error.message).toMatch(/redirected/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces Jira's own explanation", async () => {
    fetchMock.mockResolvedValue(
      json({ errorMessages: ["The project doesn't exist."], errors: {} }, { status: 400 })
    );
    const error = await failure();
    expect(error.status).toBe(400);
    expect(error.message).toBe("The project doesn't exist.");
  });

  it("falls back to the field errors, then to the status", async () => {
    fetchMock.mockResolvedValueOnce(json({ errors: { jql: "Bad JQL" } }, { status: 400 }));
    expect((await failure()).message).toBe("Bad JQL");
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 503 }));
    expect((await failure()).message).toBe("Jira request failed (HTTP 503)");
  });

  it("reads a success it can't parse as a failure", async () => {
    fetchMock.mockResolvedValue(new Response("<html>login</html>", { status: 200 }));
    expect((await failure()).message).toMatch(/couldn't read/);
  });

  it("says a request timed out, and that one couldn't connect", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "TimeoutError" }));
    expect((await failure()).message).toBe("Jira didn't respond in time");
    fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    expect((await failure()).message).toBe("Couldn't reach Jira");
  });

  it("takes the credential back out of an explanation that echoes it", async () => {
    const echoes = [
      { errorMessages: [`Bad header: Basic ${ENCODED}`] },
      { errorMessages: [`Token ATATT3xSECRET refused`] },
      { errorMessages: [`No account for ada@example.com`] },
      { errors: { auth: `Bad header: Basic ${ENCODED}` } },
    ];
    for (const body of echoes) {
      fetchMock.mockResolvedValueOnce(json(body, { status: 400 }));
      const { message } = await failure();
      expect(message).toContain("[redacted]");
      expect(message).not.toContain("ATATT3xSECRET");
      expect(message).not.toContain(ENCODED);
      expect(message).not.toContain("ada@example.com");
    }
  });

  it("redacts before truncating, so a cut can't leave part of the token behind", async () => {
    const padding = "x".repeat(300 - "ATAT".length);
    fetchMock.mockResolvedValue(
      json({ errorMessages: [`${padding}ATATT3xSECRET`] }, { status: 400 })
    );
    expect((await failure()).message).not.toContain("ATAT");
  });

  it("keeps the credential out of every failure", async () => {
    const responses: Array<() => Promise<Response>> = [
      async () => json({}, { status: 401 }),
      async () => json({}, { status: 429 }),
      async () => json({}, { status: 500 }),
      async () => new Response(null, { status: 302 }),
      async () => {
        throw new Error(`failed with Basic ${ENCODED}`);
      },
    ];
    for (const respond of responses) {
      clearJiraCooldown();
      fetchMock.mockImplementationOnce(respond);
      const error = await failure();
      const seen = `${error.message} ${String(error.stack)} ${JSON.stringify(error)}`;
      expect(seen).not.toContain("ATATT3xSECRET");
      expect(seen).not.toContain(ENCODED);
    }
  });

  describe("cooldown", () => {
    const OTHER: JiraConnection = { ...CONNECTION, token: "another-token" };

    it("leaves a rejected connection alone for a while, then tries again", async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(async () => json({}, { status: 401 }));
      await failure();
      const repeat = await failure();
      expect(repeat.message).toMatch(/rejected/);
      expect(repeat.status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5 * 60_000);
      await failure();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("treats a 200 served as anonymous like a 401", async () => {
      fetchMock.mockImplementation(async () =>
        json({ issues: [] }, { headers: { "X-Seraph-LoginReason": "AUTHENTICATED_FAILED" } })
      );
      await failure();
      await failure();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("waits as long as Retry-After says", async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(async () =>
        json({}, { status: 429, headers: { "Retry-After": "30" } })
      );
      await failure();
      vi.advanceTimersByTime(29_000);
      expect((await failure()).status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_000);
      await failure();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("waits a minute when a rate limit names no wait", async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(async () => json({}, { status: 429 }));
      await failure();
      vi.advanceTimersByTime(59_000);
      await failure();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1_000);
      await failure();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("doesn't let a huge Retry-After stop Jira for good", async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(async () =>
        json({}, { status: 429, headers: { "Retry-After": "86400" } })
      );
      await failure();
      vi.advanceTimersByTime(60 * 60_000);
      await failure();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("doesn't hold one connection's failure against another", async () => {
      fetchMock.mockImplementationOnce(async () => json({}, { status: 401 }));
      await failure();
      fetchMock.mockImplementationOnce(async () => json({ accountId: "abc" }));
      await expect(jiraRequest(OTHER, "/myself")).resolves.toEqual({ accountId: "abc" });
    });

    it("doesn't start for ordinary failures", async () => {
      fetchMock.mockImplementation(async () => json({}, { status: 500 }));
      await failure();
      await failure();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("sends a deliberate check anyway, and lets a good answer end the wait", async () => {
      fetchMock.mockImplementationOnce(async () => json({}, { status: 401 }));
      await failure();

      fetchMock.mockImplementation(async () => json({ accountId: "abc" }));
      await jiraRequest(CONNECTION, "/myself", { ignoreCooldown: true });
      await jiraRequest(CONNECTION, "/myself");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("doesn't start from a deliberate check, so a bad candidate can't pause a good token", async () => {
      fetchMock.mockImplementationOnce(async () => json({}, { status: 401 }));
      await expect(
        jiraRequest(CONNECTION, "/myself", { ignoreCooldown: true })
      ).rejects.toBeInstanceOf(JiraApiError);

      fetchMock.mockImplementationOnce(async () => json({ accountId: "abc" }));
      await expect(jiraRequest(CONNECTION, "/myself")).resolves.toEqual({ accountId: "abc" });
    });
  });
});
