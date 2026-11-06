import { describe, expect, it } from "vitest";
import { redactSecrets } from "../redactSecrets.js";

describe("redactSecrets", () => {
  it("keeps the label of an assignment and drops its value", () => {
    expect(redactSecrets("password: hunter22")).toBe("password: [redacted]");
    expect(redactSecrets("token=abcdef123456")).toBe("token=[redacted]");
  });

  it("catches prefixed environment names and quoted JSON values", () => {
    expect(redactSecrets("export OPENAI_API_KEY=abcdefgh12345")).toBe(
      "export OPENAI_API_KEY=[redacted]"
    );
    expect(redactSecrets('{"token":"abcdef123456"}')).not.toContain("abcdef123456");
  });

  it("drops a short password and the password in a connection string", () => {
    expect(redactSecrets("password: abc")).toBe("password: [redacted]");
    expect(redactSecrets("DB_PASSWORD=pw1")).toBe("DB_PASSWORD=[redacted]");
    expect(redactSecrets("connecting to postgres://app:s3cret@db.local:5432/main")).toBe(
      "connecting to postgres://app:[redacted]@db.local:5432/main"
    );
    expect(redactSecrets("password=[abc]")).toBe("password=[redacted]");
    expect(redactSecrets("password=a[b]")).toBe("password=[redacted]");
    expect(redactSecrets("redis://:s3cret@cache:6379")).toBe("redis://:[redacted]@cache:6379");
    // Already replaced by an earlier pattern: left as one marker, not two.
    expect(redactSecrets("password: hunter22")).toBe("password: [redacted]");
  });

  it("stays fast on long runs that look almost like a URL or an assignment", () => {
    const long = `${"a-".repeat(20_000)} ${"x".repeat(40_000)}`;
    const start = performance.now();
    redactSecrets(long);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("drops known key shapes wherever they appear", () => {
    const ghp = `ghp_${"x".repeat(36)}`;
    expect(redactSecrets(`cloning with ${ghp} now`)).toBe("cloning with [redacted] now");
    expect(redactSecrets("key AKIAABCDEFGHIJKLMNOP")).toBe("key [redacted]");
    for (const key of [
      `sk_live_${"a1".repeat(12)}`,
      `rk_test_${"a1".repeat(12)}`,
      `whsec_${"a1".repeat(12)}`,
      `glpat-${"a1".repeat(12)}`,
      `npm_${"a1".repeat(18)}`,
      `hf_${"a1".repeat(17)}`,
      `xapp-1-${"a1".repeat(8)}`,
      `xoxe-1-${"a1".repeat(8)}`,
      `ya29.${"a1".repeat(12)}`,
      `sk-ant-api03-${"a1".repeat(12)}`,
    ]) {
      expect(redactSecrets(`using ${key} here`)).toBe("using [redacted] here");
    }
  });

  it("catches secrets whose names end in a key rather than a secret or token", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(redactSecrets(`export AWS_SECRET_ACCESS_KEY=${secret}`)).toBe(
      "export AWS_SECRET_ACCESS_KEY=[redacted]"
    );
    expect(redactSecrets(`SECRET_KEY="${secret}"`)).toBe("SECRET_KEY=[redacted]");
    expect(redactSecrets("STRIPE_KEY: abcdef123456")).toBe("STRIPE_KEY: [redacted]");
    expect(redactSecrets("GPG_PASSPHRASE=correct-horse")).toBe("GPG_PASSPHRASE=[redacted]");
    expect(redactSecrets("SECRET_KEY_BASE=abcdef0123456789")).toBe("SECRET_KEY_BASE=[redacted]");
    expect(redactSecrets("API_KEY_PROD: abcdef012345")).toBe("API_KEY_PROD: [redacted]");
    expect(redactSecrets("deploy --password hunter2 --verbose")).toBe(
      "deploy --password [redacted] --verbose"
    );
    expect(redactSecrets('deploy --password "correct horse" --verbose')).toBe(
      "deploy --password [redacted] --verbose"
    );
    expect(redactSecrets("deploy --token 'abc def'")).toBe("deploy --token [redacted]");
    expect(redactSecrets('login --client-secret "opaque-value"')).toBe(
      "login --client-secret [redacted]"
    );
    expect(redactSecrets("login --access-token=opaquevalue123 now")).toBe(
      "login --access-token=[redacted] now"
    );
    expect(
      redactSecrets(
        "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----"
      )
    ).toBe("[redacted]");
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(
      "Authorization: Basic [redacted]"
    );
    expect(redactSecrets("Authorization: token abcdef1234567890")).toBe(
      "Authorization: token [redacted]"
    );
  });

  it("reads a name in any style, camelCase and dotted included", () => {
    expect(redactSecrets("secretAccessKey: wJalrXUtnFEMI/K7MDENG")).toBe(
      "secretAccessKey: [redacted]"
    );
    expect(redactSecrets('privateKey = "0xabcdef1234567890"')).toBe("privateKey = [redacted]");
    expect(redactSecrets("accessToken: eyJhbGciOiJIUz")).toBe("accessToken: [redacted]");
    expect(redactSecrets("spring.datasource.password=xyz")).toBe(
      "spring.datasource.password=[redacted]"
    );
    expect(redactSecrets("X-Api-Key: abcdef123456")).toBe("X-Api-Key: [redacted]");
  });

  it("keeps a value whose name is about a secret rather than one, or is no secret's", () => {
    for (const line of [
      "token_count: 123456",
      "API_KEY_FILE=/etc/keys/api",
      "maxTokens: 131072",
      "primaryKey: user_id",
      "foreign_key: users.id",
      "sort_key: created_at",
      "keyDown: ArrowLeft",
      "public_key: ssh-ed25519AAAA",
      "credential: undefined",
      "secretary: Margaret",
      "key: value12345",
      "PWD=/Users/dev/project",
    ]) {
      expect(redactSecrets(line)).toBe(line);
    }
  });

  it("finds a secret inside another assignment's value, and in a name it ends", () => {
    expect(redactSecrets('message="password=hunter22"')).toBe('message="password=[redacted]"');
    expect(redactSecrets("url=https://example.test/?token=abcdef123456")).toBe(
      "url=https://example.test/?token=[redacted]"
    );
    for (const name of [
      "MYPASSWORD",
      "DBPassword",
      "mytoken",
      "_TOKEN",
      `${"A".repeat(90)}_TOKEN`,
    ]) {
      expect(redactSecrets(`${name}=abcdef123456`)).toBe(`${name}=[redacted]`);
    }
    expect(redactSecrets("STRIPE_KEY_LIVE=abcdef123456")).toBe("STRIPE_KEY_LIVE=[redacted]");
    expect(redactSecrets("session_cookie=abcdef123456")).toBe("session_cookie=[redacted]");
  });

  it("takes a quoted value whole, wrapped across lines or longer than a screen", () => {
    expect(redactSecrets('password="first\nsecond" next')).toBe("password=[redacted] next");
    expect(redactSecrets(`password="${"a".repeat(3_000)}"`)).toBe("password=[redacted]");
    expect(redactSecrets('password="correct horse" next')).toBe("password=[redacted] next");
    expect(redactSecrets("password: |\n  hunter22\nnext: value")).toBe(
      "password: [redacted]\nnext: value"
    );
  });

  it("catches the header, flag and key shapes a screen shows them in", () => {
    expect(redactSecrets('{"Authorization":"Basic dXNlcjpwYXNzd29yZA=="}')).toBe(
      '{"Authorization":"Basic [redacted]"}'
    );
    expect(redactSecrets('--password "hunter22')).toBe("--password [redacted]");
    expect(redactSecrets("--passphrase correct-horse")).toBe("--passphrase [redacted]");
    expect(redactSecrets("AWS_ACCESS_KEY_ID=ASIAABCDEFGHIJKLMNOP")).toBe(
      "AWS_ACCESS_KEY_ID=[redacted]"
    );
  });

  it("drops a Decisions claim secret as the deploy CLI prints it and as it is passed", () => {
    const claim = "0a".repeat(32);
    expect(redactSecrets(`  Worker URL    https://relay.example\n  Claim secret  ${claim}`)).toBe(
      "  Worker URL    https://relay.example\n  Claim secret  [redacted]"
    );
    // A secret the person chose may hold spaces; the deploy line is the whole value.
    expect(redactSecrets("  Claim secret  a horse with no name\r\nNext")).toBe(
      "  Claim secret  [redacted]\r\nNext"
    );
    expect(redactSecrets(`CLAIM_SECRET=${claim}`)).toBe("CLAIM_SECRET=[redacted]");
    expect(redactSecrets(`decisions setup --claim-secret ${claim}`)).toBe(
      "decisions setup --claim-secret [redacted]"
    );
  });

  it("drops a recovery passphrase to the end of its line, however it starts", () => {
    expect(redactSecrets("Recovery passphrase: correct horse battery staple\nnext: value")).toBe(
      "Recovery passphrase: [redacted]\nnext: value"
    );
    expect(redactSecrets("RECOVERY_PASSPHRASE=Correct Horse Battery\r\nnext")).toBe(
      "RECOVERY_PASSPHRASE=[redacted]\r\nnext"
    );
    expect(redactSecrets("Recovery passphrase: none shall pass today")).toBe(
      "Recovery passphrase: [redacted]"
    );
    expect(redactSecrets(`passphrase: ghp_${"x".repeat(36)} horse battery staple`)).toBe(
      "passphrase: [redacted]"
    );
    expect(redactSecrets("passphrase: none")).toBe("passphrase: none");
  });

  it.each(["cfat_", "cfut_", "cfk_"])("drops a Cloudflare %s token", (prefix) => {
    expect(redactSecrets(`token ${prefix}${"A".repeat(40)}0123abcd here`)).toBe(
      "token [redacted] here"
    );
  });

  it("keeps a claim secret's file path and the words about it", () => {
    const text = [
      "decisions setup --claim-secret-file /home/me/claim.txt",
      "decisions setup --claim-secret-file=/home/me/claim-secret.txt",
      "the claim secret has been used and is not needed again",
      "See claim secret troubleshooting-guide.md for details",
    ].join("\n");
    expect(redactSecrets(text)).toBe(text);
  });

  it("keeps the line after an empty passphrase prompt beyond its first word", () => {
    const out = redactSecrets("Repeat passphrase:\nSaving key /home/me/.ssh/id_ed25519");
    expect(out).toContain("key /home/me/.ssh/id_ed25519");
  });

  it("drops the rest of a line whose quote never closes, and nothing past it", () => {
    expect(redactSecrets("password: 'unterminated\nI can't stop now")).toBe(
      "password: [redacted]\nI can't stop now"
    );
  });

  it("leaves ordinary output alone", () => {
    const text = [
      "Tests  212 passed (212)",
      "Duration  9.41s",
      "Token usage: total=12,345 input=10,000",
      "max_tokens=131072",
      "input_tokens: 100000",
      '"total_tokens": "123456"',
      "secrets_manager: enabled",
      "↓ 12.3k tokens · esc to interrupt",
    ].join("\n");
    expect(redactSecrets(text)).toBe(text);
  });

  it("stays fast on long runs of the words it looks for", () => {
    for (const run of [
      "secret".repeat(5_000),
      "_key".repeat(8_000),
      "api_key".repeat(4_000),
      "aKeyB".repeat(6_000),
      'password="'.repeat(3_000),
      "secret_key = ".repeat(2_500),
      "a=password=".repeat(3_000),
      `${"A".repeat(30_000)}_TOKEN=abcdef123456`,
      "password: |\n  x\n".repeat(2_000),
    ]) {
      const start = performance.now();
      redactSecrets(run);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });
});
