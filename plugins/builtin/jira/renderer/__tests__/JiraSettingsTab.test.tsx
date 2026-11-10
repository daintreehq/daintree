// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { whenPluginUiReady } from "@daintreehq/plugin-ui";
import { actionService } from "@/services/ActionService";
import { JiraSettingsTab } from "../components/JiraSettingsTab";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(async () => ({ ok: true, result: undefined })) },
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const PROVIDER_ID = "daintree.jira.jira";

// The host passes the provider this one field's value, so the form has to send it.
const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../plugin.json"), "utf8"));
const PRIMARY_FIELD: string = manifest.contributes.forgeProviders[0].credentialFields.find(
  (field: { type: string }) => field.type === "password"
).id;

const stored: Record<string, unknown> = {};
let tokenStored = false;
const order: string[] = [];

const getSettingValues = vi.fn(async () => ({ values: { ...stored } }));
const setSettingValue = vi.fn(async (_plugin: string, key: string, value: unknown) => {
  order.push(`setting:${key}`);
  stored[key] = value;
});
const getCredentialStatus = vi.fn(async () => ({ hasCredential: tokenStored }));
const clearCredential = vi.fn(async () => {
  tokenStored = false;
});
const setCredential = vi.fn(async (_providerId: string, _credentials: Record<string, string>) => {
  order.push("credential");
  return { valid: true, account: "Ada Lovelace" } as {
    valid: boolean;
    account?: string;
    error?: string;
  };
});

beforeAll(() => whenPluginUiReady(), 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  for (const key of Object.keys(stored)) delete stored[key];
  tokenStored = false;
  window.electron = {
    plugin: { getSettingValues, setSettingValue },
    forge: { getCredentialStatus, clearCredential, setCredential },
  } as unknown as typeof window.electron;
});

function field(name: string): HTMLInputElement {
  return screen.getByLabelText(name) as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

function fill(values: { site?: string; email?: string; token?: string }) {
  if (values.site !== undefined) {
    fireEvent.change(field("Jira site URL"), { target: { value: values.site } });
  }
  if (values.email !== undefined) {
    fireEvent.change(field("Jira account email"), { target: { value: values.email } });
  }
  if (values.token !== undefined) {
    fireEvent.change(field("Jira API token"), { target: { value: values.token } });
  }
}

async function renderLoaded(status: string) {
  render(<JiraSettingsTab />);
  await screen.findByText(status);
}

describe("JiraSettingsTab", () => {
  it("connects with a site URL, email and token, and shows who it signed in as", async () => {
    await renderLoaded("No credentials saved");
    expect(saveButton().disabled).toBe(true);

    fill({ site: "acme.atlassian.net/jira", email: " ada@example.com ", token: " ATATT3x " });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await screen.findByText(/Signed in as Ada Lovelace/);
    expect(stored).toEqual({
      siteUrl: "https://acme.atlassian.net",
      email: "ada@example.com",
    });
    expect(setCredential).toHaveBeenCalledWith(PROVIDER_ID, { [PRIMARY_FIELD]: "ATATT3x" });
    expect(field("Jira API token").value).toBe("");
    expect(field("Jira site URL").value).toBe("https://acme.atlassian.net");
    expect(screen.getByText("Credentials saved")).toBeTruthy();
    expect(actionService.dispatch).toHaveBeenCalledWith("worktree.refresh", undefined, {
      source: "user",
    });
  });

  it("saves once on Enter in any field, and does nothing while the token is empty", async () => {
    await renderLoaded("No credentials saved");
    fill({ site: "acme.atlassian.net", email: "ada@example.com" });
    fireEvent.keyDown(field("Jira account email"), { key: "Enter" });
    expect(setCredential).not.toHaveBeenCalled();

    fill({ token: "ATATT3x" });
    fireEvent.keyDown(field("Jira site URL"), { key: "Enter" });
    fireEvent.keyDown(field("Jira API token"), { key: "Enter" });

    await screen.findByText(/Signed in as Ada Lovelace/);
    expect(setCredential).toHaveBeenCalledTimes(1);
    expect(setCredential).toHaveBeenCalledWith(PROVIDER_ID, { [PRIMARY_FIELD]: "ATATT3x" });
  });

  it("lands the site and email before the token is checked against them", async () => {
    await renderLoaded("No credentials saved");
    fill({ site: "acme.atlassian.net", email: "ada@example.com", token: "t" });
    fireEvent.click(saveButton());
    await screen.findByText(/Signed in as/);
    expect(order).toEqual(["setting:siteUrl", "setting:email", "credential"]);
  });

  it("keeps the token out of plain settings", async () => {
    await renderLoaded("No credentials saved");
    fill({ site: "acme.atlassian.net", email: "ada@example.com", token: "ATATT3xSECRET" });
    fireEvent.click(saveButton());
    await screen.findByText(/Signed in as/);
    expect(JSON.stringify(setSettingValue.mock.calls)).not.toContain("ATATT3xSECRET");
  });

  it("loads the saved site and email and says a token is stored", async () => {
    stored.siteUrl = "https://acme.atlassian.net";
    stored.email = "ada@example.com";
    tokenStored = true;
    await renderLoaded("Credentials saved");
    expect(field("Jira site URL").value).toBe("https://acme.atlassian.net");
    expect(field("Jira account email").value).toBe("ada@example.com");
    expect(field("Jira API token").value).toBe("");
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    // A saved token is never reused for changed details without being entered again.
    expect(saveButton().disabled).toBe(true);
  });

  it("refuses a site that isn't Jira Cloud without writing or sending anything", async () => {
    await renderLoaded("No credentials saved");
    fill({ site: "https://jira.example.com", email: "ada@example.com", token: "t" });
    fireEvent.click(saveButton());
    await screen.findByText(/Use your Jira Cloud address/);
    expect(setSettingValue).not.toHaveBeenCalled();
    expect(setCredential).not.toHaveBeenCalled();
  });

  it("refuses an address that isn't an email", async () => {
    await renderLoaded("No credentials saved");
    fill({ site: "acme.atlassian.net", email: "ada", token: "t" });
    fireEvent.click(saveButton());
    await screen.findByText(/Use the email address/);
    expect(setCredential).not.toHaveBeenCalled();
  });

  it("shows Jira's refusal and puts the previous connection back", async () => {
    stored.siteUrl = "https://old.atlassian.net";
    stored.email = "old@example.com";
    tokenStored = true;
    setCredential.mockResolvedValueOnce({ valid: false, error: "Jira rejected the token" });
    await renderLoaded("Credentials saved");

    fill({ site: "new.atlassian.net", email: "new@example.com", token: "bad" });
    fireEvent.click(saveButton());

    expect((await screen.findAllByText("Jira rejected the token")).length).toBeGreaterThan(0);
    expect(stored).toEqual({
      siteUrl: "https://old.atlassian.net",
      email: "old@example.com",
    });
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    // The token that worked before is left where it is.
    expect(clearCredential).not.toHaveBeenCalled();
    expect(screen.getByText("Credentials saved")).toBeTruthy();
    // What was typed stays, so a typo can be fixed.
    expect(field("Jira site URL").value).toBe("new.atlassian.net");
    expect(field("Jira API token").value).toBe("bad");
  });

  it("puts the previous connection back when saving throws", async () => {
    stored.siteUrl = "https://old.atlassian.net";
    stored.email = "old@example.com";
    setCredential.mockRejectedValueOnce(new Error("ipc"));
    await renderLoaded("No credentials saved");

    fill({ site: "new.atlassian.net", email: "new@example.com", token: "t" });
    fireEvent.click(saveButton());

    expect(
      (await screen.findAllByText("Couldn't save the Jira connection")).length
    ).toBeGreaterThan(0);
    await waitFor(() => {
      expect(stored).toEqual({ siteUrl: "https://old.atlassian.net", email: "old@example.com" });
    });
  });

  it("undoes a save that only got half written", async () => {
    stored.siteUrl = "https://old.atlassian.net";
    stored.email = "old@example.com";
    setSettingValue.mockImplementationOnce(async (_plugin, key, value) => {
      stored[key] = value;
    });
    setSettingValue.mockRejectedValueOnce(new Error("disk"));
    await renderLoaded("No credentials saved");

    fill({ site: "new.atlassian.net", email: "new@example.com", token: "t" });
    fireEvent.click(saveButton());

    await screen.findAllByText("Couldn't save the Jira connection");
    expect(setCredential).not.toHaveBeenCalled();
    expect(stored).toEqual({ siteUrl: "https://old.atlassian.net", email: "old@example.com" });
  });

  it("leaves the connection to another window that saved in the meantime", async () => {
    stored.siteUrl = "https://old.atlassian.net";
    stored.email = "old@example.com";
    setCredential.mockImplementationOnce(async () => {
      stored.siteUrl = "https://new.atlassian.net";
      stored.email = "other-window@example.com";
      return { valid: false, error: "Jira rejected the token" };
    });
    await renderLoaded("No credentials saved");

    fill({ site: "new.atlassian.net", email: "new@example.com", token: "bad" });
    fireEvent.click(saveButton());

    await screen.findAllByText("Jira rejected the token");
    expect(stored).toEqual({
      siteUrl: "https://new.atlassian.net",
      email: "other-window@example.com",
    });
  });

  it("says so when the previous connection can't be put back", async () => {
    stored.siteUrl = "https://old.atlassian.net";
    stored.email = "old@example.com";
    tokenStored = true;
    setCredential.mockImplementationOnce(async () => {
      setSettingValue.mockRejectedValueOnce(new Error("disk"));
      return { valid: false, error: "Jira rejected the token." };
    });
    await renderLoaded("Credentials saved");

    fill({ site: "new.atlassian.net", email: "new@example.com", token: "bad" });
    fireEvent.click(saveButton());

    const messages = await screen.findAllByText(/couldn't put the previous site and email back/);
    expect(messages[0]?.textContent).toContain("Jira rejected the token.");
  });

  it("clears the signed-in name as soon as the details change", async () => {
    await renderLoaded("No credentials saved");
    fill({ site: "acme.atlassian.net", email: "ada@example.com", token: "t" });
    fireEvent.click(saveButton());
    await screen.findByText(/Signed in as/);

    fill({ email: "grace@example.com" });
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });

  it("doesn't save twice from two activations before a render", async () => {
    await renderLoaded("No credentials saved");
    fill({ site: "acme.atlassian.net", email: "ada@example.com", token: "t" });
    const button = saveButton();
    // Native clicks inside one act: the button is still enabled for the second.
    await act(async () => {
      button.click();
      button.click();
    });
    await screen.findByText(/Signed in as/);
    expect(setCredential).toHaveBeenCalledTimes(1);
  });

  it("clears the token behind a confirmation, leaving the site and email", async () => {
    stored.siteUrl = "https://acme.atlassian.net";
    stored.email = "ada@example.com";
    tokenStored = true;
    await renderLoaded("Credentials saved");

    fireEvent.click(screen.getByRole("button", { name: "Clear token" }));
    expect(clearCredential).not.toHaveBeenCalled();
    await screen.findByText("Clear the Jira API token?");
    const buttons = screen.getAllByRole("button", { name: "Clear token" });
    fireEvent.click(buttons.at(-1) as HTMLElement);

    await waitFor(() => expect(clearCredential).toHaveBeenCalledWith(PROVIDER_ID));
    await screen.findByText("No credentials saved");
    expect(stored.siteUrl).toBe("https://acme.atlassian.net");
    // The row is gone; the dialog's own button can outlive it through its exit animation.
    expect(screen.queryByText("Stored token")).toBeNull();
  });

  it("says when clearing fails, and keeps the token row", async () => {
    tokenStored = true;
    clearCredential.mockRejectedValueOnce(new Error("ipc"));
    await renderLoaded("Credentials saved");

    fireEvent.click(screen.getByRole("button", { name: "Clear token" }));
    await screen.findByText("Clear the Jira API token?");
    const buttons = screen.getAllByRole("button", { name: "Clear token" });
    fireEvent.click(buttons.at(-1) as HTMLElement);

    await screen.findAllByText("Couldn't clear the API token");
    expect(screen.getByText("Credentials saved")).toBeTruthy();
  });

  it("still loads the saved site and email when a token is typed during a slow load", async () => {
    stored.siteUrl = "https://acme.atlassian.net";
    stored.email = "ada@example.com";
    let finishLoad: (value: { values: Record<string, unknown> }) => void = () => undefined;
    getSettingValues.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        })
    );
    render(<JiraSettingsTab />);
    fill({ token: "typed-early" });

    await act(async () => {
      finishLoad({ values: { ...stored } });
    });

    await screen.findByText("No credentials saved");
    expect(field("Jira site URL").value).toBe("https://acme.atlassian.net");
    expect(field("Jira account email").value).toBe("ada@example.com");
    expect(field("Jira API token").value).toBe("typed-early");
  });

  it("loads the field that wasn't edited during a slow load, and spares the one that was", async () => {
    stored.siteUrl = "https://acme.atlassian.net";
    stored.email = "ada@example.com";
    let finishLoad: (value: { values: Record<string, unknown> }) => void = () => undefined;
    getSettingValues.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        })
    );
    render(<JiraSettingsTab />);
    fill({ site: "edited.atlassian.net" });

    await act(async () => {
      finishLoad({ values: { ...stored } });
    });

    await screen.findByText("No credentials saved");
    expect(field("Jira site URL").value).toBe("edited.atlassian.net");
    expect(field("Jira account email").value).toBe("ada@example.com");
  });

  it("says when the saved connection can't be read, and retries", async () => {
    getSettingValues.mockRejectedValueOnce(new Error("ipc"));
    render(<JiraSettingsTab />);
    await screen.findByText("Couldn't read the saved Jira connection");
    fill({ site: "acme.atlassian.net", email: "ada@example.com", token: "t" });
    // Nothing is saved over a connection it couldn't read.
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No credentials saved");
    expect(screen.queryByText("Couldn't read the saved Jira connection")).toBeNull();
    // What was typed in the meantime isn't overwritten by the late load.
    expect(field("Jira site URL").value).toBe("acme.atlassian.net");
  });

  it("opens Atlassian's token page", async () => {
    await renderLoaded("No credentials saved");
    fireEvent.click(screen.getByRole("button", { name: /Create token on Atlassian/ }));
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://id.atlassian.com/manage-profile/security/api-tokens" },
      { source: "user" }
    );
  });
});
