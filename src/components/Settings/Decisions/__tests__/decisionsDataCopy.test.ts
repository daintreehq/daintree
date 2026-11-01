import { describe, expect, it } from "vitest";
import type {
  DecisionsLocalDeleteResult,
  DecisionsRelayDeleteResult,
} from "@shared/types/decisions";
import {
  describeExportResult,
  describeLocalDeleteResult,
  describeRelayDeleteResult,
} from "../decisionsDataCopy";

const ORIGIN = "https://decisions.example.workers.dev";
const HOST = "decisions.example.workers.dev";

describe("decisionsDataCopy", () => {
  it("counts what an export holds and names where it went", () => {
    const one = describeExportResult({
      result: "saved",
      path: "/exports/a.dxz.json",
      questions: 1,
      auditEvents: 0,
    });
    const many = describeExportResult({
      result: "saved",
      path: "/exports/b.dxz.json",
      questions: 12,
      auditEvents: 40,
    });

    expect(one?.detail).toMatch(/^1 question and 0 audit events,.*\/exports\/a\.dxz\.json$/);
    expect(many?.detail).toMatch(/^12 questions and 40 audit events,.*\/exports\/b\.dxz\.json$/);
  });

  it("says nothing for a cancelled export, and that nothing was exported otherwise", () => {
    expect(describeExportResult({ result: "cancelled" })).toBeNull();
    for (const result of [
      { result: "no-identity" },
      { result: "store-unavailable" },
      { result: "key-storage", kind: "locked", reason: "The keychain is locked" },
    ] as const) {
      expect(describeExportResult(result)?.detail).toMatch(/Nothing was exported\.$/);
    }
  });

  it("names the relay, and says whether anything there changed, for every relay outcome", () => {
    const outcomes: Array<[DecisionsRelayDeleteResult, RegExp]> = [
      [{ result: "deleted", origin: ORIGIN }, /are deleted\.$/],
      [{ result: "not-sent", origin: ORIGIN, reason: "dns" }, /nothing there changed\.$/],
      [
        { result: "unconfirmed", origin: ORIGIN, reason: "server-error" },
        /^It answered with a server error\. It may have deleted some or all/,
      ],
      [
        { result: "unconfirmed", origin: ORIGIN, reason: "unexpected-answer" },
        /^Its answer wasn't the relay's\. It may have deleted/,
      ],
      [
        { result: "unconfirmed", origin: ORIGIN, reason: "timeout" },
        /^It didn't answer in time\. It may have deleted/,
      ],
      [
        { result: "refused", origin: ORIGIN, reason: "rejected", status: 422 },
        /^It answered HTTP 422\. Nothing was deleted\.$/,
      ],
      [{ result: "no-identity", origin: ORIGIN }, /Nothing was sent\.$/],
    ];
    for (const [result, detail] of outcomes) {
      const observed = describeRelayDeleteResult(result);
      expect(`${observed.label} ${observed.detail}`).toContain(HOST);
      expect(observed.detail).toMatch(detail);
    }
  });

  it("says which relay is set up now when it changed since the confirm", () => {
    expect(
      describeRelayDeleteResult({ result: "changed", origin: "https://other.example.dev" }).detail
    ).toContain("other.example.dev");
    expect(describeRelayDeleteResult({ result: "changed", origin: null }).detail).toMatch(
      /no longer has a relay set up/
    );
  });

  it("tells a deletion that removed the history from one that removed nothing", () => {
    const status = { state: "not-connected" } as const;
    const erased: DecisionsLocalDeleteResult = { result: "incomplete", erased: true, status };
    const untouched: DecisionsLocalDeleteResult = { result: "incomplete", erased: false, status };

    expect(describeLocalDeleteResult(erased).detail).toMatch(/history is deleted/);
    expect(describeLocalDeleteResult(untouched).detail).toMatch(/^Nothing was deleted/);
    expect(
      describeLocalDeleteResult({ result: "incomplete", erased: null, status }).detail
    ).toMatch(/couldn't be read to tell/);
    for (const reason of ["disk-pressure", "storage", "keys"] as const) {
      expect(describeLocalDeleteResult({ result: "failed", reason }).detail).toMatch(
        /Nothing was deleted\.$/
      );
    }
  });
});
