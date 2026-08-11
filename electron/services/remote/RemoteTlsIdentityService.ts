import * as asn1js from "asn1js";
import { createHash, createPrivateKey, randomBytes, webcrypto, X509Certificate } from "node:crypto";
import {
  AttributeTypeAndValue,
  BasicConstraints,
  Certificate,
  Extension,
  ExtKeyUsage,
  setEngine,
} from "pkijs";
import type { SecretCipher } from "../plugin/secretCipher.js";
import {
  REMOTE_IDENTITY_SCHEMA_VERSION,
  type RemoteIdentityStore,
  type StoredRemoteTlsIdentity,
} from "./RemoteIdentityStore.js";
import {
  RemoteSecureStorageUnavailableError,
  type RemoteIdentityService,
} from "./RemoteIdentityService.js";

const TLS_CERTIFICATE_LIFETIME_YEARS = 10;

export interface RemoteTlsIdentity {
  certificate: string;
  certificateFingerprint: string;
  privateKey: string;
  createdAt: number;
}

export type RemoteTlsIdentityFactory = (now: number) => Promise<RemoteTlsIdentity>;

function toPem(label: string, bytes: ArrayBuffer): string {
  const body =
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export async function generateSelfSignedRemoteTlsIdentity(
  now: number,
  createSerial: (size: number) => Buffer = randomBytes
): Promise<RemoteTlsIdentity> {
  setEngine("node-webcrypto", webcrypto as Crypto, webcrypto.subtle as SubtleCrypto);
  const keys = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );

  const certificate = new Certificate();
  certificate.version = 2;
  const serial = createSerial(16);
  if (serial.length !== 16) throw new Error("Remote TLS serial source returned an invalid length");
  serial[0] = serial[0]! & 0x7f || 1;
  certificate.serialNumber = new asn1js.Integer({ valueHex: serial });
  const commonName = new AttributeTypeAndValue({
    type: "2.5.4.3",
    value: new asn1js.Utf8String({ value: "Daintree Remote Host" }),
  });
  certificate.issuer.typesAndValues.push(commonName);
  certificate.subject.typesAndValues.push(commonName);
  certificate.notBefore.value = new Date(now - 5 * 60 * 1000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + TLS_CERTIFICATE_LIFETIME_YEARS);
  certificate.notAfter.value = notAfter;

  const keyUsage = new asn1js.BitString({ valueHex: new Uint8Array([0xa0]) });
  const basicConstraints = new BasicConstraints({ cA: false });
  const serverAuth = new ExtKeyUsage({ keyPurposes: ["1.3.6.1.5.5.7.3.1"] });
  certificate.extensions = [
    new Extension({
      extnID: "2.5.29.19",
      critical: true,
      extnValue: basicConstraints.toSchema().toBER(false),
      parsedValue: basicConstraints,
    }),
    new Extension({
      extnID: "2.5.29.15",
      critical: true,
      extnValue: keyUsage.toBER(false),
      parsedValue: keyUsage,
    }),
    new Extension({
      extnID: "2.5.29.37",
      critical: false,
      extnValue: serverAuth.toSchema().toBER(false),
      parsedValue: serverAuth,
    }),
  ];
  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
  await certificate.sign(keys.privateKey, "SHA-256");

  const certificateDer = certificate.toSchema(true).toBER(false);
  const privateKeyDer = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return {
    certificate: toPem("CERTIFICATE", certificateDer),
    certificateFingerprint: `sha256:${createHash("sha256").update(Buffer.from(certificateDer)).digest("base64url")}`,
    privateKey: toPem("PRIVATE KEY", privateKeyDer),
    createdAt: now,
  };
}

function validateTlsIdentity(identity: RemoteTlsIdentity): void {
  const certificate = new X509Certificate(identity.certificate);
  if (!certificate.checkPrivateKey(createPrivateKey(identity.privateKey))) {
    throw new Error("Stored remote TLS certificate and private key do not match");
  }
  const fingerprint = `sha256:${createHash("sha256").update(certificate.raw).digest("base64url")}`;
  if (fingerprint !== identity.certificateFingerprint) {
    throw new Error("Stored remote TLS certificate fingerprint does not match");
  }
}

export class RemoteTlsIdentityService {
  private cached: RemoteTlsIdentity | null = null;

  constructor(
    private readonly store: RemoteIdentityStore,
    private readonly identity: RemoteIdentityService,
    private readonly cipher: SecretCipher,
    private readonly factory: RemoteTlsIdentityFactory = generateSelfSignedRemoteTlsIdentity,
    private readonly now: () => number = Date.now
  ) {}

  async ensureIdentity(): Promise<RemoteTlsIdentity> {
    if (this.cached) return this.cached;
    if (this.cipher.tier() !== "keychain") throw new RemoteSecureStorageUnavailableError();
    const hostId = this.identity.publicIdentity().hostId;
    const stored = this.store.getTlsIdentity(hostId);
    if (stored) {
      this.cached = this.restore(stored);
      return this.cached;
    }

    const generated = await this.factory(this.now());
    validateTlsIdentity(generated);
    const encryptedPrivateKey = this.cipher.encrypt(generated.privateKey);
    if (encryptedPrivateKey === null) throw new RemoteSecureStorageUnavailableError();
    this.store.saveTlsIdentity({
      schemaVersion: REMOTE_IDENTITY_SCHEMA_VERSION,
      hostId,
      certificate: generated.certificate,
      certificateFingerprint: generated.certificateFingerprint,
      encryptedPrivateKey,
      createdAt: generated.createdAt,
    });
    this.cached = generated;
    return generated;
  }

  certificateFingerprint(): string {
    if (!this.cached) throw new Error("Remote TLS identity has not been initialized");
    return this.cached.certificateFingerprint;
  }

  private restore(stored: StoredRemoteTlsIdentity): RemoteTlsIdentity {
    if (stored.schemaVersion !== REMOTE_IDENTITY_SCHEMA_VERSION) {
      throw new Error(`Unsupported remote TLS identity schema version ${stored.schemaVersion}`);
    }
    const identity = {
      certificate: stored.certificate,
      certificateFingerprint: stored.certificateFingerprint,
      privateKey: this.cipher.decrypt(stored.encryptedPrivateKey),
      createdAt: stored.createdAt,
    };
    validateTlsIdentity(identity);
    return identity;
  }
}
