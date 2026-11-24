// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostConnectionState,
  HostListEntry,
  PendingHostPlacement,
} from "@shared/types/remoteHosts";

const client = vi.hoisted(() => ({
  update: vi.fn(async (payload: unknown) => payload),
  connect: vi.fn(async () => undefined),
  connectAndSettle: vi.fn(async (): Promise<HostConnectionState> => ({ status: "disconnected" })),
  disconnect: vi.fn(async () => undefined),
  forget: vi.fn(async () => undefined),
  listClipboardGrants: vi.fn(async () => []),
  listPluginViewConsents: vi.fn(async () => []),
  resetClipboardGrants: vi.fn(async () => undefined),
}));

vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: client }));
vi.mock("../HostPluginsSection", () => ({ HostPluginsSection: () => null }));
vi.mock("../HostCopySettingsSection", () => ({ HostCopySettingsSection: () => null }));
vi.mock("../HostSettingsSection", () => ({ HostSettingsSection: () => null }));
vi.mock("../HostSessionsSection", () => ({ HostSessionsSection: () => null }));
vi.mock("../AddHostDialog", () => ({
  AddHostDialog: ({ existing }: { existing: { name: string; intent?: string } }) => (
    <div role="dialog">
      {existing.intent === "setup" ? "Set up" : "Update"} {existing.name}
    </div>
  ),
}));

import { HostDetail } from "../HostDetail";
import { NOT_OPENED } from "@/components/Hosts/pendingPlacement";

const PLACEMENT: PendingHostPlacement = {
  projectId: "proj-1",
  worktreeId: "/repo/wt/feature-x",
  worktreePath: "/repo/wt/feature-x",
  label: "feature-x",
  requestedAt: 1,
};

function entry(pendingPlacement?: PendingHostPlacement): HostListEntry {
  return {
    descriptor: {
      id: "box",
      name: "box",
      connection: { kind: "ssh", target: "box" },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
      assistantControlEnabled: false,
      ...(pendingPlacement ? { pendingPlacement } : {}),
    },
    connection: { status: "unreachable", lastSeenAt: null, detail: null, hostModeOff: true },
    summary: null,
  };
}

beforeEach(() => client.update.mockClear());
afterEach(() => cleanup());

describe("HostDetail with a worktree waiting on its setup", () => {
  it("names the worktree, opens setup from its own row, and cancels the wait", async () => {
    render(<HostDetail entry={entry(PLACEMENT)} onBack={() => {}} />);
    expect(screen.getByText("feature-x opens here once setup finishes")).toBeTruthy();
    // One way into setup, beside the worktree that waits on it.
    expect(screen.getAllByRole("button", { name: "Set up…" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Set up…" }));
    expect(screen.getByRole("dialog").textContent).toBe("Set up box");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(client.update).toHaveBeenCalledWith({ hostId: "box", pendingPlacement: null });
  });

  it("says why the last setup failed, with a Retry that opens setup again", () => {
    render(
      <HostDetail
        entry={entry({ ...PLACEMENT, failure: { message: "Host mode didn't start", at: 2 } })}
        onBack={() => {}}
      />
    );
    expect(screen.getByText("Setup failed: Host mode didn't start")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("dialog").textContent).toBe("Set up box");
  });

  it("opens straight into setup when asked for it, titled for setup", () => {
    render(<HostDetail entry={entry(PLACEMENT)} onBack={() => {}} openUpdate="setup" />);
    expect(screen.getByRole("dialog").textContent).toBe("Set up box");
  });

  it("asks what becomes of a machine made for the worktree before cancelling, even unread", async () => {
    render(<HostDetail entry={entry({ ...PLACEMENT, createdMachine: true })} onBack={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(client.update).not.toHaveBeenCalled();
    expect(screen.getByText("Stop opening 'feature-x' on box?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep machine" }));
    });
    expect(client.update).toHaveBeenCalledWith({ hostId: "box", pendingPlacement: null });
  });

  it("asks again for a machine-made placement whose switch didn't open it", async () => {
    render(
      <HostDetail
        entry={entry({
          ...PLACEMENT,
          createdMachine: true,
          failure: { message: NOT_OPENED, at: 2 },
        })}
        onBack={() => {}}
      />
    );
    expect(screen.getByText(NOT_OPENED)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    const written = client.update.mock.calls.at(-1)?.[0] as {
      pendingPlacement: PendingHostPlacement;
    };
    expect(written.pendingPlacement).not.toHaveProperty("failure");
    expect(written.pendingPlacement.requestedAt).not.toBe(PLACEMENT.requestedAt);
  });

  it("shows no waiting row for a host nothing waits on", () => {
    render(<HostDetail entry={entry()} onBack={() => {}} />);
    expect(screen.queryByText(/opens here once setup finishes/)).toBeNull();
    expect(screen.getByRole("button", { name: "Set up…" })).toBeTruthy();
  });
});
