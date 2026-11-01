import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BridgeError,
  DecisionsBridge,
  MemoryKeyStore,
  MemoryLocalStore,
  RelayClient,
  TokenMapAuthenticator,
  createDecisionsMcpHandler,
  currentEpochKey,
  hostRef,
  loadIdentity,
  type Identity,
  type InjectResult,
  type PolicyRegistry,
  type QuestionOrigin,
  type StoredIdentity,
  type TerminalSink,
} from "@daintreehq/decisions-client";
import {
  buildSignedAction,
  encryptEnvelope,
  exportPublicKey,
  generateDeviceKeys,
  generateEpochKeyBytes,
  issueDeviceCert,
  newId,
  serializeDeviceKeys,
  sha256Hex,
  type DeviceKeys,
} from "@daintreehq/decisions-crypto";
import {
  EventData,
  applyAction,
  bytesToBase64Url,
  type ActionKind,
  type DeviceCert,
  type Requirement,
} from "@daintreehq/decisions-protocol";
import {
  DESIGN_REVIEW_FINAL_GATE_ID,
  createTrustedPolicy,
  decisionsPolicyOf,
  describeTrustedGates,
} from "../workflowGates.js";
import { parseAnswerNotice, renderDecisionSection } from "../answerNotice.js";

const RELAY_ORIGIN = "https://decisions.example.workers.dev";
const INSTALLATION = "inst_12345678";
const OWNER = "dev_owner_1234";
const PHONE = "dev_phone_1234";
const PANE_TOKEN = "pane-bearer-token-0123456789";

/** A PNG signature and a few bytes: enough for the library to sniff it as an image. */
function png(fill: number): Uint8Array {
  const bytes = new Uint8Array(64).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}
const IMAGES: Record<string, Uint8Array> = { before: png(1), after: png(2), other: png(3) };

function origin(workflowGateId: string | null = null): QuestionOrigin {
  return {
    host_id: "host_12345678",
    pane_id: "pane-1",
    terminal_generation: 1,
    ownership_principal: "principal-1",
    agent_incarnation: "incarnation-1",
    agent_kind: "claude",
    agent_session_id: "session-1",
    project_id: "project-1",
    worktree_id: "worktree-1",
    worktree_root: "/repo",
    workflow_gate_id: workflowGateId,
  };
}

const REVIEW_INPUT = {
  question: "Ship the final design?",
  workflow_gate_id: DESIGN_REVIEW_FINAL_GATE_ID,
  attachments: [
    { local_resource_id: "before", role: "before" as const },
    { local_resource_id: "after", role: "after" as const },
  ],
};

interface Harness {
  bridge: DecisionsBridge;
  policy: PolicyRegistry;
  identity: Identity;
  injected: string[];
  /** A phone answer, signed and sealed as the phone would send it, applied through the real inbox. */
  answer(
    questionId: string,
    content: { selected_option_ids?: string[]; text?: string; reviewed?: string[] }
  ): Promise<void>;
  /** A proxy answer signed by this desktop, as the decision model's would be. */
  proxyAnswer(questionId: string, optionIds: string[]): Promise<void>;
  /** The relay's unsigned expiry event. */
  expire(questionId: string): Promise<void>;
  /** Calls a tool on the library's MCP handler over real HTTP, as the pane's agent. */
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const bridges: DecisionsBridge[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

function deviceInfo(cert: DeviceCert) {
  return {
    device_id: cert.device_id,
    role: cert.role,
    label: cert.label,
    created_at: new Date().toISOString(),
    revoked_at: null,
    last_seen_at: null,
    last_ack_seq: 0,
    cert,
    push_enabled: false,
  };
}

async function certFor(
  identity: Identity,
  deviceId: string,
  role: "owner-desktop" | "phone",
  keys: DeviceKeys
) {
  return issueDeviceCert({
    issuerDeviceId: OWNER,
    issuerSigningKey: identity.keys.signing.privateKey,
    installationId: INSTALLATION,
    deviceId,
    role,
    label: role,
    signingPub: await exportPublicKey(keys.signing.publicKey),
    exchangePub: await exportPublicKey(keys.exchange.publicKey),
  });
}

async function harness(options: { proxyAllowlisted?: boolean } = {}): Promise<Harness> {
  const ownerKeys = await generateDeviceKeys(true);
  const stored: StoredIdentity = {
    v: 1,
    config: {
      relayOrigin: RELAY_ORIGIN,
      installationId: INSTALLATION,
      deviceId: OWNER,
      label: "Desktop",
    },
    keys: await serializeDeviceKeys(ownerKeys),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  };
  const keyStore = new MemoryKeyStore();
  await keyStore.save(stored);
  const identity = await loadIdentity(keyStore);
  const phoneKeys = await generateDeviceKeys(false);
  const devices = {
    key_epoch: 1,
    owner_device_id: OWNER,
    devices: [
      deviceInfo(await certFor(identity, OWNER, "owner-desktop", identity.keys)),
      deviceInfo(await certFor(identity, PHONE, "phone", phoneKeys)),
    ],
  };
  // The relay answers only the device directory; publishing the question stays queued offline.
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    if (pathname === "/api/v1/devices" && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(devices), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new TypeError("offline");
  }) as typeof fetch;

  const injected: string[] = [];
  const sink: TerminalSink = {
    locate: async (o) => ({
      state: "alive",
      target: {
        hostId: o.host_id,
        paneId: o.pane_id,
        terminalGeneration: o.terminal_generation,
        ownershipPrincipal: o.ownership_principal,
        agentIncarnation: o.agent_incarnation,
        agentSessionId: o.agent_session_id,
        worktreeId: o.worktree_id,
      },
    }),
    isIdle: async () => true,
    inject: async (_target, text): Promise<InjectResult> => {
      injected.push(text);
      return { outcome: "held", reason: "test" };
    },
    hasMarker: async () => false,
  };

  const policy = createTrustedPolicy({ proxyAllowlisted: options.proxyAllowlisted ?? false });
  const store = new MemoryLocalStore();
  const bridge = new DecisionsBridge({
    identity,
    keyStore,
    store,
    sink,
    policy,
    resolver: {
      resolve: async (_origin, id) => (IMAGES[id] ? { bytes: IMAGES[id] } : null),
    },
    client: new RelayClient({ identity, fetch: fetchImpl, maxRetries: 0 }),
    pumpIntervalMs: 0,
  });
  bridges.push(bridge);

  let seq = 0;
  const applyEvent = async (
    event_type: string,
    questionId: string,
    data: Record<string, unknown>
  ) => {
    seq += 1;
    await bridge.inbox.persist({
      protocol_version: 1,
      seq,
      event_id: `evt_${String(seq).padStart(8, "0")}`,
      event_type: event_type as never,
      occurred_at: new Date().toISOString(),
      question_id: questionId,
      question_revision: null,
      origin_device_id: null,
      data,
    });
    await bridge.inbox.processPending();
  };

  const action = async (
    questionId: string,
    kind: ActionKind,
    signer: { deviceId: string; keys: DeviceKeys; role: "phone" | "owner-desktop" },
    plaintext: Record<string, unknown>,
    eventType: string,
    provenance: "human" | "proxy"
  ) => {
    const row = await store.getQuestion(questionId);
    if (!row) throw new Error("no such question");
    const actionId = newId();
    const envelope = await encryptEnvelope({
      epochKey: currentEpochKey(identity),
      installationId: INSTALLATION,
      questionId,
      recordId: actionId,
      recordType: kind,
      revision: row.question_revision + 1,
      senderDeviceId: signer.deviceId,
      purpose: "answer-content",
      plaintext,
    });
    const signed = await buildSignedAction({
      installationId: INSTALLATION,
      questionId,
      action: kind,
      signerDeviceId: signer.deviceId,
      signingKey: signer.keys.signing.privateKey,
      expectedRevision: row.question_revision,
      envelope,
      actionId,
    });
    // What the relay would declare: the shared transition, or (where it refuses) what a lying relay would claim.
    let next: { status: string; revision: number };
    try {
      next = applyAction(
        {
          status: "open",
          revision: row.question_revision,
          requirement: row.requirement,
          proxyAbstained: false,
        },
        kind,
        signer.role,
        row.question_revision
      );
    } catch {
      next = { status: "proxy-answered", revision: row.question_revision + 1 };
    }
    await applyEvent(eventType, questionId, {
      action: kind,
      record: signed.record,
      envelope: signed.envelope,
      provenance,
      status: next.status,
      revision: next.revision,
      target_host_id: await hostRef(row.origin.host_id),
      deliverable: true,
    });
  };

  const authenticator = new TokenMapAuthenticator();
  const handler = createDecisionsMcpHandler(bridge, authenticator, {
    allowedHosts: () => [`127.0.0.1:${port}`],
  });
  const server = createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  authenticator.register(PANE_TOKEN, origin());
  let rpcId = 0;

  return {
    bridge,
    policy,
    identity,
    injected,
    answer: (questionId, content) =>
      action(
        questionId,
        "answer",
        { deviceId: PHONE, keys: phoneKeys, role: "phone" },
        {
          content_version: 1,
          selected_option_ids: content.selected_option_ids ?? [],
          ...(content.text !== undefined ? { text: content.text } : {}),
          reviewed_attachment_digests: content.reviewed ?? [],
        },
        "decision.answer.committed",
        "human"
      ),
    proxyAnswer: (questionId, optionIds) =>
      action(
        questionId,
        "proxy-answer",
        { deviceId: OWNER, keys: identity.keys, role: "owner-desktop" },
        {
          content_version: 1,
          selected_option_ids: optionIds,
          reviewed_attachment_digests: [],
          model_id: "test-model",
          prompt_template_version: "1",
          confidence: 0.9,
          retrieval_reference_ids: [],
        },
        "decision.proxy.committed",
        "proxy"
      ),
    expire: async (questionId) => {
      const row = await store.getQuestion(questionId);
      if (!row) throw new Error("no such question");
      const data = {
        expired_at: new Date().toISOString(),
        target_host_id: await hostRef(row.origin.host_id),
      };
      // As the relay sends it: the inbox reads nothing of it, so hold the fixture to the schema instead.
      expect(EventData.expired.safeParse(data).success).toBe(true);
      await applyEvent("decision.expired", questionId, data);
    },
    callTool: async (name, args) => {
      rpcId += 1;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${PANE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      const body = (await res.json()) as {
        result: { content: { text: string }[]; structuredContent: Record<string, unknown> };
      };
      return { ...body.result.structuredContent, summary: body.result.content[0]?.text };
    },
  };
}

async function ask(
  h: Harness,
  input: Record<string, unknown>,
  workflowGateId: string | null = null
): Promise<{ questionId: string; requirement: Requirement }> {
  const result = await h.bridge.registerQuestion({ origin: origin(workflowGateId), input });
  await h.bridge.pump();
  return result;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BridgeError) return `${error.code}: ${error.message}`;
    throw error;
  }
  throw new Error("expected the bridge to refuse");
}

describe("trusted workflow gates", () => {
  it("registers design-review/final as Settings describes it, and every gate it describes is registered", () => {
    const policy = createTrustedPolicy({ proxyAllowlisted: false });
    const described = describeTrustedGates();
    expect(described.map((gate) => gate.id)).toContain(DESIGN_REVIEW_FINAL_GATE_ID);
    for (const gate of described) {
      const registered = policy.get(gate.id);
      expect(registered?.minRequirement).toBe(gate.requirement);
      expect(registered?.choices?.map(({ id, label }) => ({ id, label })) ?? []).toEqual(
        gate.choices
      );
      expect(registered?.bindArtifacts === true).toBe(gate.bindsAttachments);
    }
    expect(described.find((gate) => gate.id === DESIGN_REVIEW_FINAL_GATE_ID)).toMatchObject({
      requirement: "human-required",
      allowsText: false,
      bindsAttachments: true,
    });
  });

  it("hands Settings copies: changing what it read changes no registered gate", () => {
    const policy = createTrustedPolicy({ proxyAllowlisted: false });
    const read = decisionsPolicyOf({ proxyAllowlisted: false }, 0);
    const gate = read.gates.find((g) => g.id === DESIGN_REVIEW_FINAL_GATE_ID)!;
    gate.requirement = "proxy-first";
    gate.choices[0]!.id = "ship-anyway";
    gate.choices[0]!.label = "Ship anyway";
    gate.choices.push({ id: "skip", label: "Skip" });

    const expected = [
      { id: "approve", label: "Approve" },
      { id: "reject", label: "Reject" },
    ];
    expect(policy.get(DESIGN_REVIEW_FINAL_GATE_ID)?.minRequirement).toBe("human-required");
    expect(policy.get(DESIGN_REVIEW_FINAL_GATE_ID)?.choices).toEqual(expected);
    const again = describeTrustedGates().find((g) => g.id === DESIGN_REVIEW_FINAL_GATE_ID)!;
    expect(again.requirement).toBe("human-required");
    expect(again.choices).toEqual(expected);
    expect(
      createTrustedPolicy({ proxyAllowlisted: false }).get(DESIGN_REVIEW_FINAL_GATE_ID)?.choices
    ).toEqual(expected);
  });

  it("reports the expiry a question really gets, and the latest its agent can ask for", async () => {
    const h = await harness();
    const { defaultQuestionExpiryMs, maxQuestionExpiryMs } = decisionsPolicyOf(
      { proxyAllowlisted: false },
      0
    );
    expect(defaultQuestionExpiryMs).not.toBeNull();
    expect(maxQuestionExpiryMs).not.toBeNull();
    expect(maxQuestionExpiryMs!).toBeGreaterThan(defaultQuestionExpiryMs!);

    const lifetime = async (input: Record<string, unknown>) => {
      const before = Date.now();
      const { questionId } = await ask(h, input);
      const after = Date.now();
      const expiresAt = Date.parse((await h.bridge.getDecision(questionId)).expiresAt!);
      return { low: expiresAt - after, high: expiresAt - before };
    };
    const byDefault = await lifetime({ question: "Tabs?" });
    expect(defaultQuestionExpiryMs!).toBeGreaterThanOrEqual(byDefault.low);
    expect(defaultQuestionExpiryMs!).toBeLessThanOrEqual(byDefault.high);

    const tooLong = new Date(Date.now() + 10 * maxQuestionExpiryMs!).toISOString();
    for (const input of [
      { question: "Tabs?", expires_at: tooLong },
      { ...REVIEW_INPUT, expires_at: tooLong },
    ]) {
      const capped = await lifetime(input);
      expect(maxQuestionExpiryMs!).toBeGreaterThanOrEqual(capped.low);
      expect(maxQuestionExpiryMs!).toBeLessThanOrEqual(capped.high);
    }
  });

  it("keeps a design review human-required whatever level the agent asks for", async () => {
    const h = await harness({ proxyAllowlisted: true });
    for (const requested of ["proxy-first", "proxy-ok", "human-required"] as const) {
      const asked = await ask(h, { ...REVIEW_INPUT, requested_requirement: requested });
      expect(asked.requirement).toBe("human-required");
      const view = await h.bridge.getDecision(asked.questionId);
      expect(view.workflowGateId).toBe(DESIGN_REVIEW_FINAL_GATE_ID);
    }
  });

  it("keeps a pane's trusted gate when the agent names another or none", async () => {
    const h = await harness({ proxyAllowlisted: true });
    const asked = await ask(
      h,
      { ...REVIEW_INPUT, workflow_gate_id: "lenient/gate", requested_requirement: "proxy-first" },
      DESIGN_REVIEW_FINAL_GATE_ID
    );
    expect(asked.requirement).toBe("human-required");
    expect((await h.bridge.getDecision(asked.questionId)).workflowGateId).toBe(
      DESIGN_REVIEW_FINAL_GATE_ID
    );
  });

  it("treats an unknown gate id as no gate", async () => {
    const h = await harness();
    const asked = await ask(h, {
      question: "Which?",
      workflow_gate_id: "agent/made-up",
      requested_requirement: "proxy-first",
    });
    expect(asked.requirement).toBe("human-required");
    expect((await h.bridge.getDecision(asked.questionId)).workflowGateId).toBeNull();
  });

  it("lets a question with no gate take the proxy level its agent asks for only once allowlisted, live", async () => {
    const h = await harness();
    expect(
      (await ask(h, { question: "Tabs?", requested_requirement: "proxy-ok" })).requirement
    ).toBe("human-required");
    h.policy.proxyAllowlisted = true;
    expect(
      (await ask(h, { question: "Tabs?", requested_requirement: "proxy-ok" })).requirement
    ).toBe("proxy-ok");
    // Asking for nothing is still a question for the person.
    expect((await ask(h, { question: "Spaces?" })).requirement).toBe("human-required");
    // An unknown gate is no gate, so the allowlist applies to it as to any gate-less question.
    expect(
      (
        await ask(h, {
          question: "Width?",
          workflow_gate_id: "agent/made-up",
          requested_requirement: "proxy-ok",
        })
      ).requirement
    ).toBe("proxy-ok");
  });

  it("offers exactly the gate's choices and refuses any other options", async () => {
    const h = await harness();
    const approve = { id: "approve", label: "Approve" };
    const reject = { id: "reject", label: "Reject" };
    expect(
      await refusal(
        ask(h, { ...REVIEW_INPUT, options: [approve, reject, { id: "ship", label: "Ship" }] })
      )
    ).toContain("validation_error");
    expect(
      await refusal(
        ask(h, { ...REVIEW_INPUT, options: [{ id: "approve", label: "LGTM" }, reject] })
      )
    ).toContain("must use the workflow gate's label");
    expect(await refusal(ask(h, { ...REVIEW_INPUT, options: [approve] }))).toContain(
      "options must be exactly the workflow gate's choices"
    );
    // The same choices, repeated as the gate states them, are fine.
    await expect(ask(h, { ...REVIEW_INPUT, options: [approve, reject] })).resolves.toMatchObject({
      requirement: "human-required",
    });
  });

  it("refuses a design review with no screenshots attached", async () => {
    const h = await harness();
    expect(
      await refusal(ask(h, { question: "Ship it?", workflow_gate_id: DESIGN_REVIEW_FINAL_GATE_ID }))
    ).toContain("attach the images to be reviewed");
  });

  it("accepts only one of the gate's choices as an answer, with no text", async () => {
    const h = await harness();
    const digests = [await sha256Hex(IMAGES.before!), await sha256Hex(IMAGES.after!)];
    const refused: Array<{ selected_option_ids?: string[]; text?: string }> = [
      { selected_option_ids: ["ship-it"] },
      { selected_option_ids: ["approve", "reject"] },
      { selected_option_ids: ["approve"], text: "and also deploy" },
      { text: "looks good" },
    ];
    for (const content of refused) {
      const { questionId } = await ask(h, REVIEW_INPUT);
      await h.answer(questionId, { ...content, reviewed: digests });
      const view = await h.bridge.getDecision(questionId);
      expect(view.status).not.toBe("human-answered");
      expect(view.provenance).toBeNull();
      expect(view.choice).toBeNull();
      expect(view.deliveryStatus).toBe("needs-attention");
    }
    const { questionId } = await ask(h, REVIEW_INPUT);
    await h.answer(questionId, { selected_option_ids: ["reject"], reviewed: digests });
    expect(await h.bridge.getDecision(questionId)).toMatchObject({
      status: "human-answered",
      provenance: "human",
      choice: "reject",
    });
  });

  it("never lets a proxy answer satisfy a human-required question", async () => {
    const h = await harness({ proxyAllowlisted: true });
    const review = await ask(h, REVIEW_INPUT);
    expect(await refusal(h.bridge.runProxy(review.questionId))).toContain("proxy_forbidden");
    await h.proxyAnswer(review.questionId, ["approve"]);
    expect(await h.bridge.getDecision(review.questionId)).toMatchObject({
      status: "queued",
      provenance: null,
      choice: null,
      reviewedDigestsMatch: false,
    });

    const plain = await ask(h, { question: "Rename it?", options: [{ id: "yes", label: "Yes" }] });
    expect(plain.requirement).toBe("human-required");
    await h.proxyAnswer(plain.questionId, ["yes"]);
    expect((await h.bridge.getDecision(plain.questionId)).provenance).toBeNull();

    // The same answer settles a question the agent and the allowlist opened to a proxy.
    const open = await ask(h, {
      question: "Rename it?",
      options: [{ id: "yes", label: "Yes" }],
      requested_requirement: "proxy-ok",
    });
    await h.proxyAnswer(open.questionId, ["yes"]);
    expect(await h.bridge.getDecision(open.questionId)).toMatchObject({
      status: "proxy-answered",
      provenance: "proxy",
      choice: "yes",
    });
  });

  it("reports through get_decision whether the person reviewed exactly the attached screenshots", async () => {
    const h = await harness();
    const before = await sha256Hex(IMAGES.before!);
    const after = await sha256Hex(IMAGES.after!);

    const asked = await h.callTool("ask_human", REVIEW_INPUT);
    expect(asked).toMatchObject({ status: "queued", enforced_requirement: "human-required" });
    const exact = String(asked.question_id);
    await h.answer(exact, { selected_option_ids: ["approve"], reviewed: [after, before] });
    expect(await h.callTool("get_decision", { question_id: exact })).toMatchObject({
      status: "human-answered",
      workflow_gate_id: DESIGN_REVIEW_FINAL_GATE_ID,
      provenance: "human",
      choice: "approve",
      reviewed_digests_match: true,
    });

    const partial = String((await h.callTool("ask_human", REVIEW_INPUT)).question_id);
    await h.answer(partial, { selected_option_ids: ["approve"], reviewed: [before] });
    expect(await h.callTool("get_decision", { question_id: partial })).toMatchObject({
      choice: "approve",
      reviewed_digests_match: false,
    });

    const other = String((await h.callTool("ask_human", REVIEW_INPUT)).question_id);
    await h.answer(other, {
      selected_option_ids: ["approve"],
      reviewed: [before, await sha256Hex(IMAGES.other!)],
    });
    expect(await h.callTool("get_decision", { question_id: other })).toMatchObject({
      reviewed_digests_match: false,
    });
  });

  it("asks again, rather than carrying an approval over, when the screenshots change", async () => {
    const h = await harness();
    const digests = [await sha256Hex(IMAGES.before!), await sha256Hex(IMAGES.after!)];
    const first = await ask(h, { ...REVIEW_INPUT, correlation_id: "review-1" });
    await h.answer(first.questionId, { selected_option_ids: ["approve"], reviewed: digests });
    const changed = await ask(h, {
      ...REVIEW_INPUT,
      correlation_id: "review-1",
      attachments: [
        { local_resource_id: "before", role: "before" },
        { local_resource_id: "other", role: "after" },
      ],
    });
    expect(changed.questionId).not.toBe(first.questionId);
    expect(await h.bridge.getDecision(changed.questionId)).toMatchObject({
      status: "queued",
      provenance: null,
      choice: null,
      reviewedDigestsMatch: false,
    });
  });

  it("authorises nothing once a question has expired, and says so to the agent", async () => {
    const h = await harness();
    const { questionId } = await ask(h, REVIEW_INPUT);
    await h.expire(questionId);
    expect(await h.callTool("get_decision", { question_id: questionId })).toMatchObject({
      status: "expired",
      provenance: null,
      choice: null,
      text: "",
      reviewed_digests_match: false,
    });
    const summary = String((await h.callTool("get_decision", { question_id: questionId })).summary);
    expect(summary).toContain("not authorised");

    // The phone answering after expiry changes nothing.
    await h.answer(questionId, {
      selected_option_ids: ["approve"],
      reviewed: [await sha256Hex(IMAGES.before!), await sha256Hex(IMAGES.after!)],
    });
    expect(await h.bridge.getDecision(questionId)).toMatchObject({
      status: "expired",
      provenance: null,
      choice: null,
    });

    // What would be typed into the pane is the expiry notice, which Daintree renders as unauthorised.
    await h.bridge.pump();
    const notice = h.injected.find((text) => text.includes("status: expired"));
    expect(notice).toBeDefined();
    const blocks = parseAnswerNotice(notice!);
    expect(blocks).not.toBeNull();
    expect(renderDecisionSection(blocks!)).toContain("authorised: no");
    expect(renderDecisionSection(blocks!)).toContain("You are not authorised to continue");
  });
});
