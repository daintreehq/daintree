import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { SecretCipher } from "../../../services/plugin/secretCipher.js";

vi.mock("electron", () => ({ app: undefined, safeStorage: {} }));

const { KeychainCloudCredentialVault, openCloudCredentials } =
  await import("../CloudCredentialVault.js");
const { PluginSettingsStore } = await import("../../../services/PluginSettingsStore.js");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-cloud-vault-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function fakeCipher(available = true): SecretCipher {
  return {
    tier: () => (available ? "keychain" : "unavailable"),
    encrypt: async (plaintext) =>
      available ? Buffer.from(`enc:${plaintext}`, "utf-8").toString("base64") : null,
    decrypt: async (c) => ({
      plaintext: Buffer.from(c, "base64").toString("utf-8").slice("enc:".length),
      reencrypt: false,
    }),
  };
}

const SERVICE_ACCOUNT_KEY = [
  "{",
  '  "type": "service_account",',
  '  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n"',
  "}",
  "",
].join("\n");

describe("KeychainCloudCredentialVault", () => {
  it("seals a whole set as ciphertext and reads every value back", async () => {
    const file = path.join(tmpDir, "cloud-credentials.json");
    const vault = new KeychainCloudCredentialVault(file, fakeCipher());
    const values = {
      accessKeyId: "AKIAEXAMPLE0001",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
      keyFile: SERVICE_ACCOUNT_KEY,
    };
    await vault.put("ca_abcdefgh", values);

    const onDisk = await fs.readFile(file, "utf-8");
    for (const value of Object.values(values)) expect(onDisk).not.toContain(value);
    expect(await vault.get("ca_abcdefgh")).toEqual(values);
  });

  it("replaces the whole set, so a value the new set leaves out is gone", async () => {
    const vault = new KeychainCloudCredentialVault(
      path.join(tmpDir, "cloud-credentials.json"),
      fakeCipher()
    );
    await vault.put("ca_abcdefgh", { accessKeyId: "AKIA1", sessionToken: "token-one" });
    await vault.put("ca_abcdefgh", { accessKeyId: "AKIA2" });
    expect(await vault.get("ca_abcdefgh")).toEqual({ accessKeyId: "AKIA2" });
  });

  it("reads a bare key sealed before sets as the account's API key", async () => {
    const file = path.join(tmpDir, "cloud-credentials.json");
    const cipher = fakeCipher();
    // How the vault sealed a key before sets: the bare string, as a secret.
    await new PluginSettingsStore(file, cipher).set("ca_abcdefgh", "boat_live_0123456789abcd", {
      secret: true,
    });
    const vault = new KeychainCloudCredentialVault(file, cipher);
    expect(await vault.get("ca_abcdefgh")).toEqual({ apiKey: "boat_live_0123456789abcd" });
  });

  it("refuses to write without a keychain, and stores nothing", async () => {
    const file = path.join(tmpDir, "cloud-credentials.json");
    const vault = new KeychainCloudCredentialVault(file, fakeCipher(false));
    expect(vault.available()).toBe(false);
    await expect(vault.put("ca_abcdefgh", { apiKey: "boat_live_x" })).rejects.toMatchObject({
      userMessage: expect.stringMatching(/plain text/),
    });
    expect(await vault.get("ca_abcdefgh")).toBeNull();
  });
});

describe("openCloudCredentials", () => {
  it("keeps a bare key that happens to read as JSON as the key itself", () => {
    expect(openCloudCredentials("12345678")).toEqual({ apiKey: "12345678" });
    expect(openCloudCredentials('{"accessKeyId":"AKIA1"}')).toEqual({
      apiKey: '{"accessKeyId":"AKIA1"}',
    });
  });

  it("never takes a set it can't read for a bare key", () => {
    expect(openCloudCredentials(undefined)).toBeNull();
    expect(openCloudCredentials("")).toBeNull();
    expect(openCloudCredentials('daintree-cloud-credentials/2\n{"apiKey":"sentinel"}')).toBeNull();
    expect(openCloudCredentials("daintree-cloud-credentials/1\n{not json")).toBeNull();
    expect(openCloudCredentials('daintree-cloud-credentials/1\n["sentinel"]')).toBeNull();
    expect(openCloudCredentials('daintree-cloud-credentials/1\n{"apiKey":7}')).toBeNull();
  });
});
