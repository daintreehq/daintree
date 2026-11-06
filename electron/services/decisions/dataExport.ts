import { exportDecisions, importIdentity, type LocalStore } from "@daintreehq/decisions-client";
import type { DecisionsExportResult } from "../../../shared/types/decisions.js";
import { keyReadFailure, type SealedKeyStore } from "./keyStore.js";

/** The parts of the sealed key store an export uses: reading the identity, never changing it. */
export type ExportKeyStore = Pick<SealedKeyStore, "load">;

/** An encrypted archive ready to be written, with what it holds. */
export interface DecisionsArchive {
  fileName: string;
  text: string;
  questions: number;
  auditEvents: number;
}

export type DecisionsExportFailure = Exclude<
  DecisionsExportResult,
  { result: "saved" } | { result: "cancelled" }
>;

/**
 * The store as the library reads it for an export, counting what each read
 * hands over, so the counts reported are of exactly the records archived.
 */
function counting(
  store: LocalStore,
  counts: { questions: number; auditEvents: number }
): LocalStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "listQuestions") {
        return async (...args: Parameters<LocalStore["listQuestions"]>) => {
          const rows = await target.listQuestions(...args);
          counts.questions = rows.length;
          return rows;
        };
      }
      if (property === "listAudit") {
        return async (...args: Parameters<LocalStore["listAudit"]>) => {
          const entries = await target.listAudit(...args);
          counts.auditEvents = entries.length;
          return entries;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
}

/**
 * Builds the encrypted decision history archive (#16025) with the library's
 * `exportDecisions`: every stored question with its content and verified
 * answers, and the audit log, opened with this computer's epoch keys and
 * encrypted again under the passphrase. Reads the keys (which may show the
 * keychain's prompt) and the store; sends nothing anywhere, so the paired
 * devices' public keys, which only the relay lists, aren't in it. Content
 * that can't be opened fails the export rather than being left out.
 */
export async function buildDecisionsArchive(options: {
  store: LocalStore;
  keys: ExportKeyStore;
  passphrase: string;
}): Promise<{ archive: DecisionsArchive } | { failure: DecisionsExportFailure }> {
  let stored;
  try {
    stored = await options.keys.load();
  } catch (error) {
    const failure = keyReadFailure(error);
    if (failure) return { failure: { result: "key-storage", ...failure } };
    throw error;
  }
  // An unfinished claim's keys were never confirmed, so nothing is sealed under them.
  if (!stored || stored.claimed === false) return { failure: { result: "no-identity" } };
  const identity = await importIdentity(stored);
  const counts = { questions: 0, auditEvents: 0 };
  const exported = await exportDecisions({
    store: counting(options.store, counts),
    identity,
    passphrase: options.passphrase,
  });
  if (!exported.encrypted) throw new Error("The Decisions export came back unencrypted");
  return {
    archive: {
      fileName: exported.fileName,
      text: JSON.stringify(exported.data),
      questions: counts.questions,
      auditEvents: counts.auditEvents,
    },
  };
}
