import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RepoRef } from "../../../../../shared/types/forge.js";
import { gitlabForgeProvider } from "../forgeProvider.js";
import {
  digestToken,
  getInstanceUrl,
  resetAuthStateForTests,
  setInstanceUrlReader,
  setProvenanceAccessors,
} from "../GitLabAuth.js";
import { resetLastRateLimitInfo } from "../GitLabClient.js";
import { clearGitLabCaches } from "../readOps.js";
import { clearValidatedUserInfo } from "../GitLabAuth.js";

const REPO: RepoRef = { host: "gitlab.com", owner: "group", repo: "project", rawData: null };
const SELF_HOSTED_REPO: RepoRef = {
  host: "gitlab.internal.example",
  owner: "team",
  repo: "app",
  rawData: null,
};

function jsonResponse(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

function fetchMock(): Mock {
  return globalThis.fetch as unknown as Mock;
}

function requestUrl(call: unknown[]): string {
  return String(call[0]);
}

function requestHeaders(call: unknown[]): Record<string, string> {
  return ((call[1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
}

function requestBody(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? "{}")) as Record<
    string,
    unknown
  >;
}

/**
 * Mirror the host's real save path: point the settings reader at the instance,
 * validate the token through the provider (which is what proves where it
 * belongs), then hand it over — exactly the `validateToken` → persist →
 * `setCredentials` sequence in `electron/ipc/handlers/forgeSettings.ts`.
 * Setting credentials WITHOUT a preceding validation is a replay, not a save,
 * so a test that skips it is not exercising the path it thinks it is.
 */
async function connectAs(instanceUrl: string, token: string): Promise<void> {
  setInstanceUrlReader(() => Promise.resolve(instanceUrl));
  await getInstanceUrl();
  const previous = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ username: "tester" }))
  );
  await gitlabForgeProvider.validateToken(token);
  vi.stubGlobal("fetch", previous);
  gitlabForgeProvider.setCredentials?.({ kind: "bearer", value: token });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  resetAuthStateForTests();
  clearGitLabCaches();
  resetLastRateLimitInfo();
  // No durable provenance record: a fresh install, where the first token
  // adopts the configured instance and that becomes its provenance.
  setProvenanceAccessors(
    () => null,
    () => undefined
  );
});

afterEach(() => {
  setInstanceUrlReader(null);
  vi.unstubAllGlobals();
});

describe("token attachment", () => {
  it("attaches the token to the configured instance host only", async () => {
    await connectAs("https://gitlab.com", "glpat-secret");
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(REPO, {});
    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBe("Bearer glpat-secret");

    await gitlabForgeProvider.listIssues(SELF_HOSTED_REPO, {});
    expect(requestHeaders(fetchMock().mock.calls[1]).Authorization).toBeUndefined();
  });

  it("follows the instanceUrl setting for self-hosted tokens", async () => {
    await connectAs("https://gitlab.internal.example", "glpat-internal");
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(SELF_HOSTED_REPO, {});
    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBe("Bearer glpat-internal");

    await gitlabForgeProvider.listIssues(REPO, {});
    expect(requestHeaders(fetchMock().mock.calls[1]).Authorization).toBeUndefined();
  });

  it("withholds the token once the instance setting moves off the bound host", async () => {
    await connectAs("https://gitlab.internal.example", "glpat-internal");
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(SELF_HOSTED_REPO, {});
    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBe("Bearer glpat-internal");

    // The generic plugin settings form can repoint instanceUrl without
    // clearing the credential. The token belongs to the old instance, so it
    // must not be replayed at the new one.
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.other.example"));
    await gitlabForgeProvider.listIssues(
      { host: "gitlab.other.example", owner: "team", repo: "app", rawData: null },
      {}
    );
    expect(requestHeaders(fetchMock().mock.calls[1]).Authorization).toBeUndefined();
  });

  it("withholds the token when the instance setting can't be read", async () => {
    await connectAs("https://gitlab.com", "glpat-secret");
    setInstanceUrlReader(() => Promise.reject(new Error("store unavailable")));
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(REPO, {});
    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBeUndefined();
  });
});

describe("identity isolation", () => {
  // An instance change doesn't move tokenVersion, so without its own guard a
  // `/user` lookup already in flight against the OLD instance resolves after
  // the change and repopulates the identity of an account on a server we are
  // no longer talking to.
  it("drops an identity write from a lookup that predates an instance change", async () => {
    await connectAs("https://gitlab.a.example", "glpat-a");
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock().mockImplementation(async () => {
      await gate;
      return jsonResponse({ username: "user-on-a" });
    });

    const inFlight = gitlabForgeProvider.identity?.getCurrentUser();
    clearValidatedUserInfo();
    release();
    await inFlight;

    // With the identity dropped, a later read must go back to the network
    // rather than serve the account from the previous instance.
    fetchMock().mockImplementation(async () => jsonResponse({ username: "user-on-b" }));
    const before = fetchMock().mock.calls.length;
    await gitlabForgeProvider.identity?.getCurrentUser();
    expect(fetchMock().mock.calls.length).toBeGreaterThan(before);
  });
});

describe("cache invalidation", () => {
  // Invalidation is provider-owned since the host stopped clearing caches
  // after mutations: a write that skips it serves the pre-write snapshot for
  // the cache's whole TTL.
  it("drops the cached tooltip a write just invalidated", async () => {
    // A fresh Response per call: a body can only be read once.
    fetchMock().mockImplementation(async () =>
      jsonResponse({ iid: 9, title: "Before", state: "opened", labels: [] })
    );
    await gitlabForgeProvider.tooltips?.getIssueTooltip(REPO, 9);
    const afterFirstRead = fetchMock().mock.calls.length;
    // A second read inside the TTL is served from cache.
    await gitlabForgeProvider.tooltips?.getIssueTooltip(REPO, 9);
    expect(fetchMock().mock.calls.length).toBe(afterFirstRead);

    await gitlabForgeProvider.closeIssue(REPO, 9);
    await gitlabForgeProvider.tooltips?.getIssueTooltip(REPO, 9);
    expect(fetchMock().mock.calls.length).toBeGreaterThan(afterFirstRead + 1);
  });
});

describe("stale-write protection", () => {
  // Clearing the maps is not enough: a read that started before the clear
  // resolves after it and repopulates the cache with data fetched under the
  // previous credential or instance.
  it("drops a cache write from a read that started before an invalidation", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock().mockImplementation(async () => {
      await gate;
      return jsonResponse({ iid: 9, title: "From the old instance", state: "opened", labels: [] });
    });

    const inFlight = gitlabForgeProvider.tooltips?.getIssueTooltip(REPO, 9);
    clearGitLabCaches();
    release();
    await inFlight;

    // The cache must be empty, so the next read goes back to the network
    // rather than serving what the pre-invalidation request brought back.
    const before = fetchMock().mock.calls.length;
    fetchMock().mockImplementation(async () =>
      jsonResponse({ iid: 9, title: "Fresh", state: "opened", labels: [] })
    );
    await gitlabForgeProvider.tooltips?.getIssueTooltip(REPO, 9);
    expect(fetchMock().mock.calls.length).toBeGreaterThan(before);
  });
});

describe("stale quota protection", () => {
  // A quota belongs to an account on an instance. A request that was already
  // in flight when the credential changed carries the PREVIOUS account's
  // headers; recording them leaves the host's polling gate shut on a quota the
  // new account never spent.
  it("ignores rate-limit headers from a request that predates an invalidation", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock().mockImplementation(async () => {
      await gate;
      return jsonResponse([], {
        headers: { "ratelimit-limit": "100", "ratelimit-remaining": "0" },
      });
    });

    const inFlight = gitlabForgeProvider.listIssues(REPO, {});
    // The credential changed, which is what invalidates the observed quota.
    clearGitLabCaches();
    release();
    await inFlight;

    // The exhausted quota belonged to the previous account, so nothing should
    // have been recorded for the new one.
    expect(await gitlabForgeProvider.getRateLimit?.()).toMatchObject({ remaining: null });
  });
});

describe("malformed list entries", () => {
  // The list endpoints filter these, but repo stats and branch lookup map the
  // same payloads through their own paths.
  it("keeps unusable rows out of repo stats and branch lookup too", async () => {
    fetchMock().mockImplementation(async () => jsonResponse([{}], { headers: { "x-total": "1" } }));
    const stats = await gitlabForgeProvider.repoStats!.getRepoStats(REPO, { bypassCache: true });
    expect(stats.issues?.items ?? []).toEqual([]);
    expect(stats.prs?.items ?? []).toEqual([]);

    expect(await gitlabForgeProvider.findPRByBranch(REPO, "feature")).toBeNull();
  });

  // An entry with no iid maps to "#0" with an empty URL — a row that opens
  // nothing and acts on nothing.
  it("drops entries with no usable number instead of rendering issue #0", async () => {
    fetchMock().mockImplementation(async () =>
      jsonResponse([{}, { iid: 4, title: "Real", state: "opened" }])
    );
    const page = await gitlabForgeProvider.listIssues(REPO, {});
    expect(page.items.map((i) => i.number)).toEqual([4]);

    const prs = await gitlabForgeProvider.listPRs(REPO, {});
    expect(prs.items.map((p) => p.number)).toEqual([4]);
  });
});

describe("list filters", () => {
  // Grape silently drops an undeclared parameter, so the wrong shape returns
  // an UNFILTERED list rather than an error. Both endpoints declare the array.
  it("sends the assignee filter in the documented array form", async () => {
    fetchMock().mockImplementation(async () => jsonResponse([]));
    await gitlabForgeProvider.listIssues(REPO, { assignee: "fixer" });
    expect(requestUrl(fetchMock().mock.calls[0])).toContain("assignee_username%5B%5D=fixer");

    await gitlabForgeProvider.listPRs(REPO, { assignee: "fixer" });
    expect(requestUrl(fetchMock().mock.calls[1])).toContain("assignee_username%5B%5D=fixer");
  });
});

describe("credential provenance", () => {
  // The host's credential store holds a bare token. On every activation it is
  // replayed into setCredentials, so without a durable record of the instance
  // it was saved for, a repointed `instanceUrl` silently claims it.
  it("replays a stored token against the instance it was saved for, not the current one", async () => {
    const saved = { instanceUrl: "https://gitlab.a.example", tokenDigest: digestToken("glpat-a") };
    setProvenanceAccessors(
      () => saved,
      () => undefined
    );
    // The user repointed the setting to B without clearing the credential,
    // then the plugin re-activated and the host replayed token A.
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.b.example"));
    await getInstanceUrl();
    gitlabForgeProvider.setCredentials?.({ kind: "bearer", value: "glpat-a" });
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(
      { host: "gitlab.b.example", owner: "team", repo: "app", rawData: null },
      {}
    );
    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBeUndefined();
  });

  it("records the instance a newly supplied token was validated against", async () => {
    const writes: unknown[] = [];
    setProvenanceAccessors(
      () => null,
      (record) => writes.push(record)
    );
    await connectAs("https://gitlab.b.example", "glpat-new");

    expect(writes).toEqual([
      { instanceUrl: "https://gitlab.b.example", tokenDigest: digestToken("glpat-new") },
    ]);
  });

  // The validation resolved its own destination; the save must use THAT, not
  // re-derive one from a setting that changed while validation was in flight.
  it("binds to the instance validation reached, not the one configured on save", async () => {
    setProvenanceAccessors(
      () => null,
      () => undefined
    );
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.a.example"));
    await getInstanceUrl();
    fetchMock().mockImplementation(async () => jsonResponse({ username: "tester" }));
    await gitlabForgeProvider.validateToken("glpat-a");

    // Another settings surface repoints the instance before the save lands.
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.b.example"));
    await getInstanceUrl();
    gitlabForgeProvider.setCredentials?.({ kind: "bearer", value: "glpat-a" });

    fetchMock().mockImplementation(async () => jsonResponse([]));
    await gitlabForgeProvider.listIssues(
      { host: "gitlab.b.example", owner: "team", repo: "app", rawData: null },
      {}
    );
    expect(
      requestHeaders(fetchMock().mock.calls.at(-1) as unknown[]).Authorization
    ).toBeUndefined();

    // ...and it is still usable at A, the instance it was actually proven
    // against. Withholding it everywhere would be safe but useless.
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.a.example"));
    await gitlabForgeProvider.listIssues(
      { host: "gitlab.a.example", owner: "team", repo: "app", rawData: null },
      {}
    );
    expect(requestHeaders(fetchMock().mock.calls.at(-1) as unknown[]).Authorization).toBe(
      "Bearer glpat-a"
    );
  });

  // Token rotation: a slow background probe of the OLD token must not stand in
  // for the NEW token's provenance, or the save reports success and every
  // request afterwards goes out unauthenticated.
  it("keeps a background probe of the old token from clobbering a save in flight", async () => {
    await connectAs("https://gitlab.a.example", "glpat-old");

    let releaseOld = (): void => undefined;
    const oldProbe = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    // One implementation for the whole test, keyed on which token the request
    // carries, so swapping mocks can't accidentally serialize the two.
    fetchMock().mockImplementation(async (_input: unknown, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization);
      if (auth.includes("glpat-old")) {
        // The old token's probe resolves LATE — after the new token's
        // validation has already recorded where it belongs.
        await oldProbe;
      }
      return jsonResponse({ username: "tester" });
    });

    const staleProbe = gitlabForgeProvider.validateCredentials?.();
    // Let the probe actually reach its fetch before the save starts.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The user saves a replacement token: validate, then setCredentials.
    await gitlabForgeProvider.validateToken("glpat-new");
    releaseOld();
    await staleProbe;
    gitlabForgeProvider.setCredentials?.({ kind: "bearer", value: "glpat-new" });

    fetchMock().mockImplementation(async () => jsonResponse([]));
    await gitlabForgeProvider.listIssues(
      { host: "gitlab.a.example", owner: "team", repo: "app", rawData: null },
      {}
    );
    expect(requestHeaders(fetchMock().mock.calls.at(-1) as unknown[]).Authorization).toBe(
      "Bearer glpat-new"
    );
  });

  // A capacity limit has the same defect as the single slot it replaced, just
  // further away: enough other validations while one is still in introspection
  // and the live entry is the one dropped.
  it("keeps a pending save's provenance through a burst of other validations", async () => {
    setProvenanceAccessors(
      () => null,
      () => undefined
    );
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.a.example"));
    await getInstanceUrl();

    let releaseIntrospection = (): void => undefined;
    const introspection = new Promise<void>((resolve) => {
      releaseIntrospection = resolve;
    });
    fetchMock().mockImplementation(async (input: unknown, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization);
      if (String(input).endsWith("/personal_access_tokens/self") && auth.includes("glpat-saving")) {
        await introspection;
        return jsonResponse({ scopes: ["api"], expires_at: null });
      }
      return jsonResponse({ username: "tester" });
    });

    const saving = gitlabForgeProvider.validateToken("glpat-saving");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Plenty of other candidate validations while that one is still in flight.
    for (let i = 0; i < 12; i += 1) {
      await gitlabForgeProvider.validateToken(`glpat-other-${i}`);
    }
    releaseIntrospection();
    await saving;
    gitlabForgeProvider.setCredentials?.({ kind: "bearer", value: "glpat-saving" });

    fetchMock().mockImplementation(async () => jsonResponse([]));
    await gitlabForgeProvider.listIssues(
      { host: "gitlab.a.example", owner: "team", repo: "app", rawData: null },
      {}
    );
    expect(requestHeaders(fetchMock().mock.calls.at(-1) as unknown[]).Authorization).toBe(
      "Bearer glpat-saving"
    );
  });

  // An absent record is not proof of a new save — it is equally a replay whose
  // record was lost, so adopting the current instance would be fail-open.
  it("withholds a replayed token whose provenance record is unreadable", async () => {
    setProvenanceAccessors(
      () => null,
      () => undefined
    );
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.b.example"));
    await getInstanceUrl();
    // Replay: setCredentials with no preceding validation.
    gitlabForgeProvider.setCredentials?.({ kind: "bearer", value: "glpat-a" });

    fetchMock().mockImplementation(async () => jsonResponse([]));
    await gitlabForgeProvider.listIssues(
      { host: "gitlab.b.example", owner: "team", repo: "app", rawData: null },
      {}
    );
    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBeUndefined();
  });

  // A deliberate re-save of the SAME token for a new instance must rebind it;
  // the stale record must not pin it to the old one forever.
  it("rebinds the same token when it is explicitly validated for another instance", async () => {
    const stale = { instanceUrl: "https://gitlab.a.example", tokenDigest: digestToken("glpat-t") };
    setProvenanceAccessors(
      () => stale,
      () => undefined
    );
    await connectAs("https://gitlab.b.example", "glpat-t");

    fetchMock().mockImplementation(async () => jsonResponse([]));
    await gitlabForgeProvider.listIssues(
      { host: "gitlab.b.example", owner: "team", repo: "app", rawData: null },
      {}
    );
    expect(requestHeaders(fetchMock().mock.calls.at(-1) as unknown[]).Authorization).toBe(
      "Bearer glpat-t"
    );
  });

  // A different token must not inherit an existing record's instance.
  it("does not let a different token inherit a stored record's instance", async () => {
    const recorded = {
      instanceUrl: "https://gitlab.a.example",
      tokenDigest: digestToken("glpat-a"),
    };
    setProvenanceAccessors(
      () => recorded,
      () => undefined
    );
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.a.example"));
    await getInstanceUrl();
    gitlabForgeProvider.setCredentials?.({ kind: "bearer", value: "glpat-different" });

    fetchMock().mockImplementation(async () => jsonResponse([]));
    await gitlabForgeProvider.listIssues(
      { host: "gitlab.a.example", owner: "team", repo: "app", rawData: null },
      {}
    );
    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBeUndefined();
  });

  it("stores a one-way digest, not the token or a reversible encoding", async () => {
    const digest = digestToken("glpat-secret");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("glpat");
    expect(Buffer.from(digest, "hex").toString("utf8")).not.toContain("glpat");
    expect(digestToken("glpat-secret2")).not.toBe(digest);
  });

  it("never writes the token itself to durable storage", async () => {
    const writes: { tokenDigest: string }[] = [];
    setProvenanceAccessors(
      () => null,
      (record) => {
        if (record) writes.push(record);
      }
    );
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.com"));
    await getInstanceUrl();
    gitlabForgeProvider.setCredentials?.({ kind: "bearer", value: "glpat-secret" });

    expect(JSON.stringify(writes)).not.toContain("glpat-secret");
  });

  it("clears the record when the credential is cleared", async () => {
    const writes: unknown[] = [];
    setProvenanceAccessors(
      () => null,
      (record) => writes.push(record)
    );
    await connectAs("https://gitlab.com", "glpat-secret");
    gitlabForgeProvider.setCredentials?.(null);
    expect(writes.at(-1)).toBeNull();
  });
});

describe("request destination", () => {
  const SELF_HOSTED = "https://code.example:8443/gitlab";
  const PREFIXED_REPO = { host: "code.example", owner: "team", repo: "app", rawData: null };

  // Destination and authorization must come from ONE settings read. Two reads
  // let the second fail and fall back to plain https — dropping the configured
  // port and deployment path — after the first already approved the token.
  it("resolves the destination and the credential from a single settings read", async () => {
    await connectAs(SELF_HOSTED, "glpat-internal");
    let reads = 0;
    setInstanceUrlReader(() => {
      reads += 1;
      return Promise.resolve(SELF_HOSTED);
    });
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(PREFIXED_REPO, {});

    expect(reads).toBe(1);
    const call = fetchMock().mock.calls[0];
    expect(requestUrl(call)).toContain(`${SELF_HOSTED}/api/v4/projects/`);
    expect(requestHeaders(call).Authorization).toBe("Bearer glpat-internal");
  });

  // The same read that authorizes names the destination, so a read that fails
  // yields no credential AND no confident base — never a token at a fallback.
  it("sends no credential when that read fails", async () => {
    await connectAs(SELF_HOSTED, "glpat-internal");
    setInstanceUrlReader(() => Promise.reject(new Error("settings store unavailable")));
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(PREFIXED_REPO, {});
    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBeUndefined();
  });
});

describe("malformed list payloads", () => {
  // A 200 carrying an object rather than a list used to become an empty page,
  // so an error envelope read as "this project has no issues".
  it("rejects a non-list body instead of reporting an empty page", async () => {
    fetchMock().mockImplementation(async () => jsonResponse({ message: "upstream unavailable" }));
    await expect(gitlabForgeProvider.listIssues(REPO, {})).rejects.toThrow(
      /unexpected list payload/
    );
    await expect(gitlabForgeProvider.listPRs(REPO, {})).rejects.toThrow(/unexpected list payload/);
  });
});

describe("validateToken destination", () => {
  it("never sends a self-hosted token to gitlab.com when the setting can't be read", async () => {
    setInstanceUrlReader(() => Promise.reject(new Error("store unavailable")));
    fetchMock().mockImplementation(async () => jsonResponse({ username: "someone" }));

    const result = await gitlabForgeProvider.validateToken("glpat-internal");

    expect(result.valid).toBe(false);
    // The point of the fix: no request at all, rather than one to the default
    // instance carrying a credential issued by a private one.
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("rejects a token whose introspected scopes can't read the API", async () => {
    fetchMock().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/personal_access_tokens/self")) {
        return jsonResponse({ scopes: ["read_user"], expires_at: null });
      }
      return jsonResponse({ username: "someone" });
    });

    // `/user` answers for a read_user token, so identity alone is not proof
    // the provider can read a single project.
    const result = await gitlabForgeProvider.validateToken("glpat-readuser");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/api or read_api/);
  });

  it("accepts read_api for read-only use", async () => {
    fetchMock().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/personal_access_tokens/self")) {
        return jsonResponse({ scopes: ["read_api"], expires_at: null });
      }
      return jsonResponse({ username: "someone" });
    });
    const result = await gitlabForgeProvider.validateToken("glpat-readapi");
    expect(result.valid).toBe(true);
  });
});

describe("gateway responses", () => {
  it("rejects a 200 HTML sign-in page instead of parsing it as GitLab data", async () => {
    await connectAs("https://gitlab.com", "glpat-secret");
    fetchMock().mockResolvedValue(
      new Response("<html>sign in</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );

    await expect(gitlabForgeProvider.listIssues(REPO, {})).rejects.toThrow(
      /didn't answer with JSON/
    );
    // An SSO gateway's 200 is not evidence the token works.
    expect(gitlabForgeProvider.healthEvents?.getTokenHealth?.().status).not.toBe("healthy");
  });
});

describe("malformed responses", () => {
  it("wraps an unparsable JSON body instead of leaking a SyntaxError", async () => {
    fetchMock().mockResolvedValue(
      new Response("{not json", { status: 200, headers: { "content-type": "application/json" } })
    );
    await expect(gitlabForgeProvider.listIssues(REPO, {})).rejects.toThrow(/unreadable response/);
  });
});

describe("parseRemote", () => {
  it("parses any GitLab-shaped host, deriving identity from the URL", () => {
    const ref = gitlabForgeProvider.parseRemote("git@gitlab.internal.example:team/sub/app.git");
    expect(ref).toMatchObject({ host: "gitlab.internal.example", owner: "team/sub", repo: "app" });
  });

  it("returns null for unparsable remotes", () => {
    expect(gitlabForgeProvider.parseRemote("not-a-remote")).toBeNull();
  });
});

describe("listPRs", () => {
  it("maps GitLab offset pagination onto the cursor contract", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse([{ iid: 1, title: "One", state: "opened" }], {
        headers: { "x-next-page": "2", "x-total": "55" },
      })
    );

    const page = await gitlabForgeProvider.listPRs(REPO, { state: "open", perPage: 20 });

    const url = requestUrl(fetchMock().mock.calls[0]);
    expect(url).toContain("/api/v4/projects/group%2Fproject/merge_requests");
    expect(url).toContain("state=opened");
    expect(url).toContain("per_page=20");
    expect(page.items[0].number).toBe(1);
    expect(page.nextCursor).toBe("2");
    expect(page.hasMore).toBe(true);
    expect(page.totalCount).toBe(55);
  });

  it("requests the cursor's page number", async () => {
    fetchMock().mockResolvedValue(jsonResponse([]));
    await gitlabForgeProvider.listPRs(REPO, { cursor: "3" });
    expect(requestUrl(fetchMock().mock.calls[0])).toContain("page=3");
  });

  it("ends pagination when GitLab omits x-next-page", async () => {
    // The last page carries no next-page header at all. Reporting a cursor
    // there would leave the host offering a load-more that fetches nothing.
    fetchMock().mockResolvedValue(
      jsonResponse([{ iid: 1, title: "One", state: "opened" }], { headers: { "x-total": "1" } })
    );

    const page = await gitlabForgeProvider.listPRs(REPO, { state: "open" });

    expect(page.nextCursor).toBeNull();
    expect(page.hasMore).toBe(false);
    expect(page.totalCount).toBe(1);
  });

  it("maps the sort onto GitLab's order_by parameter", async () => {
    // A fresh Response per call: a body is readable exactly once.
    fetchMock().mockImplementation(async () => jsonResponse([]));
    await gitlabForgeProvider.listPRs(REPO, { sort: "updated" });
    expect(requestUrl(fetchMock().mock.calls[0])).toContain("order_by=updated_at");

    fetchMock().mockClear();
    await gitlabForgeProvider.listPRs(REPO, {});
    expect(requestUrl(fetchMock().mock.calls[0])).toContain("order_by=created_at");
  });
});

describe("getIssue", () => {
  it("returns null on 404", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ message: "404 Not Found" }, { status: 404 }));
    await expect(gitlabForgeProvider.getIssue(REPO, 999)).resolves.toBeNull();
  });

  it("propagates non-404 failures", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ message: "boom" }, { status: 500 }));
    await expect(gitlabForgeProvider.getIssue(REPO, 1)).rejects.toThrow("boom");
  });
});

describe("findPRByBranch", () => {
  it("queries by source branch, newest first, any state", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse([{ iid: 8, title: "MR", state: "merged", source_branch: "feature/x" }])
    );

    const pr = await gitlabForgeProvider.findPRByBranch(REPO, "feature/x");

    const url = requestUrl(fetchMock().mock.calls[0]);
    expect(url).toContain("source_branch=feature%2Fx");
    expect(url).toContain("order_by=created_at");
    expect(url).not.toContain("state=");
    expect(pr?.number).toBe(8);
    expect(pr?.state).toBe("merged");
  });

  it("returns null when no MR matches", async () => {
    fetchMock().mockResolvedValue(jsonResponse([]));
    await expect(gitlabForgeProvider.findPRByBranch(REPO, "feature/none")).resolves.toBeNull();
  });
});

describe("findPRsByBranches", () => {
  it("confirms absent branches as null and picks the newest MR per branch", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({
        data: {
          project: {
            mergeRequests: {
              nodes: [
                {
                  iid: "12",
                  title: "Newest",
                  state: "opened",
                  sourceBranch: "feature/a",
                  targetBranch: "main",
                  webUrl: "https://gitlab.com/group/project/-/merge_requests/12",
                  createdAt: "2026-07-02T00:00:00Z",
                  updatedAt: "2026-07-02T00:00:00Z",
                },
                {
                  iid: "5",
                  title: "Older",
                  state: "closed",
                  sourceBranch: "feature/a",
                  targetBranch: "main",
                  webUrl: "https://gitlab.com/group/project/-/merge_requests/5",
                  createdAt: "2026-06-01T00:00:00Z",
                  updatedAt: "2026-06-01T00:00:00Z",
                },
              ],
            },
          },
        },
      })
    );

    const result = await gitlabForgeProvider.findPRsByBranches?.(REPO, ["feature/a", "feature/b"]);

    const url = requestUrl(fetchMock().mock.calls[0]);
    expect(url).toBe("https://gitlab.com/api/graphql");
    expect(result?.get("feature/a")?.number).toBe(12);
    expect(result?.has("feature/b")).toBe(true);
    expect(result?.get("feature/b")).toBeNull();
  });

  it("omits branches when the query fails so the host falls back", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ message: "unauthorized" }, { status: 401 }));
    const result = await gitlabForgeProvider.findPRsByBranches?.(REPO, ["feature/a"]);
    expect(result?.size).toBe(0);
  });

  it("omits branches when the project is inaccessible (null project)", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ data: { project: null } }));
    const result = await gitlabForgeProvider.findPRsByBranches?.(REPO, ["feature/a"]);
    expect(result?.size).toBe(0);
  });

  it("omits unmatched branches when the result window truncated", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({
        data: {
          project: {
            mergeRequests: {
              pageInfo: { hasNextPage: true },
              nodes: [
                {
                  iid: "12",
                  title: "Found",
                  state: "opened",
                  sourceBranch: "feature/a",
                  targetBranch: "main",
                  webUrl: "https://gitlab.com/group/project/-/merge_requests/12",
                  createdAt: "2026-07-02T00:00:00Z",
                  updatedAt: "2026-07-02T00:00:00Z",
                },
              ],
            },
          },
        },
      })
    );

    const result = await gitlabForgeProvider.findPRsByBranches?.(REPO, ["feature/a", "feature/b"]);

    // feature/a resolved inside the window; feature/b's newest MR may lie
    // beyond it, so it must be OMITTED (fallback), not confirmed absent.
    expect(result?.get("feature/a")?.number).toBe(12);
    expect(result?.has("feature/b")).toBe(false);
  });
});

describe("getCIStatus", () => {
  it("projects the head pipeline status", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ iid: 3, state: "opened", head_pipeline: { status: "running" } })
    );
    const status = await gitlabForgeProvider.getCIStatus(REPO, 3);
    expect(status?.state).toBe("pending");
    expect(status?.pending).toBe(1);
  });

  it("returns null when the MR has no pipeline", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ iid: 3, state: "opened", head_pipeline: null }));
    await expect(gitlabForgeProvider.getCIStatus(REPO, 3)).resolves.toBeNull();
  });
});

describe("mutations", () => {
  it("creates an MR with a Draft: prefix for draft input", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ iid: 20, title: "Draft: New", state: "opened", draft: true })
    );
    const pr = await gitlabForgeProvider.createPR(REPO, {
      head: "feature/x",
      base: "main",
      title: "New",
      draft: true,
    });
    const body = requestBody(fetchMock().mock.calls[0]);
    expect(body.title).toBe("Draft: New");
    expect(body.source_branch).toBe("feature/x");
    expect(pr.isDraft).toBe(true);
  });

  it("rejects rebase merges as unsupported", async () => {
    await expect(gitlabForgeProvider.mergePR(REPO, 5, { mergeMethod: "rebase" })).rejects.toThrow(
      "Not supported"
    );
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("passes squash and the squash commit message on squash merges", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ iid: 5, state: "merged" }));
    await gitlabForgeProvider.mergePR(REPO, 5, {
      mergeMethod: "squash",
      commitTitle: "feat: squashed",
    });
    const body = requestBody(fetchMock().mock.calls[0]);
    expect(body.squash).toBe(true);
    expect(body.squash_commit_message).toBe("feat: squashed");
  });

  // Squashing into a project that uses merge commits populates BOTH fields
  // with different commits. `MergePRResult.sha` names the commit the change
  // landed as on the target branch, so the merge commit is the answer.
  it("prefers the merge commit when a squash merge produces both shas", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ iid: 5, state: "merged", squash_commit_sha: "sq1", merge_commit_sha: "mc1" })
    );
    const result = await gitlabForgeProvider.mergePR(REPO, 5, { mergeMethod: "squash" });
    expect(result).toMatchObject({ prNumber: 5, sha: "mc1", merged: true });
  });

  // Fast-forward and semi-linear projects create no merge commit, so the
  // squashed commit IS the commit on the target branch.
  it("falls back to the squash commit when there is no merge commit", async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ iid: 5, state: "merged", squash_commit_sha: "sq1", merge_commit_sha: null })
    );
    const result = await gitlabForgeProvider.mergePR(REPO, 5, { mergeMethod: "squash" });
    expect(result.sha).toBe("sq1");
  });

  it("reports no sha rather than inventing one when the ack carries neither", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ iid: 5, state: "merged" }));
    const result = await gitlabForgeProvider.mergePR(REPO, 5);
    expect(result).toMatchObject({ sha: null, merged: true });
  });

  // A merge queued behind a pipeline acks 2xx with the MR still `opened`.
  // Reporting that as merged would tell the user the change landed.
  it("does not claim merged when the ack says the MR is still open", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ iid: 5, state: "opened" }));
    const result = await gitlabForgeProvider.mergePR(REPO, 5);
    expect(result.merged).toBe(false);
    // The message sits next to the flag, so it must not contradict it.
    expect(result.message).not.toMatch(/\bmerged\b/);
    expect(result.message).toMatch(/queued/);
  });

  // A 200 that isn't a merge request at all (an error envelope, a gateway
  // page) says nothing about the merge, so neither outcome can be claimed —
  // reporting it as "queued to merge" would be a fabricated success.
  it("errors on an unrecognizable merge ack rather than reporting an outcome", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ message: "upstream unavailable" }));
    await expect(gitlabForgeProvider.mergePR(REPO, 5)).rejects.toThrow(/unrecognizable response/);
  });

  // The result is mapped from the server's answer, not synthesized from the
  // request: the response below reports a state the caller did not ask for,
  // and that is what must come back.
  it("returns the MR the server answered with, not the requested state", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ iid: 7, title: "Renamed by a hook", state: "merged" })
    );
    const closed = await gitlabForgeProvider.closePR(REPO, 7);
    expect(requestBody(fetchMock().mock.calls[0]).state_event).toBe("close");
    expect(closed).toMatchObject({ number: 7, title: "Renamed by a hook", state: "merged" });

    fetchMock().mockResolvedValueOnce(jsonResponse({ iid: 7, title: "Feature", state: "opened" }));
    const reopened = await gitlabForgeProvider.reopenPR(REPO, 7);
    expect(requestBody(fetchMock().mock.calls[1]).state_event).toBe("reopen");
    expect(reopened.state).toBe("open");
  });

  it("translates unmergeable 405s into an actionable error", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ message: "Method Not Allowed" }, { status: 405 }));
    await expect(gitlabForgeProvider.mergePR(REPO, 5)).rejects.toThrow(
      /draft, have conflicts, or failing pipelines/
    );
  });

  it("converts to draft by prefixing the title", async () => {
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ iid: 6, title: "Feature", state: "opened" }))
      .mockResolvedValueOnce(jsonResponse({ iid: 6, title: "Draft: Feature", state: "opened" }));
    const result = await gitlabForgeProvider.convertPRToDraft(REPO, 6);
    const body = requestBody(fetchMock().mock.calls[1]);
    expect(body.title).toBe("Draft: Feature");
    expect(result).toEqual({ prNumber: 6, isDraft: true });
  });

  // The resulting state is read back off the updated MR, not assumed from the
  // request: a server-side title rewrite must not leave the UI claiming a
  // draft state the MR never reached.
  it("reports the state the server ended in, not the one requested", async () => {
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ iid: 6, title: "Feature", state: "opened" }))
      .mockResolvedValueOnce(jsonResponse({ iid: 6, title: "Feature", state: "opened" }));
    const result = await gitlabForgeProvider.convertPRToDraft(REPO, 6);
    expect(result.isDraft).toBe(false);
  });

  it("skips the write when the MR is already a draft", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ iid: 6, title: "Draft: Feature", state: "opened", draft: true })
    );
    const result = await gitlabForgeProvider.convertPRToDraft(REPO, 6);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ prNumber: 6, isDraft: true });
  });

  it("marks ready for review by stripping draft prefixes", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({ iid: 6, title: "Draft: [Draft] Feature", state: "opened", draft: true })
      )
      .mockResolvedValueOnce(jsonResponse({ iid: 6, title: "Feature", state: "opened" }));
    const result = await gitlabForgeProvider.markPRReadyForReview(REPO, 6);
    const body = requestBody(fetchMock().mock.calls[1]);
    expect(body.title).toBe("Feature");
    expect(result).toEqual({ prNumber: 6, isDraft: false });
  });

  it("closes issues via state_event", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ iid: 9, state: "closed" }));
    const issue = await gitlabForgeProvider.closeIssue(REPO, 9, "completed");
    expect(requestBody(fetchMock().mock.calls[0]).state_event).toBe("close");
    expect(issue.state).toBe("closed");
  });

  it("refuses to remove a label that is not on the issue", async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ iid: 9, state: "opened", labels: ["bug"] }));
    await expect(gitlabForgeProvider.removeIssueLabel(REPO, 9, "ux")).rejects.toThrow(
      'Label "ux" is not on issue #9'
    );
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("assigns additively via resolved user ids", async () => {
    fetchMock().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/users?")) {
        return jsonResponse([{ id: 77, username: "fixer" }]);
      }
      if (url.endsWith("/issues/9") && !url.includes("?")) {
        return jsonResponse({
          iid: 9,
          state: "opened",
          assignees: [{ id: 3, username: "existing" }],
        });
      }
      return jsonResponse({ iid: 9, state: "opened" });
    });

    await gitlabForgeProvider.assignIssue(REPO, 9, "fixer");

    const putCall = fetchMock().mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PUT"
    );
    expect(putCall).toBeDefined();
    // New user first: GitLab Free applies only the first id, so leading with
    // the requested user replaces instead of silently no-oping.
    expect(requestBody(putCall as unknown[]).assignee_ids).toEqual([77, 3]);
  });

  // GitLab Free keeps only the first id, so the requested user is not proof of
  // what landed — only the updated issue's own list is. The PUT answers with a
  // third login so returning the pre-write list OR the requested user fails.
  it("returns the assignees the server kept, not the one requested", async () => {
    fetchMock().mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/users?")) return jsonResponse([{ id: 77, username: "fixer" }]);
      if (init?.method === "PUT") {
        return jsonResponse({
          iid: 9,
          state: "opened",
          assignees: [{ id: 5, username: "whoever-the-server-picked" }],
        });
      }
      return jsonResponse({
        iid: 9,
        state: "opened",
        assignees: [{ id: 3, username: "existing" }],
      });
    });
    const assignees = await gitlabForgeProvider.assignIssue(REPO, 9, "fixer");
    expect(assignees.map((u) => u.login)).toEqual(["whoever-the-server-picked"]);
  });

  it("reports the current assignees without writing when already assigned", async () => {
    fetchMock().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/users?")) return jsonResponse([{ id: 77, username: "fixer" }]);
      return jsonResponse({ iid: 9, state: "opened", assignees: [{ id: 77, username: "fixer" }] });
    });
    const assignees = await gitlabForgeProvider.assignIssue(REPO, 9, "fixer");
    expect(assignees.map((u) => u.login)).toEqual(["fixer"]);
    expect(
      fetchMock().mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "PUT")
    ).toBe(false);
  });

  it("clears the last assignee with the [0] sentinel", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({ iid: 9, state: "opened", assignees: [{ id: 77, username: "fixer" }] })
      )
      // The answer disagrees with the locally computed empty list, so
      // returning that instead of reading the response would fail here.
      .mockResolvedValueOnce(
        jsonResponse({ iid: 9, state: "opened", assignees: [{ id: 8, username: "still-here" }] })
      );
    const assignees = await gitlabForgeProvider.unassignIssue(REPO, 9, "fixer");
    expect(requestBody(fetchMock().mock.calls[1]).assignee_ids).toEqual([0]);
    expect(assignees.map((u) => u.login)).toEqual(["still-here"]);
  });

  it("reports the current assignees without writing when not assigned", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ iid: 9, state: "opened", assignees: [{ id: 3, username: "someone" }] })
    );
    const assignees = await gitlabForgeProvider.unassignIssue(REPO, 9, "fixer");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(assignees.map((u) => u.login)).toEqual(["someone"]);
  });

  it("does not unassign a bystander whose row carries no numeric id", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        iid: 9,
        state: "opened",
        // `id` is optional on GitLab's user shape. An assignee that arrives
        // without one drops out of the id list the write would send — so the
        // "nothing to remove" guard has to be measured on usernames, or this
        // writes an assignee_ids that quietly unassigns them.
        assignees: [{ username: "no-id" }, { id: 3, username: "someone" }],
      })
    );
    const assignees = await gitlabForgeProvider.unassignIssue(REPO, 9, "fixer");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(assignees.map((u) => u.login)).toEqual(["no-id", "someone"]);
  });

  it("pins squash false on an explicit merge method", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ iid: 5, state: "merged" }));
    await gitlabForgeProvider.mergePR(REPO, 5, { mergeMethod: "merge" });
    expect(requestBody(fetchMock().mock.calls[0]).squash).toBe(false);
  });

  it("preserves the draft prefix when editing a draft MR's title", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({ iid: 6, title: "Draft: Old", state: "opened", draft: true })
      )
      .mockResolvedValueOnce(
        jsonResponse({ iid: 6, title: "Draft: New title", state: "opened", draft: true })
      );
    const pr = await gitlabForgeProvider.editPR(REPO, 6, { title: "New title" });
    const body = requestBody(fetchMock().mock.calls[1]);
    expect(body.title).toBe("Draft: New title");
    expect(pr.isDraft).toBe(true);
  });

  it("builds the issue-comment URL without a second issue fetch", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ id: 501, body: "Hello", created_at: "2026-07-01T00:00:00Z" })
    );
    const comment = await gitlabForgeProvider.addIssueComment(REPO, 9, "Hello");
    expect(comment.url).toBe("https://gitlab.com/group/project/-/issues/9#note_501");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("anchors an MR comment on the merge-request route, not the issue route", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ id: 502, body: "LGTM", created_at: "2026-07-01T00:00:00Z" })
    );
    const comment = await gitlabForgeProvider.commentOnPR(REPO, 6, "LGTM");
    expect(requestUrl(fetchMock().mock.calls[0])).toContain("/merge_requests/6/notes");
    expect(comment.url).toBe("https://gitlab.com/group/project/-/merge_requests/6#note_502");
    expect(comment.body).toBe("LGTM");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });
});

/**
 * `parseRemote` and the URL builders are synchronous in the contract, so they
 * read a cache the async settings read fills. `activate()` primes it; here any
 * call that reads the setting does.
 */
async function primeInstanceCache(): Promise<void> {
  fetchMock().mockResolvedValue(jsonResponse([]));
  await gitlabForgeProvider.listIssues(REPO, {});
  fetchMock().mockClear();
}

describe("PR-head refspec", () => {
  // The host's default is GitHub-shaped (`pull/<n>/head`), which GitLab does
  // not serve. Without this, checking out an MR whose source branch isn't
  // already local fails with "couldn't find remote ref".
  it("fetches from GitLab's merge-requests namespace", () => {
    expect(gitlabForgeProvider.buildPRHeadRefspec?.(42, "feature-x")).toBe(
      "refs/merge-requests/42/head:feature-x"
    );
  });

  // `merge-requests/` is not a hierarchy git expands on its own, so a bare
  // source ref would not resolve.
  it("fully qualifies the source ref", () => {
    expect(gitlabForgeProvider.buildPRHeadRefspec?.(1, "b")?.startsWith("refs/")).toBe(true);
  });

  // The host rejects a refspec whose destination isn't the requested branch
  // and silently falls back to its default, so this has to land exactly there.
  it("writes only to the branch the host asked for", () => {
    const spec = gitlabForgeProvider.buildPRHeadRefspec?.(7, "topic") ?? "";
    const [source, destination, ...rest] = spec.split(":");
    expect(rest).toEqual([]);
    expect(destination).toBe("topic");
    expect(source).not.toMatch(/^[+\-^]|\*|\s/);
  });
});

describe("self-hosted deployment path", () => {
  // A relative install serves clone URLs under its deployment path, but the
  // path is part of the instance base — not of the project namespace.
  const PREFIXED = "https://code.example:8443/gitlab";

  it("keeps the deployment prefix out of the project namespace", async () => {
    setInstanceUrlReader(() => Promise.resolve(PREFIXED));
    await primeInstanceCache();

    const ref = gitlabForgeProvider.parseRemote("https://code.example:8443/gitlab/team/app.git");
    expect(ref).toMatchObject({ host: "code.example", owner: "team", repo: "app" });
  });

  it("keeps the port and deployment prefix in browser URLs", async () => {
    setInstanceUrlReader(() => Promise.resolve(PREFIXED));
    await primeInstanceCache();

    const ref = { host: "code.example", owner: "team", repo: "app", rawData: null };
    // Plain `https://<host>/…` would drop both and hand the user a dead link.
    expect(gitlabForgeProvider.buildIssueUrl(ref, 4)).toBe(
      "https://code.example:8443/gitlab/team/app/-/issues/4"
    );
  });

  // SSH remotes address the git service directly and never carry the web
  // server's mount point, so their path IS the namespace.
  it("does not strip the prefix from an ssh remote", async () => {
    setInstanceUrlReader(() => Promise.resolve(PREFIXED));
    await primeInstanceCache();

    expect(
      gitlabForgeProvider.parseRemote("ssh://git@code.example/gitlab/team/app.git")
    ).toMatchObject({ owner: "gitlab/team", repo: "app" });
    expect(gitlabForgeProvider.parseRemote("git@code.example:gitlab/team/app.git")).toMatchObject({
      owner: "gitlab/team",
      repo: "app",
    });
  });

  it("leaves other GitLab hosts on plain https", async () => {
    setInstanceUrlReader(() => Promise.resolve(PREFIXED));
    await primeInstanceCache();

    expect(gitlabForgeProvider.buildIssueUrl(REPO, 4)).toBe(
      "https://gitlab.com/group/project/-/issues/4"
    );
    expect(gitlabForgeProvider.parseRemote("https://gitlab.com/gitlab/team/app.git")).toMatchObject(
      { owner: "gitlab/team", repo: "app" }
    );
  });
});

describe("validateToken", () => {
  it("rejects empty tokens without a request", async () => {
    const result = await gitlabForgeProvider.validateToken("   ");
    expect(result.valid).toBe(false);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("returns user identity and PAT scopes on success", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({ username: "dev", avatar_url: "https://gitlab.com/a.png" })
      )
      .mockResolvedValueOnce(jsonResponse({ scopes: ["api"], expires_at: "2027-01-01" }));

    const result = await gitlabForgeProvider.validateToken("glpat-good");

    expect(requestUrl(fetchMock().mock.calls[0])).toBe("https://gitlab.com/api/v4/user");
    expect(result.valid).toBe(true);
    expect(result.scopes).toEqual(["api"]);
    expect(result.expiresAt).toBe(Date.parse("2027-01-01"));
  });

  it("maps 401 to a rejected-token error", async () => {
    fetchMock().mockResolvedValue(jsonResponse({ message: "401 Unauthorized" }, { status: 401 }));
    const result = await gitlabForgeProvider.validateToken("glpat-bad");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("401");
  });

  it("rejects non-JSON answers (SSO gateways, wrong URLs)", async () => {
    fetchMock().mockResolvedValue(
      new Response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );
    const result = await gitlabForgeProvider.validateToken("glpat-good");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("JSON");
  });

  it("validates against the configured self-hosted instance", async () => {
    setInstanceUrlReader(() => Promise.resolve("https://gitlab.internal.example"));
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ username: "dev" }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }));

    const result = await gitlabForgeProvider.validateToken("glpat-internal");

    expect(requestUrl(fetchMock().mock.calls[0])).toBe(
      "https://gitlab.internal.example/api/v4/user"
    );
    expect(result.valid).toBe(true);
  });
});

describe("URL builders", () => {
  const repo: RepoRef = { host: "gitlab.com", owner: "group/sub", repo: "project", rawData: null };

  it("builds issue, MR, and commit URLs with the /-/ route prefix", () => {
    expect(gitlabForgeProvider.buildIssueUrl(repo, 7)).toBe(
      "https://gitlab.com/group/sub/project/-/issues/7"
    );
    expect(gitlabForgeProvider.buildPRUrl(repo, 7)).toBe(
      "https://gitlab.com/group/sub/project/-/merge_requests/7"
    );
    expect(gitlabForgeProvider.buildCommitsUrl(repo, "feature/x")).toBe(
      "https://gitlab.com/group/sub/project/-/commits/feature%2Fx"
    );
  });

  it("links the repository home page to the project root, subgroups included", () => {
    expect(gitlabForgeProvider.buildRepoUrl?.(repo)).toBe("https://gitlab.com/group/sub/project");
  });

  it("maps the open state to GitLab's 'opened' in list URLs", () => {
    expect(gitlabForgeProvider.buildIssuesUrl(repo, { state: "open" })).toContain("state=opened");
    expect(gitlabForgeProvider.buildPRsUrl(repo, { query: "search term" })).toContain(
      "search=search+term"
    );
    expect(gitlabForgeProvider.buildIssuesUrl(repo, { state: "all" })).not.toContain("state=");
  });
});

describe("self-hosted base URL", () => {
  it("preserves the configured scheme, port, and path prefix for API calls", async () => {
    await connectAs("https://gitlab.internal.example:8443/gitlab", "glpat-internal");
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(SELF_HOSTED_REPO, {});

    const url = requestUrl(fetchMock().mock.calls[0]);
    expect(url).toContain("https://gitlab.internal.example:8443/gitlab/api/v4/projects/");
    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBe("Bearer glpat-internal");
  });

  it("withholds the token when the settings read fails (fail closed)", async () => {
    await connectAs("https://gitlab.com", "glpat-secret");
    setInstanceUrlReader(() => Promise.reject(new Error("settings store unavailable")));
    fetchMock().mockImplementation(async () => jsonResponse([]));

    await gitlabForgeProvider.listIssues(REPO, {});

    expect(requestHeaders(fetchMock().mock.calls[0]).Authorization).toBeUndefined();
  });
});

describe("repoStats", () => {
  it("derives counts from x-total headers alongside first pages", async () => {
    fetchMock().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/issues")) {
        return jsonResponse([{ iid: 1, title: "I", state: "opened" }], {
          headers: { "x-total": "12" },
        });
      }
      return jsonResponse([{ iid: 2, title: "M", state: "opened" }], {
        headers: { "x-total": "4" },
      });
    });

    const stats = await gitlabForgeProvider.repoStats?.getRepoStats(REPO, { bypassCache: true });

    expect(stats?.counts.issueCount).toBe(12);
    expect(stats?.counts.prCount).toBe(4);
    expect(stats?.issues?.items[0].number).toBe(1);
    expect(stats?.prs?.items[0].number).toBe(2);
    expect(stats?.source).toBe("network");
  });

  it("reports the error without counts when the fetch fails cold", async () => {
    fetchMock().mockImplementation(async () => jsonResponse({ message: "boom" }, { status: 500 }));
    const stats = await gitlabForgeProvider.repoStats?.getRepoStats(REPO, { bypassCache: true });
    expect(stats?.counts.issueCount).toBeNull();
    expect(stats?.counts.error).toContain("boom");
  });

  it("surfaces a 429 as a rate-limit block with the time it lifts", async () => {
    // The host's rate-limit banner and poll pacing read these fields; an
    // error string alone leaves both blind to a block that has a known end.
    fetchMock().mockImplementation(async () =>
      jsonResponse(
        { message: "Too many requests" },
        { status: 429, headers: { "ratelimit-reset": "1800000000" } }
      )
    );

    const stats = await gitlabForgeProvider.repoStats?.getRepoStats(REPO, { bypassCache: true });

    expect(stats?.counts.rateLimitKind).toBe("primary");
    expect(stats?.counts.rateLimitResetAt).toBe(1_800_000_000_000);
  });

  it("prefers Retry-After over the reset header when both are sent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    try {
      fetchMock().mockImplementation(async () =>
        jsonResponse(
          { message: "Too many requests" },
          { status: 429, headers: { "retry-after": "60", "ratelimit-reset": "1800000000" } }
        )
      );

      const stats = await gitlabForgeProvider.repoStats?.getRepoStats(REPO, { bypassCache: true });

      expect(stats?.counts.rateLimitResetAt).toBe(Date.parse("2026-07-01T00:01:00Z"));
    } finally {
      vi.useRealTimers();
    }
  });
});
