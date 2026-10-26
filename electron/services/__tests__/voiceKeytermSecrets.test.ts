import { describe, expect, it } from "vitest";
import { isSecretShaped, redactSecretShapedText } from "../voiceKeytermSecrets.js";

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";

// Built at runtime from a fixed seed so no credential-shaped literal sits in
// the source for secret scanners to flag, while the bodies still look random.
function fakeBody(length: number, seed: number, alphabet = BASE62): string {
  let state = seed;
  let out = "";
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    // The low bits of this generator cycle quickly; the high ones don't.
    out += alphabet[Math.floor(state / 65536) % alphabet.length];
  }
  return out;
}

const CREDENTIALS: Record<string, string> = {
  "GitHub classic token": `ghp_${fakeBody(36, 1)}`,
  "GitHub OAuth token": `gho_${fakeBody(36, 2)}`,
  "GitHub fine-grained token": `github_pat_${fakeBody(22, 3)}_${fakeBody(59, 4)}`,
  "OpenAI project key": `sk-proj-${fakeBody(40, 5)}-${fakeBody(20, 6)}_${fakeBody(30, 7)}`,
  "OpenAI legacy key": `sk-${fakeBody(48, 8)}`,
  "Anthropic key": `sk-ant-api03-${fakeBody(93, 9)}AA`,
  "Stripe live key": `sk_live_${fakeBody(24, 10)}`,
  "Slack bot token": `xoxb-${fakeBody(12, 11, "0123456789")}-${fakeBody(24, 12)}`,
  "GitLab token": `glpat-${fakeBody(20, 13)}`,
  "AWS access key id": `AKIA${fakeBody(16, 14, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`,
  "Google API key": `AIza${fakeBody(35, 15)}`,
  "npm token": `npm_${fakeBody(36, 16)}`,
  "Hugging Face token": `hf_${fakeBody(34, 17)}`,
  "Deepgram key": fakeBody(40, 18, HEX),
  "JWT segment": `eyJ${fakeBody(30, 19)}`,
  "unknown-format random token": fakeBody(32, 20),
  "lowercase random token": fakeBody(24, 21, "abcdefghijklmnopqrstuvwxyz0123456789"),
  "truncated OpenAI key": `sk-proj-${fakeBody(14, 22)}`,
};

describe("isSecretShaped", () => {
  it.each(Object.entries(CREDENTIALS))("rejects a %s", (_label, credential) => {
    expect(isSecretShaped(credential)).toBe(true);
  });

  it.each([
    "550e8400-e29b-41d4-a716-446655440000",
    "e29b-41d4-a716-446655440000",
    "7c2652f83d4d0fff357e24e02282a679964a112b",
    "7c2652f83d",
    "build-7c2652f8",
  ])("rejects the opaque ID %s", (id) => {
    expect(isSecretShaped(id)).toBe(true);
  });

  it.each([
    "OPENAI_API_KEY",
    "DEEPGRAM_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
    "STRIPE_KEY",
    "apiKey",
    "clientSecret",
    "accessToken",
    "db-password",
    "ssh_private_key",
  ])("rejects the credential name %s", (name) => {
    expect(isSecretShaped(name)).toBe(true);
  });

  it.each([
    "useVoiceRecordingStore",
    "extractTerminalIdentifiers",
    "getAllTerminalSnapshots",
    "tokenizeBranchName",
    "voice-context-keyterms",
    "snake_case_name",
    "MAX_KEYTERMS",
    "onKeyDown",
    "primaryKey",
    "KeyboardEvent",
    "feature-auth-login",
    "Int32Array",
    "sha256Digest",
    "deadbeef",
    "gpt-live-transcribe",
  ])("keeps the identifier %s", (identifier) => {
    expect(isSecretShaped(identifier)).toBe(false);
  });
});

describe("redactSecretShapedText", () => {
  it("removes a key and its env-var name from an assignment", () => {
    const key = CREDENTIALS["OpenAI project key"];
    const out = redactSecretShapedText(`export OPENAI_API_KEY=${key} && run useVoiceRecordingStore`);
    expect(out).not.toContain("OPENAI_API_KEY");
    expect(out).not.toContain(key.slice(8, 20));
    expect(out).toContain("useVoiceRecordingStore");
  });

  it("leaves no camelCase-looking slice of a key behind", () => {
    // Between its dashes this key holds `AbcDefGhi`, which CAMEL_RE would
    // match on its own if only the whole key were checked.
    const key = `sk-proj-${fakeBody(24, 30)}-AbcDefGhi-${fakeBody(24, 31)}`;
    expect(redactSecretShapedText(`key: ${key}`)).not.toContain("AbcDefGhi");
  });

  it("removes a token embedded in a clone URL", () => {
    const token = CREDENTIALS["GitHub classic token"];
    const out = redactSecretShapedText(
      `git clone https://x-access-token:${token}@github.com/daintreehq/daintree.git`
    );
    expect(out).not.toContain(token);
    expect(out).toContain("daintreehq");
  });

  it("removes a bearer token", () => {
    const token = fakeBody(40, 32);
    expect(redactSecretShapedText(`Authorization: Bearer ${token}`)).not.toContain(token);
  });

  it("removes an AWS secret key whose slashes split it into short pieces", () => {
    const secret = `${fakeBody(12, 33)}/${fakeBody(10, 34)}+${fakeBody(16, 35)}`;
    const out = redactSecretShapedText(`aws_secret_access_key = ${secret}`);
    for (const piece of secret.split(/[/+]/)) expect(out).not.toContain(piece);
  });

  it("leaves ordinary output alone", () => {
    const line = "src/services/voiceContextKeyterms.ts: extractTerminalIdentifiers passed";
    expect(redactSecretShapedText(line)).toBe(line);
  });
});
