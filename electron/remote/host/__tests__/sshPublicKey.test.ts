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

  it("refuses a blob naming another type, its body otherwise valid", () => {
    const body = Buffer.alloc(32, 1);
    expect(parsePublicKeyFile(`ssh-ed25519 ${wire(Buffer.from("ssh-ed25518"), body)}`)).toBeNull();
  });

  // Each of these ssh-keygen -lf refuses.
  it("refuses an EC point off its curve, a toy RSA modulus, and a NUL in an application", () => {
    const point = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]);
    expect(
      parsePublicKeyFile(
        `ecdsa-sha2-nistp256 ${wire(Buffer.from("ecdsa-sha2-nistp256"), Buffer.from("nistp256"), point)}`
      )
    ).toBeNull();
    const rsa = (n: Buffer) =>
      parsePublicKeyFile(`ssh-rsa ${wire(Buffer.from("ssh-rsa"), Buffer.from([1, 0, 1]), n)}`);
    expect(rsa(Buffer.from([17]))).toBeNull();
    const [, realRsa] = FIXTURE_KEYS.rsa.line.split(" ");
    expect(parsePublicKeyFile(`ssh-rsa ${realRsa}`)).not.toBeNull();
    const sk = (application: string) =>
      parsePublicKeyFile(
        `sk-ssh-ed25519@openssh.com ${wire(
          Buffer.from("sk-ssh-ed25519@openssh.com"),
          Buffer.alloc(32, 1),
          Buffer.from(application, "latin1")
        )}`
      );
    expect(sk("ssh:\0x")).toBeNull();
    expect(sk("ssh:")).not.toBeNull();
  });

  it("refuses an inherited name as a type, and a separator OpenSSH doesn't split on", () => {
    expect(parsePublicKeyFile(`constructor ${wire(Buffer.from("constructor"))}`)).toBeNull();
    const [type, blob] = FIXTURE_KEYS.ed25519.line.split(" ");
    expect(parsePublicKeyFile(`${type}\u00a0${blob}`)).toBeNull();
    expect(parsePublicKeyFile(`${type}\t${blob}`)?.fingerprint).toBe(
      FIXTURE_KEYS.ed25519.fingerprint
    );
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
