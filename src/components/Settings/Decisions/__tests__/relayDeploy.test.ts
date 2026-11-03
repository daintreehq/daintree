import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const addPanel = vi.hoisted(() =>
  vi.fn<(options: Record<string, unknown>) => Promise<string | null>>()
);
const notify = vi.hoisted(() =>
  vi.fn<
    (payload: { message?: string; action?: { onClick: () => void }; context?: unknown }) => void
  >()
);
const windows = vi.hoisted(() => ({ on: false }));
const decisions = vi.hoisted(() => ({
  prepareRelayDeploy: vi.fn<() => Promise<{ id: string; hostChannel: string }>>(),
  cancelRelayDeploy: vi.fn<(id: string) => Promise<void>>(),
}));

vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => ({ addPanel }) } }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/platform", () => ({ isWindows: () => windows.on }));

import {
  DECISIONS_CLI_VERSION,
  freshRelayName,
  openRelayDeployTerminal,
  relayDeployCommand,
} from "../relayDeploy";
import { isScreenNeverSaved } from "@shared/config/terminalScreenPersistence";

// A Worker name and an R2 bucket name both: lowercase letters, digits and hyphens, 3–63 long.
const CLOUDFLARE_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

const CHANNEL = "/tmp/daintree-deploy-AbC123/host.sock";

/** The value a flag takes in a command line. */
function flag(command: string, name: string): string | undefined {
  const argv = command.split(" ");
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

describe("relay deploy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    addPanel.mockReset();
    notify.mockReset();
    windows.on = false;
    let deploys = 0;
    decisions.prepareRelayDeploy.mockReset().mockImplementation(async () => {
      deploys += 1;
      return { id: `deploy-${deploys}`, hostChannel: CHANNEL };
    });
    decisions.cancelRelayDeploy.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("window", { electron: { decisions } });
  });

  it("runs the CLI release that matches the Decisions libraries this build pins", () => {
    const readJson = (file: string): unknown =>
      JSON.parse(readFileSync(path.resolve(process.cwd(), file), "utf8"));

    expect(readJson("package.json")).toMatchObject({
      dependencies: { "@daintreehq/decisions-protocol": DECISIONS_CLI_VERSION },
    });
    expect(readJson("node_modules/@daintreehq/decisions-protocol/package.json")).toMatchObject({
      version: DECISIONS_CLI_VERSION,
    });
  });

  it("names a new Worker and bucket each time, never the CLI's default", () => {
    const names = new Set(Array.from({ length: 50 }, freshRelayName));

    expect(names.size).toBe(50);
    for (const name of names) {
      expect(name).toMatch(CLOUDFLARE_NAME);
      expect(name).not.toBe("daintree-decisions");
    }
  });

  it("runs the pinned deploy under that name against main's channel, with no token, account, claim or key", () => {
    const command = relayDeployCommand("daintree-decisions-0a1b2c3d", false, CHANNEL);

    expect(command.split(" ")).toEqual([
      "npx",
      "--yes",
      `@daintreehq/decisions-cli@${DECISIONS_CLI_VERSION}`,
      "deploy",
      "--name",
      "daintree-decisions-0a1b2c3d",
      "--bucket",
      "daintree-decisions-0a1b2c3d",
      "--host-channel",
      CHANNEL,
    ]);
  });

  it("runs npm's batch shim on Windows, which PowerShell's script policy doesn't block", () => {
    const posix = relayDeployCommand("daintree-decisions-0a1b2c3d", false, CHANNEL);
    const win = relayDeployCommand("daintree-decisions-0a1b2c3d", true, "//./pipe/daintree-x");

    expect(win.split(" ")[0]).toBe("npx.cmd");
    expect(flag(win, "--host-channel")).toBe("//./pipe/daintree-x");
    expect(win.split(" ").slice(1, -1)).toEqual(posix.split(" ").slice(1, -1));
  });

  it("opens a focused, labelled pane whose screen is never saved, running the deploy from home", async () => {
    addPanel.mockResolvedValue("pane-1");

    await expect(openRelayDeployTerminal({ cwd: "/home/me", worktreeId: "wt-1" })).resolves.toBe(
      "pane-1"
    );

    const options = addPanel.mock.calls[0]![0];
    expect(isScreenNeverSaved(String(options.requestedId))).toBe(true);
    expect(options).toMatchObject({
      kind: "terminal",
      title: "Deploy Decisions relay",
      cwd: "/home/me",
      worktreeId: "wt-1",
      location: "grid",
      focusPolicy: "take",
    });
    const name = flag(String(options.command), "--name")!;
    expect(options.command).toBe(relayDeployCommand(name, false, CHANNEL));
    expect(name).toMatch(CLOUDFLARE_NAME);
    expect(options.env).toBeUndefined();
    expect(decisions.prepareRelayDeploy).toHaveBeenCalledOnce();
    expect(decisions.prepareRelayDeploy.mock.invocationCallOrder[0]).toBeLessThan(
      addPanel.mock.invocationCallOrder[0]!
    );
  });

  it("runs the Windows form of the deploy on Windows", async () => {
    windows.on = true;
    addPanel.mockResolvedValue("pane-1");

    await openRelayDeployTerminal({ cwd: "C:\\Users\\me", worktreeId: "wt-1" });

    const command = String(addPanel.mock.calls[0]![0].command);
    expect(command).toBe(relayDeployCommand(flag(command, "--name")!, true, CHANNEL));
  });

  it("starts each deploy in a pane of its own, under a name of its own", async () => {
    addPanel.mockResolvedValue("pane");

    await openRelayDeployTerminal({ cwd: "/home/me", worktreeId: undefined });
    await openRelayDeployTerminal({ cwd: "/home/me", worktreeId: undefined });

    const [first, second] = addPanel.mock.calls.map(([options]) => options);
    expect(first!.requestedId).not.toBe(second!.requestedId);
    expect(first!.command).not.toBe(second!.command);
  });

  it("says the pane didn't open, lets its channel go, and tries again when asked", async () => {
    addPanel.mockRejectedValueOnce(new Error("spawn failed")).mockResolvedValueOnce("pane-2");

    await expect(openRelayDeployTerminal({ cwd: "/home/me", worktreeId: "wt-1" })).resolves.toBe(
      null
    );
    expect(decisions.cancelRelayDeploy).toHaveBeenCalledWith("deploy-1");
    expect(notify).toHaveBeenCalledOnce();
    const { action } = notify.mock.calls[0]![0];

    action!.onClick();
    await vi.waitFor(() => expect(addPanel).toHaveBeenCalledTimes(2));
    expect(addPanel.mock.calls[1]![0]).toMatchObject({ cwd: "/home/me", worktreeId: "wt-1" });
  });

  it("leaves a refusal at the panel limit to the limit's own notice, and lets its channel go", async () => {
    addPanel.mockResolvedValue(null);

    await expect(
      openRelayDeployTerminal({ cwd: "/home/me", worktreeId: undefined })
    ).resolves.toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(decisions.cancelRelayDeploy).toHaveBeenCalledWith("deploy-1");
  });

  it("opens no pane when main can't open the channel, and says why", async () => {
    decisions.prepareRelayDeploy.mockRejectedValueOnce(
      new Error("Run the guided deploy from a local project window")
    );

    await expect(
      openRelayDeployTerminal({ cwd: "/home/me", worktreeId: undefined })
    ).resolves.toBeNull();
    expect(addPanel).not.toHaveBeenCalled();
    expect(decisions.cancelRelayDeploy).not.toHaveBeenCalled();
    expect(notify.mock.calls[0]![0].message).toContain("local project window");
  });
});
