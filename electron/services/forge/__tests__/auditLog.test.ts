import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeAuditService, summarizeForgeArgs } from "../auditLog.js";
import type { ForgeAuditResult } from "../../../../shared/types/ipc/forge.js";

function makeFixture(initialConfig: Record<string, unknown> = {}) {
  const config: Record<string, unknown> = {
    auditEnabled: true,
    auditMaxRecords: 500,
    ...initialConfig,
  };
  const saveConfig = vi.fn((patch: Record<string, unknown>) => {
    Object.assign(config, patch);
  });
  // The ring is kept under the same `auditLog` key so seeding reads
  // naturally, but it round-trips through the injected log store (the real
  // ring lives in the audit-logs store since migration023).
  const writeRing = vi.fn((records: unknown[]) => {
    config.auditLog = records;
  });
  const service = new ForgeAuditService(saveConfig, () => config, {
    read: () => config.auditLog,
    write: writeRing,
  });
  return { service, saveConfig, writeRing, config };
}

function append(
  service: ForgeAuditService,
  overrides: Partial<{
    providerId: string;
    methodName: string;
    result: ForgeAuditResult;
    durationMs: number;
  }> = {}
) {
  service.appendRecord({
    providerId: overrides.providerId ?? "builtin.github",
    methodName: overrides.methodName ?? "listIssues",
    result: overrides.result ?? "success",
    durationMs: overrides.durationMs ?? 10,
    repoOwner: "octocat",
    repoName: "hello-world",
    argsSummary: "{}",
  });
}

describe("ForgeAuditService.appendRecord", () => {
  it("stores a record with derived severity and clamped duration", () => {
    const { service } = makeFixture();
    service.appendRecord({
      providerId: "builtin.github",
      methodName: "getIssue",
      result: "success",
      durationMs: 12.7,
      repoOwner: "octocat",
      repoName: "hello-world",
      argsSummary: '{"number":42}',
    });
    const [record] = service.getRecords();
    expect(record!.methodName).toBe("getIssue");
    expect(record!.severity).toBe("info");
    expect(record!.durationMs).toBe(13);
    expect(record!.schemaVersion).toBe(1);
    expect(record!.argsSummary).toBe('{"number":42}');
  });

  it("maps result to severity (not-found → notice, error → error)", () => {
    const { service } = makeFixture();
    append(service, { result: "not-found", methodName: "getPR" });
    append(service, { result: "error", methodName: "assignIssue" });
    const records = service.getRecords(); // newest-first
    expect(records[0]!.severity).toBe("error");
    expect(records[1]!.severity).toBe("notice");
  });

  it("does not append when auditEnabled is false", () => {
    const { service } = makeFixture({ auditEnabled: false });
    append(service);
    expect(service.getRecords()).toHaveLength(0);
  });

  it("omits errorMessage on non-error results", () => {
    const { service } = makeFixture();
    append(service, { result: "success" });
    expect(service.getRecords()[0]!.errorMessage).toBeUndefined();
  });
});

describe("ForgeAuditService ring buffer", () => {
  it("trims to the normalized max records", () => {
    const { service } = makeFixture({ auditMaxRecords: 50 });
    for (let i = 0; i < 60; i++) append(service);
    expect(service.getRecords()).toHaveLength(50);
  });

  it("normalizeMaxRecords clamps to bounds and falls back on garbage", () => {
    const { service } = makeFixture();
    expect(service.normalizeMaxRecords(10)).toBe(50); // below MIN
    expect(service.normalizeMaxRecords(999999)).toBe(10000); // above MAX
    expect(service.normalizeMaxRecords("nope")).toBe(500); // default
    expect(service.normalizeMaxRecords(200)).toBe(200);
  });

  it("hydrate ignores malformed persisted entries and backfills missing fields", () => {
    const { service } = makeFixture({
      auditLog: [
        null,
        "garbage",
        {
          id: "a",
          timestamp: 1,
          providerId: "p",
          methodName: "getPR",
          result: "success",
          durationMs: 5,
        },
      ],
    });
    const records = service.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.severity).toBe("info");
    expect(records[0]!.schemaVersion).toBe(1);
  });
});

describe("ForgeAuditService flush", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces flush to a single ring write and never touches config flags", () => {
    const { service, saveConfig, writeRing } = makeFixture();
    append(service);
    append(service);
    append(service);
    expect(writeRing).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(writeRing).toHaveBeenCalledTimes(1);
    expect(writeRing.mock.calls[0]![0]).toHaveLength(3);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("swallows flush errors to console.error instead of rethrowing", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config: Record<string, unknown> = { auditEnabled: true, auditMaxRecords: 500 };
    const service = new ForgeAuditService(vi.fn(), () => config, {
      read: () => undefined,
      write: () => {
        throw new Error("disk full");
      },
    });
    append(service);
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("ForgeAuditService anomaly detection", () => {
  it("suppresses signals below the record floor of 10", () => {
    const { service } = makeFixture();
    for (let i = 0; i < 9; i++) append(service);
    const stats = service.getAuditStats();
    expect(stats.anomalySuppressed).toBe(true);
    expect(stats.anomalyRecordFloor).toBe(10);
    expect(service.getSignals()).toHaveLength(0);
  });

  it("flags a failure cluster at 2 failures within a 5-record window", () => {
    const { service } = makeFixture();
    // 8 successes then 2 errors for the same method → cluster of 2 in window.
    for (let i = 0; i < 8; i++) append(service, { methodName: "getIssue", result: "success" });
    append(service, { methodName: "getIssue", result: "error" });
    append(service, { methodName: "getIssue", result: "error" });
    const clusters = service.getSignals().filter((s) => s.kind === "failure-cluster");
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0]!.methodName).toBe("getIssue");
  });

  it("does not flag a single failure as a cluster", () => {
    const { service } = makeFixture();
    for (let i = 0; i < 9; i++) append(service, { methodName: "getIssue", result: "success" });
    append(service, { methodName: "getIssue", result: "error" });
    const clusters = service.getSignals().filter((s) => s.kind === "failure-cluster");
    expect(clusters).toHaveLength(0);
  });

  it("scopes latency-drift baselines per provider+method", () => {
    const { service } = makeFixture();
    // A spread baseline (so MAD > 0 — a flat baseline yields MAD 0 and the
    // detector correctly skips), plus a single huge outlier.
    for (let i = 0; i < 11; i++) {
      append(service, { methodName: "listIssues", durationMs: 10 + i * 10 });
    }
    append(service, { methodName: "listIssues", durationMs: 5000 });
    const drift = service.getSignals().filter((s) => s.kind === "latency-drift");
    expect(drift.length).toBeGreaterThanOrEqual(1);
    expect(drift.some((s) => s.methodName === "listIssues" && s.durationMs === 5000)).toBe(true);
  });

  it("does not retroactively flag first-seen combinations on the first getSignals call", () => {
    const { service } = makeFixture();
    for (let i = 0; i < 10; i++) append(service, { methodName: "listIssues" });
    const firstSeen = service.getSignals().filter((s) => s.kind === "first-seen-method");
    expect(firstSeen).toHaveLength(0);
  });
});

describe("summarizeForgeArgs redaction", () => {
  it("returns empty string for validateToken — never any token derivative", () => {
    expect(summarizeForgeArgs("validateToken", "ghp_secrettoken")).toBe("");
  });

  it("returns empty string for validateToken with the { providerId, token } payload shape (#9985)", () => {
    // The handler now passes the full payload object; the redaction must
    // continue to drop both the token and the provider id.
    expect(
      summarizeForgeArgs("validateToken", {
        providerId: "daintree.github.github",
        token: "ghp_secrettoken",
      })
    ).toBe("");
  });

  it("includes only the number for getIssue/getPR", () => {
    expect(summarizeForgeArgs("getIssue", 42)).toBe('{"number":42}');
    expect(summarizeForgeArgs("getPR", 7)).toBe('{"number":7}');
  });

  it("omits username for assign/unassign (only the issue number)", () => {
    expect(summarizeForgeArgs("assignIssue", 99)).toBe('{"number":99}');
  });

  it("keeps only the PR number for review-write ops, omitting bodies/ids/reviewers", () => {
    // Each of these receives content (review body, dismissal message),
    // identifiers (review id), or PII (reviewer logins) beyond the PR number —
    // only the number is recorded, and it is passed positionally.
    expect(summarizeForgeArgs("approvePR", 12)).toBe('{"number":12}');
    expect(summarizeForgeArgs("requestChanges", 4)).toBe('{"number":4}');
    expect(summarizeForgeArgs("dismissReview", 5)).toBe('{"number":5}');
    expect(summarizeForgeArgs("requestReviewers", 6)).toBe('{"number":6}');
  });

  it("never leaks review content even if a non-number arg is passed", () => {
    // The number group only records a scalar number; an object arg (body,
    // message, reviewer logins) is fully redacted to an empty object.
    expect(summarizeForgeArgs("requestChanges", { body: "secret rationale" })).toBe("{}");
    expect(summarizeForgeArgs("dismissReview", { message: "secret", reviewId: 7 })).toBe("{}");
    expect(summarizeForgeArgs("requestReviewers", { users: ["alice"] })).toBe("{}");
  });

  it("redacts createIssue title/body, keeping only the label count", () => {
    expect(
      summarizeForgeArgs("createIssue", {
        title: "Security issue",
        body: "token abc123",
        labels: ["bug", "security"],
      })
    ).toBe('{"labels":2}');
  });

  it("emits an empty object for createIssue with no labels", () => {
    expect(summarizeForgeArgs("createIssue", { title: "No labels" })).toBe("{}");
  });

  it("includes only the number for close/reopen", () => {
    expect(summarizeForgeArgs("closeIssue", 12)).toBe('{"number":12}');
    expect(summarizeForgeArgs("reopenIssue", 12)).toBe('{"number":12}');
  });

  it("redacts editIssue title/body, keeping only which fields were touched", () => {
    expect(
      summarizeForgeArgs("editIssue", {
        number: 5,
        hasTitle: true,
        hasBody: true,
      })
    ).toBe('{"number":5,"hasTitle":true,"hasBody":true}');
    expect(summarizeForgeArgs("editIssue", { number: 5, hasTitle: false, hasBody: true })).toBe(
      '{"number":5,"hasBody":true}'
    );
  });

  it("redacts addIssueComment body content, keeping only its length", () => {
    expect(summarizeForgeArgs("addIssueComment", { number: 8, bodyLength: 42 })).toBe(
      '{"number":8,"bodyLength":42}'
    );
  });

  it("keeps the label name for add/remove label (repo metadata, not PII)", () => {
    expect(summarizeForgeArgs("addIssueLabel", { number: 8, label: "bug" })).toBe(
      '{"number":8,"label":"bug"}'
    );
    expect(summarizeForgeArgs("removeIssueLabel", { number: 8, label: "bug" })).toBe(
      '{"number":8,"label":"bug"}'
    );
  });

  it("returns empty string for getCurrentUser — read probe, no args to summarize", () => {
    expect(summarizeForgeArgs("getCurrentUser", { cwd: "/repo" })).toBe("");
  });

  it("summarizes list filters as safe metadata only", () => {
    const summary = summarizeForgeArgs("listIssues", {
      state: "open",
      labels: ["bug", "p1"],
      perPage: 30,
      assignee: "secret-user",
    });
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    expect(parsed.state).toBe("open");
    expect(parsed.labels).toBe(2);
    expect(parsed.perPage).toBe(30);
    expect(parsed).not.toHaveProperty("assignee");
  });
});
