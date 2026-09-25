// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { GitLabSettingsTab } from "../components/GitLabSettingsTab";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(async () => ({ ok: true, result: { valid: true } })) },
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const stored: Record<string, unknown> = {};
let tokenStored = true;

const getSettingValues = vi.fn(async () => ({ values: { ...stored } }));
const setSettingValue = vi.fn(async (_p: string, key: string, value: unknown) => {
  stored[key] = value;
});
const getCredentialStatus = vi.fn(async () => ({ hasCredential: tokenStored }));
const clearCredential = vi.fn(async () => {
  tokenStored = false;
});
const setCredential = vi.fn(async () => ({ valid: true }));

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(stored)) delete stored[key];
  stored.instanceUrl = "https://gitlab.com";
  tokenStored = true;
  window.electron = {
    plugin: { getSettingValues, setSettingValue },
    forge: { getCredentialStatus, clearCredential, setCredential },
  } as unknown as typeof window.electron;
});

async function renderLoaded() {
  render(<GitLabSettingsTab />);
  await screen.findByText("Token saved for gitlab.com");
  return screen.getByLabelText("GitLab instance URL") as HTMLInputElement;
}

describe("GitLabSettingsTab — switching instance with a saved token", () => {
  it("never deletes the saved token when the URL field loses focus", async () => {
    const url = await renderLoaded();
    fireEvent.change(url, { target: { value: "https://gitlab.example.com" } });
    fireEvent.blur(url);

    await screen.findByText(/Not switched yet/);
    expect(clearCredential).not.toHaveBeenCalled();
    expect(setSettingValue).not.toHaveBeenCalled();
  });

  it("does not delete a token that turns up only at write time", async () => {
    // The tab loaded believing there was no token; another window has since saved one.
    tokenStored = false;
    render(<GitLabSettingsTab />);
    await screen.findByText("No token saved");
    tokenStored = true;

    const url = screen.getByLabelText("GitLab instance URL");
    fireEvent.change(url, { target: { value: "https://gitlab.example.com" } });
    fireEvent.blur(url);

    await waitFor(() => expect(getCredentialStatus).toHaveBeenCalledTimes(2));
    expect(clearCredential).not.toHaveBeenCalled();
    expect(setSettingValue).not.toHaveBeenCalled();
  });

  it("asks before Save switches instance, and removes the old token only once confirmed", async () => {
    const url = await renderLoaded();
    fireEvent.change(url, { target: { value: "https://gitlab.example.com" } });
    fireEvent.change(screen.getByLabelText("GitLab personal access token"), {
      target: { value: "glpat-new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Switch to gitlab.example.com?")).toBeTruthy();
    expect(clearCredential).not.toHaveBeenCalled();
    expect(setSettingValue).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Switch instance" }));
    await waitFor(() => expect(setCredential).toHaveBeenCalled());
    expect(stored.instanceUrl).toBe("https://gitlab.example.com");
    expect(clearCredential).toHaveBeenCalledTimes(1);
  });
});
