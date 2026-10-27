import { describe, expect, it } from "vitest";
import {
  CURSOR_GAP,
  holdsCredential,
  isSecretShaped,
  redactSecretShapedLines,
} from "../voiceKeytermSecrets.js";

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
  "JWT segment": `eyJ${fakeBody(30, 19)}`,
  "unknown-format random token": fakeBody(32, 20),
  "lowercase random token": fakeBody(24, 21, "abcdefghijklmnopqrstuvwxyz0123456789"),
  // Long words, so only its three separate digit runs give it away.
  "digit-studded token": "orange1banana2cherry3",
  // Too short for the generic `sk-` rule, so only `sk-proj-` itself catches it.
  "truncated OpenAI key": "sk-proj-Abcd",
  "truncated GitHub token": "ghp_AbcDefGhi",
};

// Passwords with no shape of their own, given away only by the name or flag
// beside them.
const LEAKY_LINES: [label: string, line: string][] = [
  ["a libpq password variable", "PGPASSWORD=hunter_two_x"],
  ["a concatenated password name", "DBPASSWORD=hunter_two_x"],
  ["a concatenated secret name", "SECRETKEY=my_value_here"],
  ["a PascalCase password", "PGPASSWORD=CorrectHorseBattery"],
  ["an abbreviated password name", "DB_PASS=hunter_two_x"],
  ["a password flag", "mysql -u root --password hunter_two_x"],
  ["a token flag", "deploy --token hunter_two_x --verbose"],
  ["a credential flag in an argv array", `spawn("mysql", ["--password", "hunter_two_x"])`],
];

describe("isSecretShaped", () => {
  it.each(Object.entries(CREDENTIALS))("rejects a %s", (_label, credential) => {
    expect(isSecretShaped(credential)).toBe(true);
  });

  it.each([
    fakeBody(40, 18, HEX),
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

describe("holdsCredential", () => {
  it.each(Object.entries(CREDENTIALS))("finds a %s in a line of output", (_label, credential) => {
    expect(holdsCredential(`  -> using ${credential} for the request`)).toBe(true);
  });

  it.each([
    ["an env assignment", `OPENAI_API_KEY=${CREDENTIALS["OpenAI legacy key"]}`],
    ["a prefix behind an assignment", "value=sk-proj-UserProfileCache"],
    ["a prefix inside a path", "/tmp/sk-proj-UserProfileCache"],
    ["a recognised token with a suffix", `${CREDENTIALS["GitHub classic token"]}-UserProfileCache`],
    ["a quoted assignment", `"password": "correct-horse-battery"`],
    ["a spaced assignment", "client_secret = correct-horse-battery"],
    ["a clone URL", `https://x-access-token:${CREDENTIALS["GitHub classic token"]}@github.com/o/r`],
    ["a bearer header", `Authorization: Bearer ${fakeBody(40, 40)}`],
    [
      // Every piece is too short to judge alone; joined, they're random.
      "an AWS secret split by slashes",
      `${fakeBody(12, 41)}/${fakeBody(10, 42)}+${fakeBody(14, 43)}`,
    ],
    ["a .netrc entry", "machine github.com login alice password MapleRiver7!"],
    ["a padded JSON field", `"password":      "MapleRiver7!"`],
    ["a YAML key whose value is on the next line", "  password:"],
    ["credentials in a database URL", "postgres://alice:MapleRiver7!@localhost/db"],
    ["a basic auth header", "Authorization: Basic Zm9vOmJhcg=="],
    ["a Docker registry auth", `"auths":{"registry.example.com":{"auth":"Zm9vOmJhcg=="}}`],
    // Nothing but the shared scrubber's bearer pattern recognises this one.
    ["a bearer token in prose", "retry with Bearer abcdefghijklmnop"],
    ["a password with a dot in it", "password: MapleRiver7.fooBar"],
    ["a password starting with $", "password: $MapleRiver7"],
    ["a password wrapped in a call", `password = String("MapleRiver7")`],
    ["a base64url body", `${fakeBody(9, 44)}-${fakeBody(7, 45)}_${fakeBody(11, 46)}`],
    ...LEAKY_LINES,
  ])("finds %s", (_label, text) => {
    expect(holdsCredential(text)).toBe(true);
  });

  it.each([
    "src/services/voiceContextKeyterms.ts: extractTerminalIdentifiers passed",
    "from huggingface_hub import hf_hub_download",
    "npm_config_registry=https://registry.npmjs.org/",
    "refreshing the access token in useAuthStore",
    "commit 7c2652f83d4d0fff357e24e02282a679964a112b",
    "const password = getPassword();",
    "MAX_TOKENS=8192 useSessionRouter",
    "Use accessToken: string in useSessionRouter",
    "secret: process.env.SECRET",
    "password: ${DB_PASSWORD}",
    "if (auth === expectedAuth) useSessionRouter();",
    "const run = (token) => useSessionRouter(token);",
    "mysql -u root --password",
    "  -t, --token string   use useSessionRouter",
    "mysql --password $DB_PASSWORD",
    "vitest run --reporter verbose useSessionRouter",
    "a".repeat(1000),
  ])("finds nothing in %s", (line) => {
    expect(holdsCredential(line)).toBe(false);
  });
});

describe("redactSecretShapedLines", () => {
  it("empties a line holding a credential, keeping line positions", () => {
    const key = CREDENTIALS["OpenAI project key"];
    const out = redactSecretShapedLines([
      "before useSessionRouter",
      `export OPENAI_API_KEY=${key} && run useVoiceRecordingStore`,
      "",
      "after useTerminalStore",
    ]);
    expect(out).toHaveLength(4);
    expect(out[1]).toBe("");
    expect(out[0]).toContain("useSessionRouter");
    expect(out[3]).toContain("useTerminalStore");
  });

  it("empties the lines a wrapped key runs onto, up to the first ordinary line", () => {
    const out = redactSecretShapedLines([
      `token: ${CREDENTIALS["GitHub classic token"]}`,
      "AbcDefGhi more of the output",
      "│ JklMnoPqr │",
      "then useTerminalStore ran",
    ]);
    expect(out.slice(0, 3)).toEqual(["", "", ""]);
    expect(out[3]).toBe("then useTerminalStore ran");
  });

  it("doesn't take a line of code for the rest of a wrapped key", () => {
    const out = redactSecretShapedLines([
      `token: ${CREDENTIALS["GitHub classic token"]}`,
      "AbcDefGhi",
      "useSessionRouter();",
    ]);
    expect(out[2]).toBe("useSessionRouter();");
  });

  it("stops treating lines as a wrapped key at a blank line", () => {
    const out = redactSecretShapedLines([
      `token: ${CREDENTIALS["GitHub classic token"]}`,
      "",
      "useTerminalStore",
    ]);
    expect(out[2]).toBe("useTerminalStore");
  });

  it("blanks opaque IDs and bare credential names but keeps the rest of the line", () => {
    const [out] = redactSecretShapedLines([
      "request e29b-41d4-a716-446655440000 set GITHUB_TOKEN via useSessionRouter",
    ]);
    expect(out).not.toContain("a716");
    expect(out).not.toContain("GITHUB_TOKEN");
    expect(out).toContain("useSessionRouter");
  });

  it("blanks a hex key, which reads like a commit SHA", () => {
    const deepgramKey = fakeBody(40, 18, HEX);
    const [out] = redactSecretShapedLines([`DG=${deepgramKey} useSessionRouter`]);
    expect(out).not.toContain(deepgramKey.slice(0, 12));
    expect(out).toContain("useSessionRouter");
  });

  it("blanks a credential name in a path without the rest of the path", () => {
    const [out] = redactSecretShapedLines(["src/voiceKeytermSecrets/useSessionRouter.ts"]);
    expect(out).not.toContain("voiceKeytermSecrets");
    expect(out).toContain("useSessionRouter");
  });

  it("leaves ordinary output alone", () => {
    const line = "src/services/voiceContextKeyterms.ts: extractTerminalIdentifiers passed";
    expect(redactSecretShapedLines([line])).toEqual([line]);
  });

  it.each(LEAKY_LINES)("lets nothing of %s through", (_label, line) => {
    const [out] = redactSecretShapedLines([line]);
    expect(out).toBe("");
  });

  it("keeps an identifier on a line whose flags hold no credential", () => {
    const line = "vitest run --reporter verbose useSessionRouter";
    expect(redactSecretShapedLines([line])).toEqual([line]);
  });

  describe("with cursor gaps", () => {
    const G = CURSOR_GAP;
    // Pieces too short to read as a key alone, as a repaint can leave them.
    const head = fakeBody(10, 30);
    const tail = fakeBody(10, 31);

    it("reads each gap as a space", () => {
      expect(redactSecretShapedLines([`Sonnet${G}5${G}Efficient`])).toEqual(["Sonnet 5 Efficient"]);
    });

    it("empties a line that holds a credential only with its gaps closed", () => {
      expect(redactSecretShapedLines([`key ${head} ${tail} done`])).toEqual([
        `key ${head} ${tail} done`,
      ]);
      expect(
        redactSecretShapedLines([`key ${head}${G}${tail} done`, "", "useTerminalStore"])
      ).toEqual(["", "", "useTerminalStore"]);
    });

    it("continues a wrapped key onto a line that is one run only with its gaps closed", () => {
      const out = redactSecretShapedLines([
        `--password${G}hunter_two_x`,
        "AbcDefGhi",
        `JklMno${G}PqrStu`,
        "",
        "useTerminalStore",
      ]);
      expect(out).toEqual(["", "", "", "", "useTerminalStore"]);
    });

    it("empties a line whose pieces join across gaps into an ID", () => {
      const pieces = fakeBody(16, 18, HEX).match(/.{4}/g)!;
      expect(redactSecretShapedLines([`DG=${pieces.join(" ")} useSessionRouter`], true)).toEqual([
        `DG=${pieces.join(" ")} useSessionRouter`,
      ]);
      expect(redactSecretShapedLines([`DG=${pieces.join(G)} useSessionRouter`], true)).toEqual([
        "",
      ]);
    });

    it("empties a line whose split ID has an intact copy beside it", () => {
      const key = fakeBody(16, 18, HEX);
      const split = `DG=${key.match(/.{4}/g)!.join(G)}`;
      expect(redactSecretShapedLines([`${split} DG=${key}`], true)).toEqual([""]);
      // The intact copy joins the next word across a gap, so only its own run
      // can tell the two apart.
      expect(redactSecretShapedLines([`${split} ${key}${G}Router`], true)).toEqual([""]);
    });

    it("blanks an ID the line shows whole and keeps the rest", () => {
      const [out] = redactSecretShapedLines([`Commit abcdef1234 with${G}useSessionRouter`]);
      expect(out).not.toContain("abcdef1234");
      expect(out).toContain("with useSessionRouter");
    });

    it("keeps a line whose words only join across a gap into a credential name", () => {
      expect(redactSecretShapedLines([`Set the API${G}Key in useSessionRouter`])).toEqual([
        "Set the API Key in useSessionRouter",
      ]);
    });
  });
});
