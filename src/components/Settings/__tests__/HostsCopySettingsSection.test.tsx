// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConfigImportReport, ConfigImportSectionReport } from "@shared/types/configBundle";
import type { SettingsCopyPreview } from "@shared/types/ipc/settingsCopy";
import { HostsCopySettingsSection, type CopyTargetHost } from "../Hosts/HostsCopySettingsSection";

const preview = (ticket: string): SettingsCopyPreview => ({
  ticket,
  hostPlatform: "linux",
  sections: [
    {
      section: "agentSettings",
      add: 0,
      update: 1,
      unchanged: 0,
      changes: [{ key: "claude", label: "Claude", kind: "update", from: "On", to: "Off" }],
    },
  ],
  unknownSections: [],
  withheld: [],
});

const section = (counts: Partial<ConfigImportSectionReport>): ConfigImportSectionReport => ({
  section: "agentSettings",
  present: true,
  applied: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  leaves: [],
  errors: [],
  ...counts,
});

const report = (counts: Partial<ConfigImportSectionReport>): ConfigImportReport => ({
  outcome: "applied",
  rolledBack: false,
  errors: [],
  sections: [section(counts)],
});

const REPORT = report({ applied: 1, leaves: [{ key: "claude", status: "applied" }] });

const settingsCopy = { preview: vi.fn(), apply: vi.fn() };

const HOSTS: CopyTargetHost[] = [
  { id: "a", name: "alpha", connected: true },
  { id: "b", name: "bravo", connected: true },
  { id: "c", name: "charlie", connected: false },
];

function renderSection(hosts: CopyTargetHost[] = HOSTS) {
  const onOpenHost = vi.fn();
  render(<HostsCopySettingsSection hosts={hosts} onOpenHost={onOpenHost} />);
  fireEvent.click(screen.getByTestId("hosts-copy-several"));
  for (const host of hosts) fireEvent.click(screen.getByLabelText(new RegExp(host.name)));
  return onOpenHost;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  settingsCopy.preview
    .mockReset()
    .mockImplementation(async ({ hostId }: { hostId: string }) => preview(`ticket-${hostId}`));
  settingsCopy.apply.mockReset().mockResolvedValue(REPORT);
  Object.defineProperty(window, "electron", { value: { settingsCopy }, configurable: true });
});

afterEach(cleanup);

describe("HostsCopySettingsSection", () => {
  it("applies to the hosts that are up and reports the offline one", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /Preview on 3 hosts/ }));
    await waitFor(() => screen.getByRole("button", { name: /Copy to 2 hosts/ }));
    expect(settingsCopy.preview).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText(/charlie is offline|Offline/).length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: /Copy to 2 hosts/ }));
    await waitFor(() => screen.getByText("Results"));
    expect(settingsCopy.apply).toHaveBeenCalledTimes(2);
    expect(settingsCopy.apply).toHaveBeenCalledWith({ hostId: "a", ticket: "ticket-a" });
    expect(settingsCopy.apply).toHaveBeenCalledWith({ hostId: "b", ticket: "ticket-b" });
  });

  it("shows each host's own changes before anything is copied", async () => {
    settingsCopy.preview.mockImplementation(async ({ hostId }: { hostId: string }) =>
      hostId === "a"
        ? preview("ticket-a")
        : {
            ...preview("ticket-b"),
            sections: [
              {
                section: "agentSettings",
                add: 0,
                update: 0,
                unchanged: 2,
                changes: [],
                skipped: [{ key: "codex", label: "Codex", reason: "not installed there" }],
              },
            ],
            unknownSections: ["notificationSettings"],
            withheld: [{ section: "agentSettings", name: "API_TOKEN" }],
          }
    );
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /Preview on 3 hosts/ }));
    await waitFor(() => screen.getByRole("button", { name: /Copy to 1 host/ }));

    const alpha = screen.getByRole("group", { name: "alpha" });
    expect(alpha.textContent).toContain("Claude");
    expect(alpha.textContent).toContain("Agent settings · Replaced · On → Off");

    const bravo = screen.getByRole("group", { name: "bravo" });
    expect(bravo.textContent).not.toContain("Claude");
    expect(bravo.textContent).toContain("Codex");
    expect(bravo.textContent).toContain("Skipped · not installed there");
    expect(bravo.textContent).toContain("API_TOKEN looks like a secret");
    // Kept even though bravo has nothing else to change.
    expect(bravo.textContent).toContain("Not known there yet");
    expect(bravo.textContent).toContain("Notifications: update Daintree on bravo");

    expect(settingsCopy.apply).not.toHaveBeenCalled();
  });

  it("reports skipped and failed settings instead of a plain Applied", async () => {
    settingsCopy.apply.mockImplementation(async ({ hostId }: { hostId: string }) =>
      hostId === "a" ? report({ applied: 2, failed: 1 }) : report({ skipped: 1 })
    );
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /Preview on 3 hosts/ }));
    await waitFor(() => screen.getByRole("button", { name: /Copy to 2 hosts/ }));
    fireEvent.click(screen.getByRole("button", { name: /Copy to 2 hosts/ }));
    await waitFor(() => screen.getByText("Results"));

    expect(screen.getByText("Partly applied · 2 settings · 1 failed")).toBeTruthy();
    expect(screen.getByText("Not applied · 1 skipped")).toBeTruthy();
    expect(screen.queryByText(/^Applied/)).toBeNull();
  });

  it("refuses a host that changed since its preview without stopping the rest", async () => {
    settingsCopy.apply.mockImplementation(async ({ hostId }: { hostId: string }) => {
      if (hostId === "a")
        throw Object.assign(new Error("stale"), {
          name: "AppError",
          code: "SETTINGS_PREVIEW_STALE",
          userMessage: "stale",
        });
      return REPORT;
    });
    const onOpenHost = renderSection();
    fireEvent.click(screen.getByRole("button", { name: /Preview on 3 hosts/ }));
    await waitFor(() => screen.getByRole("button", { name: /Copy to 2 hosts/ }));
    fireEvent.click(screen.getByRole("button", { name: /Copy to 2 hosts/ }));
    await waitFor(() => screen.getByText("Results"));
    expect(screen.getByText("Changed since preview")).toBeTruthy();
    expect(screen.getAllByText("stale")).toHaveLength(1);
    expect(screen.getByText("Applied · 1 setting")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open bravo" }));
    expect(onOpenHost).toHaveBeenCalledWith("b");
    // The changed host's own page is where it is previewed again.
    fireEvent.click(screen.getByRole("button", { name: "Open alpha" }));
    expect(onOpenHost).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "Open charlie" }));
    expect(onOpenHost).toHaveBeenCalledWith("c");
  });

  it("previews and copies at most three hosts at a time", async () => {
    const hosts = ["h1", "h2", "h3", "h4", "h5"].map((id) => ({ id, name: id, connected: true }));
    const previews = new Map<string, ReturnType<typeof deferred<SettingsCopyPreview>>>();
    settingsCopy.preview.mockImplementation(({ hostId }: { hostId: string }) => {
      const pending = deferred<SettingsCopyPreview>();
      previews.set(hostId, pending);
      return pending.promise;
    });
    const applies = new Map<string, ReturnType<typeof deferred<ConfigImportReport>>>();
    settingsCopy.apply.mockImplementation(({ hostId }: { hostId: string }) => {
      const pending = deferred<ConfigImportReport>();
      applies.set(hostId, pending);
      return pending.promise;
    });
    renderSection(hosts);

    fireEvent.click(screen.getByRole("button", { name: /Preview on 5 hosts/ }));
    await waitFor(() => expect(settingsCopy.preview).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settingsCopy.preview).toHaveBeenCalledTimes(3);
    previews.get("h1")!.resolve(preview("ticket-h1"));
    await waitFor(() => expect(settingsCopy.preview).toHaveBeenCalledTimes(4));
    for (const id of ["h2", "h3"]) previews.get(id)!.resolve(preview(`ticket-${id}`));
    await waitFor(() => expect(settingsCopy.preview).toHaveBeenCalledTimes(5));
    for (const id of ["h4", "h5"]) previews.get(id)!.resolve(preview(`ticket-${id}`));
    await waitFor(() => screen.getByRole("button", { name: /Copy to 5 hosts/ }));

    fireEvent.click(screen.getByRole("button", { name: /Copy to 5 hosts/ }));
    await waitFor(() => expect(settingsCopy.apply).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settingsCopy.apply).toHaveBeenCalledTimes(3);
    applies.get("h1")!.resolve(REPORT);
    await waitFor(() => expect(settingsCopy.apply).toHaveBeenCalledTimes(4));
    for (const id of ["h2", "h3"]) applies.get(id)!.resolve(REPORT);
    await waitFor(() => expect(settingsCopy.apply).toHaveBeenCalledTimes(5));
    for (const id of ["h4", "h5"]) applies.get(id)!.resolve(REPORT);
    await waitFor(() => screen.getByText("Results"));
  });
});
