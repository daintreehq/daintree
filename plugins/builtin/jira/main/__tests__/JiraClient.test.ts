import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { JiraApiError, jiraRequest, type JiraConnection } from "../JiraClient.js";

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
});

afterEach(() => {
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
      fetchMock.mockImplementationOnce(respond);
      const error = await failure();
      const seen = `${error.message} ${String(error.stack)} ${JSON.stringify(error)}`;
      expect(seen).not.toContain("ATATT3xSECRET");
      expect(seen).not.toContain(ENCODED);
    }
  });
});
