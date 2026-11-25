// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { whenPluginUiReady } from "@daintreehq/plugin-ui";
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitHubSettingsTab } from "../components/GitHubSettingsTab";
import { GitHubEnterpriseSection } from "../components/GitHubEnterpriseSection";
import { SettingsValidationProvider } from "@/components/Settings/SettingsValidationRegistry";
import { ENTERPRISE_CHANNELS } from "../../shared/enterprise.js";
import { GH_SIGN_IN_CHANNELS } from "../../shared/ghSignIn.js";

vi.mock("../stores/githubConfigStore", () => ({ useGitHubConfigStore: vi.fn() }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(async () => ({ ok: true, result: undefined })) },
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

// The dialog primitive has its own suite; this keeps the flow's wiring visible.
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    isOpen: boolean;
    title: ReactNode;
    description?: ReactNode;
    confirmLabel: string;
    onConfirm: () => void;
    onClose?: () => void;
  }) =>
    props.isOpen ? (
      <div role="dialog">
        <h2>{props.title}</h2>
        <p>{props.description}</p>
        <button type="button" onClick={() => props.onConfirm()}>
          {props.confirmLabel}
        </button>
        <button type="button" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    ) : null,
}));

import { useGitHubConfigStore } from "../stores/githubConfigStore";

const TOKEN = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";
const DIGEST = createHash("sha256").update(TOKEN, "utf8").digest("hex");

const setCredential = vi.fn();
const invoke = vi.fn();
let ghStatus: unknown;
let ghSignIn: unknown[];
let enterpriseHost: string | null;

beforeAll(() => whenPluginUiReady(), 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  ghStatus = { ok: true, signedIn: false };
  ghSignIn = [{ ok: true, gitConfigured: true }];
  enterpriseHost = null;
  setCredential.mockResolvedValue({ valid: true, scopes: ["repo"], account: "octocat" });
  invoke.mockImplementation(async (_plugin: string, channel: string) => {
    if (channel === ENTERPRISE_CHANNELS.status) {
      return { host: enterpriseHost, hasToken: false, staleTokenHost: null };
    }
    if (channel === ENTERPRISE_CHANNELS.saveToken || channel === ENTERPRISE_CHANNELS.testToken) {
      return { valid: true, account: "corp-me", scopes: ["repo"] };
    }
    if (channel === GH_SIGN_IN_CHANNELS.status) return ghStatus;
    if (channel === GH_SIGN_IN_CHANNELS.signIn) return ghSignIn.shift();
    throw new Error(`unexpected channel ${channel}`);
  });
  window.electron = {
    forge: { setCredential, clearCredential: vi.fn() },
    plugin: { invoke },
  } as unknown as typeof window.electron;
  vi.mocked(useGitHubConfigStore).mockReturnValue({
    config: { hasToken: false },
    isLoading: false,
    error: null,
    initialize: vi.fn(),
    refresh: vi.fn(),
    updateConfig: vi.fn(),
  } as unknown as ReturnType<typeof useGitHubConfigStore>);
});

const ghCalls = () =>
  invoke.mock.calls.filter(([, channel]) => String(channel).startsWith("ghSignIn."));
const signInCalls = () =>
  invoke.mock.calls.filter(([, channel]) => channel === GH_SIGN_IN_CHANNELS.signIn);

function renderTab() {
  render(
    <SettingsValidationProvider>
      <GitHubSettingsTab />
    </SettingsValidationProvider>
  );
}

function saveToken(tick: boolean) {
  fireEvent.change(screen.getByLabelText(/github personal access token/i), {
    target: { value: `  ${TOKEN}  ` },
  });
  const option = screen.getByRole("checkbox", { name: /Also sign in GitHub CLI/ });
  expect(option.getAttribute("aria-checked")).toBe("false");
  if (tick) fireEvent.click(option);
  fireEvent.click(screen.getByRole("button", { name: "Save token" }));
}

describe("gh sign-in from the github.com token save", () => {
  it("leaves gh alone when the option isn't ticked", async () => {
    renderTab();
    saveToken(false);

    await screen.findByText("Checked and saved");
    expect(ghCalls()).toHaveLength(0);
  });

  it("says gh gets the same token and rights on this machine", () => {
    renderTab();
    expect(
      screen.getByText(
        "gh will hold this same token, with the same rights, so anything on this machine that uses gh gets them."
      )
    ).toBeTruthy();
  });

  it("signs gh in on a fresh host, sending only a digest of the saved token", async () => {
    renderTab();
    saveToken(true);

    await screen.findByText("GitHub CLI on this machine is signed in to github.com as @octocat.");
    expect(setCredential).toHaveBeenCalledWith("daintree.github.github", { token: TOKEN });
    expect(signInCalls()).toHaveLength(1);
    expect(signInCalls()[0]![2]).toEqual({
      host: "github.com",
      tokenDigest: DIGEST,
      expected: { signedIn: false },
    });
    expect(JSON.stringify(ghCalls())).not.toContain(TOKEN);
    // The option is a per-save choice.
    expect(
      screen.getByRole("checkbox", { name: /Also sign in GitHub CLI/ }).getAttribute("aria-checked")
    ).toBe("false");
  });

  it("does nothing to gh when the save doesn't validate", async () => {
    setCredential.mockResolvedValue({ valid: false, error: "Bad credentials" });
    renderTab();
    saveToken(true);

    await screen.findAllByText("Bad credentials");
    expect(ghCalls()).toHaveLength(0);
  });

  it("names gh's current account and asks before replacing it", async () => {
    ghStatus = { ok: true, signedIn: true, account: "alice" };
    renderTab();
    saveToken(true);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("@alice");
    expect(dialog.textContent).toContain("@octocat");
    expect(signInCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Sign in GitHub CLI" }));

    await screen.findByText("GitHub CLI on this machine is signed in to github.com as @octocat.");
    expect(signInCalls()[0]![2]).toMatchObject({
      expected: { signedIn: true, account: "alice" },
    });
  });

  it("asks about the same account too, since its token is replaced", async () => {
    ghStatus = { ok: true, signedIn: true, account: "OctoCat" };
    renderTab();
    saveToken(true);

    expect((await screen.findByRole("dialog")).textContent).toContain(
      "Replace GitHub CLI's token for @OctoCat?"
    );
    expect(signInCalls()).toHaveLength(0);
  });

  it("leaves gh as it was when the person cancels", async () => {
    ghStatus = { ok: true, signedIn: true, account: "alice" };
    renderTab();
    saveToken(true);

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await screen.findByText("GitHub CLI wasn't changed; it's still signed in as @alice.");
    expect(signInCalls()).toHaveLength(0);
  });

  it("asks again when another sign-in landed while the person decided", async () => {
    ghSignIn = [
      { ok: false, reason: "gh-changed", current: { signedIn: true, account: "bob" } },
      { ok: true, gitConfigured: true },
    ];
    renderTab();
    saveToken(true);

    expect((await screen.findByRole("dialog")).textContent).toContain("@bob");
    fireEvent.click(screen.getByRole("button", { name: "Sign in GitHub CLI" }));

    await screen.findByText("GitHub CLI on this machine is signed in to github.com as @octocat.");
    expect(signInCalls()[1]![2]).toMatchObject({ expected: { signedIn: true, account: "bob" } });
  });

  it("reports a missing gh without undoing the save", async () => {
    ghStatus = { ok: false, reason: "cli-not-found" };
    renderTab();
    saveToken(true);

    await screen.findByText(
      "The token is saved in Daintree, but GitHub CLI (gh) isn't installed on this machine."
    );
    expect(screen.getByText("Checked and saved")).toBeTruthy();
    expect(signInCalls()).toHaveLength(0);
  });

  it("reports the scopes gh says the token lacks", async () => {
    ghSignIn = [{ ok: false, reason: "missing-scopes", missingScopes: ["read:org"] }];
    renderTab();
    saveToken(true);

    await screen.findByText(
      "The token is saved in Daintree, but GitHub CLI refused it: gh needs the read:org scope."
    );
  });

  it("reports a sign-in whose git setup failed", async () => {
    ghSignIn = [{ ok: true, gitConfigured: false }];
    renderTab();
    saveToken(true);

    await screen.findByText(
      "GitHub CLI on this machine is signed in to github.com as @octocat, but git isn't set up to use it. Run gh auth setup-git --hostname github.com there."
    );
  });

  it("keeps a result past the save confirmation's timer", async () => {
    ghStatus = { ok: false, reason: "cli-not-found" };
    renderTab();
    saveToken(true);
    const message =
      "The token is saved in Daintree, but GitHub CLI (gh) isn't installed on this machine.";
    await screen.findByText(message);

    await waitFor(() => expect(screen.queryByText("Checked and saved")).toBeNull(), {
      timeout: 6000,
    });
    expect(screen.getByText(message)).toBeTruthy();
  }, 10_000);
});

describe("gh sign-in from the Enterprise Server token save", () => {
  it("signs gh in to the Enterprise Server host", async () => {
    enterpriseHost = "ghe.example.com";
    render(<GitHubEnterpriseSection isGhAvailable={false} onTokenChanged={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("Personal access token for ghe.example.com"), {
      target: { value: TOKEN },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Also sign in GitHub CLI/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save Enterprise Server token" }));

    await screen.findByText(
      "GitHub CLI on this machine is signed in to ghe.example.com as @corp-me."
    );
    expect(invoke).toHaveBeenCalledWith("daintree.github", GH_SIGN_IN_CHANNELS.status, {
      host: "ghe.example.com",
    });
    expect(signInCalls()[0]![2]).toEqual({
      host: "ghe.example.com",
      tokenDigest: DIGEST,
      expected: { signedIn: false },
    });
  });

  it("leaves gh alone on Test", async () => {
    enterpriseHost = "ghe.example.com";
    render(<GitHubEnterpriseSection isGhAvailable={false} onTokenChanged={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("Personal access token for ghe.example.com"), {
      target: { value: TOKEN },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Also sign in GitHub CLI/ }));
    fireEvent.click(screen.getByRole("button", { name: "Test Enterprise Server token" }));

    await screen.findByText("Token works — not saved yet");
    expect(ghCalls()).toHaveLength(0);
  });
});
