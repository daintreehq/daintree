// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentInstallBlock, AgentInstallOS } from "@shared/config/agentRegistry";
import type {
  AgentInstallProgressEvent,
  AgentInstallResult,
  CliAvailability,
} from "@shared/types/ipc/system";

const blocks = vi.hoisted(() => ({ current: [] as AgentInstallBlock[] }));
const installOS = vi.hoisted(() => ({ current: "linux" as AgentInstallOS }));

vi.mock("@/clients", () => ({
  systemClient: { openExternal: vi.fn(() => Promise.resolve()) },
}));

// jsdom reports no platform, so the test names the OS and the methods it offers.
vi.mock("@/lib/agentInstall", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agentInstall")>()),
  detectOS: () => installOS.current,
  getInstallBlocksForCurrentOS: () => blocks.current,
}));

vi.mock("@/store", () => ({
  useAgentSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ updateAgent: vi.fn(), settings: { agents: {} } }),
}));

import { AgentCliStep } from "../AgentCliStep";
import { NPM_USER_PREFIX_COMMAND } from "@/lib/agentInstall";

const NPM: AgentInstallBlock = { label: "npm", commands: ["npm install -g agent"] };
const CURL: AgentInstallBlock = {
  label: "curl",
  commands: ["curl -fsSL https://example.com/install.sh | bash"],
};

// npm 10.9's report lines, as captured against unwritable folders.
const PREFIX_REPORT = [
  "npm error code EACCES",
  "npm error syscall mkdir",
  "npm error path /usr/lib/node_modules/agent",
  "npm error errno -13",
  "npm error Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/agent'",
].join("\n");
const CACHE_FIX = 'sudo chown -R 501:20 "/Users/me/.npm"';
const CACHE_REPORT = [
  "npm error code EACCES",
  "npm error syscall mkdir",
  "npm error path /Users/me/.npm/_cacache",
  "npm error errno EACCES",
  "npm error",
  "npm error Your cache folder contains root-owned files, due to a bug in",
  "npm error previous versions of npm which has since been addressed.",
  "npm error",
  "npm error To permanently fix this problem, please run:",
  `npm error   ${CACHE_FIX}`,
].join("\n");

function render(ui: ReactElement) {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
}

let originalBridge: PropertyDescriptor | undefined;

/** The install fails after npm writes `stderr`, as main streams it. */
function failInstallWith(stderr: string) {
  let listener: ((event: AgentInstallProgressEvent) => void) | null = null;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      system: {
        onAgentInstallProgress: vi.fn((cb: (event: AgentInstallProgressEvent) => void) => {
          listener = cb;
          return () => {
            listener = null;
          };
        }),
        installAgent: vi.fn(async (payload: { jobId: string }): Promise<AgentInstallResult> => {
          listener?.({ jobId: payload.jobId, chunk: stderr, stream: "stderr" });
          return {
            success: false,
            exitCode: 243,
            error: "Command failed with exit code 243: npm install -g agent",
          };
        }),
      },
    },
  });
}

async function installAndFail() {
  const availability: CliAvailability = { claude: "missing" };
  render(<AgentCliStep availability={availability} selections={{ claude: true }} />);
  await act(async () => {
    fireEvent.click(screen.getByTestId("agent-cli-install-primary"));
  });
}

describe("npm refusing a global install", () => {
  beforeEach(() => {
    originalBridge = Object.getOwnPropertyDescriptor(window, "electron");
    blocks.current = [NPM, CURL];
    installOS.current = "linux";
  });

  afterEach(() => {
    if (originalBridge) Object.defineProperty(window, "electron", originalBridge);
    else Reflect.deleteProperty(window, "electron");
  });

  it("names the folder npm couldn't write and offers its user-prefix fix", async () => {
    failInstallWith(PREFIX_REPORT);
    await installAndFail();

    const callout = await screen.findByTestId("npm-permission-claude");
    expect(callout.dataset.npmFailure).toBe("global-folder");
    expect(callout.textContent).toContain("/usr/lib/node_modules");
    expect(callout.textContent).toContain(NPM_USER_PREFIX_COMMAND);
  });

  it("gives a cache failure npm's chown, not a new prefix", async () => {
    installOS.current = "macos";
    failInstallWith(CACHE_REPORT);
    await installAndFail();

    const callout = await screen.findByTestId("npm-permission-claude");
    expect(callout.dataset.npmFailure).toBe("cache");
    expect(callout.textContent).toContain(CACHE_FIX);
    expect(callout.textContent).not.toContain(NPM_USER_PREFIX_COMMAND);
  });

  it("leaves Windows with the plain failure", async () => {
    installOS.current = "windows";
    failInstallWith(PREFIX_REPORT.replaceAll("EACCES", "EPERM"));
    await installAndFail();

    await screen.findByText("Or install manually:");
    expect(screen.queryByTestId("npm-permission-claude")).toBeNull();
  });

  it("points at the method that skips npm when the agent has one", async () => {
    failInstallWith(PREFIX_REPORT);
    await installAndFail();

    const callout = await screen.findByTestId("npm-permission-claude");
    expect(callout.textContent).toContain("Or install with curl");
  });

  it("names no alternative when npm is the only method", async () => {
    blocks.current = [NPM];
    failInstallWith(PREFIX_REPORT);
    await installAndFail();

    const callout = await screen.findByTestId("npm-permission-claude");
    expect(callout.textContent).not.toContain("Or install with");
  });

  it("drops the manual npm line, which would hit the same folder", async () => {
    failInstallWith(PREFIX_REPORT);
    await installAndFail();

    await screen.findByTestId("npm-permission-claude");
    expect(screen.queryByText("Or install manually:")).toBeNull();
  });

  it("keeps the plain failure for anything else npm reports", async () => {
    failInstallWith("npm error code E404\nnpm error 404 Not Found - GET agent\n");
    await installAndFail();

    await screen.findByText("Or install manually:");
    expect(screen.queryByTestId("npm-permission-claude")).toBeNull();
  });
});
