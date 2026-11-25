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
const FRESH = "GitHub CLI on this machine is signed in to github.com as @octocat.";
const MISSING_GH =
  "The token is saved in Daintree, but GitHub CLI (gh) isn't installed on this machine.";

const setCredential = vi.fn();
const clearCredential = vi.fn(async () => {});
const invoke = vi.fn();
let ghStatus: unknown;
let ghSignIn: unknown[];
let enterpriseHosts: Array<string | null>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const signedInAs = (account: string | null, accounts: string[] = account ? [account] : []) => ({
  ok: true,
  signedIn: true,
  account,
  accounts,
});

beforeAll(() => whenPluginUiReady(), 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  ghStatus = { ok: true, signedIn: false };
  ghSignIn = [{ ok: true, gitConfigured: true }];
  enterpriseHosts = [null];
  setCredential.mockResolvedValue({ valid: true, scopes: ["repo"], account: "octocat" });
  invoke.mockImplementation(async (_plugin: string, channel: string) => {
    if (channel === ENTERPRISE_CHANNELS.status) {
      const host = enterpriseHosts.length > 1 ? enterpriseHosts.shift()! : enterpriseHosts[0]!;
      return { host, hasToken: false, staleTokenHost: null };
    }
    if (channel === ENTERPRISE_CHANNELS.saveToken || channel === ENTERPRISE_CHANNELS.testToken) {
      return { valid: true, account: "corp-me", scopes: ["repo"] };
    }
    if (channel === GH_SIGN_IN_CHANNELS.status) return ghStatus;
    if (channel === GH_SIGN_IN_CHANNELS.signIn) return ghSignIn.shift();
    throw new Error(`unexpected channel ${channel}`);
  });
  window.electron = {
    forge: { setCredential, clearCredential },
    plugin: { invoke },
  } as unknown as typeof window.electron;
  vi.mocked(useGitHubConfigStore).mockReturnValue({
    config: { hasToken: true },
    isLoading: false,
    error: null,
    initialize: vi.fn(),
    refresh: vi.fn(),
    updateConfig: vi.fn(),
  } as unknown as ReturnType<typeof useGitHubConfigStore>);
});

const channelCalls = (channel: string) =>
  invoke.mock.calls.filter(([, called]) => called === channel);
const ghCalls = () =>
  invoke.mock.calls.filter(([, channel]) => String(channel).startsWith("ghSignIn."));
const signInCalls = () => channelCalls(GH_SIGN_IN_CHANNELS.signIn);
const option = () => screen.getByRole("checkbox", { name: /Also sign in GitHub CLI/ });

function renderTab() {
  render(
    <SettingsValidationProvider>
      <GitHubSettingsTab />
    </SettingsValidationProvider>
  );
}

function saveToken(tick: boolean, via: "click" | "enter" = "click") {
  const field = screen.getByLabelText(/github personal access token/i);
  fireEvent.change(field, { target: { value: `  ${TOKEN}  ` } });
  expect(option().getAttribute("aria-checked")).toBe("false");
  if (tick) fireEvent.click(option());
  if (via === "enter") fireEvent.keyDown(field, { key: "Enter" });
  else fireEvent.click(screen.getByRole("button", { name: "Save token" }));
}

async function confirmReplace() {
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Sign in GitHub CLI" }));
}

describe("gh sign-in from the github.com token save", () => {
  it("leaves gh alone when the option isn't ticked", async () => {
    renderTab();
    saveToken(false);

    await screen.findByText("Checked and saved");
    expect(ghCalls()).toHaveLength(0);
  });

  it("describes the option on the checkbox itself: same token, same rights, this machine", () => {
    renderTab();
    const describedBy = option().getAttribute("aria-describedby") ?? "";
    const description = describedBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toContain(
      "gh will hold this same token, with the same rights, so anything on this machine that uses gh gets them."
    );
  });

  it("signs gh in on a fresh host after the save's own feedback, sending only a digest", async () => {
    const status = deferred<unknown>();
    ghStatus = status.promise;
    renderTab();
    saveToken(true, "enter");

    // The save stands on its own while gh is still being checked.
    await screen.findByText("Checked and saved");
    expect(signInCalls()).toHaveLength(0);
    status.resolve({ ok: true, signedIn: false });

    await screen.findByText(FRESH);
    expect(setCredential).toHaveBeenCalledWith("daintree.github.github", { token: TOKEN });
    expect(channelCalls(GH_SIGN_IN_CHANNELS.status)[0]![2]).toEqual({ host: "github.com" });
    expect(signInCalls()[0]![2]).toEqual({
      host: "github.com",
      tokenDigest: DIGEST,
      expected: { signedIn: false },
    });
    expect(JSON.stringify(ghCalls())).not.toContain(TOKEN);
    // The option is a per-save choice.
    expect(option().getAttribute("aria-checked")).toBe("false");
  });

  it.each([
    ["a refusal without a message", { valid: false }],
    ["a refusal with one", { valid: false, error: "Bad credentials" }],
  ])("does nothing to gh after %s", async (_label, validation) => {
    setCredential.mockResolvedValue(validation);
    renderTab();
    saveToken(true);

    await waitFor(() =>
      expect(
        screen.getByLabelText(/github personal access token/i).getAttribute("aria-invalid")
      ).toBe("true")
    );
    expect(ghCalls()).toHaveLength(0);
  });

  it("does nothing to gh when the save itself fails", async () => {
    setCredential.mockRejectedValue(new Error("ipc down"));
    renderTab();
    saveToken(true);

    await screen.findAllByText("Couldn't save token");
    expect(ghCalls()).toHaveLength(0);
  });

  it("names gh's current account and the incoming one, and asks before replacing", async () => {
    ghStatus = signedInAs("alice");
    renderTab();
    saveToken(true);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("h2")!.textContent).toBe(
      "Replace GitHub CLI's sign-in for @alice?"
    );
    expect(dialog.textContent).toContain("is signed in to github.com as @alice.");
    expect(dialog.textContent).toContain(
      "the token you just saved as @octocat, which gh then uses"
    );
    expect(signInCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Sign in GitHub CLI" }));

    await screen.findByText(FRESH);
    expect(signInCalls()[0]![2]).toEqual({
      host: "github.com",
      tokenDigest: DIGEST,
      expected: { signedIn: true, account: "alice", accounts: ["alice"] },
    });
  });

  it("says when gh also holds an older token for the incoming account", async () => {
    ghStatus = signedInAs("alice", ["alice", "octocat"]);
    renderTab();
    saveToken(true);

    expect((await screen.findByRole("dialog")).textContent).toContain(
      "gh also holds an older token for @octocat, which this replaces."
    );
  });

  it("asks about the same account too, and replaces its token on confirm", async () => {
    ghStatus = signedInAs("OctoCat");
    renderTab();
    saveToken(true);

    expect((await screen.findByRole("dialog")).querySelector("h2")!.textContent).toBe(
      "Replace GitHub CLI's token for @OctoCat?"
    );
    expect(signInCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Sign in GitHub CLI" }));

    await screen.findByText(FRESH);
    expect(signInCalls()[0]![2]).toMatchObject({
      tokenDigest: DIGEST,
      expected: { signedIn: true, account: "OctoCat" },
    });
  });

  it("says plainly when it can't tell which account the token is", async () => {
    setCredential.mockResolvedValue({ valid: true, scopes: ["repo"] });
    ghStatus = signedInAs(null);
    renderTab();
    saveToken(true);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "already has a sign-in for github.com that it doesn't name"
    );
    expect(dialog.textContent).toContain(
      "Daintree couldn't tell which account that token belongs to."
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in GitHub CLI" }));

    await screen.findByText(
      "GitHub CLI on this machine is signed in to github.com with the saved token."
    );
  });

  it("leaves gh as it was when the person cancels", async () => {
    ghStatus = signedInAs("alice");
    renderTab();
    saveToken(true);

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await screen.findByText("GitHub CLI wasn't changed.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((option() as HTMLButtonElement).disabled).toBe(false);
    expect(signInCalls()).toHaveLength(0);
  });

  it("asks again when another sign-in landed while the person decided", async () => {
    ghStatus = signedInAs("alice");
    ghSignIn = [
      {
        ok: false,
        reason: "gh-changed",
        current: { signedIn: true, account: "bob", accounts: ["bob"] },
      },
      { ok: true, gitConfigured: true },
    ];
    renderTab();
    saveToken(true);

    await confirmReplace();
    await waitFor(() =>
      expect(screen.getByRole("dialog").querySelector("h2")!.textContent).toContain("@bob")
    );
    expect(signInCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Sign in GitHub CLI" }));

    await screen.findByText(FRESH);
    expect(signInCalls()[1]![2]).toMatchObject({
      expected: { signedIn: true, account: "bob", accounts: ["bob"] },
    });
  });

  it("drops an earlier ticked save's gh work when a later save goes ahead unticked", async () => {
    const status = deferred<unknown>();
    ghStatus = status.promise;
    renderTab();
    saveToken(true);
    await screen.findByText("Checked and saved");

    saveToken(false);
    await waitFor(() => expect(setCredential).toHaveBeenCalledTimes(2));
    status.resolve({ ok: true, signedIn: false });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(signInCalls()).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((option() as HTMLButtonElement).disabled).toBe(false);
  });

  it("still shows a sign-in already handed to gh when a later save goes ahead unticked", async () => {
    const signIn = deferred<unknown>();
    ghSignIn = [signIn.promise];
    renderTab();
    saveToken(true);
    await waitFor(() => expect(signInCalls()).toHaveLength(1));

    saveToken(false);
    await waitFor(() => expect(setCredential).toHaveBeenCalledTimes(2));
    signIn.resolve({ ok: true, gitConfigured: true });

    await screen.findByText(FRESH);
  });

  it("drops gh work in flight when the token is cleared", async () => {
    const status = deferred<unknown>();
    ghStatus = status.promise;
    renderTab();
    saveToken(true);
    await screen.findByText("Checked and saved");

    fireEvent.click(screen.getByRole("button", { name: "Clear token" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getAllByRole("button", { name: "Clear token" }).at(-1)!);
    await waitFor(() => expect(clearCredential).toHaveBeenCalled());
    status.resolve({ ok: false, reason: "cli-not-found" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByText(MISSING_GH)).toBeNull();
    expect(signInCalls()).toHaveLength(0);
  });

  it("reports a missing gh while the save stands", async () => {
    ghStatus = { ok: false, reason: "cli-not-found" };
    renderTab();
    saveToken(true);

    await screen.findByText(MISSING_GH);
    expect(screen.getByText("Checked and saved")).toBeTruthy();
    expect(clearCredential).not.toHaveBeenCalled();
    expect(setCredential).toHaveBeenCalledTimes(1);
    expect(signInCalls()).toHaveLength(0);
  });

  it.each([
    [["read:org"], "gh needs the read:org scope."],
    [["repo", "workflow"], "gh needs the repo and workflow scopes."],
  ])("reports the scopes gh says the token lacks: %j", async (missingScopes, text) => {
    ghSignIn = [{ ok: false, reason: "missing-scopes", missingScopes }];
    renderTab();
    saveToken(true);

    await screen.findByText(`The token is saved in Daintree, but GitHub CLI refused it: ${text}`);
  });

  it("keeps a result past the save confirmation's timer", async () => {
    ghStatus = { ok: false, reason: "cli-not-found" };
    renderTab();
    saveToken(true);
    await screen.findByText(MISSING_GH);
    expect(screen.getByText("Checked and saved")).toBeTruthy();

    await waitFor(() => expect(screen.queryByText("Checked and saved")).toBeNull(), {
      timeout: 6000,
    });
    expect(screen.getByText(MISSING_GH)).toBeTruthy();
  }, 10_000);
});

function renderEnterprise() {
  render(<GitHubEnterpriseSection isGhAvailable={false} onTokenChanged={vi.fn()} />);
}

async function typeEnterpriseToken(host: string, tick: boolean) {
  fireEvent.change(await screen.findByLabelText(`Personal access token for ${host}`), {
    target: { value: TOKEN },
  });
  if (tick) fireEvent.click(option());
}

describe("gh sign-in from the Enterprise Server token save", () => {
  it("signs gh in to the Enterprise Server host after saving there", async () => {
    enterpriseHosts = ["ghe.example.com"];
    renderEnterprise();
    await typeEnterpriseToken("ghe.example.com", true);
    fireEvent.click(screen.getByRole("button", { name: "Save Enterprise Server token" }));

    await screen.findByText(
      "GitHub CLI on this machine is signed in to ghe.example.com as @corp-me."
    );
    expect(channelCalls(ENTERPRISE_CHANNELS.saveToken)[0]![2]).toEqual({
      token: TOKEN,
      host: "ghe.example.com",
    });
    expect(channelCalls(ENTERPRISE_CHANNELS.testToken)).toHaveLength(0);
    const order = invoke.mock.calls.map(([, channel]) => channel);
    expect(order.indexOf(ENTERPRISE_CHANNELS.saveToken)).toBeLessThan(
      order.indexOf(GH_SIGN_IN_CHANNELS.status)
    );
    expect(channelCalls(GH_SIGN_IN_CHANNELS.status)[0]![2]).toEqual({ host: "ghe.example.com" });
    expect(signInCalls()[0]![2]).toEqual({
      host: "ghe.example.com",
      tokenDigest: DIGEST,
      expected: { signedIn: false },
    });
  });

  it("names the Enterprise Server host in the setup-git recovery", async () => {
    enterpriseHosts = ["ghe.example.com"];
    ghSignIn = [{ ok: true, gitConfigured: false }];
    renderEnterprise();
    await typeEnterpriseToken("ghe.example.com", true);
    fireEvent.click(screen.getByRole("button", { name: "Save Enterprise Server token" }));

    await screen.findByText(
      "GitHub CLI on this machine is signed in to ghe.example.com as @corp-me, but git isn't set up to use it. Run gh auth setup-git --hostname ghe.example.com there."
    );
  });

  it("leaves gh alone on Test", async () => {
    enterpriseHosts = ["ghe.example.com"];
    renderEnterprise();
    await typeEnterpriseToken("ghe.example.com", true);
    fireEvent.click(screen.getByRole("button", { name: "Test Enterprise Server token" }));

    await screen.findByText("Token works — not saved yet");
    expect(channelCalls(ENTERPRISE_CHANNELS.testToken)).toHaveLength(1);
    expect(channelCalls(ENTERPRISE_CHANNELS.saveToken)).toHaveLength(0);
    expect(ghCalls()).toHaveLength(0);
  });

  it("drops gh work for a server the form no longer points at", async () => {
    // The status read after the save finds another window moved the account.
    enterpriseHosts = ["ghe.one.example", "ghe.two.example"];
    const status = deferred<unknown>();
    ghStatus = status.promise;
    renderEnterprise();
    await typeEnterpriseToken("ghe.one.example", true);
    fireEvent.click(screen.getByRole("button", { name: "Save Enterprise Server token" }));

    await screen.findByLabelText("Personal access token for ghe.two.example");
    status.resolve(signedInAs("alice"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(signInCalls()).toHaveLength(0);
    expect((option() as HTMLButtonElement).disabled).toBe(false);
    expect(option().getAttribute("aria-checked")).toBe("false");
  });
});
