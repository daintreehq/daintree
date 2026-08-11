import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { remoteContentMetadata } from "../RemoteAuditService.js";
import { remoteMutationFingerprint } from "../RemoteMutationLedgerService.js";

describe("remote mutation privacy primitives", () => {
  it("canonicalizes operation arguments into a content-free fingerprint", () => {
    const canary = "prompt-content-canary";
    const first = remoteMutationFingerprint("prompt.submit", {
      panelId: "panel-01",
      text: canary,
      nested: { right: 2, left: 1, absent: undefined },
    });
    const reordered = remoteMutationFingerprint("prompt.submit", {
      nested: { absent: undefined, left: 1, right: 2 },
      text: canary,
      panelId: "panel-01",
    });
    const changed = remoteMutationFingerprint("prompt.submit", {
      panelId: "panel-01",
      text: `${canary}-changed`,
      nested: { left: 1, right: 2 },
    });

    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain(canary);
  });

  it("reduces content to digest and Unicode-aware size metadata", () => {
    const canary = "secret 😀";
    const metadata = remoteContentMetadata(canary);

    expect(metadata).toEqual({
      characterCount: 8,
      byteCount: Buffer.byteLength(canary),
      contentDigest: expect.stringMatching(/^sha256:[A-Za-z0-9_-]{43}$/),
    });
    expect(JSON.stringify(metadata)).not.toContain(canary);
  });

  it("defines only metadata columns in the generated remote persistence migration", () => {
    const sql = readFileSync(
      path.resolve(__dirname, "../../persistence/migrations/0013_great_gorgon.sql"),
      "utf8"
    );

    expect(sql).toContain("remote_mutation_ledger");
    expect(sql).toContain("remote_audit_events");
    expect(sql).toContain("PRIMARY KEY(`device_id`, `idempotency_key`)");
    expect(sql).not.toMatch(
      /`(?:prompt|console|secret|private_key|bearer|token|absolute_path|environment|clipboard)(?:_[a-z]+)?`/i
    );
  });
});
