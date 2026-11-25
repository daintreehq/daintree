// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry, HostMetricsSummary } from "@shared/types/remoteHosts";

const signIns = vi.hoisted(() => ({
  startSignIn: vi.fn(),
  releaseSignIn: vi.fn(async (_consumer: string) => undefined),
  signInShown: vi.fn(async (_consumer: string) => undefined),
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
    signInShown: signIns.signInShown,
    signInStep: vi.fn(async () => null),
    onEvent: vi.fn(() => () => {}),
  },
}));
// The live pane is xterm; what it is pointed at is what matters here.
vi.mock("@/components/Canopy/CanopyTerminal", () => ({
  CanopyTerminal: ({
    runId,
    endedMessage,
    autoFocus,
    onStreamChange,
  }: {
    runId: string;
    endedMessage?: string;
    autoFocus?: boolean;
    onStreamChange?: (state: { watchId: number | null; ended: boolean; secretPrompt: boolean }) => void;
  }) => (
    <div
      data-testid="sign-in-pane"
      data-run-id={runId}
      data-ended-message={endedMessage}
      data-auto-focus={String(autoFocus === true)}
    >
      {/* The stream's own transitions, as the live pane publishes them. */}
      <button
        type="button"
        data-testid="pane-opening"
        onClick={() => onStreamChange?.({ watchId: null, ended: false, secretPrompt: false })}
      />
      <button
        type="button"
        data-testid="pane-live"
        onClick={() => onStreamChange?.({ watchId: 3, ended: false, secretPrompt: false })}
      />
    </div>
  ),
}));
vi.mock("../HostPluginsSection", () => ({ HostPluginsSection: () => null }));
vi.mock("../HostCopySettingsSection", () => ({ HostCopySettingsSection: () => null }));
vi.mock("../HostSettingsSection", () => ({ HostSettingsSection: () => null }));
vi.mock("../HostSessionsSection", () => ({ HostSessionsSection: () => null }));

import { ClientAppError } from "@/utils/clientAppError";
import { HostDetail } from "../HostDetail";

const HANDSHAKE = {
  version: "0.52.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "linux" as const,
  arch: "x64" as const,
};

const SUMMARY: HostMetricsSummary = {
  hostId: "studio-01",
  sampledAt: 1,
  platform: "linux",
  cpuPercent: null,
  memoryPressure: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
  swapUsedBytes: null,
  swapTotalBytes: null,
  thermal: null,
  cpuPressure: null,
  agentsObserved: null,
  projectCount: null,
  worktreeCount: null,
  driver: null,
  agentClis: [
    { agentId: "claude", version: "2.1.0" },
    { agentId: "gemini", version: null },
  ],
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
    summary: SUMMARY,
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

/** Past the task the dialog lets an adopted sign-in go in. */
async function settleRelease() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function offer(overrides: { seq?: number; agentId?: string; consumer?: string } = {}) {
  return {
    seq: overrides.seq ?? 1,
    hostId: "studio-01",
    agentId: overrides.agentId ?? "claude",
    consumer: overrides.consumer ?? "offer-1",
    terminal: { terminalId: "daintree-sign-in-9", spawnedAt: 5 },
    expiresAt: Date.now() + 30_000,
  };
}

beforeEach(async () => {
  // A dialog the last test left lets its adopted sign-in go a task later.
  await new Promise((resolve) => setTimeout(resolve, 0));
  signIns.startSignIn.mockReset();
  signIns.releaseSignIn.mockClear();
  signIns.signInShown.mockClear();
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
    expect(dialog.textContent).toContain(
      "If Claude opens without asking you to sign in, type /login in it."
    );
    expect(screen.getByTestId("sign-in-pane").getAttribute("data-run-id")).toBe(
      "daintree-sign-in-1"
    );
  });

  it("names the CLI itself for one with no sign-in command of its own", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Gemini on studio-01" }));
    await settle();
    expect(signIns.startSignIn.mock.calls[0]![2]).toBe("gemini");
    const text = screen.getByTestId("host-agent-sign-in-dialog").textContent;
    expect(text).toContain("Runs gemini on studio-01.");
    expect(text).toContain("If Gemini opens without asking you to sign in, type /auth in it.");
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

  it("says why a sign-in didn't start, and starts it afresh on Retry", async () => {
    signIns.startSignIn.mockRejectedValueOnce(
      new ClientAppError(
        "HOST_DISCONNECTED",
        "Host studio-01 is not connected",
        "Couldn't reach it."
      )
    );
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude on studio-01" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't reach it.");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(signIns.startSignIn).toHaveBeenCalledTimes(2);
    const [first, second] = signIns.startSignIn.mock.calls.map((call) => call[0]);
    expect(second).not.toBe(first);
    expect(signIns.releaseSignIn).toHaveBeenCalledWith(first);
    expect(screen.getByTestId("sign-in-pane")).toBeTruthy();
  });

  it("offers no Retry to a host too old for sign-ins, only the reason", async () => {
    signIns.startSignIn.mockRejectedValueOnce(
      new ClientAppError(
        "UNSUPPORTED",
        "Host studio-01 has no agent sign-ins",
        "This host needs a newer Daintree to sign in its agents from here."
      )
    );
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude on studio-01" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("needs a newer Daintree");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("hands the pane the keyboard once it opens", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude on studio-01" }));
    await settle();
    expect(screen.getByTestId("sign-in-pane").getAttribute("data-auto-focus")).toBe("true");
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

describe("HostDetail sign-in started by an assistant (#18197)", () => {
  it("opens it as the CLI's row would, on the terminal Main started, starting none", async () => {
    render(<HostDetail entry={entry()} onBack={() => {}} signInOffer={offer()} />);
    await settle();
    const dialog = screen.getByTestId("host-agent-sign-in-dialog");
    expect(dialog.textContent).toContain("Sign in to Claude on studio-01");
    expect(dialog.textContent).toContain("Runs claude auth login on studio-01.");
    expect(screen.getByTestId("sign-in-pane").getAttribute("data-run-id")).toBe(
      "daintree-sign-in-9"
    );
    expect(screen.getByTestId("sign-in-pane").getAttribute("data-auto-focus")).toBe("true");
    expect(signIns.startSignIn).not.toHaveBeenCalled();
  });

  it("tells Main once, when its terminal goes live, and never for the person's own", async () => {
    const { unmount } = render(
      <HostDetail entry={entry()} onBack={() => {}} signInOffer={offer()} />
    );
    await settle();
    fireEvent.click(screen.getByTestId("pane-opening"));
    expect(signIns.signInShown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("pane-live"));
    fireEvent.click(screen.getByTestId("pane-live"));
    expect(signIns.signInShown.mock.calls).toEqual([["offer-1"]]);
    unmount();

    signIns.signInShown.mockClear();
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude on studio-01" }));
    await settle();
    fireEvent.click(screen.getByTestId("pane-live"));
    expect(signIns.signInShown).not.toHaveBeenCalled();
  });

  it("ends it on the host when the dialog closes, and opens each offer once", async () => {
    const first = offer();
    const { rerender } = render(
      <HostDetail entry={entry()} onBack={() => {}} signInOffer={first} />
    );
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await settleRelease();
    expect(signIns.releaseSignIn).toHaveBeenCalledWith("offer-1");
    expect(screen.queryByTestId("host-agent-sign-in-dialog")).toBeNull();

    rerender(<HostDetail entry={entry()} onBack={() => {}} signInOffer={{ ...first }} />);
    await settle();
    expect(screen.queryByTestId("host-agent-sign-in-dialog")).toBeNull();

    rerender(
      <HostDetail
        entry={entry()}
        onBack={() => {}}
        signInOffer={offer({ seq: 2, consumer: "offer-2" })}
      />
    );
    await settle();
    expect(screen.getByTestId("host-agent-sign-in-dialog")).toBeTruthy();
  });

  it("keeps the sign-in through StrictMode's replayed mount", async () => {
    render(
      <StrictMode>
        <HostDetail entry={entry()} onBack={() => {}} signInOffer={offer()} />
      </StrictMode>
    );
    await settle();
    await settleRelease();
    expect(signIns.releaseSignIn).not.toHaveBeenCalled();
    expect(screen.getByTestId("sign-in-pane").getAttribute("data-run-id")).toBe(
      "daintree-sign-in-9"
    );
    expect(signIns.startSignIn).not.toHaveBeenCalled();
  });

  it("leaves alone one for a CLI the host doesn't list, or while a sign-in is open, or a host not connected", async () => {
    const { rerender, unmount } = render(
      <HostDetail entry={entry()} onBack={() => {}} signInOffer={offer({ agentId: "codex" })} />
    );
    await settle();
    expect(screen.queryByTestId("host-agent-sign-in-dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign in to Gemini on studio-01" }));
    await settle();
    rerender(
      <HostDetail entry={entry()} onBack={() => {}} signInOffer={offer({ seq: 2 })} />
    );
    await settle();
    // The person's own sign-in stays, untouched.
    expect(screen.getByTestId("host-agent-sign-in-dialog").textContent).toContain("Gemini");
    expect(signIns.releaseSignIn).not.toHaveBeenCalled();
    unmount();

    render(<HostDetail entry={entry(false)} onBack={() => {}} signInOffer={offer({ seq: 3 })} />);
    await settle();
    expect(screen.queryByTestId("host-agent-sign-in-dialog")).toBeNull();
  });
});
