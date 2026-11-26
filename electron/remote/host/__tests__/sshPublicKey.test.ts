// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parsePublicKeyFile } from "../sshPublicKey.js";
import { FIXTURE_KEYS } from "./sshKeyFixtures.js";

function wire(...fields: Buffer[]): string {
  return Buffer.concat(
    fields.flatMap((field) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(field.length);
      return [length, field];
    })
  ).toString("base64");
}

describe("parsePublicKeyFile", () => {
  it.each(Object.entries(FIXTURE_KEYS))("fingerprints %s as ssh-keygen does", (type, key) => {
    const parsed = parsePublicKeyFile(`${key.line}\n`);
    expect(parsed?.fingerprint, type).toBe(key.fingerprint);
    // The comment is the file's, not the key's.
    expect(parsed?.publicKey).toBe(key.line.split(" ").slice(0, 2).join(" "));
  });

  it("skips blank and comment lines before the key", () => {
    const parsed = parsePublicKeyFile(`\n# host key\n${FIXTURE_KEYS.ed25519.line}`);
    expect(parsed?.type).toBe("ssh-ed25519");
  });

  it("refuses a blob that holds only its type name", () => {
    expect(parsePublicKeyFile(`ssh-ed25519 ${wire(Buffer.from("ssh-ed25519"))}`)).toBeNull();
  });

  it("refuses a key with trailing data, a short key, or a blob naming another type", () => {
    const name = Buffer.from("ssh-ed25519");
    expect(
      parsePublicKeyFile(`ssh-ed25519 ${wire(name, Buffer.alloc(32, 1), Buffer.from("x"))}`)
    ).toBeNull();
    expect(parsePublicKeyFile(`ssh-ed25519 ${wire(name, Buffer.alloc(31, 1))}`)).toBeNull();
    const [, rsaBlob] = FIXTURE_KEYS.rsa.line.split(" ");
    expect(parsePublicKeyFile(`ssh-ed25519 ${rsaBlob}`)).toBeNull();
    expect(parsePublicKeyFile(`ssh-ed25519 ${wire(name, Buffer.alloc(32, 1))}`)).not.toBeNull();
  });

  it("refuses an unknown type, bad base64, and a private key", () => {
    expect(parsePublicKeyFile(`ssh-foo ${wire(Buffer.from("ssh-foo"))}`)).toBeNull();
    expect(parsePublicKeyFile("ssh-ed25519 not*base64")).toBeNull();
    expect(
      parsePublicKeyFile("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n")
    ).toBeNull();
    expect(parsePublicKeyFile("")).toBeNull();
  });
});
