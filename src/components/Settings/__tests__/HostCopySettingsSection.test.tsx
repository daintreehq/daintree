// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConfigImportReport } from "@shared/types/configBundle";
import type {
  SettingsCopyLastCopy,
  SettingsCopyPreview,
  SettingsCopyStatus,
  SettingsCopyUndoResult,
} from "@shared/types/ipc/settingsCopy";
import { PORTABLE_SETTINGS_CATEGORIES } from "@shared/config/portableSettings";
import { HostCopySettingsSection } from "../Hosts/HostCopySettingsSection";

const HOST = "studio-01";

const PREVIEW: SettingsCopyPreview = {
  ticket: "0123456789abcdef0123456789abcdef",
  hostPlatform: "linux",
  sections: [
    {
      section: "agentSettings",
      add: 0,
      update: 1,
      unchanged: 0,
      changes: [{ key: "claude", label: "Claude", kind: "update" }],
      skipped: [
        {
          key: "claude.presetId",
          label: "Claude default preset",
          reason: "That preset isn't defined",
        },
      ],
    },
    {
      section: "worktreeConfig",
      add: 0,
      update: 1,
      unchanged: 0,
      changes: [
        { key: "pathPattern", label: "Path pattern", kind: "update", from: "a/{x}", to: "b/{x}" },
      ],
    },
    { section: "hibernation", add: 0, update: 0, unchanged: 2, changes: [] },
  ],
  unknownSections: ["sessionRestore"],
  withheld: [{ section: "agentSettings", name: "GITHUB_TOKEN" }],
};

const REPORT: ConfigImportReport = {
  outcome: "applied",
  rolledBack: false,
  errors: [],
  sections: [
    {
      section: "agentSettings",
      present: true,
      applied: 1,
      unchanged: 0,
      skipped: 1,
      failed: 0,
      leaves: [
        { key: "claude", status: "applied" },
        { key: "claude.presetId", status: "skipped", reason: "That preset isn't defined" },
      ],
      errors: [],
    },
    {
      section: "worktreeConfig",
      present: true,
      applied: 1,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      leaves: [{ key: "pathPattern", status: "applied" }],
      errors: [],
    },
  ],
};

const LAST_COPY: SettingsCopyLastCopy = {
  id: "fedcba9876543210fedcba9876543210",
  source: "Laptop",
  at: Date.now() - 5 * 60_000,
  sections: [
    { section: "agentSettings", applied: 2, skipped: 1 },
    { section: "worktreeConfig", applied: 1, skipped: 0 },
  ],
  undo: "available",
  changed: [
    { section: "agentSettings", key: "claude", label: "Claude" },
    { section: "worktreeConfig", key: "pathPattern", label: "Path pattern" },
  ],
};

const STATUS: SettingsCopyStatus = {
  supported: true,
  changes: ["agentSettings", "worktreePath"],
  lastCopy: null,
};

const UNDONE: SettingsCopyUndoResult["undone"] = {
  at: Date.now(),
  leaves: [
    { section: "agentSettings", key: "claude", label: "Claude", status: "edited" },
    { section: "worktreeConfig", key: "pathPattern", label: "Path pattern", status: "restored" },
  ],
};

const UNDONE_COPY: SettingsCopyLastCopy = {
  ...LAST_COPY,
  undo: "done",
  changed: undefined,
  undone: UNDONE,
};

const settingsCopy = {
  preview: vi.fn(async (): Promise<SettingsCopyPreview> => PREVIEW),
  apply: vi.fn(async (): Promise<ConfigImportReport> => REPORT),
  status: vi.fn(async (): Promise<SettingsCopyStatus> => STATUS),
  undo: vi.fn(async (): Promise<SettingsCopyUndoResult> => ({
    undone: UNDONE,
    lastCopy: UNDONE_COPY,
  })),
};

function appError(code: string, userMessage: string): Error {
  return Object.assign(new Error(userMessage), { name: "AppError", code, userMessage });
}

function checkbox(label: string): HTMLElement {
  return screen.getByRole("checkbox", { name: label });
}

function isChecked(label: string): boolean {
  return checkbox(label).getAttribute("aria-checked") === "true";
}

beforeEach(() => {
  settingsCopy.status.mockReset().mockImplementation(async () => STATUS);
  Object.defineProperty(window, "electron", {
    value: { settingsCopy },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Settings → Hosts → host → Copy settings", () => {
  it("asks for a connection before anything else", () => {
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected={false} />);
    expect(screen.getByText("Connect to Studio to copy settings to it")).not.toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("starts with the catalog's own choice: sensitive and device categories unticked", () => {
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    for (const category of PORTABLE_SETTINGS_CATEGORIES) {
      expect(isChecked(category.label)).toBe(category.selectedByDefault);
    }
    expect(isChecked("Select all")).toBe(false);
  });

  it("selects and clears every category at once", () => {
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    fireEvent.click(checkbox("Select all"));
    expect(PORTABLE_SETTINGS_CATEGORIES.every((c) => isChecked(c.label))).toBe(true);
    fireEvent.click(checkbox("Select all"));
    expect(PORTABLE_SETTINGS_CATEGORIES.some((c) => isChecked(c.label))).toBe(false);
    const previewButton = screen.getByRole("button", { name: "Preview changes on Studio" });
    expect(previewButton.hasAttribute("disabled")).toBe(true);
  });

  it("previews the chosen categories on the host, then copies exactly that preview", async () => {
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes on Studio" }));

    await screen.findByText("Replaced · a/{x} → b/{x}");
    expect(settingsCopy.preview).toHaveBeenCalledWith({
      hostId: HOST,
      categories: PORTABLE_SETTINGS_CATEGORIES.filter((c) => c.selectedByDefault).map((c) => c.id),
    });
    expect(screen.getByText("Skipped · That preset isn't defined")).not.toBeNull();
    expect(screen.getByText("GITHUB_TOKEN looks like a secret")).not.toBeNull();
    expect(screen.getByText("Already the same on Studio")).not.toBeNull();
    expect(screen.getByText(/doesn't know these settings yet/)).not.toBeNull();
    expect(screen.getByText("2 changes on Studio")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy to Studio" }));
    await screen.findByText("2 settings copied to Studio");
    expect(settingsCopy.apply).toHaveBeenCalledWith({ hostId: HOST, ticket: PREVIEW.ticket });
    expect(screen.getByText("1 applied · 1 skipped")).not.toBeNull();
    // A skipped leaf in the report keeps the name the preview gave it.
    expect(screen.getByText("Claude default preset")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "Preview changes on Studio" })).not.toBeNull();
  });

  it("drops the preview when the choice changes, since it no longer matches", async () => {
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes on Studio" }));
    await screen.findByRole("button", { name: "Copy to Studio" });
    fireEvent.click(checkbox("Notifications"));
    expect(screen.queryByRole("button", { name: "Copy to Studio" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preview changes on Studio" })).not.toBeNull();
  });

  it("asks for a fresh preview when the host's settings changed in between", async () => {
    settingsCopy.apply.mockRejectedValueOnce(
      appError("SETTINGS_PREVIEW_STALE", "Settings on Studio changed since this preview.")
    );
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes on Studio" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy to Studio" }));

    await screen.findByText("Settings on Studio changed since this preview.");
    expect(screen.queryByRole("button", { name: "Copy to Studio" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview again" }));
    await waitFor(() => expect(settingsCopy.preview).toHaveBeenCalledTimes(2));
  });

  it("keeps the preview and shows the error when the copy fails for another reason", async () => {
    settingsCopy.apply.mockRejectedValueOnce(
      appError("INTERNAL", "Couldn't copy settings to Studio.")
    );
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes on Studio" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy to Studio" }));
    await screen.findByText("Couldn't copy settings to Studio.");
    expect(screen.getByRole("button", { name: "Copy to Studio" })).not.toBeNull();
  });

  it("ignores a preview that answers after the host went away", async () => {
    let resolve: (value: SettingsCopyPreview) => void = () => {};
    settingsCopy.preview.mockImplementationOnce(
      () => new Promise<SettingsCopyPreview>((r) => (resolve = r))
    );
    const { rerender } = render(
      <HostCopySettingsSection hostId={HOST} hostName="Studio" connected />
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview changes on Studio" }));
    rerender(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected={false} />);
    await act(async () => resolve(PREVIEW));
    rerender(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    expect(screen.queryByRole("button", { name: "Copy to Studio" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preview changes on Studio" })).not.toBeNull();
  });

  it("says so when undoing a failed copy failed too, rather than claim nothing changed", async () => {
    settingsCopy.apply.mockResolvedValueOnce({
      outcome: "rolled-back",
      rolledBack: false,
      restoreFailed: true,
      sections: [],
      errors: [
        "Couldn't import notifications: disk full. Undoing the earlier sections also failed.",
      ],
    });
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes on Studio" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy to Studio" }));
    await screen.findByText("Partly changed");
    expect(screen.queryByText("Nothing changed")).toBeNull();
    expect(screen.getByText(/may be partly changed/)).not.toBeNull();
  });

  it("offers the copy for a host that was just added", () => {
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected offered />);
    expect(screen.getByText(/Studio starts from defaults/)).not.toBeNull();
  });
});

describe("Settings → Hosts → host → what a copy would change", () => {
  function categoryLabel(id: string): string {
    return PORTABLE_SETTINGS_CATEGORIES.find((c) => c.id === id)!.label;
  }

  it("says what a copy from here would change on opening, and again on Refresh", async () => {
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    await screen.findByText("Copying from this computer would change 2 categories");
    expect(
      screen.getByText([categoryLabel("agentSettings"), categoryLabel("worktreePath")].join(", "))
    ).not.toBeNull();
    expect(settingsCopy.status).toHaveBeenCalledWith({ hostId: HOST });

    settingsCopy.status.mockResolvedValueOnce({ ...STATUS, changes: [] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Copying from this computer would change 0 categories");
    expect(settingsCopy.status).toHaveBeenCalledTimes(2);
  });

  it("never asks while disconnected", () => {
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected={false} />);
    expect(settingsCopy.status).not.toHaveBeenCalled();
  });

  it("shows nothing for a host too old to say", async () => {
    settingsCopy.status.mockResolvedValueOnce({ supported: false, changes: [], lastCopy: null });
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    await waitFor(() => expect(screen.queryByText(/Checking what a copy/)).toBeNull());
    expect(screen.queryByText(/Copying from this computer/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("drops an answer for a host the page has since moved off", async () => {
    let answerFirst: (status: SettingsCopyStatus) => void = () => {};
    settingsCopy.status.mockImplementationOnce(
      () => new Promise<SettingsCopyStatus>((resolve) => (answerFirst = resolve))
    );
    const { rerender } = render(
      <HostCopySettingsSection hostId={HOST} hostName="Studio" connected />
    );
    settingsCopy.status.mockResolvedValueOnce({ ...STATUS, changes: [] });
    rerender(<HostCopySettingsSection hostId="studio-02" hostName="Other" connected />);
    await screen.findByText("Copying from this computer would change 0 categories");
    await act(async () => answerFirst(STATUS));
    expect(screen.queryByText("Copying from this computer would change 2 categories")).toBeNull();
  });

  it("names where the last copy came from and undoes it, listing what it left alone", async () => {
    settingsCopy.status.mockResolvedValue({ ...STATUS, lastCopy: LAST_COPY });
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    await screen.findByText("Last copied from Laptop 5 minutes ago");
    expect(screen.getByText(/3 applied · 1 skipped/)).not.toBeNull();
    // What the host reports once it has been undone.
    settingsCopy.status.mockResolvedValue({ ...STATUS, lastCopy: UNDONE_COPY });

    fireEvent.click(screen.getByRole("button", { name: "Undo last copy" }));
    await screen.findByText("Undo the last settings copy to 'Studio'?");
    expect(screen.getByText("Path pattern")).not.toBeNull();
    expect(settingsCopy.undo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Undo copy" }));
    await screen.findByText("Kept · Changed on Studio since the copy");
    expect(settingsCopy.undo).toHaveBeenCalledWith({ hostId: HOST, copyId: LAST_COPY.id });
    expect(screen.getByText(/1 setting restored/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Undo last copy" })).toBeNull();
  });

  it("says why an undo didn't happen, on the row it was asked from", async () => {
    settingsCopy.status.mockResolvedValue({ ...STATUS, lastCopy: LAST_COPY });
    settingsCopy.undo.mockRejectedValueOnce(
      appError("SETTINGS_COPY_UNDO_STALE", "Studio has a newer copy. Refresh to see it.")
    );
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    fireEvent.click(await screen.findByRole("button", { name: "Undo last copy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo copy" }));
    await screen.findByText("Studio has a newer copy. Refresh to see it.");
  });

  it("checks again after a copy lands", async () => {
    render(<HostCopySettingsSection hostId={HOST} hostName="Studio" connected />);
    await screen.findByText("Copying from this computer would change 2 categories");
    fireEvent.click(screen.getByRole("button", { name: "Preview changes on Studio" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy to Studio" }));
    await screen.findByText("1 applied · 1 skipped");
    await waitFor(() => expect(settingsCopy.status).toHaveBeenCalledTimes(2));
  });
});
