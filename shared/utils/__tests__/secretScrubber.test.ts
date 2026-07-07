import { describe, expect, it } from "vitest";
import safe from "safe-regex2";
import { findSecretInValue, PATTERNS, REDACTED, scrubSecrets } from "../secretScrubber.js";

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
        name: "openai-admin-key",
        input: `OPENAI_API_KEY=sk-admin-${"A".repeat(155)}`,
        expected: `OPENAI_API_KEY=${REDACTED}`,
      },
      {
        name: "openrouter-api-key",
        input: `OPENROUTER_API_KEY=sk-or-v1-${"a".repeat(64)}`,
        expected: `OPENROUTER_API_KEY=${REDACTED}`,
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
        name: "slack-app-token",
        input: `token=xapp-${"A".repeat(100)} end`,
        expected: `token=${REDACTED} end`,
      },
      {
        name: "slack-access-token-xoxb",
        input: `token=xoxe.xoxb-${"A".repeat(170)} end`,
        expected: `token=${REDACTED} end`,
      },
      {
        name: "slack-access-token-xoxp",
        input: `token=xoxe.xoxp-${"0".repeat(175)}`,
        expected: `token=${REDACTED}`,
      },
      {
        name: "slack-refresh-token",
        input: `token=xoxe-${"A".repeat(145)} end`,
        expected: `token=${REDACTED} end`,
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
        name: "aws-sts-access-key",
        input: "aws_access_key=ASIAIOSFODNN7EXAMPLE trailing",
        expected: `aws_access_key=${REDACTED} trailing`,
      },
      {
        name: "aws-sts-variant-key",
        input: "aws_access_key=ABIAIOSFODNN7EXAMPLE",
        expected: `aws_access_key=${REDACTED}`,
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
        name: "replicate-api-token",
        input: `REPLICATE_API_TOKEN=r8_${"A".repeat(37)}`,
        expected: `REPLICATE_API_TOKEN=${REDACTED}`,
      },
      {
        name: "huggingface-api-token",
        input: `HF_TOKEN=hf_${"a".repeat(34)} end`,
        expected: `HF_TOKEN=${REDACTED} end`,
      },
      {
        name: "groq-api-key",
        input: `GROQ_API_KEY=gsk_${"z".repeat(50)} end`,
        expected: `GROQ_API_KEY=${REDACTED} end`,
      },
      {
        name: "linear-api-key",
        input: `LINEAR_API_KEY=lin_api_${"A".repeat(40)}`,
        expected: `LINEAR_API_KEY=${REDACTED}`,
      },
      {
        name: "notion-api-key",
        input: `NOTION_API_KEY=ntn_${"a".repeat(47)} end`,
        expected: `NOTION_API_KEY=${REDACTED} end`,
      },
      {
        name: "sendgrid-api-key",
        input: `SENDGRID_API_KEY=SG.${"A".repeat(22)}.${"z".repeat(43)} end`,
        expected: `SENDGRID_API_KEY=${REDACTED} end`,
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
      {
        name: "slack-signing-secret-fallback",
        input: `SLACK_SIGNING_SECRET=${"a".repeat(32)} end`,
        expected: `${REDACTED} end`,
      },
      {
        name: "vercel-vcp",
        input: `VERCEL_TOKEN=vcp_${"A".repeat(32)} end`,
        expected: `VERCEL_TOKEN=${REDACTED} end`,
      },
      {
        name: "vercel-vci",
        input: `VERCEL_TOKEN=vci_${"a".repeat(24)}`,
        expected: `VERCEL_TOKEN=${REDACTED}`,
      },
      {
        name: "vercel-vca",
        input: `VERCEL_TOKEN=vca_${"Z".repeat(40)} next`,
        expected: `VERCEL_TOKEN=${REDACTED} next`,
      },
      {
        name: "vercel-vcr",
        input: `VERCEL_TOKEN=vcr_${"0".repeat(36)}`,
        expected: `VERCEL_TOKEN=${REDACTED}`,
      },
      {
        name: "vercel-vck",
        input: `VERCEL_TOKEN=vck_${"X".repeat(28)}`,
        expected: `VERCEL_TOKEN=${REDACTED}`,
      },
      {
        name: "perplexity-api-key",
        input: `PPLX_API_KEY=pplx-${"a".repeat(48)} end`,
        expected: `PPLX_API_KEY=${REDACTED} end`,
      },
      {
        name: "xai-api-key",
        input: `XAI_API_KEY=xai-${"A".repeat(80)}`,
        expected: `XAI_API_KEY=${REDACTED}`,
      },
      {
        name: "together-api-key",
        input: `TOGETHER_API_KEY=tgp_v1_${"A".repeat(43)} end`,
        expected: `TOGETHER_API_KEY=${REDACTED} end`,
      },
      {
        name: "together-api-key-trailing-dash",
        // Body ending in `-` or `_` (non-word) must still redact — the lack of
        // a trailing `\b` is what makes this work.
        input: `TOGETHER_API_KEY=tgp_v1_${"A".repeat(42)}-`,
        expected: `TOGETHER_API_KEY=${REDACTED}`,
      },
      {
        name: "resend-api-key",
        input: `RESEND_API_KEY=re_${"A".repeat(48)}`,
        expected: `RESEND_API_KEY=${REDACTED}`,
      },
      {
        name: "heroku-oauth-token",
        input: `HEROKU_API_KEY=HRKU-${"a".repeat(60)} end`,
        expected: `HEROKU_API_KEY=${REDACTED} end`,
      },
      {
        name: "heroku-oauth-token-trailing-underscore",
        // Body ending in `_` must still redact (no trailing `\b`).
        input: `HEROKU_API_KEY=HRKU-${"a".repeat(59)}_`,
        expected: `HEROKU_API_KEY=${REDACTED}`,
      },
      {
        name: "telegram-bot-token",
        input: `TELEGRAM_BOT_TOKEN=1234567890:${"A".repeat(35)} end`,
        expected: `${REDACTED} end`,
      },
      {
        name: "datadog-api-key",
        input: `DD_API_KEY=${"a".repeat(32)} next`,
        expected: `${REDACTED} next`,
      },
      {
        name: "datadog-app-key",
        input: `DD_APP_KEY="${"f".repeat(40)}" next`,
        expected: `${REDACTED} next`,
      },
      {
        name: "pulumi-api-token",
        input: `PULUMI_ACCESS_TOKEN=pul-${"a".repeat(40)} end`,
        expected: `PULUMI_ACCESS_TOKEN=${REDACTED} end`,
      },
      {
        name: "rubygems-api-token",
        input: `GEM_HOST_API_KEY=rubygems_${"a".repeat(48)} next`,
        expected: `GEM_HOST_API_KEY=${REDACTED} next`,
      },
      {
        name: "readme-api-token",
        input: `README_API_KEY=rdme_${"a".repeat(70)}`,
        expected: `README_API_KEY=${REDACTED}`,
      },
      {
        name: "huggingface-org-api-token",
        input: `HF_ORG_TOKEN=api_org_${"A".repeat(34)} end`,
        expected: `HF_ORG_TOKEN=${REDACTED} end`,
      },
      {
        name: "age-secret-key",
        input: `AGE_SECRET_KEY=AGE-SECRET-KEY-1${"Q".repeat(58)}`,
        expected: `AGE_SECRET_KEY=${REDACTED}`,
      },
      {
        name: "infracost-api-token",
        input: `INFRACOST_API_KEY=ico-${"A".repeat(32)} next`,
        expected: `INFRACOST_API_KEY=${REDACTED} next`,
      },
      {
        name: "artifactory-api-key",
        input: `ARTIFACTORY_KEY=AKCp${"A".repeat(69)} end`,
        expected: `ARTIFACTORY_KEY=${REDACTED} end`,
      },
      {
        name: "artifactory-reference-token",
        input: `ARTIFACTORY_TOKEN=cmVmd${"a".repeat(59)}`,
        expected: `ARTIFACTORY_TOKEN=${REDACTED}`,
      },
      {
        name: "grafana-service-account-token",
        input: `GF_SERVICE_ACCOUNT_TOKEN=glsa_${"A".repeat(32)}_${"a".repeat(8)} end`,
        expected: `GF_SERVICE_ACCOUNT_TOKEN=${REDACTED} end`,
      },
      {
        name: "easypost-api-token",
        input: `EASYPOST_API_KEY=EZAK${"a".repeat(54)} next`,
        expected: `EASYPOST_API_KEY=${REDACTED} next`,
      },
      {
        name: "easypost-test-api-token",
        input: `EASYPOST_TEST_API_KEY=EZTK${"b".repeat(54)}`,
        expected: `EASYPOST_TEST_API_KEY=${REDACTED}`,
      },
      {
        name: "maxmind-license-key",
        input: `MAXMIND_LICENSE_KEY=${"X".repeat(6)}_${"y".repeat(29)}_mmk end`,
        expected: `MAXMIND_LICENSE_KEY=${REDACTED} end`,
      },
      {
        name: "doppler-api-token",
        input: `DOPPLER_TOKEN=dp.pt.${"a".repeat(43)} next`,
        expected: `DOPPLER_TOKEN=${REDACTED} next`,
      },
      {
        name: "scalingo-api-token",
        input: `SCALINGO_API_TOKEN=tk-us-${"A".repeat(48)}`,
        expected: `SCALINGO_API_TOKEN=${REDACTED}`,
      },
      {
        name: "heroku-api-key-v2",
        input: `HEROKU_API_KEY=HRKU-AA${"a".repeat(58)} end`,
        expected: `HEROKU_API_KEY=${REDACTED} end`,
      },
    ];

    for (const { name, input, expected } of positive) {
      it(`redacts ${name}`, () => {
        expect(scrubSecrets(input)).toBe(expected);
      });
    }

    // Every pattern must have at least one positive fixture above. The fixtures
    // assert end-to-end through `scrubSecrets`, so together with this coverage
    // check they prove the pre-scan probe is sound: a pattern whose `probe`
    // fragment failed to match its own secrets would return the fixture input
    // unredacted and fail its `redacts <name>` case.
    for (const { name, regex } of PATTERNS) {
      it(`has a positive fixture exercising ${name}`, () => {
        const stateless = new RegExp(regex.source, regex.flags.replace(/[gy]/g, ""));
        expect(positive.some(({ input }) => stateless.test(input))).toBe(true);
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

    it("does not flag sk-or-v1- with uppercase hex body", () => {
      const upperHex = `sk-or-v1-${"A".repeat(64)}`;
      expect(scrubSecrets(upperHex)).toBe(upperHex);
    });

    it("does not flag a too-short openrouter key", () => {
      const tooShort = `sk-or-v1-${"a".repeat(54)}`;
      expect(scrubSecrets(tooShort)).toBe(tooShort);
    });

    it("does not flag bare 32-char hex without slack_signing_secret context", () => {
      const bareHex = `${"a".repeat(32)}`;
      expect(scrubSecrets(bareHex)).toBe(bareHex);
    });

    it("does not flag a too-short xapp token", () => {
      const tooShort = `xapp-${"A".repeat(89)}`;
      expect(scrubSecrets(tooShort)).toBe(tooShort);
    });

    it("does not flag xoxe- with too-short body", () => {
      const tooShort = `xoxe-${"A".repeat(139)}`;
      expect(scrubSecrets(tooShort)).toBe(tooShort);
    });

    it("partially redacts xoxe.xoxb- with too-short body via slack-token fallback", () => {
      // 159-char body is below the {160,180} access-token floor, but the
      // `xoxb-` portion still matches the existing slack-token pattern.
      const tooShort = `xoxe.xoxb-${"A".repeat(159)}`;
      expect(scrubSecrets(tooShort)).toBe(`xoxe.${REDACTED}`);
    });

    it("does not flag ACIA as an AWS key (wrong prefix)", () => {
      const wrongPrefix = "ACIAIOSFODNN7EXAMPLE";
      expect(scrubSecrets(wrongPrefix)).toBe(wrongPrefix);
    });

    it("does not flag too-short r8_ token", () => {
      const tooShort = `r8_${"A".repeat(34)}`;
      expect(scrubSecrets(tooShort)).toBe(tooShort);
    });

    it("does not flag too-short hf_ token", () => {
      const tooShort = `hf_${"a".repeat(24)}`;
      expect(scrubSecrets(tooShort)).toBe(tooShort);
    });

    it("does not flag too-short gsk_ token", () => {
      const tooShort = `gsk_${"z".repeat(39)}`;
      expect(scrubSecrets(tooShort)).toBe(tooShort);
    });

    it("does not flag AIIA as an AWS key (invalid prefix)", () => {
      const invalid = "AIIAIOSFODNN7EXAMPLE";
      expect(scrubSecrets(invalid)).toBe(invalid);
    });

    it("does not flag too-short lin_api_ token", () => {
      const tooShort = `lin_api_${"A".repeat(34)}`;
      expect(scrubSecrets(tooShort)).toBe(tooShort);
    });

    it("does not flag too-short ntn_ token", () => {
      const tooShort = `ntn_${"a".repeat(39)}`;
      expect(scrubSecrets(tooShort)).toBe(tooShort);
    });

    it("does not flag sendgrid with wrong segment count (2 segments)", () => {
      const malformed = `SG.${"A".repeat(22)}`;
      expect(scrubSecrets(malformed)).toBe(malformed);
    });

    it("scrubs valid-key portion of sendgrid-like string with trailing segment", () => {
      // The first three segments form a valid key shape; the regex scrubs them
      // and the trailing `.extra` is preserved as non-secret context.
      const withExtra = `SG.${"A".repeat(22)}.${"b".repeat(43)}.extra`;
      expect(scrubSecrets(withExtra)).toBe(`${REDACTED}.extra`);
    });

    it("does not flag sendgrid with wrong segment lengths", () => {
      const malformed = `SG.${"A".repeat(21)}.${"b".repeat(42)}`;
      expect(scrubSecrets(malformed)).toBe(malformed);
    });

    it("does not flag r8_ as substring in ordinary text", () => {
      const ordinary = "The car8_example text here is not a secret key at all";
      expect(scrubSecrets(ordinary)).toBe(ordinary);
    });

    it("does not flag hf_ as substring in ordinary text", () => {
      const ordinary = "The chef_example text here is not a secret key at all";
      expect(scrubSecrets(ordinary)).toBe(ordinary);
    });

    it("does not flag vcc_ as a Vercel token (not a real prefix)", () => {
      // Vercel issues vcp_/vci_/vca_/vcr_/vck_ — `vcc_` is not a real prefix
      // and the character class must reject it.
      const fake = `vcc_${"A".repeat(32)}`;
      expect(scrubSecrets(fake)).toBe(fake);
    });

    it("does not flag a bare timestamp:token shape without telegram context", () => {
      // 10-digit Unix timestamp + colon + 35-char alphanumeric tail can appear
      // in ordinary log lines; the telegram pattern's anchor must keep it safe.
      const bare = `1700000000:${"A".repeat(35)}`;
      expect(scrubSecrets(bare)).toBe(bare);
    });

    it("does not flag a bare 32-char hex without datadog context", () => {
      // Plain MD5 hash — must remain visible without the DD_API_KEY anchor.
      const md5 = `digest=${"a".repeat(32)}`;
      expect(scrubSecrets(md5)).toBe(md5);
    });

    it("does not flag a bare 40-char hex without datadog context", () => {
      // Plain SHA1 hash — must remain visible without the DD_APP_KEY anchor.
      const sha1 = `commit=${"f".repeat(40)}`;
      expect(scrubSecrets(sha1)).toBe(sha1);
    });

    it("redacts realistically-sized Atlassian token bodies fully", () => {
      // Real Atlassian tokens are ~170-200 chars. The {120,512} upper bound
      // must cover that range plus generous headroom. A 400-char body is well
      // past typical and must still be fully consumed by the pattern.
      const realistic = `auth=ATATT3x${"A".repeat(400)}`;
      const out = scrubSecrets(realistic);
      expect(out).toBe(`auth=${REDACTED}`);
    });

    it("does not flag too-short pulumi token", () => {
      const ts = `pul-${"a".repeat(39)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short rubygems token", () => {
      const ts = `rubygems_${"a".repeat(47)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short readme token", () => {
      const ts = `rdme_${"a".repeat(69)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short huggingface-org token", () => {
      const ts = `api_org_${"A".repeat(33)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short age secret key", () => {
      const ts = `AGE-SECRET-KEY-1${"Q".repeat(57)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short infracost token", () => {
      const ts = `ico-${"A".repeat(31)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short artifactory API key", () => {
      const ts = `AKCp${"A".repeat(68)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short artifactory reference token", () => {
      const ts = `cmVmd${"a".repeat(58)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag malformed grafana-sa token (too few hex chars)", () => {
      const ts = `glsa_${"A".repeat(32)}_${"a".repeat(7)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short easypost API token", () => {
      const ts = `EZAK${"a".repeat(53)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short easypost test token", () => {
      const ts = `EZTK${"b".repeat(53)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short maxmind license key", () => {
      const ts = `${"X".repeat(6)}_${"y".repeat(28)}_mmk`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short doppler token", () => {
      const ts = `dp.pt.${"a".repeat(42)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short scalingo token", () => {
      const ts = `tk-us-${"A".repeat(47)}`;
      expect(scrubSecrets(ts)).toBe(ts);
    });

    it("does not flag too-short heroku-v2 token", () => {
      const ts = `HRKU-AA${"a".repeat(57)}`;
      expect(scrubSecrets(ts)).toBe(ts);
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
        `pul-${"a".repeat(40)}`,
        `rubygems_${"a".repeat(48)}`,
        `rdme_${"a".repeat(70)}`,
        `api_org_${"A".repeat(34)}`,
        `AGE-SECRET-KEY-1${"Q".repeat(58)}`,
        `ico-${"A".repeat(32)}`,
        `AKCp${"A".repeat(69)}`,
        `cmVmd${"a".repeat(59)}`,
        `glsa_${"A".repeat(32)}_${"a".repeat(8)}`,
        `EZAK${"a".repeat(54)}`,
        `EZTK${"b".repeat(54)}`,
        `${"X".repeat(6)}_${"y".repeat(29)}_mmk`,
        `dp.pt.${"a".repeat(43)}`,
        `tk-us-${"A".repeat(48)}`,
        `HRKU-AA${"a".repeat(58)}`,
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

    it("scalingo token ending in dash is scrubbed (no trailing \\b)", () => {
      const input = `SCALINGO_API_TOKEN=tk-us-${"A".repeat(47)}- end`;
      expect(scrubSecrets(input)).toBe(`SCALINGO_API_TOKEN=${REDACTED} end`);
    });

    it("scalingo token ending in underscore is scrubbed (no trailing \\b)", () => {
      const input = `SCALINGO_API_TOKEN=tk-us-${"A".repeat(47)}_ end`;
      expect(scrubSecrets(input)).toBe(`SCALINGO_API_TOKEN=${REDACTED} end`);
    });

    it("heroku-v2 token ending in underscore is scrubbed (no trailing \\b)", () => {
      const input = `HEROKU_API_KEY=HRKU-AA${"a".repeat(57)}_ end`;
      expect(scrubSecrets(input)).toBe(`HEROKU_API_KEY=${REDACTED} end`);
    });

    it("heroku-v2 token ending in dash is scrubbed (no trailing \\b)", () => {
      const input = `HEROKU_API_KEY=HRKU-AA${"a".repeat(57)}- end`;
      expect(scrubSecrets(input)).toBe(`HEROKU_API_KEY=${REDACTED} end`);
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

  describe("ordering regression", () => {
    it("xoxe.xoxb- access token is fully scrubbed (not partially by xoxe-)", () => {
      const token = `xoxe.xoxb-${"A".repeat(170)}`;
      const out = scrubSecrets(token);
      expect(out).toBe(REDACTED);
      // If the broader `xoxe-` pattern matched first, we'd see `xoxb-` remnants.
      expect(out).not.toContain("xoxb");
      expect(out).not.toContain("xoxe");
    });

    it("sk-or-v1- token fully scrubbed (not partially by sk-{48})", () => {
      const token = `sk-or-v1-${"a".repeat(64)}`;
      const out = scrubSecrets(token);
      expect(out).toBe(REDACTED);
      expect(out).not.toContain("or-v1");
    });

    it("all four sk- variants redact independently in one string", () => {
      const input = [
        `sk-proj-${"A".repeat(120)}`,
        `sk-svcacct-${"B".repeat(130)}`,
        `sk-admin-${"C".repeat(155)}`,
        `sk-or-v1-${"a".repeat(64)}`,
        `sk-${"D".repeat(48)}`,
      ].join(" | ");
      const out = scrubSecrets(input);
      expect(out).not.toContain("sk-proj");
      expect(out).not.toContain("sk-svcacct");
      expect(out).not.toContain("sk-admin");
      expect(out).not.toContain("sk-or-v1");
      expect(out).not.toContain("sk-D");
      const redactionCount = (out.match(/\[REDACTED\]/g) ?? []).length;
      expect(redactionCount).toBe(5);
    });

    it("HRKU-AA v2 token fully scrubbed (not partially by HRKU- oauth)", () => {
      const token = `HRKU-AA${"a".repeat(58)}`;
      const out = scrubSecrets(token);
      expect(out).toBe(REDACTED);
      expect(out).not.toContain("HRKU");
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

  describe("findSecretInValue", () => {
    it("returns undefined for a clean string", () => {
      expect(findSecretInValue("just a normal value")).toBeUndefined();
    });

    it("returns undefined for an empty string", () => {
      expect(findSecretInValue("")).toBeUndefined();
    });

    it("returns the matching pattern for a GitHub PAT", () => {
      const match = findSecretInValue(`ghp_${"A".repeat(36)}`);
      expect(match?.name).toBe("github-pat");
    });

    it("identifies an Anthropic key", () => {
      const match = findSecretInValue(`sk-ant-${"a".repeat(95)}`);
      expect(match?.name).toBe("anthropic-api-key");
    });

    it("is stateless across repeated calls on the same value (no lastIndex leak)", () => {
      const token = `ghp_${"A".repeat(36)}`;
      expect(findSecretInValue(token)?.name).toBe("github-pat");
      expect(findSecretInValue(token)?.name).toBe("github-pat");
      expect(findSecretInValue(token)?.name).toBe("github-pat");
    });

    it("matches context-dependent patterns when the key name precedes the value", () => {
      expect(findSecretInValue(`AWS_SECRET_ACCESS_KEY=${"A".repeat(40)}`)?.name).toBe(
        "aws-secret-access-key"
      );
      expect(findSecretInValue(`DD_API_KEY=${"a".repeat(32)}`)?.name).toBe("datadog-key");
      expect(findSecretInValue(`api_key=${"A".repeat(32)}`)?.name).toBe("generic-key-fallback");
    });

    it("does not match a bare context-dependent value without its key name", () => {
      // The AWS secret pattern requires the key name as context — the bare
      // 40-char value alone must not match (this is why assertNoSecretEnvValues
      // also tests the `KEY=value` form).
      expect(findSecretInValue("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBeUndefined();
    });

    it("does not mutate the shared PATTERNS lastIndex (scrubSecrets still works after)", () => {
      findSecretInValue(`ghp_${"A".repeat(36)}`);
      // If findSecretInValue had advanced a shared regex's lastIndex, this
      // global-flag .replace() would skip the leading match.
      expect(scrubSecrets(`ghp_${"A".repeat(36)}`)).toBe(REDACTED);
    });
  });
});
