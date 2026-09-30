import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { AGENT_REGISTRY, type AgentConfig } from "../../../shared/config/agentRegistry";
import type { LaunchMcpInjection } from "../../../shared/config/launchMcp";
import { closeApp, launchApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { fakeAgentEnv } from "../../helpers/fakeAgent";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { recordTempDir } from "../../helpers/tempDirs";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import {
  installLaunchRecorders,
  readRecordedLaunches,
  redactLaunch,
  serversFromLaunch,
  type RecordedLaunch,
} from "../../plugins/helpers/launchRecorder";
import { mcpEndpointStatus } from "../../plugins/helpers/mcpClient";

/**
 * Daintree hands its own MCP server to an agent launch without touching
 * anything the user owns. Every registry agent that declares a `launchMcp`
 * format is launched from the toolbar launcher as a recorder CLI that keeps
 * exactly what it was started with, and for each one: the orchestration
 * endpoint arrives in that agent's own dialect, the bearer is nowhere on the
 * command line, a config file (when the dialect needs one) is private and
 * lives under userData, the bearer answers while the PTY lives and is refused
 * once it is killed, and neither the repository nor the agent's own config dir
 * in HOME gained a byte. Building every dialect exhaustively is
 * `renderLaunchMcp.test.ts`; this proves the seam from launcher to PTY to HTTP.
 */

interface WiredAgent {
  id: string;
  name: string;
  command: string;
  injection: LaunchMcpInjection;
  /** HOME-relative files and dirs the agent itself owns. */
  configRoots: string[];
}

/**
 * Config an agent owns beyond what its auth check probes, so a write there is
 * caught too. Amp keeps its user settings under `~/.config/amp`.
 */
const EXTRA_CONFIG_ROOTS: Record<string, string[]> = { amp: [".config/amp"] };

function configRootsOf(config: AgentConfig): string[] {
  const auth = config.authCheck;
  const paths = [
    ...(auth?.configPathsAll ?? []),
    ...(auth?.configPaths?.[process.platform as "darwin" | "linux" | "win32"] ?? []),
  ];
  const roots = paths
    .map((p) => p.replace(/^~[/\\]/, "").replace(/\\/g, "/"))
    .filter((p) => !path.isAbsolute(p) && !p.includes("%"))
    .map((p) => (p.includes("/") ? path.posix.dirname(p) : p));
  return [...new Set([...roots, ...(EXTRA_CONFIG_ROOTS[config.id] ?? [])])];
}

const WIRED: WiredAgent[] = Object.values(AGENT_REGISTRY)
  .filter((config) => config.capabilities?.launchMcp !== undefined)
  .map((config) => ({
    id: config.id,
    name: config.name,
    command: config.command,
    injection: config.capabilities!.launchMcp!,
    configRoots: configRootsOf(config),
  }));

const FILE_DIALECTS = new Set<LaunchMcpInjection["format"]>([
  "claude-mcp-config",
  "gemini-system-defaults",
  "qwen-mcp-config",
  "copilot-additional-mcp-config",
  "amp-mcp-config",
]);
const PANE_CONFIG_DIR = "mcp-pane-configs";
const DAINTREE_KEY = "daintree";

let ctx: AppContext;
let binDir = "";
let repoDir = "";
let fixtureCleanup: (() => void) | undefined;
let port = 0;
let repoBefore: ReturnType<typeof snapshotRepo> | undefined;
let homeBefore: Record<string, string> = {};

/** Every file and dir under `rels` inside `base`, by mode and content. */
function snapshotTree(
  base: string,
  rels: string[],
  skip = new Set<string>()
): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    if (skip.has(rel)) return;
    const abs = path.join(base, rel);
    if (!existsSync(abs)) {
      out[rel] = "absent";
      return;
    }
    const stat = lstatSync(abs);
    if (stat.isDirectory()) {
      out[rel] = `dir ${stat.mode.toString(8)}`;
      for (const name of readdirSync(abs).sort()) walk(path.join(rel, name));
    } else {
      const hash = createHash("sha256").update(readFileSync(abs)).digest("hex");
      out[rel] = `file ${stat.mode.toString(8)} ${stat.size} ${hash}`;
    }
  };
  for (const rel of rels) walk(rel);
  return out;
}

function snapshotAgentHome(homeDir: string): Record<string, string> {
  return snapshotTree(homeDir, [...new Set(WIRED.flatMap((a) => a.configRoots))].sort());
}

/**
 * Status (tracked, untracked, and every ignored file by name) plus a content
 * hash of the working tree: an overwrite of an existing file changes no status.
 */
function snapshotRepo(): { status: string; tree: Record<string, string> } {
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=traditional"],
    { cwd: repoDir, encoding: "utf8" }
  );
  const top = readdirSync(repoDir).sort();
  return { status, tree: snapshotTree(repoDir, top, new Set([".git"])) };
}

interface ServerEntry {
  type?: string;
  url?: string;
  httpUrl?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
}
type ServerConfig = { mcpServers?: Record<string, ServerEntry> } & Record<string, unknown>;

/** An entry fit for a failure message: its headers hold a live bearer. */
function withoutHeaders(entry: ServerEntry | undefined): Omit<ServerEntry, "headers"> | undefined {
  if (!entry) return entry;
  const { headers: _headers, ...rest } = entry;
  return rest;
}

function bearerOf(entry: ServerEntry | undefined): string {
  const match = /^Bearer (.+)$/.exec(entry?.headers?.Authorization ?? "");
  expect(match, `no bearer header in ${JSON.stringify(Object.keys(entry ?? {}))}`).not.toBeNull();
  return match![1];
}

function readFileArg(
  launch: RecordedLaunch,
  flag: string,
  prefix = ""
): { file: string; config: ServerConfig } {
  const at = launch.argv.indexOf(flag);
  expect(
    at,
    `${flag} missing from ${JSON.stringify(redactLaunch(launch).argv)}`
  ).toBeGreaterThanOrEqual(0);
  const value = launch.argv[at + 1];
  expect(value.startsWith(prefix), `${flag} value should start with "${prefix}"`).toBe(true);
  const file = value.slice(prefix.length);
  expect(launch.files[file], `${flag} names a file that was not there at launch`).toBeDefined();
  return { file, config: JSON.parse(launch.files[file]) as ServerConfig };
}

/**
 * The Daintree server read out of exactly the channel the agent's format
 * declares — not "anywhere in the launch" — so a format that silently fell
 * back to another carrier fails here.
 */
function daintreeFromDialect(
  agent: WiredAgent,
  launch: RecordedLaunch
): { url: string; bearer: string; file: string | null } {
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  const { injection } = agent;
  switch (injection.format) {
    case "claude-mcp-config": {
      const { file, config } = readFileArg(launch, "--mcp-config");
      const entry = config.mcpServers?.[DAINTREE_KEY];
      expect(withoutHeaders(entry)).toMatchObject({
        type: "sse",
        url: `http://127.0.0.1:${port}/sse`,
      });
      return { url: entry!.url!, bearer: bearerOf(entry), file };
    }
    case "qwen-mcp-config": {
      const { file, config } = readFileArg(launch, "--mcp-config");
      const entry = config.mcpServers?.[DAINTREE_KEY];
      expect(withoutHeaders(entry)).toMatchObject({ httpUrl: mcpUrl });
      return { url: entry!.httpUrl!, bearer: bearerOf(entry), file };
    }
    case "amp-mcp-config": {
      const { file, config } = readFileArg(launch, "--mcp-config");
      expect(config.mcpServers, "Amp takes a bare server map").toBeUndefined();
      const entry = config[DAINTREE_KEY] as ServerEntry | undefined;
      expect(withoutHeaders(entry)).toMatchObject({ url: mcpUrl });
      return { url: entry!.url!, bearer: bearerOf(entry), file };
    }
    case "copilot-additional-mcp-config": {
      const { file, config } = readFileArg(launch, "--additional-mcp-config", "@");
      const entry = config.mcpServers?.[DAINTREE_KEY];
      expect(withoutHeaders(entry)).toMatchObject({ type: "http", url: mcpUrl });
      return { url: entry!.url!, bearer: bearerOf(entry), file };
    }
    case "gemini-system-defaults": {
      const file = launch.env[injection.envVar];
      expect(file, `${injection.envVar} not set`).toBeTruthy();
      expect(launch.files[file], `${injection.envVar} names a missing file`).toBeDefined();
      const entry = (JSON.parse(launch.files[file]) as ServerConfig).mcpServers?.[DAINTREE_KEY];
      expect(withoutHeaders(entry)).toMatchObject({ type: "http", url: mcpUrl });
      return { url: entry!.url!, bearer: bearerOf(entry), file };
    }
    case "codex-config-overrides": {
      const overrides = launch.argv.filter((_, i) => launch.argv[i - 1] === "-c");
      expect(overrides).toContain(`mcp_servers.${DAINTREE_KEY}.url=${JSON.stringify(mcpUrl)}`);
      const envLine = overrides.find((o) =>
        o.startsWith(`mcp_servers.${DAINTREE_KEY}.bearer_token_env_var=`)
      );
      expect(envLine, "no bearer_token_env_var override").toBeDefined();
      const envVar = JSON.parse(envLine!.split("=").slice(1).join("=")) as string;
      expect(launch.env[envVar], `${envVar} not in the PTY env`).toBeTruthy();
      return { url: mcpUrl, bearer: launch.env[envVar], file: null };
    }
    case "opencode-config-content": {
      const raw = launch.env[injection.envVar];
      expect(raw, `${injection.envVar} not set`).toBeTruthy();
      const entry = (JSON.parse(raw) as { mcp?: Record<string, ServerEntry> }).mcp?.[DAINTREE_KEY];
      expect(withoutHeaders(entry)).toMatchObject({ type: "remote", url: mcpUrl, enabled: true });
      return { url: entry!.url!, bearer: bearerOf(entry), file: null };
    }
    case "vibe-mcp-servers-env": {
      const list = JSON.parse(launch.env.VIBE_MCP_SERVERS ?? "[]") as Array<{
        name: string;
        url: string;
        auth?: { api_key_env?: string };
      }>;
      const entry = list.find((s) => s.name === DAINTREE_KEY);
      expect(entry).toMatchObject({ transport: "streamable-http", url: mcpUrl });
      const envVar = entry!.auth?.api_key_env ?? "";
      expect(launch.env[envVar], `${envVar} not in the PTY env`).toBeTruthy();
      return { url: entry!.url, bearer: launch.env[envVar], file: null };
    }
  }
}

/** Launch through the toolbar launcher, the way a user picks an agent. */
async function launchFromLauncher(agent: WiredAgent): Promise<RecordedLaunch> {
  const page = ctx.window;
  const before = readRecordedLaunches(binDir, agent.command).length;
  const launcher = page.getByRole("dialog", { name: "Launch" });
  await page.locator(SEL.agent.trayButton).first().click();
  await expect(launcher).toBeVisible({ timeout: T_MEDIUM });
  await page.getByRole("combobox", { name: "Search agents, panels, and recipes" }).fill(agent.name);
  await launcher
    .locator(`[role="option"][data-row-kind="item"][aria-label^="${agent.name},"]`)
    .first()
    .click();
  await expect(launcher).toBeHidden({ timeout: T_MEDIUM });

  let launch: RecordedLaunch | undefined;
  await expect
    .poll(
      () => {
        launch = readRecordedLaunches(binDir, agent.command)[before];
        return launch !== undefined;
      },
      { timeout: T_LONG, message: `${agent.id} recorder never started` }
    )
    .toBe(true);
  expect(launch!.paneId, "launch carried no DAINTREE_PANE_ID").toBeTruthy();
  await expect(page.locator(`[data-panel-id="${launch!.paneId}"]`)).toHaveAttribute(
    "data-launch-agent-id",
    agent.id,
    { timeout: T_MEDIUM }
  );
  return launch!;
}

test.describe.serial("launchMcp: Daintree's server reaches every wired agent", () => {
  test.beforeAll(async () => {
    const fixture = createFixtureRepo({ name: "launch-mcp" });
    repoDir = fixture.dir;
    // Outside the repo, so the repo's status is the product's alone.
    binDir = installLaunchRecorders(
      mkdtempSync(path.join(tmpdir(), "daintree-e2e-launch-mcp-bin-")),
      WIRED.map((agent) => agent.command)
    );
    recordTempDir(path.dirname(binDir));
    fixtureCleanup = fixture.cleanup;

    ctx = await launchApp({ env: fakeAgentEnv(binDir) });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoDir, "Launch MCP");

    await ctx.window.evaluate(() => window.electron.mcpServer.setEnabled(true));
    await expect
      .poll(
        async () => (await ctx.window.evaluate(() => window.electron.mcpServer.getStatus())).port,
        {
          timeout: T_LONG,
        }
      )
      .toBeTruthy();
    port = (await ctx.window.evaluate(() => window.electron.mcpServer.getStatus())).port!;

    await ctx.window.evaluate(async () => {
      const current = await window.electron.project.getCurrent();
      const settings = (await window.electron.project.getSettings(current!.id)) ?? {
        runCommands: [],
      };
      await window.electron.project.saveSettings(current!.id, {
        ...settings,
        daintreeMcpTier: "core",
      });
    });
    await expect
      .poll(() =>
        ctx.window.evaluate(async () => {
          const current = await window.electron.project.getCurrent();
          return (await window.electron.project.getSettings(current!.id))?.daintreeMcpTier;
        })
      )
      .toBe("core");

    repoBefore = snapshotRepo();
    homeBefore = snapshotAgentHome(ctx.homeDir);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.afterEach(async () => {
    const info = test.info();
    if (info.status === info.expectedStatus || !binDir) return;
    await info.attach("launches", {
      body: JSON.stringify(readRecordedLaunches(binDir).map(redactLaunch), null, 2),
    });
  });

  test("the registry's wired agents are the ones this spec launches", () => {
    // Fails loudly if a format is added without a dialect check below.
    expect(WIRED.map((a) => a.injection.format).sort()).toEqual([
      "amp-mcp-config",
      "claude-mcp-config",
      "codex-config-overrides",
      "copilot-additional-mcp-config",
      "gemini-system-defaults",
      "opencode-config-content",
      "qwen-mcp-config",
      "vibe-mcp-servers-env",
    ]);
    for (const agent of WIRED) {
      expect(agent.configRoots.length, `${agent.id} names no config dir to watch`).toBeGreaterThan(
        0
      );
    }
  });

  for (const agent of WIRED) {
    test(`${agent.id} (${agent.injection.format}) gets a private, revocable Daintree endpoint`, async () => {
      const launch = await launchFromLauncher(agent);
      const paneId = launch.paneId!;
      const daintree = daintreeFromDialect(agent, launch);

      // The shared reader agrees with the dialect-specific read: one Daintree
      // server, the same URL and bearer.
      const servers = serversFromLaunch(launch).filter((s) => s.key === DAINTREE_KEY);
      // Booleans, not values: a failure message must never print a live bearer.
      expect(servers.map((s) => s.url)).toEqual([daintree.url]);
      expect(servers[0].bearer === daintree.bearer, "shared reader found another bearer").toBe(
        true
      );

      // A bearer is a secret: never on the command line, where any local user
      // can read it from the process table.
      expect(
        launch.argv.findIndex((arg) => arg.includes(daintree.bearer)),
        "index of the argv element carrying the bearer"
      ).toBe(-1);

      const userData = realpathSync(ctx.userDataDir);
      const paneFile = path.join(userData, PANE_CONFIG_DIR, `${paneId}.json`);
      if (FILE_DIALECTS.has(agent.injection.format)) {
        expect(realpathSync(daintree.file!)).toBe(realpathSync(paneFile));
        if (process.platform === "win32") {
          test.info().annotations.push({
            type: "platform-skip",
            description: "POSIX 0600/0700 modes do not exist on Windows; ACLs are not asserted",
          });
        } else {
          expect((lstatSync(paneFile).mode & 0o777).toString(8)).toBe("600");
          expect((lstatSync(path.dirname(paneFile)).mode & 0o777).toString(8)).toBe("700");
        }
      } else {
        expect(existsSync(paneFile), "a file-less dialect still wrote a pane config").toBe(false);
      }

      expect(await mcpEndpointStatus(daintree.url, daintree.bearer)).toBe(200);

      await ctx.window.evaluate((id) => window.electron.terminal.kill(id), paneId);
      await expect
        .poll(() => existsSync(paneFile), {
          timeout: T_LONG,
          message: "pane config outlived its PTY",
        })
        .toBe(false);
      await expect
        .poll(() => mcpEndpointStatus(daintree.url, daintree.bearer), {
          timeout: T_LONG,
          message: "bearer still accepted after the PTY was killed",
        })
        .toBe(401);
    });
  }

  test("nothing landed in the repository or any agent's own config dir", () => {
    expect(
      readRecordedLaunches(binDir)
        .map((l) => l.agent)
        .sort()
    ).toEqual(WIRED.map((a) => a.command).sort());
    expect(snapshotRepo()).toEqual(repoBefore);
    expect(snapshotAgentHome(ctx.homeDir)).toEqual(homeBefore);
  });
});
