import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import type { RemoteHostPublicIdentity } from "../../../shared/types/remote/index.js";
import { RemoteHostPublicIdentitySchema } from "../../../shared/types/remote/index.js";
import type { SecretCipher } from "../plugin/secretCipher.js";
import {
  REMOTE_IDENTITY_SCHEMA_VERSION,
  type RemoteIdentityStore,
  type StoredRemoteHostIdentity,
} from "./RemoteIdentityStore.js";

export class RemoteSecureStorageUnavailableError extends Error {
  readonly recovery = "Unlock or configure the operating-system keychain, then try again";

  constructor() {
    super("Remote access requires protected operating-system storage");
    this.name = "RemoteSecureStorageUnavailableError";
  }
}

interface RemoteHostIdentity extends RemoteHostPublicIdentity {
  privateKey: string;
}

function fingerprint(publicKey: string): string {
  return `sha256:${createHash("sha256").update(publicKey).digest("base64url")}`;
}

function generateIdentity(now: number): Omit<RemoteHostIdentity, "hostId"> & { hostId: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicFingerprint = fingerprint(publicPem);
  return {
    hostId: `host-${publicFingerprint.slice("sha256:".length, "sha256:".length + 32)}`,
    publicKey: publicPem,
    privateKey: privatePem,
    fingerprint: publicFingerprint,
    createdAt: now,
  };
}

function assertKeyPair(publicKey: string, privateKey: string): void {
  const derived = createPublicKey(createPrivateKey(privateKey))
    .export({ type: "spki", format: "pem" })
    .toString();
  if (derived !== publicKey) throw new Error("Stored remote host key pair does not match");
}

export class RemoteIdentityService {
  constructor(
    private readonly store: RemoteIdentityStore,
    private readonly cipher: SecretCipher,
    private readonly now: () => number = Date.now
  ) {}

  publicIdentity(): RemoteHostPublicIdentity {
    const identity = this.loadIdentity();
    return RemoteHostPublicIdentitySchema.parse({
      hostId: identity.hostId,
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      createdAt: identity.createdAt,
    });
  }

  signChallenge(challenge: string): string {
    const identity = this.loadIdentity();
    return sign(null, Buffer.from(challenge, "utf8"), identity.privateKey).toString("base64url");
  }

  private loadIdentity(): RemoteHostIdentity {
    if (this.cipher.tier() !== "keychain") throw new RemoteSecureStorageUnavailableError();

    const stored = this.store.getHostIdentity();
    if (stored) return this.restore(stored);

    const identity = generateIdentity(this.now());
    const encryptedPrivateKey = this.cipher.encrypt(identity.privateKey);
    if (encryptedPrivateKey === null) throw new RemoteSecureStorageUnavailableError();
    this.store.saveHostIdentity({
      schemaVersion: REMOTE_IDENTITY_SCHEMA_VERSION,
      hostId: identity.hostId,
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      encryptedPrivateKey,
      createdAt: identity.createdAt,
    });
    return identity;
  }

  private restore(stored: StoredRemoteHostIdentity): RemoteHostIdentity {
    if (stored.schemaVersion !== REMOTE_IDENTITY_SCHEMA_VERSION) {
      throw new Error(`Unsupported remote identity schema version ${stored.schemaVersion}`);
    }
    const privateKey = this.cipher.decrypt(stored.encryptedPrivateKey);
    assertKeyPair(stored.publicKey, privateKey);
    if (fingerprint(stored.publicKey) !== stored.fingerprint) {
      throw new Error("Stored remote host fingerprint does not match its public key");
    }
    return {
      hostId: stored.hostId,
      publicKey: stored.publicKey,
      fingerprint: stored.fingerprint,
      createdAt: stored.createdAt,
      privateKey,
    };
  }
}
