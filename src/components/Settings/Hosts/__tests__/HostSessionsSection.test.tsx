// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostLinkActivity, HostLinkActivityResult } from "@shared/types/ipc/hostMetrics";
import { HostSessionsSection } from "../HostSessionsSection";

const linkActivity = vi.fn<(payload: { hostId: string }) => Promise<HostLinkActivityResult>>();

function activity(overrides: Partial<HostLinkActivity> = {}): HostLinkActivity {
  return {
    observedAt: 10_000,
    listeningSince: 1_000,
    version: "0.46.0",
    commit: "abc",
    events: [
      {
        kind: "session-started",
        at: 9_000,
        clientId: "launch-2",
        clientName: "Greg's Mac Studio",
        sessionId: "s2",
        previousNotResumed: "session-unknown",
      },
    ],
    eventsTruncated: false,
    drivers: [
      {
        projectId: "p1",
        projectName: "daintree",
        holder: {
          leaseId: 1,
          endpointId: "s1:e1",
          clientId: "launch-1",
          clientName: "Greg's Mac Studio",
          isHostLocal: false,
          acquiredAt: 2_000,
        },
        state: "away",
        awayUntil: 15_000,
      },
    ],
    attached: [
      {
        sessionId: "s2",
        clientId: "launch-2",
        clientName: "Greg's Mac Studio",
        platform: "darwin",
        connectedAt: 9_000,
        drivingProjectIds: [],
      },
    ],
    ...overrides,
  };
}

const SELF = { clientId: "launch-2", clientName: "Greg's Mac Studio" };

function group(label: string): string {
  const heading = [...document.querySelectorAll("div")].find((el) => el.textContent === label);
  return heading?.nextElementSibling?.textContent ?? "";
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  linkActivity.mockReset();
  Object.defineProperty(window, "electron", {
    value: { hostMetrics: { linkActivity } },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

describe("HostSessionsSection", () => {
  it("shows who drives each project, who is attached, and what happened, this launch named", async () => {
    linkActivity.mockResolvedValue({ supported: true, activity: activity(), self: SELF });
    render(<HostSessionsSection hostId="studio-01" hostName="studio-01" connected sampledAt={1} />);
    await flush();

    expect(linkActivity).toHaveBeenCalledWith({ hostId: "studio-01" });
    expect(group("Projects driven")).toContain("daintree");
    expect(group("Projects driven")).toContain("Greg's Mac Studio (another launch) · away · held");
    expect(group("Attached now")).toContain("Greg's Mac Studio (this launch)");
    expect(group("Recent activity")).toContain(
      "New session; the previous one wasn't resumed: the host didn't know it"
    );
    expect(group("Recent activity")).toContain("Started taking connections");
    expect(group("Recent activity")).toContain("Daintree 0.46.0");
  });

  it("reads again with each new summary, never while a read is out, and keeps what it shows", async () => {
    let answer: (value: HostLinkActivityResult) => void = () => {};
    linkActivity.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    const { rerender } = render(
      <HostSessionsSection hostId="studio-01" hostName="studio-01" connected sampledAt={1} />
    );
    rerender(
      <HostSessionsSection hostId="studio-01" hostName="studio-01" connected sampledAt={2} />
    );
    expect(linkActivity).toHaveBeenCalledTimes(1);
    await act(async () => answer({ supported: true, activity: activity(), self: SELF }));

    rerender(
      <HostSessionsSection hostId="studio-01" hostName="studio-01" connected sampledAt={3} />
    );
    expect(linkActivity).toHaveBeenCalledTimes(2);
    expect(group("Projects driven")).toContain("daintree");
    await act(async () =>
      answer({ supported: true, activity: activity({ drivers: [] }), self: SELF })
    );
    expect(group("Projects driven")).toContain("Nobody is driving a project on studio-01");
  });

  it("says a host from before this can't report it, and stops asking until Retry or a reconnect", async () => {
    linkActivity.mockResolvedValue({ supported: false });
    const { rerender } = render(
      <HostSessionsSection hostId="studio-01" hostName="studio-01" connected sampledAt={1} />
    );
    await flush();
    expect(screen.getByText(/studio-01's build can't report its sessions/)).toBeTruthy();
    rerender(
      <HostSessionsSection hostId="studio-01" hostName="studio-01" connected sampledAt={2} />
    );
    await flush();
    expect(linkActivity).toHaveBeenCalledTimes(1);

    rerender(
      <HostSessionsSection
        hostId="studio-01"
        hostName="studio-01"
        connected={false}
        sampledAt={null}
      />
    );
    rerender(
      <HostSessionsSection hostId="studio-01" hostName="studio-01" connected sampledAt={3} />
    );
    await flush();
    expect(linkActivity).toHaveBeenCalledTimes(2);
  });

  it("puts a failed read on the section with Retry", async () => {
    linkActivity.mockRejectedValueOnce(new Error("link closed"));
    render(<HostSessionsSection hostId="studio-01" hostName="studio-01" connected sampledAt={1} />);
    await flush();
    linkActivity.mockResolvedValue({ supported: true, activity: activity(), self: SELF });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(group("Projects driven")).toContain("daintree");
  });

  it("asks nothing of a host that isn't connected", () => {
    render(
      <HostSessionsSection
        hostId="studio-01"
        hostName="studio-01"
        connected={false}
        sampledAt={null}
      />
    );
    expect(screen.getByText("Connect to studio-01 to see its sessions")).toBeTruthy();
    expect(linkActivity).not.toHaveBeenCalled();
  });

  it("shows the latest events and the rest on request", async () => {
    const events = Array.from({ length: 13 }, (_, i) => ({
      kind: "session-resumed" as const,
      at: 9_000 - i,
      clientId: "launch-2",
      clientName: "Greg's Mac Studio",
      sessionId: "s2",
      overLiveLink: false,
    }));
    linkActivity.mockResolvedValue({
      supported: true,
      activity: activity({ events }),
      self: SELF,
    });
    render(<HostSessionsSection hostId="studio-01" hostName="studio-01" connected sampledAt={1} />);
    await flush();
    expect(screen.getAllByText("Session resumed")).toHaveLength(10);
    expect(screen.getByText("3 earlier events")).toBeTruthy();
    expect(screen.queryByText("Started taking connections")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getAllByText("Session resumed")).toHaveLength(13);
    expect(screen.getByText("Started taking connections")).toBeTruthy();
  });
});
