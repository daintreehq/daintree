/**
 * TEMPORARY — where the triage panel's provider keys live until the triage
 * backend takes a single Daintree key.
 *
 * A saved key is encrypted with the OS keychain (`safeStorage`) and kept in the
 * main store; with no keychain the save is refused rather than written in
 * plaintext. A saved key wins over the environment, which remains as the
 * developer path. Keys never cross to the renderer: it sees the source and the
 * last four characters only.
 */
import { store } from "../../store.js";
import { safeStorageCipher, type SecretCipher } from "../plugin/secretCipher.js";
import type {
  TriageKeyId,
  TriageKeyStatus,
  TriageKeysStatus,
} from "../../../shared/types/ipc/triage.js";
import { TRIAGE_ENV } from "./triageProviders.js";

type SavedKeys = { classifier?: string; describer?: string };

export interface TriageKeyStore {
  read(): SavedKeys;
  write(keys: SavedKeys): void;
}

const electronStoreBackend: TriageKeyStore = {
  read: () => store.get("triageProviderKeys") ?? {},
  write: (keys) => store.set("triageProviderKeys", keys),
};

export const TRIAGE_KEY_ENV: Record<TriageKeyId, readonly string[]> = {
  classifier: TRIAGE_ENV.classifierKey,
  describer: TRIAGE_ENV.describerKey,
};

const MAX_KEY_LENGTH = 512;

export class TriageKeys {
  constructor(
    private readonly backend: TriageKeyStore = electronStoreBackend,
    private readonly cipher: SecretCipher = safeStorageCipher,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  /** The saved key, decrypted, or null when none is saved or it can't be read. */
  saved(id: TriageKeyId): string | null {
    const ciphertext = this.backend.read()[id];
    if (!ciphertext) return null;
    try {
      const key = this.cipher.decrypt(ciphertext).trim();
      return key === "" ? null : key;
    } catch {
      // A keychain reset makes old ciphertext unreadable; treat it as unset.
      return null;
    }
  }

  fromEnvironment(id: TriageKeyId): string | null {
    for (const name of TRIAGE_KEY_ENV[id]) {
      const value = this.env[name]?.trim();
      if (value) return value;
    }
    return null;
  }

  /** The key the providers should use: saved first, then the environment. */
  effective(id: TriageKeyId): string | null {
    return this.saved(id) ?? this.fromEnvironment(id);
  }

  save(id: TriageKeyId, key: string): void {
    const trimmed = key.trim();
    if (trimmed === "" || trimmed.length > MAX_KEY_LENGTH || /\s/.test(trimmed)) {
      throw new Error("That doesn't look like an API key.");
    }
    const ciphertext = this.cipher.encrypt(trimmed);
    if (ciphertext === null) {
      throw new Error(
        "There's no system keychain to encrypt the key with, so it wasn't saved. Set it in the environment instead."
      );
    }
    this.backend.write({ ...this.backend.read(), [id]: ciphertext });
  }

  clear(id: TriageKeyId): void {
    const next = { ...this.backend.read() };
    delete next[id];
    this.backend.write(next);
  }

  status(): TriageKeysStatus {
    const describe = (id: TriageKeyId): TriageKeyStatus => {
      const saved = this.saved(id);
      if (saved) return { source: "saved", hint: saved.slice(-4) };
      const env = this.fromEnvironment(id);
      if (env) return { source: "environment", hint: env.slice(-4) };
      return { source: "none", hint: null };
    };
    return {
      storage: this.cipher.tier(),
      keys: { classifier: describe("classifier"), describer: describe("describer") },
    };
  }
}
