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
        name: "gitlab-personal-token",
        input: `glpat-${"A".repeat(20)} trailing`,
        expected: `${REDACTED} trailing`,
      },
      {
        name: "gitlab-deploy-token",
        input: `gldt-${"x".repeat(20)}`,
        expected: REDACTED,
      },
      {
        name: "anthropic-api-key",
        input: `key=sk-ant-${"a".repeat(95)}`,
        expected: `key=${REDACTED}`,
      },
      {
        name: "anthropic-oauth-setup-token",
        // `sk-ant-oat01-` should be covered by the existing anthropic-api-key
        // pattern. Body length here is 95 (includes the `oat01-` infix).
        input: `key=sk-ant-oat01-${"b".repeat(89)}`,
        expected: `key=${REDACTED}`,
      },
      {
        name: "openai-project-key",
        input: `OPENAI_API_KEY=sk-proj-${"A".repeat(120)} next`,
        expected: `OPENAI_API_KEY=${REDACTED} next`,
      },
      {
        name: "openai-svcacct-key",
        input: `OPENAI_API_KEY=sk-svcacct-${"z".repeat(150)}`,
        expected: `OPENAI_API_KEY=${REDACTED}`,
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
        name: "stripe-restricted-live",
        input: `stripe=rk_live_${"a".repeat(32)}`,
        expected: `stripe=${REDACTED}`,
      },
      {
        name: "stripe-restricted-test",
        input: `stripe=rk_test_${"z".repeat(40)} end`,
        expected: `stripe=${REDACTED} end`,
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
        name: "digitalocean-personal-token",
        input: `DO_TOKEN=dop_v1_${"a".repeat(64)} next`,
        expected: `DO_TOKEN=${REDACTED} next`,
      },
      {
        name: "digitalocean-oauth-token",
        input: `tok=doo_v1_${"B".repeat(64)}`,
        expected: `tok=${REDACTED}`,
      },
      {
        name: "digitalocean-refresh-token",
        input: `tok=dor_v1_${"9".repeat(64)}`,
        expected: `tok=${REDACTED}`,
      },
      {
        name: "atlassian-api-token",
        input: `auth=ATATT3xFfGF0${"A".repeat(180)}=`,
        expected: `auth=${REDACTED}`,
      },
      {
        name: "atlassian-connect-token",
        input: `auth=ATCTT3xFfGN0${"a".repeat(150)}`,
        expected: `auth=${REDACTED}`,
      },
      {
        name: "cloudflare-account-token",
        input: `CF_TOKEN=cfat_${"A".repeat(40)}${"0a1b2c3d"} end`,
        expected: `CF_TOKEN=${REDACTED} end`,
      },
      {
        name: "cloudflare-user-token",
        input: `tok=cfut_${"z".repeat(40)}deadbeef`,
        expected: `tok=${REDACTED}`,
      },
      {
        name: "cloudflare-key",
        input: `tok=cfk_${"x".repeat(40)}cafebabe`,
        expected: `tok=${REDACTED}`,
      },
      {
        name: "supabase-publishable",
        input: `SUPABASE_KEY=sb_publishable_${"A".repeat(48)}`,
        expected: `SUPABASE_KEY=${REDACTED}`,
      },
      {
        name: "supabase-secret",
        input: `SUPABASE_KEY=sb_secret_${"z".repeat(48)} next`,
        expected: `SUPABASE_KEY=${REDACTED} next`,
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
      {
        name: "url-basic-auth-https",
        input: "git remote set-url origin https://user:pass@example.com/x/y.git",
        expected: "git remote set-url origin https://<redacted>@example.com/x/y.git",
      },
      {
        name: "url-basic-auth-http",
        input: "fetch http://admin:hunter2@internal.example.com/path",
        expected: "fetch http://<redacted>@internal.example.com/path",
      },
      {
        name: "url-basic-auth-percent-encoded",
        input: "clone https://oauth2:%24token%2Fvalue@gitlab.com/a/b.git",
        expected: "clone https://<redacted>@gitlab.com/a/b.git",
      },
      {
        name: "generic-api-key-fallback",
        input: `API_KEY=${"A".repeat(32)} trailing`,
        expected: `${REDACTED} trailing`,
      },
      {
        name: "generic-client-secret-fallback",
        input: `client_secret = ${"x".repeat(40)}`,
        expected: REDACTED,
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

    it("does not flag a too-short GitLab token", () => {
      const tooShort = `glpat-${"A".repeat(19)}`;
      expect(scrubSecrets(tooShort)).toBe(tooShort);
    });

    it("does not flag MAX_TOKENS as a generic API key", () => {
      const config = "MAX_TOKENS=8192 next";
      expect(scrubSecrets(config)).toBe(config);
    });

    it("does not flag TOTAL_TOKENS as a generic API key", () => {
      const config = "TOTAL_TOKENS=4096";
      expect(scrubSecrets(config)).toBe(config);
    });

    it("does not flag short API_KEY values below the 16-char floor", () => {
      const tooShort = "API_KEY=12345";
      expect(scrubSecrets(tooShort)).toBe(tooShort);
    });

    it("does not flag a request-id-shaped value without a key prefix", () => {
      const reqId = "req_01HXABCDEFGHJKMNPQRSTVWXYZ trace=ok";
      expect(scrubSecrets(reqId)).toBe(reqId);
    });

    it("does not flag a URL without basic-auth credentials", () => {
      const url = "https://example.com/path?foo=bar";
      expect(scrubSecrets(url)).toBe(url);
    });

    it("redacts realistically-sized Atlassian token bodies fully", () => {
      // Real Atlassian tokens are ~170-200 chars. The {120,512} upper bound
      // must cover that range plus generous headroom. A 400-char body is well
      // past typical and must still be fully consumed by the pattern.
      const realistic = `auth=ATATT3x${"A".repeat(400)}`;
      const out = scrubSecrets(realistic);
      expect(out).toBe(`auth=${REDACTED}`);
    });
  });

  describe("idempotence", () => {
    it("scrubSecrets(scrubSecrets(x)) === scrubSecrets(x) for mixed secrets", () => {
      const mixed = [
        "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456",
        "Bearer abcdefghij.klmnop-qr_st=",
        `sk-${"A".repeat(48)}`,
        `sk-proj-${"A".repeat(120)}`,
        `glpat-${"A".repeat(20)}`,
        `dop_v1_${"a".repeat(64)}`,
        `cfat_${"A".repeat(40)}deadbeef`,
        `sb_secret_${"x".repeat(48)}`,
        "https://user:pass@example.com/path",
        "AKIAIOSFODNN7EXAMPLE",
        "plain text with no secrets",
      ].join(" | ");

      const once = scrubSecrets(mixed);
      expect(scrubSecrets(once)).toBe(once);
    });

    it("URL basic-auth replacement is itself non-matching (no infinite loop)", () => {
      const input = "clone https://user:pass@example.com/x/y.git";
      const out = scrubSecrets(input);
      expect(out).toBe("clone https://<redacted>@example.com/x/y.git");
      expect(scrubSecrets(out)).toBe(out);
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
