import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const addPanel = vi.hoisted(() =>
  vi.fn<(options: Record<string, unknown>) => Promise<string | null>>()
);
const notify = vi.hoisted(() => vi.fn());

vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => ({ addPanel }) } }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import {
  DECISIONS_CLI_VERSION,
  freshRelayName,
  openRelayDeployTerminal,
  relayDeployCommand,
} from "../relayDeploy";
import { isScreenNeverSaved } from "@shared/config/terminalScreenPersistence";

// A Worker name and an R2 bucket name both: lowercase letters, digits and hyphens, 3–63 long.
const CLOUDFLARE_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

describe("relay deploy", () => {
  beforeEach(() => {
    addPanel.mockReset();
    notify.mockReset();
  });

  it("runs the CLI release that matches the Decisions libraries this build pins", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const installed = JSON.parse(
      readFileSync(
        path.resolve(process.cwd(), "node_modules/@daintreehq/decisions-protocol/package.json"),
        "utf8"
      )
    ) as { version: string };

    expect(DECISIONS_CLI_VERSION).toBe(pkg.dependencies["@daintreehq/decisions-protocol"]);
    expect(DECISIONS_CLI_VERSION).toBe(installed.version);
  });

  it("names a new Worker and bucket each time, never the CLI's default", () => {
    const names = new Set(Array.from({ length: 50 }, freshRelayName));

    expect(names.size).toBe(50);
    for (const name of names) {
      expect(name).toMatch(CLOUDFLARE_NAME);
      expect(name).not.toBe("daintree-decisions");
    }
  });

  it("runs the pinned deploy under that name, with no token, account or claim of its own", () => {
    const command = relayDeployCommand("daintree-decisions-0a1b2c3d");
    const argv = command.split(" ");

    expect(argv.slice(0, 4)).toEqual([
      "npx",
      "--yes",
      `@daintreehq/decisions-cli@${DECISIONS_CLI_VERSION}`,
      "deploy",
    ]);
    expect(argv[argv.indexOf("--name") + 1]).toBe("daintree-decisions-0a1b2c3d");
    expect(argv[argv.indexOf("--bucket") + 1]).toBe("daintree-decisions-0a1b2c3d");
    expect(argv.filter((arg) => arg.startsWith("-"))).toEqual(["--yes", "--name", "--bucket"]);
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
    const name = String(options.command).split(" ").at(-1)!;
    expect(options.command).toBe(relayDeployCommand(name));
    expect(name).toMatch(CLOUDFLARE_NAME);
  });

  it("starts each deploy in a pane of its own, under a name of its own", async () => {
    addPanel.mockResolvedValue("pane");

    await openRelayDeployTerminal({ cwd: "/home/me", worktreeId: undefined });
    await openRelayDeployTerminal({ cwd: "/home/me", worktreeId: undefined });

    const [first, second] = addPanel.mock.calls.map(([options]) => options);
    expect(first!.requestedId).not.toBe(second!.requestedId);
    expect(first!.command).not.toBe(second!.command);
  });

  it("says the pane didn't open, and tries again when asked", async () => {
    addPanel.mockRejectedValueOnce(new Error("spawn failed")).mockResolvedValueOnce("pane-2");

    await expect(openRelayDeployTerminal({ cwd: "/home/me", worktreeId: "wt-1" })).resolves.toBe(
      null
    );
    expect(notify).toHaveBeenCalledOnce();
    const { action } = notify.mock.calls[0]![0] as { action: { onClick: () => void } };

    action.onClick();
    await vi.waitFor(() => expect(addPanel).toHaveBeenCalledTimes(2));
    expect(addPanel.mock.calls[1]![0]).toMatchObject({ cwd: "/home/me", worktreeId: "wt-1" });
  });

  it("leaves a refusal at the panel limit to the limit's own notice", async () => {
    addPanel.mockResolvedValue(null);

    await expect(
      openRelayDeployTerminal({ cwd: "/home/me", worktreeId: undefined })
    ).resolves.toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });
});
