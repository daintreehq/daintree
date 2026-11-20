import { beforeAll, describe, expect, it, vi } from "vitest";

// Counts the image opens this module makes, so a read that has timed out can be shown to stop.
const opens = vi.hoisted(() => ({ count: 0 }));
vi.mock("@daintreehq/decisions-crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daintreehq/decisions-crypto")>();
  return {
    ...actual,
    decryptAttachment: (...args: Parameters<typeof actual.decryptAttachment>) => {
      opens.count += 1;
      return actual.decryptAttachment(...args);
    },
  };
});
import {
  MemoryKeyStore,
  RelayError,
  loadIdentity,
  sealAnswerContent,
  sealQuestionContent,
  serializeAnswers,
  serializeMessages,
  type AnswerContent,
  type AnswerEntry,
  type Identity,
  type QuestionRow,
  type StoredMessage,
} from "@daintreehq/decisions-client";
import {
  encryptAttachment,
  encryptEnvelope,
  generateDeviceKeys,
  generateEpochKeyBytes,
  importEpochKey,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import {
  MESSAGE_RECORD_TYPE,
  bytesToBase64Url,
  type PhoneImageReference,
} from "@daintreehq/decisions-protocol";
import {
  inScope,
  readQuestionContent,
  QUESTION_IMAGE_PART_BYTES,
  readQuestionImage,
  readQuestionSummary,
  type ImageReadContext,
} from "../questionContent.js";
import { NO_ADVISORY_HOST } from "../questionRound.js";
import { RetiredAttemptError } from "../relayTransport.js";
import { row as baseRow } from "./questionRows.js";

const QID = "0190f0aa11112222333344445555aa01";
const SHA = "a".repeat(64);
const NONCE = "AAAAAAAAAAAAAAAA";

let identity: Identity;

beforeAll(async () => {
  const keys = new MemoryKeyStore();
  await keys.save({
    v: 1,
    config: {
      relayOrigin: "https://decisions.example.workers.dev",
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Test desktop",
    },
    keys: await serializeDeviceKeys(await generateDeviceKeys(true)),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  });
  identity = await loadIdentity(keys);
});

function ctx() {
  return { identity };
}

const IMAGE: PhoneImageReference = {
  attachment_id: "phoneimg_0001",
  mime: "image/jpeg",
  size: 2048,
  sha256: SHA,
  nonce: NONCE,
  key_epoch: 1,
  alt: "A sketch of the layout",
};

async function question(content: unknown, over: Partial<QuestionRow> = {}): Promise<QuestionRow> {
  return {
    ...baseRow(1, {
      origin: { host_id: "host-1", pane_id: "pane-a", project_id: "project-1" },
    }),
    question_id: QID,
    content_sealed: await sealQuestionContent(ctx(), QID, content),
    legacy_content_json: null,
    ...over,
  };
}

async function answer(
  over: Partial<AnswerEntry>,
  content: Partial<AnswerContent> = {}
): Promise<AnswerEntry> {
  const entryId = over.entry_id ?? "entry-1";
  const revision = over.revision ?? 1;
  return {
    entry_id: entryId,
    kind: "answer",
    action: "answer",
    revision,
    source: "human",
    correction: false,
    created_at: "2026-11-01T10:05:00.000Z",
    deliver: true,
    delivered: true,
    sealed: await sealAnswerContent(ctx(), QID, entryId, revision, {
      choices: [],
      text: "",
      reviewed_attachment_digests: [],
      ...content,
    }),
    ...over,
  };
}

async function message(
  messageId: string,
  side: "human" | "agent",
  text: string,
  eventSeq: number,
  images: PhoneImageReference[] = []
): Promise<StoredMessage> {
  const envelope = await encryptEnvelope({
    epochKey: identity.epochs.get(1)!,
    installationId: identity.config.installationId,
    questionId: QID,
    recordId: messageId,
    recordType: MESSAGE_RECORD_TYPE,
    revision: 0,
    senderDeviceId: side === "human" ? "phone-1" : "dev_12345678",
    purpose: "message-content",
    plaintext:
      side === "human"
        ? { content_version: 1, side, text, images }
        : { content_version: 1, side, text },
  });
  return {
    message_id: messageId,
    message_seq: eventSeq,
    event_seq: eventSeq,
    side,
    expects_reply: side === "agent",
    signer_device_id: side === "human" ? "phone-1" : "dev_12345678",
    attachment_ids: images.map((image) => image.attachment_id),
    created_at: `2026-11-01T10:${String(eventSeq).padStart(2, "0")}:00.000Z`,
    committed_at: `2026-11-01T10:${String(eventSeq).padStart(2, "0")}:01.000Z`,
    envelope_digest: `digest-${messageId}`,
    sealed: JSON.stringify(envelope),
    target_host_id: "host-1",
    delivery:
      side === "human"
        ? {
            status: "terminal-delivered",
            deliver: true,
            received_at: "2026-11-01T10:30:00.000Z",
            terminal_delivered_at: "2026-11-01T10:31:00.000Z",
            injection_id: "inj-1",
            error_code: null,
            reported: null,
          }
        : null,
  };
}

const CONTENT = {
  content_version: 1,
  question: "\n  Which database should the cache use?\nPostgres is already running.",
  context: "The cache sits behind the API.",
  kind: "choice",
  options: [
    { id: "pg", label: "Postgres", description: "Already deployed" },
    { id: "redis", label: "Redis" },
  ],
  attachments: [
    {
      attachment_id: "attach_0001",
      role: "before",
      alt: "Current schema",
      mime: "image/png",
      size: 4096,
      sha256: SHA,
      nonce: NONCE,
      key_epoch: 1,
    },
  ],
  allow_text: false,
};

describe("readQuestionContent", () => {
  it("opens the question, its options and attachments, and the row's own fields", async () => {
    const row = await question(CONTENT, {
      requirement: "proxy-ok",
      expires_at: "2026-11-02T10:00:00.000Z",
      local_status: "human-answered",
      delivery_status: "terminal-delivered",
    });

    const read = await readQuestionContent(ctx(), row, NO_ADVISORY_HOST);

    expect(read).toEqual({
      result: "read",
      question: {
        questionId: QID,
        alias: 1,
        terminalId: "pane-a",
        reference: {
          hostId: "host-1",
          projectId: "project-1",
          terminalId: "pane-a",
          questionId: QID,
        },
        revision: 1,
        question: CONTENT.question,
        context: "The cache sits behind the API.",
        kind: "choice",
        options: [
          { id: "pg", label: "Postgres", description: "Already deployed" },
          { id: "redis", label: "Redis", description: null },
        ],
        allowText: false,
        requirement: "proxy-ok",
        askedAt: row.origin_created_at,
        expiresAt: "2026-11-02T10:00:00.000Z",
        status: "human-answered",
        closedReason: null,
        replyMode: "blocking",
        plannedFallback: null,
        closureNotice: null,
        deliveryStatus: "terminal-delivered",
        attachments: [
          {
            attachmentId: "attach_0001",
            role: "before",
            alt: "Current schema",
            mime: "image/png",
            size: 4096,
            sha256: SHA,
          },
        ],
        thread: [],
      },
    });
  });

  it("fills what the agent left out with the protocol's defaults", async () => {
    const read = await readQuestionContent(
      ctx(),
      await question({ question: "Ship it?" }),
      NO_ADVISORY_HOST
    );

    expect(read).toMatchObject({
      result: "read",
      question: { context: null, kind: "mixed", options: [], attachments: [], allowText: true },
    });
  });

  it("orders answers, expiry and follow-ups by ledger seq, saying who sent each", async () => {
    const legacy = await answer(
      { entry_id: "entry-0", revision: 1, created_at: "2026-11-01T10:01:00.000Z" },
      { choices: [{ id: "pg", label: "Postgres" }], text: "Postgres for now." }
    );
    const proxy = await answer(
      { entry_id: "entry-p", revision: 2, source: "proxy", action: "proxy-answer", event_seq: 3 },
      { choices: [{ id: "redis" }], confidence: 0.9, model_id: "model-1" }
    );
    const confirmed = await answer(
      { entry_id: "entry-c", revision: 3, action: "confirm-proxy", event_seq: 5 },
      { choices: [{ id: "redis", label: "Redis" }] }
    );
    const corrected = await answer(
      { entry_id: "entry-x", revision: 4, action: "override", correction: true, event_seq: 8 },
      {
        choices: [{ id: "pg", label: "Postgres" }],
        text: "Back to Postgres.",
        reason: "Redis isn't approved yet.",
        images: [IMAGE],
      }
    );
    const expired: AnswerEntry = {
      entry_id: "entry-e",
      kind: "expired",
      action: "expire",
      revision: 5,
      source: "system",
      correction: false,
      created_at: "2026-11-01T11:00:00.000Z",
      event_seq: 12,
      deliver: true,
      delivered: true,
      sealed: null,
    };
    const fromAgent = await message("msg_agent_01", "agent", "Is Redis allowed here?", 4);
    const fromPerson = await message("msg_human_01", "human", "See the sketch.", 10, [IMAGE]);
    const row = await question(CONTENT, {
      answers_json: serializeAnswers([legacy, proxy, confirmed, corrected, expired]),
      messages_json: serializeMessages([fromAgent, fromPerson]),
    });

    const read = await readQuestionContent(ctx(), row, NO_ADVISORY_HOST);
    if (read.result !== "read") throw new Error(read.result);
    const { thread } = read.question;

    expect(
      thread.map((entry) => (entry.type === "message" ? entry.messageId : entry.entryId))
    ).toEqual([
      "entry-0",
      "entry-p",
      "msg_agent_01",
      "entry-c",
      "entry-x",
      "msg_human_01",
      "entry-e",
    ]);
    expect(thread[0]).toMatchObject({
      type: "answer",
      from: "person",
      choices: [{ id: "pg", label: "Postgres" }],
      text: "Postgres for now.",
      unreadable: false,
    });
    expect(thread[1]).toMatchObject({
      type: "answer",
      from: "model",
      choices: [{ id: "redis", label: null }],
      text: null,
      confirmsModel: false,
    });
    expect(thread[2]).toEqual({
      type: "message",
      messageId: "msg_agent_01",
      from: "agent",
      text: "Is Redis allowed here?",
      images: [],
      expectsReply: true,
      onComputer: false,
      sentAt: fromAgent.created_at,
      deliveryStatus: null,
      deliveryStopped: false,
      unreadable: false,
    });
    expect(thread[3]).toMatchObject({ type: "answer", from: "person", confirmsModel: true });
    expect(thread[4]).toEqual({
      type: "answer",
      entryId: "entry-x",
      revision: 4,
      from: "person",
      onComputer: false,
      correction: true,
      confirmsModel: false,
      choices: [{ id: "pg", label: "Postgres" }],
      text: "Back to Postgres.",
      reason: "Redis isn't approved yet.",
      images: [
        {
          attachmentId: "phoneimg_0001",
          alt: "A sketch of the layout",
          mime: "image/jpeg",
          size: 2048,
        },
      ],
      sentAt: corrected.created_at,
      unreadable: false,
      // Its own delivery, apart from the question's (#17943).
      delivered: corrected.delivered,
    });
    expect(thread[5]).toMatchObject({
      type: "message",
      from: "person",
      text: "See the sketch.",
      deliveryStatus: "terminal-delivered",
      images: [{ attachmentId: "phoneimg_0001" }],
    });
    expect(thread[6]).toEqual({ type: "expired", entryId: "entry-e", sentAt: expired.created_at });
  });

  it("shows no answer for a question that never reached the relay, only that it never did (#17939, #17943)", async () => {
    const unpublished: AnswerEntry = {
      entry_id: "unpublished-1",
      kind: "unpublished",
      action: "expire",
      revision: 0,
      source: "system",
      correction: false,
      created_at: "2026-11-01T11:00:00.000Z",
      deliver: true,
      delivered: false,
      sealed: null,
    };
    const row = await question(CONTENT, {
      local_status: "publish-failed",
      error_code: "never_published",
      answers_json: serializeAnswers([unpublished]),
    });

    const read = await readQuestionContent(ctx(), row, NO_ADVISORY_HOST);
    if (read.result !== "read") throw new Error(read.result);
    expect(read.question).toMatchObject({
      status: "publish-failed",
      closedReason: "never-published",
      closureNotice: { delivery: "pending", disposition: null },
    });
    expect(read.question.thread).toEqual([]);
  });

  /** A question as the publisher stores an advisory one: its envelope, AAD and all (#17943). */
  async function advisory(content: object, over: Partial<QuestionRow> = {}): Promise<QuestionRow> {
    const envelope = await encryptEnvelope({
      epochKey: identity.epochs.get(1)!,
      installationId: identity.config.installationId,
      questionId: QID,
      recordId: QID,
      recordType: "question",
      revision: 0,
      senderDeviceId: identity.config.deviceId,
      purpose: "question-content",
      plaintext: content,
      replyMode: "advisory",
    });
    return question(CONTENT, {
      question_revision: 0,
      expires_at: "2026-11-02T10:00:00.000Z",
      content_sealed: JSON.stringify(envelope),
      ...over,
    });
  }

  it("says of each answer whether typing it in was confirmed, apart from a later correction (#17943)", async () => {
    const first = await answer({ entry_id: "entry-a", revision: 1, delivered: true, event_seq: 2 });
    const correction = await answer({
      entry_id: "entry-b",
      revision: 2,
      correction: true,
      delivered: false,
      event_seq: 3,
    });
    const row = await question(CONTENT, {
      local_status: "human-answered",
      delivery_status: "desktop-received",
      answers_json: serializeAnswers([first, correction]),
    });
    const read = await readQuestionContent(ctx(), row, NO_ADVISORY_HOST);
    if (read.result !== "read") throw new Error(read.result);
    expect(
      read.question.thread.map((entry) => (entry.type === "answer" ? entry.delivered : null))
    ).toEqual([true, false]);
  });

  it("leaves a decline from a source the library doesn't know out of the thread (#17943)", async () => {
    const decline: AnswerEntry = {
      entry_id: "decline-x",
      kind: "declined",
      action: "cancel",
      revision: 1,
      source: "proxy",
      correction: false,
      created_at: "2026-11-01T11:00:00.000Z",
      deliver: true,
      delivered: false,
      sealed: null,
    };
    const row = await question(CONTENT, {
      local_status: "cancelled",
      answers_json: serializeAnswers([decline]),
    });
    const read = await readQuestionContent(ctx(), row, NO_ADVISORY_HOST);
    if (read.result !== "read") throw new Error(read.result);
    expect(read.question.closedReason).toBe("withdrawn");
    expect(read.question.thread).toEqual([]);
  });

  it("names no reason or notice for a question the relay refused (#17943)", async () => {
    const row = await question(CONTENT, { local_status: "publish-failed", error_code: "invalid" });
    const read = await readQuestionContent(ctx(), row, NO_ADVISORY_HOST);
    if (read.result !== "read") throw new Error(read.result);
    expect(read.question).toMatchObject({ closedReason: null, closureNotice: null });
  });

  it("reads an advisory round's mode and the plan its content states (#17943)", async () => {
    const row = await advisory({ ...CONTENT, planned_fallback: "Use the existing fixture" });

    const read = await readQuestionContent(ctx(), row, NO_ADVISORY_HOST);
    if (read.result !== "read") throw new Error(read.result);
    expect(read.question).toMatchObject({
      replyMode: "advisory",
      plannedFallback: "Use the existing fixture",
      expiresAt: "2026-11-02T10:00:00.000Z",
    });

    // A blocking question's stray plan is never shown as one.
    const blocking = await question({ ...CONTENT, planned_fallback: "Use the existing fixture" });
    const plain = await readQuestionContent(ctx(), blocking, NO_ADVISORY_HOST);
    if (plain.result !== "read") throw new Error(plain.result);
    expect(plain.question).toMatchObject({ replyMode: "blocking", plannedFallback: null });
  });

  it("won't show advisory content the protocol refuses (#17943)", async () => {
    const approval = await advisory({
      ...CONTENT,
      kind: "approval",
      planned_fallback: "Ship it anyway",
    });
    expect(await readQuestionContent(ctx(), approval, NO_ADVISORY_HOST)).toEqual({
      result: "unreadable",
    });
    // No plan: blank plans are dropped by the content parse, so this is the same as none.
    const planless = await advisory({ ...CONTENT, planned_fallback: "   " });
    expect(await readQuestionContent(ctx(), planless, NO_ADVISORY_HOST)).toEqual({
      result: "unreadable",
    });
  });

  it("names the revision it read, and tells a person's answer on the computer from a phone's (#17101)", async () => {
    const onPhone = await answer(
      { entry_id: "entry-1", signer_role: "phone", event_seq: 2 },
      { text: "From the phone." }
    );
    const onComputer = await answer(
      { entry_id: "entry-2", revision: 2, signer_role: "owner-desktop", event_seq: 4 },
      { text: "From the desk." }
    );
    const byModel = await answer({
      entry_id: "entry-3",
      revision: 3,
      source: "proxy",
      action: "proxy-answer",
      signer_role: "owner-desktop",
      event_seq: 6,
    });
    const row = await question(CONTENT, {
      question_revision: 3,
      answers_json: serializeAnswers([onPhone, onComputer, byModel]),
    });

    const read = await readQuestionContent(ctx(), row, NO_ADVISORY_HOST);
    if (read.result !== "read") throw new Error(read.result);

    expect(read.question.revision).toBe(3);
    expect(
      read.question.thread.map((entry) =>
        entry.type === "answer" ? [entry.from, entry.onComputer] : null
      )
    ).toEqual([
      ["person", false],
      ["person", true],
      ["model", false],
    ]);
  });

  it("reads a person's decline as declined, apart from a withdrawal and an expiry, and keeps it in the thread (#17234)", async () => {
    const decline: AnswerEntry = {
      entry_id: "entry-d",
      kind: "declined",
      action: "cancel",
      revision: 1,
      source: "human",
      correction: false,
      created_at: "2026-11-01T10:30:00.000Z",
      event_seq: 6,
      deliver: true,
      delivered: false,
      sealed: null,
    };
    const fromAgent = await message("msg_agent_01", "agent", "Still needed?", 4);
    const read = async (over: Partial<QuestionRow>) => {
      const result = await readQuestionContent(
        ctx(),
        await question(CONTENT, over),
        NO_ADVISORY_HOST
      );
      if (result.result !== "read") throw new Error(result.result);
      return result.question;
    };

    const declined = await read({
      local_status: "cancelled",
      answers_json: serializeAnswers([decline]),
      messages_json: serializeMessages([fromAgent]),
    });
    expect(declined.status).toBe("cancelled");
    expect(declined.closedReason).toBe("declined");
    expect(declined.thread).toEqual([
      expect.objectContaining({ type: "message", messageId: "msg_agent_01" }),
      { type: "declined", entryId: "entry-d", sentAt: decline.created_at },
    ]);

    // Declined, reopened, then withdrawn from the desktop: the decline is history, not why it closed.
    const reopened = await read({
      local_status: "cancelled",
      question_revision: 2,
      answers_json: serializeAnswers([decline]),
    });
    expect(reopened.closedReason).toBe("withdrawn");
    expect(reopened.thread).toEqual([
      { type: "declined", entryId: "entry-d", sentAt: decline.created_at },
    ]);

    expect((await read({ local_status: "cancelled" })).closedReason).toBe("withdrawn");
    expect((await read({ local_status: "expired" })).closedReason).toBe("expired");
    expect((await read({ local_status: "open" })).closedReason).toBeNull();
  });

  it("tells a person's follow-up written on the computer from a phone's and the agent's (#17238)", async () => {
    const fromAgent = await message("msg_agent_01", "agent", "Which region?", 2);
    const fromPhone = { ...(await message("msg_human_01", "human", "From the phone.", 4)) };
    const fromComputer = {
      ...(await message("msg_human_02", "human", "From the desk.", 6)),
      signer_device_id: "dev_owner_1",
      signer_role: "owner-desktop" as const,
    };
    // Withdrawn with its question after it arrived: kept in the thread, never typed.
    fromComputer.delivery = { ...fromComputer.delivery!, status: "received", deliver: false };
    // Stored before the signer's role was kept: a person's message then was always a phone's.
    const legacy = { ...(await message("msg_human_03", "human", "Older.", 8)) };
    delete (legacy as { signer_role?: unknown }).signer_role;
    fromPhone.signer_role = "phone";
    const row = await question(CONTENT, {
      messages_json: serializeMessages([fromAgent, fromPhone, fromComputer, legacy]),
    });

    const read = await readQuestionContent(ctx(), row, NO_ADVISORY_HOST);
    if (read.result !== "read") throw new Error(read.result);

    expect(
      read.question.thread.map((entry) =>
        entry.type === "message" ? [entry.from, entry.onComputer, entry.text] : null
      )
    ).toEqual([
      ["agent", false, "Which region?"],
      ["person", false, "From the phone."],
      ["person", true, "From the desk."],
      ["person", false, "Older."],
    ]);
    expect(
      read.question.thread.map((entry) =>
        entry.type === "message" ? [entry.deliveryStatus, entry.deliveryStopped] : null
      )
    ).toEqual([
      [null, false],
      ["terminal-delivered", false],
      ["received", true],
      ["terminal-delivered", false],
    ]);
  });

  it("keeps the rest of the thread when one entry can't be opened", async () => {
    const good = await answer({ entry_id: "entry-1", event_seq: 2 }, { text: "Yes." });
    const broken = { ...(await answer({ entry_id: "entry-2", revision: 2, event_seq: 6 })) };
    broken.sealed = good.sealed;
    const after = await answer({ entry_id: "entry-3", revision: 3, event_seq: 7 }, { text: "No." });
    const tampered = { ...(await message("msg_human_02", "human", "Later.", 9)) };
    tampered.side = "agent";
    const last = await message("msg_human_03", "human", "Last word.", 11);
    const row = await question(CONTENT, {
      answers_json: serializeAnswers([good, broken, after]),
      messages_json: serializeMessages([tampered, last]),
    });

    const read = await readQuestionContent(ctx(), row, NO_ADVISORY_HOST);
    if (read.result !== "read") throw new Error(read.result);

    expect(read.question.thread).toMatchObject([
      { entryId: "entry-1", text: "Yes.", unreadable: false },
      { entryId: "entry-2", choices: [], text: null, images: [], unreadable: true },
      { entryId: "entry-3", text: "No.", unreadable: false },
      { messageId: "msg_human_02", text: null, unreadable: true },
      { messageId: "msg_human_03", text: "Last word.", unreadable: false },
    ]);
  });

  it("is unreadable when the question has no content, can't be opened, or doesn't parse", async () => {
    const sealedElsewhere = await question(CONTENT);
    const moved = { ...sealedElsewhere, question_id: "0190f0aa11112222333344445555aa02" };

    for (const row of [
      await question(CONTENT, { content_sealed: null }),
      moved,
      await question({ question: "" }),
      await question({ ...CONTENT, kind: "poll" }),
    ]) {
      await expect(readQuestionContent(ctx(), row, NO_ADVISORY_HOST)).resolves.toEqual({
        result: "unreadable",
      });
    }
  });

  it("lets a stopped delivery's refusal through, so the read ends as not running", async () => {
    const row = await question(CONTENT);
    const missingKey = { identity: { ...identity, epochs: new Map() } };
    const retired = {
      ...missingKey,
      refreshIdentity: async () => {
        throw new RetiredAttemptError();
      },
    };

    await expect(readQuestionContent(missingKey, row, NO_ADVISORY_HOST)).resolves.toEqual({
      result: "unreadable",
    });
    await expect(readQuestionContent(retired, row, NO_ADVISORY_HOST)).rejects.toBeInstanceOf(
      RetiredAttemptError
    );
    await expect(readQuestionSummary(retired, row)).rejects.toBeInstanceOf(RetiredAttemptError);
  });

  it("lets a stopped delivery's refusal through from a thread entry too", async () => {
    const rotated = {
      ...identity,
      epochs: new Map([[2, await importEpochKey(generateEpochKeyBytes(), 2, false)]]),
      currentEpoch: 2,
    };
    const later: AnswerEntry = {
      ...(await answer({ entry_id: "entry-9", event_seq: 3 })),
      sealed: await sealAnswerContent({ identity: rotated }, QID, "entry-9", 1, {
        choices: [],
        text: "Sealed after a rotation.",
        reviewed_attachment_digests: [],
      }),
    };
    const row = await question(CONTENT, { answers_json: serializeAnswers([later]) });
    const retired = {
      identity,
      refreshIdentity: async () => {
        throw new RetiredAttemptError();
      },
    };

    await expect(readQuestionContent(ctx(), row, NO_ADVISORY_HOST)).resolves.toMatchObject({
      result: "read",
      question: { thread: [{ entryId: "entry-9", unreadable: true }] },
    });
    await expect(readQuestionContent(retired, row, NO_ADVISORY_HOST)).rejects.toBeInstanceOf(
      RetiredAttemptError
    );
  });
});

describe("readQuestionSummary", () => {
  it("is the question's first line that has words", async () => {
    await expect(readQuestionSummary(ctx(), await question(CONTENT))).resolves.toEqual({
      questionId: QID,
      result: "read",
      line: "Which database should the cache use?",
    });
  });

  it("strips controls from the line", async () => {
    const row = await question({ question: "Deploy \u001b[31mnow\u001b[0m?" });

    await expect(readQuestionSummary(ctx(), row)).resolves.toMatchObject({ line: "Deploy now?" });
  });

  it("is unreadable without saying why when the content can't be opened", async () => {
    const row = await question(CONTENT, { content_sealed: '{"ciphertext":"x"}' });

    await expect(readQuestionSummary(ctx(), row)).resolves.toEqual({
      questionId: QID,
      result: "unreadable",
    });
  });
});

describe("inScope", () => {
  const scope = { hostId: "host-1", projectId: "project-1", terminalId: "pane-a" };

  it("reads only the pane's own questions, asked on this machine for this project", async () => {
    const row = await question(CONTENT);

    expect(inScope(row, scope)).toBe(true);
    expect(inScope(row, { ...scope, terminalId: "pane-b" })).toBe(false);
    expect(inScope(row, { ...scope, projectId: "project-2" })).toBe(false);
    expect(inScope(row, { ...scope, hostId: "host-2" })).toBe(false);
  });

  it("reads nothing for a view with no project or a machine with no host id yet", async () => {
    const row = await question(CONTENT);

    expect(inScope(row, { ...scope, projectId: null })).toBe(false);
    expect(inScope(row, { ...scope, hostId: null })).toBe(false);
    expect(
      inScope({ ...row, origin: { ...row.origin, project_id: "" } }, { ...scope, projectId: "" })
    ).toBe(false);
  });
});

/** A PNG's signature and a little more: what `sniffImageMime` reads as a PNG. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7]);
const ATTACHMENT_ID = "attach_0002";

/** A question carrying one image really sealed under the identity's epoch, and its ciphertext. */
async function imageQuestion(
  descriptor: Record<string, unknown> = {},
  bytes: Uint8Array = PNG
): Promise<{ row: QuestionRow; ciphertext: Uint8Array; sha256: string }> {
  const sealed = await encryptAttachment(
    identity.epochs.get(1)!,
    {
      installationId: identity.config.installationId,
      questionId: QID,
      attachmentId: ATTACHMENT_ID,
      keyEpoch: 1,
    },
    bytes
  );
  const row = await question({
    question: "Which layout?",
    attachments: [
      {
        attachment_id: ATTACHMENT_ID,
        role: "after",
        alt: "The new layout",
        mime: "image/png",
        size: bytes.length,
        sha256: sealed.sha256Plaintext,
        nonce: sealed.nonce,
        key_epoch: 1,
        ...descriptor,
      },
    ],
  });
  return { row, ciphertext: sealed.ciphertext, sha256: sealed.sha256Plaintext };
}

function relay(download: (id: string, opts?: { maxBytes?: number }) => Promise<Uint8Array>) {
  const downloadAttachment = vi.fn(download);
  const context: ImageReadContext = { identity, client: { downloadAttachment } };
  return { context, downloadAttachment };
}

describe("readQuestionImage", () => {
  it("fetches the image, opens it and checks it against its digest and type", async () => {
    const { row, ciphertext, sha256 } = await imageQuestion();
    const { context, downloadAttachment } = relay(async () => ciphertext);

    const read = await readQuestionImage(context, row, ATTACHMENT_ID, 0);

    expect(read).toEqual({
      result: "read",
      part: {
        attachmentId: ATTACHMENT_ID,
        mime: "image/png",
        sha256,
        size: PNG.length,
        offset: 0,
        bytes: PNG,
      },
    });
    // Never reads more than the declared size and its tag.
    expect(downloadAttachment).toHaveBeenCalledExactlyOnceWith(ATTACHMENT_ID, {
      maxBytes: PNG.length + 16,
    });
  });

  it("hands a larger image over in parts, each read checking the whole image", async () => {
    const large = new Uint8Array(QUESTION_IMAGE_PART_BYTES + 10);
    large.set(PNG);
    large[large.length - 1] = 7;
    const { row, ciphertext, sha256 } = await imageQuestion({}, large);
    const { context, downloadAttachment } = relay(async () => ciphertext);

    const first = await readQuestionImage(context, row, ATTACHMENT_ID, 0);
    const rest = await readQuestionImage(context, row, ATTACHMENT_ID, QUESTION_IMAGE_PART_BYTES);
    const past = await readQuestionImage(context, row, ATTACHMENT_ID, large.length);

    expect(first).toMatchObject({
      result: "read",
      part: { size: large.length, offset: 0, sha256 },
    });
    expect(rest).toMatchObject({ result: "read", part: { offset: QUESTION_IMAGE_PART_BYTES } });
    expect(past).toMatchObject({ result: "read", part: { offset: large.length } });
    if (first.result !== "read" || rest.result !== "read" || past.result !== "read") return;
    expect(first.part.bytes.length).toBe(QUESTION_IMAGE_PART_BYTES);
    // A copy of its own: the part never carries the rest of the image's buffer across IPC.
    expect(first.part.bytes.buffer.byteLength).toBe(QUESTION_IMAGE_PART_BYTES);
    expect(rest.part.bytes).toEqual(large.slice(QUESTION_IMAGE_PART_BYTES));
    expect(past.part.bytes.length).toBe(0);
    expect(downloadAttachment).toHaveBeenCalledTimes(3);
  });

  it("finds nothing for an image the question doesn't name, and fetches nothing", async () => {
    const { row, ciphertext } = await imageQuestion();
    const { context, downloadAttachment } = relay(async () => ciphertext);

    await expect(readQuestionImage(context, row, "attach_9999", 0)).resolves.toEqual({
      result: "not-found",
    });
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it("says the question is unreadable when its content can't be opened", async () => {
    const { ciphertext } = await imageQuestion();
    const { context, downloadAttachment } = relay(async () => ciphertext);
    const row = await question(CONTENT, { content_sealed: "not sealed" });

    await expect(readQuestionImage(context, row, ATTACHMENT_ID, 0)).resolves.toEqual({
      result: "unreadable",
    });
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it.each([
    ["the relay doesn't serve it", "fetch-failed", async () => Promise.reject(new Error("gone"))],
    [
      "the relay refuses it as larger than declared",
      "size-mismatch",
      async () => Promise.reject(new RelayError("payload_too_large", "too large", 413)),
    ],
  ] as const)("reports an image %s as %s", async (_label, reason, download) => {
    const { row } = await imageQuestion();
    const { context } = relay(download);

    await expect(readQuestionImage(context, row, ATTACHMENT_ID, 0)).resolves.toEqual({
      result: "unavailable",
      reason,
    });
  });

  it("refuses ciphertext that isn't exactly the declared size and its tag", async () => {
    const { row, ciphertext } = await imageQuestion();
    const { context } = relay(async () => ciphertext.slice(0, ciphertext.length - 1));

    await expect(readQuestionImage(context, row, ATTACHMENT_ID, 0)).resolves.toEqual({
      result: "unavailable",
      reason: "size-mismatch",
    });
  });

  it("refuses ciphertext that doesn't open under the question's binding", async () => {
    const { row, ciphertext } = await imageQuestion();
    const tampered = ciphertext.slice();
    tampered[0] = tampered[0]! ^ 0xff;
    const { context } = relay(async () => tampered);

    await expect(readQuestionImage(context, row, ATTACHMENT_ID, 0)).resolves.toEqual({
      result: "unavailable",
      reason: "decrypt-failed",
    });
  });

  it("refuses an image that doesn't hash to the question's digest", async () => {
    const { row, ciphertext } = await imageQuestion({ sha256: "c".repeat(64) });
    const { context } = relay(async () => ciphertext);

    await expect(readQuestionImage(context, row, ATTACHMENT_ID, 0)).resolves.toEqual({
      result: "unavailable",
      reason: "digest-mismatch",
    });
  });

  it("refuses an image that isn't the type the question declares", async () => {
    const { row, ciphertext } = await imageQuestion({ mime: "image/jpeg" });
    const { context } = relay(async () => ciphertext);

    await expect(readQuestionImage(context, row, ATTACHMENT_ID, 0)).resolves.toEqual({
      result: "unavailable",
      reason: "type-mismatch",
    });
  });

  it("refuses bytes that aren't an image at all", async () => {
    const text = new TextEncoder().encode("plain text, not an image");
    const { row, ciphertext } = await imageQuestion({}, text);
    const { context } = relay(async () => ciphertext);

    await expect(readQuestionImage(context, row, ATTACHMENT_ID, 0)).resolves.toEqual({
      result: "unavailable",
      reason: "type-mismatch",
    });
  });

  it("reloads the keys once for an epoch it doesn't hold, then says the key is unavailable", async () => {
    const { row, ciphertext } = await imageQuestion({ key_epoch: 2 });
    const refreshIdentity = vi.fn(async () => {});
    const downloadAttachment = vi.fn(async () => ciphertext);

    await expect(
      readQuestionImage(
        { identity, refreshIdentity, client: { downloadAttachment } },
        row,
        ATTACHMENT_ID,
        0
      )
    ).resolves.toEqual({ result: "unavailable", reason: "key-unavailable" });
    expect(refreshIdentity).toHaveBeenCalledOnce();
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it("says an image that takes too long timed out", async () => {
    const { row } = await imageQuestion();
    // Never settles; the opening's WebCrypto work needs real timers, so the budget is short and real.
    const { context } = relay(() => new Promise<Uint8Array>(() => {}));

    await expect(readQuestionImage(context, row, ATTACHMENT_ID, 0, 20)).resolves.toEqual({
      result: "unavailable",
      reason: "timed-out",
    });
  });

  it("opens nothing that arrives after its read timed out, and takes a late failure quietly", async () => {
    const { row, ciphertext } = await imageQuestion();
    const late: Array<{ resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }> =
      [];
    const { context } = relay(
      () => new Promise<Uint8Array>((resolve, reject) => late.push({ resolve, reject }))
    );
    opens.count = 0;

    for (let i = 0; i < 2; i += 1) {
      await expect(readQuestionImage(context, row, ATTACHMENT_ID, 0, 20)).resolves.toEqual({
        result: "unavailable",
        reason: "timed-out",
      });
    }
    late[0]!.resolve(ciphertext);
    late[1]!.reject(new Error("connection reset"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(opens.count).toBe(0);
  });

  it("fetches nothing once a key reload has outlasted its read", async () => {
    const { row, ciphertext } = await imageQuestion({ key_epoch: 2 });
    let reloaded: () => void = () => {};
    const refreshIdentity = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          reloaded = () => {
            // The reload finds the epoch after all, but too late.
            identity.epochs.set(2, identity.epochs.get(1)!);
            resolve();
          };
        })
    );
    const downloadAttachment = vi.fn(async () => ciphertext);
    try {
      await expect(
        readQuestionImage(
          { identity, refreshIdentity, client: { downloadAttachment } },
          row,
          ATTACHMENT_ID,
          0,
          20
        )
      ).resolves.toEqual({ result: "unavailable", reason: "timed-out" });
      reloaded();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(downloadAttachment).not.toHaveBeenCalled();
    } finally {
      identity.epochs.delete(2);
    }
  });

  it("passes a stopped delivery's refusal through rather than calling the image unavailable", async () => {
    const { row } = await imageQuestion();
    const { context } = relay(async () => {
      throw new RetiredAttemptError();
    });

    await expect(readQuestionImage(context, row, ATTACHMENT_ID, 0)).rejects.toBeInstanceOf(
      RetiredAttemptError
    );
  });
});
