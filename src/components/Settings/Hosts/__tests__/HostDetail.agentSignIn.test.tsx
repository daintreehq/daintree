// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry, HostMetricsSummary } from "@shared/types/remoteHosts";

const signIns = vi.hoisted(() => ({
  startSignIn: vi.fn(),
  releaseSignIn: vi.fn(async () => undefined),
}));

vi.mock("@/clients/remoteHostsClient", () => ({
  remoteHostsClient: {
    update: vi.fn(async (payload: unknown) => payload),
    connect: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    listClipboardGrants: vi.fn(async () => []),
    listPluginViewConsents: vi.fn(async () => []),
    resetClipboardGrants: vi.fn(async () => undefined),
    pluginParity: vi.fn(async () => []),
  },
}));
vi.mock("@/clients/canopyHostClient", () => ({
  canopyHostClient: {
    startSignIn: signIns.startSignIn,
    releaseSignIn: signIns.releaseSignIn,
    signInStep: vi.fn(async () => null),
    onEvent: vi.fn(() => () => {}),
  },
}));
// The live pane is xterm; what it is pointed at is what matters here.
vi.mock("@/components/Canopy/CanopyTerminal", () => ({
  CanopyTerminal: ({ runId, endedMessage }: { runId: string; endedMessage?: string }) => (
    <div data-testid="sign-in-pane" data-run-id={runId} data-ended-message={endedMessage} />
  ),
}));
vi.mock("../HostPluginsSection", () => ({ HostPluginsSection: () => null }));
vi.mock("../HostCopySettingsSection", () => ({ HostCopySettingsSection: () => null }));
vi.mock("../HostSettingsSection", () => ({ HostSettingsSection: () => null }));
vi.mock("../HostSessionsSection", () => ({ HostSessionsSection: () => null }));

import { HostDetail } from "../HostDetail";

const HANDSHAKE = {
  version: "0.52.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "linux" as const,
  arch: "x64" as const,
};

function entry(connected = true): HostListEntry {
  return {
    descriptor: {
      id: "studio-01",
      name: "studio-01",
      connection: { kind: "ssh", target: "greg@studio" },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
      assistantControlEnabled: false,
    },
    connection: connected
      ? { status: "connected", rttMs: 3, handshake: HANDSHAKE }
      : { status: "disconnected" },
    summary: {
      hostId: "studio-01",
      sampledAt: 1,
      platform: "linux",
      agentClis: [
        { agentId: "claude", version: "2.1.0" },
        { agentId: "gemini", version: null },
      ],
    } as unknown as HostMetricsSummary,
  } as HostListEntry;
}

function agentClisText(): string {
  return screen.getByText("Agent CLIs").closest("section")?.textContent ?? "";
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  signIns.startSignIn.mockReset();
  signIns.releaseSignIn.mockClear();
  signIns.startSignIn.mockResolvedValue({ terminalId: "daintree-sign-in-1", spawnedAt: 10 });
});

describe("HostDetail agent CLI sign-in", () => {
  it("offers Sign in on every reported agent CLI of a connected host", () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    expect(screen.getByRole("button", { name: "Sign in to Claude on studio-01" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in to Gemini on studio-01" })).toBeTruthy();
  });

  it("offers none on a host that isn't connected", () => {
    render(<HostDetail entry={entry(false)} onBack={() => {}} />);
    expect(screen.queryAllByRole("button", { name: /^Sign in to / })).toHaveLength(0);
  });

  it("starts that CLI's own sign-in on the named host and shows its terminal", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude on studio-01" }));
    await settle();

    expect(signIns.startSignIn).toHaveBeenCalledTimes(1);
    const [consumer, hostId, agentId] = signIns.startSignIn.mock.calls[0]!;
    expect(hostId).toBe("studio-01");
    expect(agentId).toBe("claude");
    expect(typeof consumer).toBe("string");

    const dialog = screen.getByTestId("host-agent-sign-in-dialog");
    expect(dialog.textContent).toContain("Sign in to Claude on studio-01");
    expect(dialog.textContent).toContain("Runs claude auth login on studio-01.");
    expect(screen.getByTestId("sign-in-pane").getAttribute("data-run-id")).toBe(
      "daintree-sign-in-1"
    );
  });

  it("names the CLI itself for one with no sign-in command of its own", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Gemini on studio-01" }));
    await settle();
    expect(signIns.startSignIn.mock.calls[0]![2]).toBe("gemini");
    expect(screen.getByTestId("host-agent-sign-in-dialog").textContent).toContain(
      "Runs gemini on studio-01."
    );
  });

  it("ends the sign-in on the host when the dialog closes", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude on studio-01" }));
    await settle();
    const consumer = signIns.startSignIn.mock.calls[0]![0];
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await settle();
    expect(signIns.releaseSignIn).toHaveBeenCalledWith(consumer);
    expect(screen.queryByTestId("host-agent-sign-in-dialog")).toBeNull();
  });

  it("puts the sign-in away when the host disconnects, and doesn't reopen it on reconnect", async () => {
    const { rerender } = render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude on studio-01" }));
    await settle();
    const consumer = signIns.startSignIn.mock.calls[0]![0];

    rerender(<HostDetail entry={entry(false)} onBack={() => {}} />);
    await settle();
    expect(screen.queryByTestId("host-agent-sign-in-dialog")).toBeNull();
    expect(signIns.releaseSignIn).toHaveBeenCalledWith(consumer);

    rerender(<HostDetail entry={entry()} onBack={() => {}} />);
    await settle();
    expect(screen.queryByTestId("host-agent-sign-in-dialog")).toBeNull();
    expect(signIns.startSignIn).toHaveBeenCalledTimes(1);
  });

  it("says why a sign-in didn't start, and starts it afresh on Try again", async () => {
    signIns.startSignIn.mockRejectedValueOnce(
      Object.assign(new Error("needs newer"), {
        code: "UNSUPPORTED",
        userMessage: "This host needs a newer Daintree to sign in its agents from here.",
      })
    );
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude on studio-01" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("needs a newer Daintree");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(signIns.startSignIn).toHaveBeenCalledTimes(2);
    const [first, second] = signIns.startSignIn.mock.calls.map((call) => call[0]);
    expect(second).not.toBe(first);
    expect(screen.getByTestId("sign-in-pane")).toBeTruthy();
  });

  it("never shows a signed-in status on the rows, before or after a sign-in", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    const before = agentClisText();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude on studio-01" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await settle();
    expect(agentClisText()).toBe(before);
    expect(before.toLowerCase()).not.toMatch(/signed in|not signed|authenticated/);
  });
});
