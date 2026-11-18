// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  CloudAccountCheckResult,
  CloudAccountSummary,
  CloudCredentialField,
  CloudProviderInfo,
} from "@shared/types/cloudHosts";

const { cloudClient } = vi.hoisted(() => ({
  cloudClient: {
    checkAccountCredentials: vi.fn(),
    addAccount: vi.fn(),
    replaceAccountCredentials: vi.fn(),
  },
}));
vi.mock("@/clients/cloudHostsClient", () => ({ cloudHostsClient: cloudClient }));
vi.mock("@/clients/systemClient", () => ({ systemClient: { openExternal: vi.fn() } }));

import { ConnectCloudAccountDialog } from "../ConnectCloudAccountDialog";

function field(
  id: string,
  label: string,
  input: CloudCredentialField["input"],
  options: Partial<CloudCredentialField> = {}
): CloudCredentialField {
  return { id, label, secret: true, input, required: true, help: null, ...options };
}

function provider(id: string, credentialFields: CloudCredentialField[]): CloudProviderInfo {
  return {
    id,
    name: "Acme",
    description: "",
    apiKeyUrl: "https://acme.test/keys",
    dashboardUrl: "",
    docsUrl: "",
    credentialFields,
    capabilities: {
      persistence: {
        kept: "Files",
        lost: "memory",
        retentionDays: null,
        saveRetryBilled: false,
        stoppedComputeBilled: false,
        stoppedStorageBilled: false,
      },
      typicalStartSeconds: null,
      lifetime: { kind: "none" },
      sshTrust: "pinned-from-api",
      transport: "direct",
      tunnel: null,
      provisioning: { location: "none", image: "none", network: "none", sshKey: "after-create" },
      deletion: true,
    },
    unsupportedReason: null,
  };
}

const EC2 = provider("acme.clouds.ec2", [
  field("accessKeyId", "Access key ID", "single-line", { secret: false }),
  field("secretAccessKey", "Secret access key", "single-line"),
  field("sessionToken", "Session token", "multi-line", { required: false, help: "Only for SSO" }),
]);

const GCE = provider("acme.clouds.gce", [
  field("keyFile", "Service account key", "key-file"),
  field("project", "Project", "single-line", { secret: false }),
]);

const BOAT = provider("boat", [field("apiKey", "API key", "single-line")]);

const CHECKED: CloudAccountCheckResult = {
  identity: "octocat",
  scopes: [{ scope: { kind: "personal", id: "personal", name: "Personal" }, active: true }],
};

function summary(overrides: Partial<CloudAccountSummary> = {}): CloudAccountSummary {
  return {
    id: "ca_0123456789",
    providerId: "acme.clouds.gce",
    providerUnavailable: null,
    displayName: "Build",
    identity: "octocat",
    billingScope: { kind: "personal", id: "personal", name: "Personal" },
    validation: { status: "valid", checkedAt: 1 },
    hostCount: 0,
    addedAt: 1,
    keyHint: null,
    ...overrides,
  };
}

const KEY_FILE_TEXT = [
  "{",
  '  "type": "service_account",',
  '  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n"',
  "}",
  "",
].join("\n");

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const isDisabled = (element: HTMLElement) =>
  element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";

function type(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function chooseFile(testId: string, file: File) {
  fireEvent.change(screen.getByTestId(testId), { target: { files: [file] } });
}

beforeEach(() => {
  cloudClient.checkAccountCredentials.mockResolvedValue(CHECKED);
  cloudClient.addAccount.mockImplementation(async () => summary());
  cloudClient.replaceAccountCredentials.mockImplementation(async () => summary());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fromPlugin(
  base: CloudProviderInfo,
  plugin: Partial<NonNullable<CloudProviderInfo["plugin"]>> = {}
): CloudProviderInfo {
  return {
    ...base,
    plugin: {
      pluginId: "acme.clouds",
      pluginName: "Acme Clouds",
      fingerprint: "fp-1",
      granted: false,
      providerNames: ["Acme", "Acme GCE"],
      ...plugin,
    },
  };
}

describe("ConnectCloudAccountDialog for a plugin's provider", () => {
  it("names the plugin and what it gets before any field, and sends nothing when declined", () => {
    const onClose = vi.fn();
    render(<ConnectCloudAccountDialog isOpen onClose={onClose} provider={fromPlugin(EC2)} />);
    const consent = screen.getByTestId("cloud-provider-consent-dialog");
    expect(consent.textContent).toContain("Acme Clouds");
    expect(consent.textContent).toContain("acme.clouds");
    const terms = [
      ...screen.getByTestId("cloud-provider-consent-terms").querySelectorAll("li"),
    ].map((item) => item.textContent);
    expect(terms).toHaveLength(3);
    expect(terms[0]).toMatch(/credentials you enter/);
    // Connecting also resumes any of its accounts already saved here.
    expect(terms[0]).toMatch(/saved for any of its accounts/);
    expect(terms[1]).toMatch(/machines Daintree connects to.*vouches for their identity/);
    expect(terms[2]).toMatch(/bill your own account/);
    // The plugin's other providers are named as covered too.
    expect(consent.textContent).toContain("Acme GCE");
    expect(screen.queryByTestId("cloud-account-credential-accessKeyId")).toBeNull();

    fireEvent.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cloudClient.checkAccountCredentials).not.toHaveBeenCalled();
    expect(cloudClient.addAccount).not.toHaveBeenCalled();
    expect(cloudClient.replaceAccountCredentials).not.toHaveBeenCalled();
  });

  it("sends what was agreed to with the check and the connect once allowed", async () => {
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={fromPlugin(EC2)} />);
    fireEvent.click(button("Allow and continue"));
    type("cloud-account-credential-accessKeyId", "AKIAEXAMPLE0001");
    type("cloud-account-credential-secretAccessKey", "secret-access-key");
    fireEvent.click(button("Check credentials"));
    await screen.findByRole("radio", { name: /Personal/ });
    const entered = { accessKeyId: "AKIAEXAMPLE0001", secretAccessKey: "secret-access-key" };
    expect(cloudClient.checkAccountCredentials).toHaveBeenLastCalledWith(
      "acme.clouds.ec2",
      entered,
      "fp-1"
    );
    fireEvent.click(button("Connect account"));
    await waitFor(() => expect(cloudClient.addAccount).toHaveBeenCalled());
    expect(cloudClient.addAccount.mock.calls[0]![0]).toMatchObject({
      providerId: "acme.clouds.ec2",
      credentials: entered,
      consent: "fp-1",
    });
  });

  it("asks nothing of a plugin already allowed, and asks again once what it declares changes", () => {
    const { rerender } = render(
      <ConnectCloudAccountDialog
        isOpen
        onClose={() => {}}
        provider={fromPlugin(EC2, { granted: true })}
      />
    );
    expect(screen.queryByTestId("cloud-provider-consent-dialog")).toBeNull();
    type("cloud-account-credential-accessKeyId", "AKIAEXAMPLE0001");

    rerender(
      <ConnectCloudAccountDialog
        isOpen
        onClose={() => {}}
        provider={fromPlugin(EC2, { fingerprint: "fp-2", granted: false })}
      />
    );
    expect(screen.getByTestId("cloud-provider-consent-dialog")).toBeTruthy();
    expect(screen.queryByTestId("cloud-account-credential-accessKeyId")).toBeNull();
  });

  it("starts over when what the plugin declares changes after it was allowed here", async () => {
    const { rerender } = render(
      <ConnectCloudAccountDialog isOpen onClose={() => {}} provider={fromPlugin(EC2)} />
    );
    fireEvent.click(button("Allow and continue"));
    type("cloud-account-credential-accessKeyId", "AKIAEXAMPLE0001");
    type("cloud-account-credential-secretAccessKey", "secret-access-key");
    fireEvent.click(button("Check credentials"));
    await screen.findByRole("radio", { name: /Personal/ });

    rerender(
      <ConnectCloudAccountDialog
        isOpen
        onClose={() => {}}
        provider={fromPlugin(EC2, { fingerprint: "fp-2" })}
      />
    );
    // Agreement to the old declarations answers for nothing: asked again.
    expect(screen.getByTestId("cloud-provider-consent-dialog")).toBeTruthy();
    fireEvent.click(button("Allow and continue"));
    // Nothing entered or checked under the old ones carries over.
    expect(
      (screen.getByTestId("cloud-account-credential-accessKeyId") as HTMLInputElement).value
    ).toBe("");
    expect(screen.queryByRole("radio", { name: /Personal/ })).toBeNull();
    type("cloud-account-credential-accessKeyId", "AKIAEXAMPLE0002");
    type("cloud-account-credential-secretAccessKey", "another-secret");
    fireEvent.click(button("Check credentials"));
    await screen.findByRole("radio", { name: /Personal/ });
    expect(cloudClient.checkAccountCredentials).toHaveBeenLastCalledWith(
      "acme.clouds.ec2",
      { accessKeyId: "AKIAEXAMPLE0002", secretAccessKey: "another-secret" },
      "fp-2"
    );
  });

  it("asks before replacing the credentials of an account whose plugin isn't allowed now", async () => {
    render(
      <ConnectCloudAccountDialog
        isOpen
        onClose={() => {}}
        provider={fromPlugin(GCE, { fingerprint: "fp-2" })}
        replacing={summary()}
      />
    );
    fireEvent.click(button("Allow and continue"));
    chooseFile("cloud-account-credential-keyFile", new File([KEY_FILE_TEXT], "new-key.json"));
    await screen.findByText("new-key.json");
    type("cloud-account-credential-project", "acme-build");
    fireEvent.click(button("Replace credentials"));
    await waitFor(() => expect(cloudClient.replaceAccountCredentials).toHaveBeenCalled());
    expect(cloudClient.replaceAccountCredentials.mock.calls[0]![2]).toBe("fp-2");
  });
});

describe("ConnectCloudAccountDialog", () => {
  it("asks for each declared field in order, masking secrets and naming what's optional", () => {
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={EC2} />);
    const labels = [...document.querySelectorAll("label")].map((label) => label.textContent);
    expect(labels).toEqual(["Access key ID", "Secret access key", "Session token (optional)"]);
    expect(
      (screen.getByTestId("cloud-account-credential-accessKeyId") as HTMLInputElement).type
    ).toBe("text");
    expect(
      (screen.getByTestId("cloud-account-credential-secretAccessKey") as HTMLInputElement).type
    ).toBe("password");
    expect(screen.getByTestId("cloud-account-credential-sessionToken").tagName).toBe("TEXTAREA");
    expect(screen.getByText("Only for SSO")).toBeTruthy();
  });

  it("checks only once every required value is in, and connects with the scopes of the set it checked last", async () => {
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={EC2} />);
    expect(isDisabled(button("Check credentials"))).toBe(true);
    type("cloud-account-credential-accessKeyId", "  AKIAEXAMPLE0001 ");
    expect(isDisabled(button("Check credentials"))).toBe(true);
    type("cloud-account-credential-secretAccessKey", "secret-access-key");
    type("cloud-account-credential-sessionToken", "  \n ");
    fireEvent.click(button("Check credentials"));
    await screen.findByRole("radio", { name: /Personal/ });
    // One-line values trimmed; an optional value that's only whitespace left out.
    expect(cloudClient.checkAccountCredentials).toHaveBeenLastCalledWith("acme.clouds.ec2", {
      accessKeyId: "AKIAEXAMPLE0001",
      secretAccessKey: "secret-access-key",
    });

    cloudClient.checkAccountCredentials.mockResolvedValueOnce({
      identity: "octocat",
      scopes: [{ scope: { kind: "organization", id: "team_1", name: "Acme" }, active: true }],
    });
    const token = "  line one\nline two\n";
    type("cloud-account-credential-sessionToken", token);
    // An edit after the check voids it: the set must be checked again before it can connect.
    expect(screen.queryByRole("radio", { name: /Personal/ })).toBeNull();
    fireEvent.click(button("Check credentials"));
    await screen.findByRole("radio", { name: /Acme/ });
    expect(screen.queryByRole("radio", { name: /Personal/ })).toBeNull();
    const latest = {
      accessKeyId: "AKIAEXAMPLE0001",
      secretAccessKey: "secret-access-key",
      // Text over several lines goes as it was typed.
      sessionToken: token,
    };
    expect(cloudClient.checkAccountCredentials).toHaveBeenLastCalledWith("acme.clouds.ec2", latest);
    fireEvent.click(button("Connect account"));
    await waitFor(() => expect(cloudClient.addAccount).toHaveBeenCalled());
    expect(cloudClient.addAccount.mock.calls[0]![0]).toEqual({
      providerId: "acme.clouds.ec2",
      credentials: latest,
      scopeId: "team_1",
      displayName: undefined,
    });
  });

  it("sends a chosen key file exactly as read and shows only its name", async () => {
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={GCE} />);
    expect(button("Choose file for Service account key")).toBeTruthy();
    chooseFile(
      "cloud-account-credential-keyFile",
      new File([KEY_FILE_TEXT], "build-key.json", { type: "application/json" })
    );
    await screen.findByText("build-key.json");
    expect(button("Choose another file for Service account key")).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    const shown = [
      dialog.textContent ?? "",
      ...[...dialog.querySelectorAll("input, textarea")].map((control) =>
        control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement
          ? control.value
          : ""
      ),
    ].join("\n");
    expect(shown).not.toContain("PRIVATE KEY");
    type("cloud-account-credential-project", "acme-build");
    fireEvent.click(button("Check credentials"));
    await screen.findByRole("radio", { name: /Personal/ });
    expect(cloudClient.checkAccountCredentials).toHaveBeenCalledWith("acme.clouds.gce", {
      keyFile: KEY_FILE_TEXT,
      project: "acme-build",
    });
  });

  it("describes a project scope by its id, and names the account after it by default", async () => {
    cloudClient.checkAccountCredentials.mockResolvedValueOnce({
      identity: "daintree@key-home.iam.gserviceaccount.com",
      scopes: [
        { scope: { kind: "project", id: "acme-build", name: "Acme Build" }, active: true },
        { scope: { kind: "organization", id: "org_1", name: "Acme Org" }, active: false },
      ],
    });
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={GCE} />);
    chooseFile(
      "cloud-account-credential-keyFile",
      new File([KEY_FILE_TEXT], "build-key.json", { type: "application/json" })
    );
    await screen.findByText("build-key.json");
    type("cloud-account-credential-project", "acme-build");
    fireEvent.click(button("Check credentials"));
    const project = await screen.findByRole("radio", { name: /Acme Build/ });
    const row = (radio: HTMLElement) => radio.closest("label")?.textContent ?? "";
    expect(row(project)).toContain("Project acme-build: machines are created and billed here");
    expect(row(screen.getByRole("radio", { name: /Acme Org/ }))).toContain(
      "An organization you belong to"
    );
    expect(screen.getByPlaceholderText("Acme Build")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Acme Org/ }));
    expect(screen.getByPlaceholderText("Acme Org")).toBeTruthy();
  });

  it("drops the file it held when the next one can't be used", async () => {
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={GCE} />);
    type("cloud-account-credential-project", "acme-build");
    chooseFile("cloud-account-credential-keyFile", new File([KEY_FILE_TEXT], "build-key.json"));
    await screen.findByText("build-key.json");
    expect(isDisabled(button("Check credentials"))).toBe(false);
    chooseFile("cloud-account-credential-keyFile", new File(["x".repeat(65 * 1024)], "huge.json"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/larger than a key file/);
    expect(screen.queryByText("build-key.json")).toBeNull();
    expect(isDisabled(button("Check credentials"))).toBe(true);
  });

  it("sends nothing without an optional file that couldn't be used until it's cleared", async () => {
    const optionalFile = provider("acme.clouds.gce", [
      field("project", "Project", "single-line", { secret: false }),
      field("keyFile", "Service account key", "key-file", { required: false }),
    ]);
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={optionalFile} />);
    type("cloud-account-credential-project", "acme-build");
    expect(isDisabled(button("Check credentials"))).toBe(false);
    chooseFile("cloud-account-credential-keyFile", new File(["  \n"], "blank.json"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/empty/);
    // The picker is the field's control: its label names it and its error describes it.
    const picker = button("Choose file for Service account key");
    const label = [...document.querySelectorAll("label")].find(
      (candidate) => candidate.textContent === "Service account key (optional)"
    );
    expect(label?.control).toBe(picker);
    expect(picker.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(isDisabled(button("Check credentials"))).toBe(true);
    const project = screen.getByTestId("cloud-account-credential-project");
    fireEvent.keyDown(project, { key: "Enter" });
    expect(cloudClient.checkAccountCredentials).not.toHaveBeenCalled();
    fireEvent.click(button("Clear Service account key"));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.keyDown(project, { key: "Enter" });
    await screen.findByRole("radio", { name: /Personal/ });
    expect(cloudClient.checkAccountCredentials).toHaveBeenCalledWith("acme.clouds.gce", {
      project: "acme-build",
    });
  });

  it("says a file couldn't be read, even when the failure has no words of its own", async () => {
    const optionalFile = provider("acme.clouds.gce", [
      field("project", "Project", "single-line", { secret: false }),
      field("keyFile", "Service account key", "key-file", { required: false }),
    ]);
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={optionalFile} />);
    type("cloud-account-credential-project", "acme-build");
    const unreadable = (said: string) => {
      const file = new File(["{}"], "locked.json");
      Object.defineProperty(file, "text", { value: () => Promise.reject(new Error(said)) });
      return file;
    };
    chooseFile("cloud-account-credential-keyFile", unreadable(" \t "));
    expect((await screen.findByRole("alert")).textContent).toBe("That file couldn't be read");
    expect(isDisabled(button("Check credentials"))).toBe(true);
    chooseFile("cloud-account-credential-keyFile", unreadable("Permission denied"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Permission denied"));
    expect(isDisabled(button("Check credentials"))).toBe(true);
  });

  it("checks nothing for a provider whose every field is optional until one is filled in", () => {
    const optional = provider("acme.clouds.do", [
      field("token", "Token", "single-line", { required: false }),
    ]);
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={optional} />);
    expect(isDisabled(button("Check key"))).toBe(true);
    type("cloud-account-credential-token", "   ");
    expect(isDisabled(button("Check key"))).toBe(true);
    type("cloud-account-credential-token", "dop_v1_token");
    expect(isDisabled(button("Check key"))).toBe(false);
  });

  it("replaces an account's whole set", async () => {
    const onClose = vi.fn();
    render(
      <ConnectCloudAccountDialog isOpen onClose={onClose} provider={GCE} replacing={summary()} />
    );
    expect(screen.getByRole("heading").textContent).toBe("Replace the credentials for 'Build'");
    chooseFile("cloud-account-credential-keyFile", new File([KEY_FILE_TEXT], "new-key.json"));
    await screen.findByText("new-key.json");
    type("cloud-account-credential-project", "acme-build");
    fireEvent.click(button("Replace credentials"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(cloudClient.replaceAccountCredentials).toHaveBeenCalledWith("ca_0123456789", {
      keyFile: KEY_FILE_TEXT,
      project: "acme-build",
    });
  });

  it("keeps a one-key provider's form as it was, refusal and all", async () => {
    cloudClient.checkAccountCredentials.mockRejectedValueOnce(
      Object.assign(new Error("refused"), {
        name: "AppError",
        code: "PERMISSION",
        userMessage: "Boat didn't accept this account's API key.",
      })
    );
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={BOAT} />);
    type("cloud-account-api-key", "boat_e2e_wrong_key");
    fireEvent.click(button("Check key"));
    expect((await screen.findByRole("alert")).textContent).toContain("didn't accept");
    type("cloud-account-api-key", " boat_live_0123456789abcd ");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(button("Check key"));
    fireEvent.click(await screen.findByRole("button", { name: "Connect account" }));
    await waitFor(() => expect(cloudClient.addAccount).toHaveBeenCalled());
    expect(cloudClient.checkAccountCredentials.mock.calls).toEqual([
      ["boat", { apiKey: "boat_e2e_wrong_key" }],
      ["boat", { apiKey: "boat_live_0123456789abcd" }],
    ]);
    expect(cloudClient.addAccount.mock.calls[0]![0]).toMatchObject({
      providerId: "boat",
      credentials: { apiKey: "boat_live_0123456789abcd" },
      scopeId: "personal",
    });
  });
});
