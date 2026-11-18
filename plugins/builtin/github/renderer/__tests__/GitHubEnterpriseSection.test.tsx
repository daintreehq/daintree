// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { whenPluginUiReady } from "@daintreehq/plugin-ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitHubEnterpriseSection } from "../components/GitHubEnterpriseSection";
import { ENTERPRISE_CHANNELS } from "../../shared/enterprise.js";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(async () => ({ ok: true, result: undefined })) },
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const invokeMock = vi.fn();

beforeAll(() => whenPluginUiReady(), 30_000);

beforeEach(() => {
  invokeMock.mockReset();
  window.electron = {
    plugin: { invoke: invokeMock },
  } as unknown as typeof window.electron;
});

function serveStatus(hosts: string[]) {
  invokeMock.mockImplementation(async (_pluginId: string, channel: string) => {
    if (channel === ENTERPRISE_CHANNELS.status) {
      const host = hosts.length > 1 ? hosts.shift()! : hosts[0]!;
      return { host, hasToken: false, staleTokenHost: null };
    }
    if (channel === ENTERPRISE_CHANNELS.saveToken) {
      return { valid: false, error: "The Enterprise Server host changed in another window." };
    }
    throw new Error(`unexpected channel ${channel}`);
  });
}

function tokenCalls() {
  return invokeMock.mock.calls.filter(([, channel]) => channel === ENTERPRISE_CHANNELS.saveToken);
}

describe("GitHubEnterpriseSection", () => {
  it("sends a token with the host the form showed", async () => {
    serveStatus(["ghe.one.example"]);
    render(<GitHubEnterpriseSection isGhAvailable={false} onTokenChanged={vi.fn()} />);

    const field = await screen.findByLabelText("Personal access token for ghe.one.example");
    fireEvent.change(field, { target: { value: "ghp_draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Enterprise Server token" }));

    await waitFor(() => expect(tokenCalls()).toHaveLength(1));
    expect(tokenCalls()[0]![2]).toEqual({ token: "ghp_draft", host: "ghe.one.example" });
  });

  it("drops a draft typed for one server once the account points at another", async () => {
    // Another window moved the account from one host to another; the refusal
    // refreshes the form, which now shows the second host.
    serveStatus(["ghe.one.example", "ghe.two.example"]);
    render(<GitHubEnterpriseSection isGhAvailable={false} onTokenChanged={vi.fn()} />);

    const field = await screen.findByLabelText("Personal access token for ghe.one.example");
    fireEvent.change(field, { target: { value: "ghp_meant_for_one" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Enterprise Server token" }));

    const relabelled = await screen.findByLabelText("Personal access token for ghe.two.example");
    expect((relabelled as HTMLInputElement).value).toBe("");
    // Nothing left to send: the first server's token can't follow to the second.
    fireEvent.click(screen.getByRole("button", { name: "Save Enterprise Server token" }));
    expect(tokenCalls()).toHaveLength(1);
  });
});
