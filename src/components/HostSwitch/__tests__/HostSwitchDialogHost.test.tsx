// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";

vi.mock("../HostProjectPicker", () => ({
  HostProjectPicker: ({ hostId }: { hostId: string }) => <div>Projects on {hostId}</div>,
}));
vi.mock("../HostSwitchDialog", () => ({ HostSwitchDialog: () => null }));
vi.mock("../HostSetupRecipeConfirm", () => ({ HostSetupRecipeConfirm: () => null }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: { currentProject: null }) => unknown) =>
    selector({ currentProject: null }),
}));

import { HostSwitchDialogHost } from "../HostSwitchDialogHost";

let listeners: Array<(event: RemoteHostsEvent) => void> = [];
const takeProjectOffer = vi.fn<() => Promise<string | null>>();

beforeEach(() => {
  listeners = [];
  takeProjectOffer.mockReset();
  Object.assign(window, {
    electron: {
      remoteHosts: {
        takeProjectOffer,
        onEvent: (listener: (event: RemoteHostsEvent) => void) => {
          listeners.push(listener);
          return () => {
            listeners = listeners.filter((l) => l !== listener);
          };
        },
      },
    },
  });
});

afterEach(() => cleanup());

describe("HostSwitchDialogHost", () => {
  it("offers the host's projects in a new window that was opened for them", async () => {
    takeProjectOffer.mockResolvedValue("studio-01");
    render(<HostSwitchDialogHost />);
    expect(await screen.findByText("Projects on studio-01")).toBeTruthy();
  });

  it("asks again when main says an offer is waiting for a view already up", async () => {
    takeProjectOffer.mockResolvedValueOnce(null).mockResolvedValueOnce("studio-01");
    render(<HostSwitchDialogHost />);
    await act(async () => {});
    expect(screen.queryByText(/Projects on/)).toBeNull();
    act(() => listeners.forEach((listener) => listener({ type: "project-offer" })));
    expect(await screen.findByText("Projects on studio-01")).toBeTruthy();
    expect(takeProjectOffer).toHaveBeenCalledTimes(2);
  });

  it("shows nothing in a window with no offer", async () => {
    takeProjectOffer.mockResolvedValue(null);
    render(<HostSwitchDialogHost />);
    await act(async () => {});
    expect(screen.queryByText(/Projects on/)).toBeNull();
  });
});
