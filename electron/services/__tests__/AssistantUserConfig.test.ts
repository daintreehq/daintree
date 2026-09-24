import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { getProjectAssistantContentDir } from "../AssistantContentMirror.js";
import { parse as parseToml } from "smol-toml";
import {
  loadAssistantUserConfig,
  readCodexNativeServerNames,
  toCodexMcpServerArgs,
  toJsonMcpServerEntry,
  tomlString,
} from "../AssistantUserConfig.js";

let tmpDir: string;
let projectPath: string;
let projectDir: string;
let globalDir: string;

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

function load(loadGlobalHooksAndServers = true, agentId = "claude") {
  return loadAssistantUserConfig({
    projectPath,
    agentId,
    loadGlobalHooksAndServers,
    globalContentDir: globalDir,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-user-config-"));
  projectPath = path.join(tmpDir, "project");
  projectDir = getProjectAssistantContentDir(projectPath);
  globalDir = path.join(tmpDir, "global-assistant");
  await fs.mkdir(projectPath, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("instructions", () => {
  it("returns nothing when neither folder has instructions", async () => {
    const config = await load();
    expect(config).toEqual({ instructions: [], mcpServers: {}, claudeHooks: null, warnings: [] });
  });

  it("reads global then project instructions, trimmed, skipping blank files", async () => {
    await write(globalDir, "instructions.md", "\n  Global rule.\n\n");
    await write(projectDir, "instructions.md", "Project rule.");

    const config = await load(false);

    expect(config.instructions).toEqual([
      {
        scope: "global",
        displayPath: "~/.daintree/assistant/instructions.md",
        content: "Global rule.",
      },
      {
        scope: "project",
        displayPath: ".daintree/assistant/instructions.md",
        content: "Project rule.",
      },
    ]);

    await write(globalDir, "instructions.md", "   \n");
    expect((await load(false)).instructions.map((entry) => entry.scope)).toEqual(["project"]);
  });

  it("refuses an oversized instructions file rather than truncating it", async () => {
    await write(globalDir, "instructions.md", "x".repeat(64 * 1024 + 1));
    await expect(load()).rejects.toThrow(/limit/);
  });

  it("refuses a project instructions.md that links outside the project", async () => {
    // Otherwise a repository could inline a file like ~/.ssh/id_rsa into the
    // prompt that goes to the model provider.
    const secret = path.join(tmpDir, "secret.txt");
    await fs.writeFile(secret, "hunter2", "utf-8");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.symlink(secret, path.join(projectDir, "instructions.md"));

    await expect(load()).rejects.toThrow(/outside the project/);
  });

  it("allows a project instructions.md that links elsewhere inside the project", async () => {
    await write(projectPath, "docs/assistant.md", "Shared doc.");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.symlink(
      path.join(projectPath, "docs", "assistant.md"),
      path.join(projectDir, "instructions.md")
    );

    expect((await load()).instructions[0]?.content).toBe("Shared doc.");
  });
});

describe("file decoding", () => {
  it("accepts a UTF-8 BOM in the JSON files", async () => {
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(
      path.join(globalDir, "mcp.json"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(JSON.stringify({ mcpServers: { ok: { command: "node" } } })),
      ])
    );

    expect(Object.keys((await load()).mcpServers)).toEqual(["ok"]);
  });

  it("refuses invalid UTF-8 rather than replacing the bytes", async () => {
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(
      path.join(globalDir, "hooks.json"),
      Buffer.concat([Buffer.from('{"hooks":{"x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}}')])
    );

    await expect(load()).rejects.toThrow(/valid UTF-8/);
  });
});

describe("MCP servers and hooks", () => {
  const mcpJson = JSON.stringify({
    mcpServers: {
      linear: { command: "npx", args: ["-y", "linear-mcp"], env: { LINEAR_TOKEN: "t" } },
      docs: { type: "http", url: "https://example.com/mcp", headers: { "X-Key": "k" } },
    },
  });
  const hooksJson = JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] },
  });

  it("ignores the global files while the opt-in is off", async () => {
    await write(globalDir, "mcp.json", mcpJson);
    await write(globalDir, "hooks.json", hooksJson);

    const config = await load(false);

    expect(config.mcpServers).toEqual({});
    expect(config.claudeHooks).toBeNull();
  });

  it("loads them from the global folder once opted in", async () => {
    await write(globalDir, "mcp.json", mcpJson);
    await write(globalDir, "hooks.json", hooksJson);

    const config = await load(true);

    expect(config.mcpServers).toEqual({
      linear: {
        type: "stdio",
        command: "npx",
        args: ["-y", "linear-mcp"],
        env: { LINEAR_TOKEN: "t" },
      },
      docs: { type: "http", url: "https://example.com/mcp", headers: { "X-Key": "k" } },
    });
    expect(config.claudeHooks).toEqual(JSON.parse(hooksJson).hooks);
  });

  it("never loads them from a project folder, and says so", async () => {
    await write(projectDir, "mcp.json", mcpJson);
    await write(projectDir, "hooks.json", hooksJson);

    const config = await load(true);

    expect(config.mcpServers).toEqual({});
    expect(config.claudeHooks).toBeNull();
    expect(config.warnings).toHaveLength(2);
    expect(config.warnings[0]).toContain("only from ~/.daintree/assistant");
  });

  it("drops reserved, badly named and malformed servers but keeps the rest", async () => {
    await write(
      globalDir,
      "mcp.json",
      JSON.stringify({
        mcpServers: {
          daintree: { command: "evil" },
          "Daintree-Docs": { type: "http", url: "https://evil.example" },
          "bad name": { command: "x" },
          noCommand: { args: [] },
          badUrl: { type: "http", url: "file:///etc/passwd" },
          badEnv: { command: "x", env: { "A=B": "c" } },
          ok: { command: "node", args: ["server.js"] },
        },
      })
    );

    const config = await load();

    expect(Object.keys(config.mcpServers)).toEqual(["ok"]);
    expect(config.warnings).toHaveLength(6);
  });

  it("rejects unusable URLs, header line breaks and prototype names from literal JSON", async () => {
    // Written as raw JSON text: an object literal with `__proto__` would set a
    // prototype in the fixture itself and hide the case.
    await write(
      globalDir,
      "mcp.json",
      String.raw`{"mcpServers":{
        "__proto__":{"command":"x"},
        "hostless":{"type":"http","url":"https://"},
        "crlf":{"type":"http","url":"https://ok.example","headers":{"X-A":"a\r\nX-B: b"}},
        "protoEnv":{"command":"x","env":{"__proto__":"y"}},
        "ok":{"type":"http","url":"https://ok.example"}
      }}`
    );

    const config = await load();

    expect(Object.keys(config.mcpServers)).toEqual(["ok"]);
    expect(config.warnings).toHaveLength(4);
  });

  it("keeps newlines in env values, where they can be legitimate", async () => {
    await write(
      globalDir,
      "mcp.json",
      JSON.stringify({ mcpServers: { pem: { command: "x", env: { KEY: "a\nb" } } } })
    );

    expect((await load()).mcpServers.pem).toMatchObject({ env: { KEY: "a\nb" } });
  });

  it("doesn't read hooks.json for agents that never load hooks", async () => {
    await write(globalDir, "hooks.json", "{ broken");

    const config = await load(true, "codex");

    expect(config.claudeHooks).toBeNull();
    expect(config.warnings[0]).toContain("codex sessions don't load it");
  });

  it("warns and adds nothing when mcp.json isn't valid JSON", async () => {
    await write(globalDir, "mcp.json", "{ nope");

    const config = await load();

    expect(config.mcpServers).toEqual({});
    expect(config.warnings[0]).toContain("not valid JSON");
  });

  it("fails closed when an opted-in hooks.json can't be parsed", async () => {
    // A hook may be a guard; launching without it would silently drop it.
    await write(globalDir, "hooks.json", "{ nope");
    await expect(load()).rejects.toThrow(/not valid JSON/);

    await write(globalDir, "hooks.json", JSON.stringify({ hooks: { PreToolUse: "guard.sh" } }));
    await expect(load()).rejects.toThrow(/must be an array/);
  });

  it.each([
    [
      "an array matcher",
      [{ matcher: ["Bash"], hooks: [{ type: "command", command: "g" }] }],
      /matcher must be a string/,
    ],
    ["an empty hook list", [{ matcher: "Bash", hooks: [] }], /non-empty array/],
    ["a hook without a type", [{ hooks: [{ command: "g" }] }], /string "type"/],
    ["an unknown hook type", [{ hooks: [{ type: "shell", command: "g" }] }], /isn't one of/],
    ["a prompt hook without a prompt", [{ hooks: [{ type: "prompt" }] }], /string "prompt"/],
    ["an agent hook without a prompt", [{ hooks: [{ type: "agent" }] }], /string "prompt"/],
    ["an http hook with a bad url", [{ hooks: [{ type: "http", url: "nope" }] }], /http\(s\) URL/],
    [
      "http headers that aren't a string map",
      [{ hooks: [{ type: "http", url: "https://h.example", headers: [] }] }],
      /headers must be an object of strings/,
    ],
    [
      "allowedEnvVars that isn't an array",
      [{ hooks: [{ type: "http", url: "https://h.example", allowedEnvVars: "TOKEN" }] }],
      /allowedEnvVars must be an array/,
    ],
    [
      "a non-boolean async",
      [{ hooks: [{ type: "command", command: "g", async: "yes" }] }],
      /async must be a boolean/,
    ],
    ["a command hook without a command", [{ hooks: [{ type: "command" }] }], /string "command"/],
    [
      "a non-numeric timeout",
      [{ hooks: [{ type: "command", command: "g", timeout: "5" }] }],
      /timeout must be a positive number/,
    ],
  ])(
    "fails closed on %s, which Claude would reject with the whole settings file",
    async (_label, groups, message) => {
      await write(globalDir, "hooks.json", JSON.stringify({ hooks: { PreToolUse: groups } }));
      await expect(load()).rejects.toThrow(message);
    }
  );
});

describe("hook numbers", () => {
  it("rejects a timeout JSON can only represent as Infinity", async () => {
    await write(
      globalDir,
      "hooks.json",
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"g","timeout":1e400}]}]}}'
    );
    await expect(load()).rejects.toThrow(/positive number/);
  });

  it("accepts every supported handler type", async () => {
    const hooks = {
      Stop: [
        {
          hooks: [
            { type: "command", command: "g", timeout: 5, async: true },
            { type: "prompt", prompt: "check" },
            { type: "agent", prompt: "verify" },
            { type: "http", url: "https://hooks.example/stop" },
          ],
        },
      ],
    };
    await write(globalDir, "hooks.json", JSON.stringify({ hooks }));

    expect((await load()).claudeHooks).toEqual(hooks);
  });
});

describe("tomlString", () => {
  it.each([
    ["plain", "npx"],
    ["quotes and backslashes", 'a"b\\c'],
    ["CRLF and tab", "a\r\n\tb"],
    ["DEL and NUL", "a\u007fb\u0000c"],
    ["non-ASCII", "café — 日本"],
    ["astral", "emoji 🎉"],
  ])("round-trips %s through a TOML parser", (_label, value) => {
    expect(parseToml(`v = ${tomlString(value)}`).v).toBe(value);
  });

  it("drops servers whose strings hold a lone surrogate", async () => {
    await write(
      globalDir,
      "mcp.json",
      '{"mcpServers":{"bad":{"command":"x","args":["\\ud800"]},"ok":{"command":"y"}}}'
    );
    expect(Object.keys((await load()).mcpServers)).toEqual(["ok"]);
  });
});

describe("readCodexNativeServerNames", () => {
  it("lists configured servers, treats a missing file as none, and an unparseable one as unknown", async () => {
    const home = path.join(tmpDir, "codex-home");
    expect(await readCodexNativeServerNames(home)).toEqual(new Set());

    await write(home, "config.toml", '[mcp_servers.assistant-foo]\nurl = "https://x"\n');
    expect(await readCodexNativeServerNames(home)).toEqual(new Set(["assistant-foo"]));

    await write(home, "config.toml", "not = [valid");
    expect(await readCodexNativeServerNames(home)).toBeNull();
  });
});

describe("toJsonMcpServerEntry", () => {
  it("emits the Claude/Copilot mcpServers shape", () => {
    expect(
      toJsonMcpServerEntry({ type: "stdio", command: "node", args: ["s.js"], env: {}, cwd: "/w" })
    ).toEqual({ type: "stdio", command: "node", args: ["s.js"], env: {}, cwd: "/w" });
    expect(toJsonMcpServerEntry({ type: "sse", url: "https://x/sse", headers: {} })).toEqual({
      type: "sse",
      url: "https://x/sse",
      headers: {},
    });
  });
});

describe("toCodexMcpServerArgs", () => {
  it("encodes stdio and http servers as TOML -c overrides", () => {
    const warnings: string[] = [];
    const args = toCodexMcpServerArgs(
      {
        linear: {
          type: "stdio",
          command: "npx",
          args: ["-y", 'quote"d'],
          env: { TOKEN: "a\nb" },
          cwd: "/work",
        },
        docs: { type: "http", url: "https://example.com/mcp", headers: { "X-Key": "k" } },
      },
      warnings
    );

    expect(args).toEqual([
      "-c",
      'mcp_servers.assistant-linear.command="npx"',
      "-c",
      'mcp_servers.assistant-linear.args=["-y","quote\\"d"]',
      "-c",
      'mcp_servers.assistant-linear.env={"TOKEN"="a\\nb"}',
      "-c",
      'mcp_servers.assistant-linear.cwd="/work"',
      "-c",
      'mcp_servers.assistant-docs.url="https://example.com/mcp"',
      "-c",
      'mcp_servers.assistant-docs.http_headers={"X-Key"="k"}',
    ]);
    expect(warnings).toEqual([]);
  });

  it("writes empty args, env and headers so a same-named native server lends nothing", () => {
    expect(
      toCodexMcpServerArgs(
        {
          bare: { type: "stdio", command: "srv", args: [], env: {} },
          web: { type: "http", url: "https://x/mcp", headers: {} },
        },
        []
      )
    ).toEqual([
      "-c",
      'mcp_servers.assistant-bare.command="srv"',
      "-c",
      "mcp_servers.assistant-bare.args=[]",
      "-c",
      "mcp_servers.assistant-bare.env={}",
      "-c",
      'mcp_servers.assistant-web.url="https://x/mcp"',
      "-c",
      "mcp_servers.assistant-web.http_headers={}",
    ]);
  });

  it("skips a server whose prefixed name is already in the user's Codex config", () => {
    const warnings: string[] = [];
    const args = toCodexMcpServerArgs(
      {
        foo: { type: "http", url: "https://new.example", headers: {} },
        bar: { type: "http", url: "https://bar.example", headers: {} },
      },
      warnings,
      new Set(["assistant-foo"])
    );

    expect(args.some((arg) => arg.includes("assistant-foo"))).toBe(false);
    expect(args.some((arg) => arg.includes("assistant-bar"))).toBe(true);
    expect(warnings[0]).toContain("clashes");
  });

  it("adds no user servers when the Codex config can't be read", () => {
    const warnings: string[] = [];
    expect(
      toCodexMcpServerArgs(
        { foo: { type: "http", url: "https://x.example", headers: {} } },
        warnings,
        null
      )
    ).toEqual([]);
    expect(warnings[0]).toContain("config.toml");
  });

  it("weights characters that grow when the launch line is quoted", () => {
    const warnings: string[] = [];
    // 3,500 apostrophes weigh as 7,000 units, past the budget, although the
    // raw argument is well under it.
    const quoted = { type: "stdio" as const, command: "x", args: ["'".repeat(3500)], env: {} };
    expect(toCodexMcpServerArgs({ quoted }, warnings)).toEqual([]);
    expect(warnings[0]).toContain("too long");
  });

  it("skips servers once the launch-line budget is spent", () => {
    const warnings: string[] = [];
    const big = { type: "stdio" as const, command: "x", args: ["y".repeat(5000)], env: {} };
    const args = toCodexMcpServerArgs({ first: big, second: big }, warnings);

    expect(args.some((arg) => arg.startsWith("mcp_servers.assistant-first."))).toBe(true);
    expect(args.some((arg) => arg.startsWith("mcp_servers.assistant-second."))).toBe(false);
    expect(warnings[0]).toContain("too long");
  });

  it("skips SSE servers, which Codex can't use", () => {
    const warnings: string[] = [];
    expect(
      toCodexMcpServerArgs({ old: { type: "sse", url: "https://x/sse", headers: {} } }, warnings)
    ).toEqual([]);
    expect(warnings[0]).toContain("SSE");
  });
});
