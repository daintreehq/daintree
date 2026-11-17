// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      },
      typicalStartSeconds: null,
      lifetime: { kind: "none" },
      sshTrust: "pinned-from-api",
      transport: "direct",
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

  it("checks only once every required value is in, and sends the set without blank ones", async () => {
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={EC2} />);
    expect(isDisabled(button("Check credentials"))).toBe(true);
    type("cloud-account-credential-accessKeyId", "  AKIAEXAMPLE0001 ");
    expect(isDisabled(button("Check credentials"))).toBe(true);
    type("cloud-account-credential-secretAccessKey", "secret-access-key");
    fireEvent.click(button("Check credentials"));
    await screen.findByRole("radio", { name: /Personal/ });
    expect(cloudClient.checkAccountCredentials).toHaveBeenCalledWith("acme.clouds.ec2", {
      accessKeyId: "AKIAEXAMPLE0001",
      secretAccessKey: "secret-access-key",
    });

    const token = "line one\nline two";
    type("cloud-account-credential-sessionToken", token);
    // An edit after the check voids it: the set must be checked again before it can connect.
    expect(screen.queryByRole("radio", { name: /Personal/ })).toBeNull();
    fireEvent.click(button("Check credentials"));
    fireEvent.click(await screen.findByRole("button", { name: "Connect account" }));
    await waitFor(() => expect(cloudClient.addAccount).toHaveBeenCalled());
    expect(cloudClient.addAccount.mock.calls[0]![0]).toEqual({
      providerId: "acme.clouds.ec2",
      credentials: {
        accessKeyId: "AKIAEXAMPLE0001",
        secretAccessKey: "secret-access-key",
        sessionToken: token,
      },
      scopeId: "personal",
      displayName: undefined,
    });
  });

  it("sends a chosen key file exactly as read and shows only its name", async () => {
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={GCE} />);
    chooseFile(
      "cloud-account-credential-keyFile",
      new File([KEY_FILE_TEXT], "build-key.json", { type: "application/json" })
    );
    await screen.findByText("build-key.json");
    expect(screen.getByRole("dialog").textContent).not.toContain("PRIVATE KEY");
    type("cloud-account-credential-project", "acme-build");
    fireEvent.click(button("Check credentials"));
    await screen.findByRole("radio", { name: /Personal/ });
    expect(cloudClient.checkAccountCredentials).toHaveBeenCalledWith("acme.clouds.gce", {
      keyFile: KEY_FILE_TEXT,
      project: "acme-build",
    });
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

  it("ignores a check that comes back after the set was edited", async () => {
    let answer: (result: CloudAccountCheckResult) => void = () => {};
    cloudClient.checkAccountCredentials.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    );
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={EC2} />);
    type("cloud-account-credential-accessKeyId", "AKIAEXAMPLE0001");
    type("cloud-account-credential-secretAccessKey", "secret-one");
    fireEvent.click(button("Check credentials"));
    type("cloud-account-credential-secretAccessKey", "secret-two");
    await act(async () => answer(CHECKED));
    expect(screen.queryByRole("radio", { name: /Personal/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect account" })).toBeNull();
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

  it("keeps a one-key provider's form as it was", async () => {
    render(<ConnectCloudAccountDialog isOpen onClose={() => {}} provider={BOAT} />);
    type("cloud-account-api-key", " boat_live_0123456789abcd ");
    fireEvent.click(button("Check key"));
    await screen.findByRole("radio", { name: /Personal/ });
    expect(cloudClient.checkAccountCredentials).toHaveBeenCalledWith("boat", {
      apiKey: "boat_live_0123456789abcd",
    });
  });
});
