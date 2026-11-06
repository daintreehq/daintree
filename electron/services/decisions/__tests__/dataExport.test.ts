import { describe, expect, it, vi } from "vitest";
import {
  MemoryLocalStore,
  importDecisions,
  importIdentity,
  openAnswers,
  openQuestionContent,
  sealAnswerContent,
  sealQuestionContent,
  serializeAnswers,
  storedEntry,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import {
  generateDeviceKeys,
  generateEpochKeyBytes,
  newId,
  serializeDeviceKeys,
  type RecoveryBundleFile,
} from "@daintreehq/decisions-crypto";
import { bytesToBase64Url } from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({ app: {}, safeStorage: {}, net: {} }));

import { DecisionsKeyStoreError } from "../keyStore.js";
import { buildDecisionsArchive } from "../dataExport.js";
import { entry, row } from "./questionRows.js";

const PASSPHRASE = "a long export passphrase";
const QUESTION = "Ship the migration tonight?";
const ANSWER = "Yes, after the backup finishes";

async function storedIdentity(overrides: Partial<StoredIdentity> = {}): Promise<StoredIdentity> {
  return {
    v: 1,
    config: {
      relayOrigin: "https://relay.example.com",
      installationId: newId(),
      deviceId: newId(),
      label: "Daintree",
    },
    keys: await serializeDeviceKeys(await generateDeviceKeys(true)),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
    ...overrides,
  };
}

/** A store holding one answered question, sealed under `stored`'s keys, and two audit events. */
async function history(stored: StoredIdentity): Promise<MemoryLocalStore> {
  const ctx = { identity: await importIdentity(stored) };
  const question = row(1);
  const sealedAnswer = await sealAnswerContent(ctx, question.question_id, "entry-1", 1, {
    choices: [{ id: "yes", label: "Yes" }],
    text: ANSWER,
    reviewed_attachment_digests: [],
  });
  const store = new MemoryLocalStore();
  await store.commitNewQuestion(
    {
      ...question,
      content_sealed: await sealQuestionContent(ctx, question.question_id, {
        question: QUESTION,
        options: [{ id: "yes", label: "Yes" }],
      }),
      legacy_content_json: null,
      answers_json: serializeAnswers([storedEntry(entry({ sealed: undefined }), sealedAnswer)]),
      attachment_digests: [],
    },
    {
      id: "outbox-1",
      kind: "create",
      question_id: question.question_id,
      payload: {},
      attempts: 0,
      next_attempt_at: 0,
      created_at: 0,
      last_error: null,
    }
  );
  await store.appendAudit({ at: "2026-11-01T10:00:00.000Z", event: "question.created" });
  await store.appendAudit({ at: "2026-11-01T10:05:00.000Z", event: "answer.received" });
  return store;
}

/** Restores an archive with the library's own import, which checks every file against its manifest. */
async function restore(text: string, stored: StoredIdentity) {
  const identity = await importIdentity(stored);
  const target = new MemoryLocalStore();
  const { manifest } = await importDecisions(
    { encrypted: JSON.parse(text) as RecoveryBundleFile, passphrase: PASSPHRASE },
    target,
    identity
  );
  const [restored] = await target.listQuestions();
  return {
    manifest,
    content: restored ? await openQuestionContent({ identity }, restored) : null,
    answers: restored ? await openAnswers({ identity }, restored) : [],
  };
}

describe("buildDecisionsArchive", () => {
  it("encrypts the whole history under the passphrase, counting what it holds", async () => {
    const stored = await storedIdentity();
    const store = await history(stored);

    const built = await buildDecisionsArchive({
      store,
      keys: { load: async () => stored },
      passphrase: PASSPHRASE,
    });
    if (!("archive" in built)) throw new Error(`expected an archive, got ${built.failure.result}`);
    const { archive } = built;

    expect(archive.fileName).toMatch(/^decisions-export-\d{4}-\d{2}-\d{2}\.dxz\.json$/);
    // Nothing of the history, and no key, is readable without the passphrase.
    expect(archive.text).not.toContain(QUESTION);
    expect(archive.text).not.toContain(ANSWER);
    expect(archive.text).not.toContain(stored.keys.signing_private_pkcs8);

    const restored = await restore(archive.text, stored);
    expect({ questions: archive.questions, auditEvents: archive.auditEvents }).toEqual({
      questions: restored.manifest.counts.decisions,
      auditEvents: restored.manifest.counts.audit_events,
    });
    expect(archive.questions).toBe(1);
    expect(archive.auditEvents).toBe(2);
    expect(restored.manifest.installation_id).toBe(stored.config.installationId);
    expect(restored.content).toMatchObject({ question: QUESTION });
    expect(restored.answers).toMatchObject([{ text: ANSWER }]);
  });

  it("exports an empty history as an archive holding nothing", async () => {
    const stored = await storedIdentity();

    const built = await buildDecisionsArchive({
      store: new MemoryLocalStore(),
      keys: { load: async () => stored },
      passphrase: PASSPHRASE,
    });

    expect(built).toMatchObject({ archive: { questions: 0, auditEvents: 0 } });
  });

  it("says there is no identity when no keys are stored, or only an unfinished claim's", async () => {
    const unfinished = await storedIdentity({ claimed: false });
    for (const stored of [null, unfinished]) {
      await expect(
        buildDecisionsArchive({
          store: new MemoryLocalStore(),
          keys: { load: async () => stored },
          passphrase: PASSPHRASE,
        })
      ).resolves.toEqual({ failure: { result: "no-identity" } });
    }
  });

  it("reports a key store that won't open as the key store's refusal", async () => {
    const locked = new DecisionsKeyStoreError("locked", "The keychain is locked");

    await expect(
      buildDecisionsArchive({
        store: new MemoryLocalStore(),
        keys: { load: async () => Promise.reject(locked) },
        passphrase: PASSPHRASE,
      })
    ).resolves.toEqual({
      failure: { result: "key-storage", kind: "locked", reason: "The keychain is locked" },
    });
  });

  it("fails rather than leave out history its keys can't open", async () => {
    const store = await history(await storedIdentity());
    const someoneElse = await storedIdentity();

    await expect(
      buildDecisionsArchive({
        store,
        keys: { load: async () => someoneElse },
        passphrase: PASSPHRASE,
      })
    ).rejects.toThrow();
  });
});
