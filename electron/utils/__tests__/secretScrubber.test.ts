import { describe, expect, it } from "vitest";
import safe from "safe-regex2";
import { PATTERNS, REDACTED, scrubSecrets } from "../secretScrubber.js";

describe("secretScrubber", () => {
  describe("ReDoS safety", () => {
    // Runs first — if any pattern introduces catastrophic backtracking, every
    // other test in this file is moot. `safe-regex2` is the maintained fork of
    // the unmaintained `safe-regex`.
    for (const { name, regex } of PATTERNS) {
      it(`pattern "${name}" passes safe-regex2`, () => {
        expect(safe(regex)).toBe(true);
      });
    }
  });

  describe("per-pattern redaction", () => {
    const positive: Array<{ name: string; input: string; expected: string }> = [
      {
        name: "github-pat",
        input: "clone https://ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456@github.com/x/y.git",
        expected: `clone https://${REDACTED}@github.com/x/y.git`,
      },
      {
        name: "github-fine-grained-pat",
        input: `token=github_pat_${"A".repeat(82)} trailing`,
        expected: `token=${REDACTED} trailing`,
      },
      {
        name: "github-app-token",
        input: `token=ghs_${"a".repeat(36)}`,
        expected: `token=${REDACTED}`,
      },
      {
        name: "github-user-to-server-token",
        input: `token=ghu_${"A".repeat(36)}`,
        expected: `token=${REDACTED}`,
      },
      {
        name: "github-oauth-token",
        input: `token=gho_${"z".repeat(36)}`,
        expected: `token=${REDACTED}`,
      },
      {
        name: "anthropic-api-key",
        input: `key=sk-ant-${"a".repeat(95)}`,
        expected: `key=${REDACTED}`,
      },
      {
        name: "openai-api-key",
        input: `OPENAI_API_KEY=sk-${"A".repeat(48)}`,
        expected: `OPENAI_API_KEY=${REDACTED}`,
      },
      {
        name: "stripe-live",
        input: `stripe=sk_live_${"a".repeat(32)} next`,
        expected: `stripe=${REDACTED} next`,
      },
      {
        name: "stripe-test",
        input: `stripe=sk_test_${"z".repeat(40)}`,
        expected: `stripe=${REDACTED}`,
      },
      {
        name: "slack-token",
        input: "xoxb-1234567890-abcdefghijkl",
        expected: REDACTED,
      },
      {
        name: "google-api-key",
        input: `url=AIza${"A".repeat(35)}/path`,
        expected: `url=${REDACTED}/path`,
      },
      {
        name: "aws-access-key",
        input: "aws_access_key=AKIAIOSFODNN7EXAMPLE trailing",
        expected: `aws_access_key=${REDACTED} trailing`,
      },
      {
        name: "aws-secret-access-key-credentials-file",
        input: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end",
        expected: `${REDACTED} end`,
      },
      {
        name: "aws-secret-access-key-env-var",
        input: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY next",
        expected: `${REDACTED} next`,
      },
      {
        name: "aws-secret-access-key-sts-json",
        input: `"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"`,
        expected: `"${REDACTED}`,
      },
      {
        name: "npm-token",
        input: `registry=npm_${"a".repeat(36)}`,
        expected: `registry=${REDACTED}`,
      },
      {
        name: "azure-connection-string",
        input: `conn=DefaultEndpointsProtocol=https;AccountName=myacct;AccountKey=${"A".repeat(86)}== end`,
        expected: `conn=${REDACTED} end`,
      },
      {
        name: "pem-block",
        input:
          "before -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY----- after",
        expected: `before ${REDACTED} after`,
      },
      {
        name: "jwt",
        input: `Authorization: eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(40)}`,
        expected: `Authorization: ${REDACTED}`,
      },
      {
        name: "bearer-token",
        input: "Authorization: Bearer abcdefghij.klmnop-qr_st=",
        expected: `Authorization: Bearer ${REDACTED}`,
      },
      {
        name: "oauth-access_token",
        input: "https://api.example.com/?foo=bar&access_token=AbCdEfGhIj123456",
        expected: `https://api.example.com/?foo=bar&access_token=${REDACTED}`,
      },
      {
        name: "oauth-client_secret",
        input: "?client_secret=supersecretvalue&other=1",
        expected: `?client_secret=${REDACTED}&other=1`,
      },
      {
        name: "oauth-code-in-url",
        input: "https://example.com/callback?code=abcd1234xyz&state=zz",
        expected: `https://example.com/callback?code=${REDACTED}&state=zz`,
      },
    ];

    for (const { name, input, expected } of positive) {
      it(`redacts ${name}`, () => {
        expect(scrubSecrets(input)).toBe(expected);
      });
    }
  });

  describe("negative cases", () => {
    it("leaves plain English log lines untouched", () => {
      const msg = "User 42 signed in at 2026-04-18T12:00:00Z from Los Angeles";
      expect(scrubSecrets(msg)).toBe(msg);
    });

    it("does not match a sigil that is one character short", () => {
      // Anthropic keys require {90,255}; 89 chars must not match.
      const shortKey = `sk-ant-${"a".repeat(89)}`;
      expect(scrubSecrets(shortKey)).toBe(shortKey);
    });

    it("does not match md5-length hex strings as AWS keys", () => {
      const md5 = "0123456789abcdef0123456789abcdef";
      expect(scrubSecrets(md5)).toBe(md5);
    });

    it("does not match partial PEM sigils", () => {
      const partial = "-----BEGIN CERTIFICATE----- without matching end marker";
      expect(scrubSecrets(partial)).toBe(partial);
    });

    it("leaves an empty string unchanged", () => {
      expect(scrubSecrets("")).toBe("");
    });

    it("does not re-redact an already redacted placeholder", () => {
      const already = `prefix ${REDACTED} suffix`;
      expect(scrubSecrets(already)).toBe(already);
    });

    it("leaves plain `code=` log lines alone (not in a URL query)", () => {
      const logLine = "code=42 not found in handler";
      expect(scrubSecrets(logLine)).toBe(logLine);
    });

    it("leaves a `code=` log line at a subsequent line start alone", () => {
      const multiline = "ERROR at 12:00:00\ncode=ENOENT path=/tmp/foo";
      expect(scrubSecrets(multiline)).toBe(multiline);
    });

    it("does not flag an unrelated 40-char base64-ish string as an AWS secret", () => {
      // No `aws_secret_access_key` / `SecretAccessKey` context — must pass through.
      const hashish = "sha256=" + "A".repeat(40);
      expect(scrubSecrets(hashish)).toBe(hashish);
    });
  });

  describe("idempotence", () => {
    it("scrubSecrets(scrubSecrets(x)) === scrubSecrets(x) for mixed secrets", () => {
      const mixed = [
        "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456",
        "Bearer abcdefghij.klmnop-qr_st=",
        `sk-${"A".repeat(48)}`,
        "AKIAIOSFODNN7EXAMPLE",
        "plain text with no secrets",
      ].join(" | ");

      const once = scrubSecrets(mixed);
      expect(scrubSecrets(once)).toBe(once);
    });
  });

  describe("large inputs", () => {
    it("scrubs secrets in oversized strings without truncating (no prefix leak)", () => {
      // Place the secret deep inside a 200KB input. Prior 100KB pre-truncation
      // would have severed the secret and leaked its head. With no truncation,
      // the full secret must be recognized and redacted wherever it sits, and
      // the post-secret tail must survive untruncated.
      const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456";
      const buried = `${"a ".repeat(60_000)}${secret} tail-marker`;
      expect(buried.length).toBeGreaterThan(100_000);
      const out = scrubSecrets(buried);
      expect(out).not.toContain(secret);
      expect(out).not.toContain(secret.slice(0, 12));
      // Proves nothing was silently dropped after the secret position.
      expect(out).toContain(`${REDACTED} tail-marker`);
    });

    it("scrubs a secret that would have straddled a legacy 100KB cap", () => {
      const MAX = 100 * 1024;
      const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456";
      // Position the secret so it starts 10 chars before the legacy cut point.
      const prefix = "a ".repeat((MAX - 10) / 2);
      const straddle = `${prefix}${secret} keep-this`;
      const out = scrubSecrets(straddle);
      expect(out).not.toContain(secret);
      // Even a 10-char head of the secret must be gone — guards against a
      // re-introduced slice that severs the secret mid-string.
      expect(out).not.toContain(secret.slice(0, 10));
      expect(out).toContain("keep-this");
    });
  });

  describe("boundary fidelity", () => {
    it("Bearer token does not consume across CRLF into the next header", () => {
      const input = "Authorization: Bearer abcdefghij.klmnop-qr_st=\r\nX-Trace-Id: keep-this";
      const out = scrubSecrets(input);
      expect(out).toBe(`Authorization: Bearer ${REDACTED}\r\nX-Trace-Id: keep-this`);
    });

    it("oauth form-body at start of a non-first line is scrubbed (m flag)", () => {
      const input = "POST /token\naccess_token=supersecrettokenvalue&other=1";
      const out = scrubSecrets(input);
      expect(out).toBe(`POST /token\naccess_token=${REDACTED}&other=1`);
    });

    it("oauth param after CRLF is scrubbed", () => {
      const input = "request body:\r\nclient_secret=abc123xyz";
      const out = scrubSecrets(input);
      expect(out).toContain(`client_secret=${REDACTED}`);
      expect(out).not.toContain("abc123xyz");
    });

    it("oauth param at byte 0 (no preceding separator) is scrubbed", () => {
      const input = "access_token=supersecretvalue123&other=1";
      expect(scrubSecrets(input)).toBe(`access_token=${REDACTED}&other=1`);
    });

    it("chained PEM bundle (>10KB) is scrubbed end-to-end", () => {
      // A fullchain.pem with three certs is ~15-20KB. Prior {1,10000}? cap
      // would refuse to match the outermost BEGIN..END pair.
      const longBody = "a".repeat(20_000);
      const pem = `-----BEGIN CERTIFICATE-----\n${longBody}\n-----END CERTIFICATE-----`;
      const out = scrubSecrets(`prefix ${pem} suffix`);
      expect(out).toBe(`prefix ${REDACTED} suffix`);
    });
  });

  describe("pattern upper bounds", () => {
    it("Anthropic key at the upper bound (255) matches", () => {
      const atCap = `sk-ant-${"a".repeat(255)}`;
      expect(scrubSecrets(atCap)).toBe(REDACTED);
    });

    it("Bearer token at upper bound (4000 chars) is scrubbed", () => {
      const input = `Authorization: Bearer ${"A".repeat(4000)}`;
      expect(scrubSecrets(input)).toBe(`Authorization: Bearer ${REDACTED}`);
    });
  });

  describe("multiple secrets in one string", () => {
    it("redacts every distinct secret in a single pass", () => {
      const input = [
        "token1=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456",
        "token2=AKIAIOSFODNN7EXAMPLE",
        `auth=Bearer abc123.def-456_xyz=`,
      ].join(" ; ");

      const out = scrubSecrets(input);
      expect(out).not.toContain("ghp_");
      expect(out).not.toContain("AKIA");
      expect(out).not.toMatch(/Bearer [A-Za-z0-9]/);
      const redactionCount = (out.match(/\[REDACTED\]/g) ?? []).length;
      expect(redactionCount).toBe(3);
    });
  });
});
