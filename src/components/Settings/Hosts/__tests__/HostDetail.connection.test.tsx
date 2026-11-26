// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnectionState, HostListEntry } from "@shared/types/remoteHosts";
import type { SshSignInEvent, SshSignInResult } from "@shared/types/ipc/remoteHosts";

const client = vi.hoisted(() => ({
  update: vi.fn(async (payload: unknown) => payload),
  connect: vi.fn(async () => undefined),
  connectAndSettle: vi.fn(async (): Promise<HostConnectionState> => ({
    status: "connecting",
    attempt: 1,
  })),
  disconnect: vi.fn(async () => undefined),
  forget: vi.fn(async () => undefined),
  listClipboardGrants: vi.fn(async () => []),
  readSshHostKeys: vi.fn(async () => ({ outcome: { status: "not-connected" }, baselines: [] })),
  listPluginViewConsents: vi.fn(async () => []),
  resetClipboardGrants: vi.fn(async () => undefined),
  startSshSignIn: vi.fn(
    (_payload: { attemptId: string }): Promise<SshSignInResult> => new Promise(() => {})
  ),
  answerSshSignIn: vi.fn(async () => true),
  cancelSshSignIn: vi.fn(async () => true),
  onSshSignInEvent: vi.fn((listener: (event: SshSignInEvent) => void) => {
    signInListeners.add(listener);
    return () => signInListeners.delete(listener);
  }),
}));
const signInListeners = vi.hoisted(() => new Set<(event: SshSignInEvent) => void>());

vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: client }));
vi.mock("../HostPluginsSection", () => ({ HostPluginsSection: () => null }));
vi.mock("../HostCopySettingsSection", () => ({ HostCopySettingsSection: () => null }));
vi.mock("../HostSettingsSection", () => ({ HostSettingsSection: () => null }));
vi.mock("../HostSessionsSection", () => ({ HostSessionsSection: () => null }));

import { HostDetail } from "../HostDetail";
import { HOST_PACKAGES_COMMAND, HOST_PACKAGES_INSTRUCTION } from "@shared/config/linuxHostPackages";

function entry(connection: HostConnectionState): HostListEntry {
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
    connection,
    summary: null,
  };
}

const HANDSHAKE = {
  version: "1",
  commit: "c",
  protocolVersion: 1,
  platform: "linux",
  arch: "x64",
} as const;

beforeEach(() => {
  client.startSshSignIn.mockClear();
  client.cancelSshSignIn.mockClear();
  client.answerSshSignIn.mockClear();
  client.connect.mockClear();
  client.connectAndSettle.mockClear();
  client.disconnect.mockClear();
});

describe("HostDetail on a machine where Daintree starts on connect", () => {
  it("says how it is kept running and what that doesn't cover, and that removing it stops it", async () => {
    const seen = entry({ status: "unreachable", lastSeenAt: null, detail: "timed out" });
    render(
      <HostDetail
        entry={{ ...seen, descriptor: { ...seen.descriptor, startsOnConnect: true } }}
        onBack={() => {}}
      />
    );
    const kept = screen.getByText(/has no systemd for a Host mode service/);
    expect(kept.textContent).toContain(
      "doesn't come back by itself after the machine reboots, stops or is rebuilt"
    );
    expect(kept.textContent).toContain("Connecting from Daintree starts it again.");
    expect(
      screen.getByText("Daintree on studio-01 stops, with its terminals and agents")
    ).toBeTruthy();
  });

  it("says nothing of the kind for a host kept running by a service", () => {
    render(
      <HostDetail
        entry={entry({ status: "unreachable", lastSeenAt: null, detail: "timed out" })}
        onBack={() => {}}
      />
    );
    expect(screen.queryByText(/has no systemd for a Host mode service/)).toBeNull();
    expect(screen.getByText("Projects and Daintree on studio-01 keep running")).toBeTruthy();
  });
});

describe("HostDetail connection controls", () => {
  it("disconnects a connected host with no window on it", async () => {
    render(
      <HostDetail
        entry={entry({ status: "connected", rttMs: 4, handshake: HANDSHAKE })}
        onBack={() => {}}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    });
    expect(client.disconnect).toHaveBeenCalledWith("studio-01");
  });

  it("stops a link that is still retrying", () => {
    render(
      <HostDetail
        entry={entry({ status: "unreachable", lastSeenAt: null, detail: "timed out" })}
        onBack={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers Retry for a link that stopped retrying", async () => {
    render(
      <HostDetail
        entry={entry({
          status: "unreachable",
          lastSeenAt: null,
          detail: "Permission denied (publickey).",
          stoppedRetrying: true,
        })}
        onBack={() => {}}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    // A person's Retry starts over, even with an attempt under way.
    expect(client.connectAndSettle).toHaveBeenCalledWith("studio-01", { restart: true });
  });

  it("signs in to a host that refused the login, relays ssh's prompt, then connects", async () => {
    let finish: (result: SshSignInResult) => void = () => {};
    client.startSshSignIn.mockImplementationOnce(
      () => new Promise<SshSignInResult>((resolve) => (finish = resolve))
    );
    render(
      <HostDetail
        entry={entry({
          status: "unreachable",
          lastSeenAt: null,
          detail: "greg@studio: Permission denied (publickey,keyboard-interactive).",
          stoppedRetrying: true,
        })}
        onBack={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in…" }));
    await waitFor(() => expect(client.startSshSignIn).toHaveBeenCalledTimes(1));
    const { attemptId } = client.startSshSignIn.mock.calls[0]![0] as { attemptId: string };
    expect(client.startSshSignIn).toHaveBeenCalledWith({
      attemptId,
      connection: { kind: "ssh", target: "greg@studio" },
    });
    const send = (event: SshSignInEvent) =>
      act(() => {
        for (const listener of signInListeners) listener(event);
      });
    // Another sign-in's prompt is none of this one's business.
    send({
      type: "prompt",
      attemptId: "someone-else",
      promptId: "x1",
      kind: "secret",
      text: "Password:",
    });
    expect(screen.queryByTestId("ssh-sign-in-prompt")).toBeNull();
    send({
      type: "prompt",
      attemptId,
      promptId: "p1",
      kind: "secret",
      text: "(greg@studio) Verification code:",
    });
    send({ type: "prompt-closed", attemptId, promptId: "x1" });
    expect(screen.getByTestId("ssh-sign-in-prompt").textContent).toBe(
      "(greg@studio) Verification code:"
    );
    fireEvent.change(screen.getByTestId("ssh-sign-in-answer"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(client.answerSshSignIn).toHaveBeenCalledWith({
      attemptId,
      promptId: "p1",
      answer: "123456",
    });
    // Answered, the field goes: nothing typed stays on screen.
    expect(screen.queryByTestId("ssh-sign-in-answer")).toBeNull();
    // Nothing dials until ssh is in.
    expect(client.connectAndSettle).not.toHaveBeenCalled();
    await act(async () => finish({ status: "signed-in" }));
    expect(client.connectAndSettle).toHaveBeenCalledWith("studio-01", { restart: true });
    expect(signInListeners.size).toBe(0);
  });

  it("offers no sign-in for a host key ssh refused", () => {
    render(
      <HostDetail
        entry={entry({
          status: "unreachable",
          lastSeenAt: null,
          detail: "Host key verification failed.",
          stoppedRetrying: true,
        })}
        onBack={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in…" })).toBeNull();
  });

  it("cancels a sign-in still running when the host's page goes", async () => {
    const view = render(
      <HostDetail
        entry={entry({
          status: "unreachable",
          lastSeenAt: null,
          detail: "Permission denied (publickey).",
          stoppedRetrying: true,
        })}
        onBack={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in…" }));
    await waitFor(() => expect(client.startSshSignIn).toHaveBeenCalledTimes(1));
    const { attemptId } = client.startSshSignIn.mock.calls.at(-1)![0] as { attemptId: string };
    expect(signInListeners.size).toBe(1);
    view.unmount();
    expect(client.cancelSshSignIn).toHaveBeenCalledWith(attemptId);
    expect(signInListeners.size).toBe(0);
  });

  it("says a Connect failed when the link reports it unreachable, in ssh's words", async () => {
    client.connectAndSettle.mockResolvedValueOnce({
      status: "unreachable",
      lastSeenAt: null,
      detail: "Permission denied (publickey).",
      stoppedRetrying: true,
    });
    render(<HostDetail entry={entry({ status: "disconnected" })} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't connect: Permission denied (publickey)."
    );
  });

  it("offers a refused start's package install once, whether the status or a Connect says it (#18181)", async () => {
    const words =
      "Daintree can't start on greg@studio: these libraries it needs aren't installed there: libnspr4.so.";
    const refused: HostConnectionState = {
      status: "unreachable",
      lastSeenAt: null,
      detail: `${words} ${HOST_PACKAGES_INSTRUCTION}`,
      stoppedRetrying: true,
    };
    render(<HostDetail entry={entry(refused)} onBack={() => {}} />);
    // Seen without pressing anything: the status alone carries it.
    const status = screen.getByText(/^Unreachable · never seen/);
    expect(status.textContent).toContain(words);
    expect(status.textContent).not.toContain("apt-get");
    const fix = screen.getByTestId("host-root-command");
    expect(fix.textContent).toContain("run this on studio-01 as root");
    expect(fix.querySelector("code")?.textContent).toBe(HOST_PACKAGES_COMMAND);

    client.connectAndSettle.mockResolvedValueOnce(refused);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(`Couldn't connect: ${words}`);
    expect(screen.getAllByTestId("host-root-command")).toHaveLength(1);
  });

  it("offers the package install when only a Connect says it", async () => {
    const words =
      "Daintree can't start on greg@studio: these libraries it needs aren't installed there: libnspr4.so.";
    client.connectAndSettle.mockResolvedValueOnce({
      status: "unreachable",
      lastSeenAt: null,
      detail: `${words} ${HOST_PACKAGES_INSTRUCTION}`,
      stoppedRetrying: true,
    });
    render(<HostDetail entry={entry({ status: "disconnected" })} onBack={() => {}} />);
    expect(screen.queryByTestId("host-root-command")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(`Couldn't connect: ${words}`);
    expect(screen.getByTestId("host-root-command").querySelector("code")?.textContent).toBe(
      HOST_PACKAGES_COMMAND
    );
  });

  it("drops what a Connect said once the host points at another machine", async () => {
    const words =
      "Daintree can't start on greg@studio: these libraries it needs aren't installed there: libnspr4.so.";
    client.connectAndSettle.mockResolvedValueOnce({
      status: "unreachable",
      lastSeenAt: null,
      detail: `${words} ${HOST_PACKAGES_INSTRUCTION}`,
      stoppedRetrying: true,
    });
    const before = entry({ status: "disconnected" });
    const view = render(<HostDetail entry={before} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
    expect(screen.getByTestId("host-root-command")).toBeTruthy();
    // Change target… keeps the record and its id; only the machine it reaches changes.
    view.rerender(
      <HostDetail
        entry={{
          ...before,
          descriptor: { ...before.descriptor, connection: { kind: "ssh", target: "greg@build" } },
        }}
        onBack={() => {}}
      />
    );
    expect(screen.queryByTestId("host-root-command")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leaves Host mode off to its own row rather than calling it a failed connect", async () => {
    client.connectAndSettle.mockResolvedValueOnce({
      status: "unreachable",
      lastSeenAt: null,
      detail: null,
      hostModeOff: true,
      stoppedRetrying: true,
    });
    render(<HostDetail entry={entry({ status: "disconnected" })} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps Retry beside Set up when Host mode is off there", () => {
    render(
      <HostDetail
        entry={entry({
          status: "unreachable",
          lastSeenAt: null,
          detail: null,
          hostModeOff: true,
          stoppedRetrying: true,
        })}
        onBack={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Set up…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("offers Connect for a host nothing has dialled", () => {
    render(<HostDetail entry={entry({ status: "disconnected" })} onBack={() => {}} />);
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });
});
