import type { PerfScenario } from "../types";
import {
  disposeStore,
  expectedExposedIds,
  forbiddenCallSample,
  loadMcpModules,
  loadRealManifest,
  MCP_TIERS,
  openSession,
  PERF_WORKSPACE_BINDING,
  permittedCallSample,
  probeCall,
  readResultPayload,
  requiredOutputKeys,
  RESOURCE_TAG_ARG,
  SELF_GATED_TOOLS,
  taggedTerminalId,
  type CallOutcome,
  type ListedTool,
  type ManifestBundle,
  type McpModules,
  type McpSession,
} from "../lib/mcpSessionFixture";

/** Graded tools per direction, per tier, in the authorization battery. */
const AUTH_SAMPLE_SIZE = 12;

/** Denials the abuse policy tolerates before it revokes the session. */
const ABUSE_MAX_DENIALS = 4;

/** Duplicate calls fired at one dedup key, and distinct keys fired beside them. */
const DEDUP_BATCH = 8;

/** Sessions in the concurrent-fanout scenario. */
const FANOUT_SESSIONS = 12;

/** The dedup-allowlisted creation tool the dedup scenario drives. */
const DEDUP_TOOL = "terminal.new";

/** A non-allowlisted control, to prove the cache is not swallowing everything. */
const DEDUP_CONTROL_TOOL = "terminal.list";

/** The only host a `help.displayImage` URL may name. */
const DISPLAY_IMAGE_URL = "https://daintree.org/perf/figure.png";

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index]!;
}

/** Ids in one set and not the other, both ways. The listing oracle's whole test. */
function symmetricDifference(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const id of a) if (!b.has(id)) count += 1;
  for (const id of b) if (!a.has(id)) count += 1;
  return count;
}

/**
 * Grade one battery of authorization outcomes.
 *
 * Three readings, because the failures are not the same failure. Admitting a
 * call the tier withholds has failed OPEN, which is the security defect.
 * Refusing one the tier permits has failed CLOSED, which breaks every agent.
 * Reaching the right verdict under the wrong code has drifted — a client tells
 * "not in your tier" from "needs a human" and from "your session is gone" only
 * by the code, and all three refuse.
 */
function gradeAuth(
  outcomes: readonly CallOutcome[],
  expected: ReadonlyArray<{ toolId: string; ok: boolean; code: string | null }>
): { failOpen: number; failClosed: number; codeMismatch: number } {
  let failOpen = 0;
  let failClosed = 0;
  let codeMismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i]!;
    const got = outcomes[i];
    if (!got || got.toolId !== want.toolId) {
      // A missing or reordered probe is not evidence of anything; count it the
      // safe way rather than skipping it.
      failClosed += 1;
      continue;
    }
    if (got.ok !== want.ok) {
      if (got.ok) failOpen += 1;
      else failClosed += 1;
      continue;
    }
    if (!want.ok && got.code !== want.code) codeMismatch += 1;
  }
  return { failOpen, failClosed, codeMismatch };
}

/** Whether `tools/list` refuses, and with which message. */
async function listOrRefusal(session: McpSession): Promise<{ ok: boolean; message: string }> {
  try {
    await session.client.listTools();
    return { ok: true, message: "" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Every listed tool id, as a set. */
function listedIds(tools: readonly ListedTool[]): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

async function fixture(): Promise<{ mods: McpModules; manifest: ManifestBundle }> {
  const [mods, manifest] = await Promise.all([loadMcpModules(), loadRealManifest()]);
  return { mods, manifest };
}

export const mcpSessionScenarios: PerfScenario[] = [
  {
    id: "PERF-280",
    name: "MCP Session Establishment - Handshake to First tools/list",
    description:
      "What an external agent pays to connect. Constructs a real createSessionServer, completes a real MCP initialize handshake with a real SDK Client over an in-memory transport, and reads the first tools/list. Reports the handshake frame bytes, the MCP_SERVER_INSTRUCTIONS block billed on every connection, and the first listing, for an unbound system session and a workspace-bound external one. The workspace-binding capability must be echoed for the bound session and absent for the unbound one.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 5, ci: 10, nightly: 14 },
    warmups: 2,
    correctness: ["handshakeMisses"],
    async run() {
      const { mods, manifest } = await fixture();
      const start = performance.now();

      const unbound = await openSession(mods, manifest, { tier: "system" });
      const handshakeWireBytes = unbound.serverOutBytes;
      const instructions = unbound.client.getInstructions() ?? "";
      const capabilities = unbound.client.getServerCapabilities();

      const listStart = performance.now();
      const listResult = await unbound.measureServerBytes(() => unbound.client.listTools());
      const firstListMs = performance.now() - listStart;
      const advertised = listedIds(listResult.value.tools);

      const bound = await openSession(mods, manifest, {
        tier: "external",
        workspaceBinding: PERF_WORKSPACE_BINDING,
      });
      const boundCapabilities = bound.client.getServerCapabilities();
      const boundListed = listedIds((await bound.client.listTools()).tools);

      let handshakeMisses = 0;
      if (instructions !== mods.MCP_SERVER_INSTRUCTIONS) handshakeMisses += 1;
      // `listChanged` is what lets a client act on the tier-elevation
      // notification; a server that drops it looks identical until a tier moves.
      if (capabilities?.tools?.listChanged !== true) handshakeMisses += 1;
      if (capabilities?.resources?.subscribe !== true) handshakeMisses += 1;
      if (capabilities?.prompts === undefined) handshakeMisses += 1;
      // Declaring capabilities at construction must not cost the SDK's own
      // initialize handling — client capability capture still has to work.
      if (unbound.server.getClientCapabilities() === undefined) handshakeMisses += 1;
      if (capabilities?.experimental?.[mods.WORKSPACE_BINDING_CAPABILITY_KEY] !== undefined) {
        handshakeMisses += 1;
      }
      const echoed = boundCapabilities?.experimental?.[mods.WORKSPACE_BINDING_CAPABILITY_KEY];
      if (JSON.stringify(echoed) !== JSON.stringify(PERF_WORKSPACE_BINDING)) handshakeMisses += 1;
      handshakeMisses += symmetricDifference(
        advertised,
        expectedExposedIds(manifest, "system", false)
      );
      handshakeMisses += symmetricDifference(
        boundListed,
        expectedExposedIds(manifest, "external", true)
      );

      const durationMs = performance.now() - start;
      await unbound.close();
      await bound.close();

      return {
        durationMs,
        metrics: {
          handshakeMs: unbound.connectMs,
          handshakeWireBytes,
          instructionsBytes: Buffer.byteLength(instructions, "utf8"),
          firstListMs,
          firstListWireBytes: listResult.bytes,
          // What an agent pays before it can issue its first call.
          sessionReadyBytes: handshakeWireBytes + listResult.bytes,
          advertisedToolCount: advertised.size,
          boundAdvertisedToolCount: boundListed.size,
          handshakeMisses,
        },
      };
    },
  },
  {
    id: "PERF-281",
    name: "MCP tools/list Across Tiers - Bytes On The Transport",
    description:
      "The advertised tool surface as it actually crosses the transport, at all four tiers plus a workspace-bound external session, through the real ListTools handler and the real SDK. PERF-203 prices the projection alone; this adds the JSON-RPC frame and the client's own result validation, and the two numbers are meant to be read together. The exposure set is re-derived from the tier allowlist and the manifest's own danger/mcpVisibility fields rather than from shouldExposeTool, so the oracle cannot agree with the function it grades.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 2,
    correctness: ["surfaceMisses"],
    async run() {
      const { mods, manifest } = await fixture();
      const start = performance.now();

      const toolCounts: Record<string, number> = {};
      const wireBytes: Record<string, number> = {};
      let surfaceMisses = 0;
      let listMs = 0;
      let payloadBytesSystem = 0;
      let wireBytesSystem = 0;

      for (const tier of MCP_TIERS) {
        const session = await openSession(mods, manifest, { tier });
        const listStart = performance.now();
        const measured = await session.measureServerBytes(() => session.client.listTools());
        listMs += performance.now() - listStart;
        const tools = measured.value.tools;
        toolCounts[tier] = tools.length;
        wireBytes[tier] = measured.bytes;
        if (tier === "system") {
          wireBytesSystem = measured.bytes;
          payloadBytesSystem = Buffer.byteLength(JSON.stringify({ tools }), "utf8");
        }

        surfaceMisses += symmetricDifference(
          listedIds(tools),
          expectedExposedIds(manifest, tier, false)
        );
        for (const tool of tools) {
          // Every advertised tool carries a closed object input schema and a
          // title annotation — that is what a client compiles against.
          if (tool.inputSchema?.["type"] !== "object") surfaceMisses += 1;
          if (tool.inputSchema?.["additionalProperties"] !== false) surfaceMisses += 1;
          if (tool.annotations?.["title"] !== manifest.byId.get(tool.name)?.title) {
            surfaceMisses += 1;
          }
        }
        await session.close();
      }

      const boundSession = await openSession(mods, manifest, {
        tier: "external",
        workspaceBinding: PERF_WORKSPACE_BINDING,
      });
      const boundMeasured = await boundSession.measureServerBytes(() =>
        boundSession.client.listTools()
      );
      const boundIds = listedIds(boundMeasured.value.tools);
      surfaceMisses += symmetricDifference(
        boundIds,
        expectedExposedIds(manifest, "external", true)
      );
      await boundSession.close();

      // Currently zero for every tier — no allowlisted action is `restricted`
      // or `hidden`. Reported rather than assumed so the day one is, the
      // listing ceiling is visible as a number instead of an unexercised branch.
      let withheldByVisibilityCount = 0;
      for (const tier of MCP_TIERS) {
        const permitted = manifest.actionModules.getTierPermittedActionIds(tier);
        for (const entry of manifest.entries) {
          if (!permitted.has(entry.id)) continue;
          if (entry.danger === "restricted" || entry.mcpVisibility === "hidden") {
            withheldByVisibilityCount += 1;
          }
        }
      }

      const durationMs = performance.now() - start;
      return {
        durationMs,
        metrics: {
          workbenchToolCount: toolCounts.workbench ?? 0,
          actionToolCount: toolCounts.action ?? 0,
          systemToolCount: toolCounts.system ?? 0,
          externalToolCount: toolCounts.external ?? 0,
          boundExternalToolCount: boundIds.size,
          boundExternalWithheldCount: (toolCounts.external ?? 0) - boundIds.size,
          workbenchWireBytes: wireBytes.workbench ?? 0,
          actionWireBytes: wireBytes.action ?? 0,
          systemWireBytes: wireBytes.system ?? 0,
          externalWireBytes: wireBytes.external ?? 0,
          boundExternalWireBytes: boundMeasured.bytes,
          // What the JSON-RPC envelope adds to PERF-203's projection number.
          jsonRpcEnvelopeBytes: wireBytesSystem - payloadBytesSystem,
          withheldByVisibilityCount,
          listMs,
          surfaceMisses,
        },
      };
    },
  },
  {
    id: "PERF-282",
    name: "MCP tools/call Round Trip - Dispatch, Result and Client Schema Validation",
    description:
      "Every tool a system-tier session can reach, called through the real CallTool handler: parseToolArguments strips the protocol-only fields, the gate chain admits, the result is assembled by buildToolCallResult and buildStructuredContent, and the SDK client compiles each advertised outputSchema and validates the structuredContent with AJV. The renderer is not here, so the dispatch leg is a counting stand-in that answers with a minimal instance of the action's own advertised schema. One final call is answered with a payload that schema rejects, so the client's AJV pass is observed refusing it rather than assumed to have run — a client that skipped validation would be faster and otherwise indistinguishable.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 10 },
    warmups: 2,
    correctness: [
      "callMisses",
      "structuredContentMisses",
      "argsMisses",
      "auditRecordMisses",
      "schemaValidationMisses",
    ],
    async run() {
      const { mods, manifest } = await fixture();
      const session = await openSession(mods, manifest, { tier: "system" });
      const start = performance.now();

      // The battery is derived from the tier allowlist and the manifest, NOT
      // from what the server just advertised. Reading it off the listing would
      // make a server that lists nothing call nothing and score a clean sheet
      // — the exact shape this harness exists to refuse.
      //
      // Three tools are held out: the two `*Owned` cleanups check the ownership
      // ledger and `help.displayImage` requires a help binding, so refusing is
      // the right answer for all three and none belongs in a battery whose
      // oracle is "every call is admitted". PERF-283 grades them both ways.
      const battery = [...expectedExposedIds(manifest, "system", false)]
        .filter((id) => !SELF_GATED_TOOLS.has(id))
        .sort();
      // Mirrors `buildToolOutputSchema`: only an object-typed schema is
      // advertised, and only an advertised one makes the client validate.
      const schemaCarrying = new Set(
        battery.filter((id) => {
          const schema = manifest.byId.get(id)?.outputSchema;
          return (
            schema !== undefined &&
            typeof schema === "object" &&
            !Array.isArray(schema) &&
            (schema as Record<string, unknown>)["type"] === "object"
          );
        })
      );
      // Still listed, because the client compiles the advertised schemas it
      // validates against and the compile is part of the number.
      const listedCount = (await session.client.listTools()).tools.length;

      const bytesBefore = session.serverOutBytes;
      const requestBytesBefore = session.clientOutBytes;
      const auditsBefore = session.audits.length;
      const dispatchesBefore = session.dispatches.length;

      const latencies: number[] = [];
      let callMisses = 0;
      let structuredContentMisses = 0;
      let structuredContentCount = 0;

      const callStart = performance.now();
      for (let index = 0; index < battery.length; index += 1) {
        const toolId = battery[index]!;
        const nonce = `perf-282-${index}`;
        const at = performance.now();
        const outcome = await probeCall(session, toolId, {
          perfNonce: nonce,
          // Stripped by `parseToolArguments` before dispatch — the args check
          // below is what proves it.
          requestKey: nonce,
          _meta: { progressToken: nonce },
        });
        latencies.push(performance.now() - at);
        if (!outcome.ok) callMisses += 1;
        if (outcome.hasStructuredContent) structuredContentCount += 1;
        if (schemaCarrying.has(toolId) && !outcome.hasStructuredContent) {
          structuredContentMisses += 1;
        }
      }
      const callMs = performance.now() - callStart;

      const dispatched = session.dispatches.slice(dispatchesBefore);
      let argsMisses = 0;
      for (const record of dispatched) {
        const args = record.args as Record<string, unknown> | undefined;
        // `perfNonce` must survive verbatim; `requestKey` and `_meta` must not.
        if (typeof args?.perfNonce !== "string" || !args.perfNonce.startsWith("perf-282-")) {
          argsMisses += 1;
        }
        if (args !== undefined && ("requestKey" in args || "_meta" in args)) argsMisses += 1;
      }

      const audits = session.audits.slice(auditsBefore);
      let auditRecordMisses = Math.abs(audits.length - battery.length);
      for (const record of audits) {
        if (record.outcomeKind !== "result") auditRecordMisses += 1;
        if (record.tier !== "system") auditRecordMisses += 1;
      }

      const responseWireBytes = session.serverOutBytes - bytesBefore;
      const requestWireBytes = session.clientOutBytes - requestBytesBefore;

      // Every reply above satisfied the schema it was advertised under, so all
      // of them are equally consistent with a client that never validated
      // anything — and that client would be faster, which is the direction this
      // scenario's number is read in. The arm below is the only reading that
      // separates the two: one call answered with a payload the tool's own
      // advertised schema rejects, which nothing on the server checks.
      //
      // The tool is chosen from what the battery actually dispatched, so this
      // can never quietly grade a call the stand-in dispatcher never served.
      // Dedup-allowlisted tools are excluded: a cached replay would answer
      // without dispatching, and the poisoned reply would never be built.
      const poisonTool = dispatched
        .map((record) => record.actionId)
        .find(
          (id) =>
            schemaCarrying.has(id) &&
            !mods.MCP_DEDUP_ALLOWLIST.has(id) &&
            requiredOutputKeys(manifest.byId.get(id)?.outputSchema).length > 0
        );
      let schemaValidationMisses = 1;
      if (poisonTool !== undefined) {
        const beforePoison = session.dispatches.length;
        session.poisonNextResult(poisonTool);
        const rejected = await probeCall(session, poisonTool, { perfNonce: "perf-282-poison" });
        const servedByDispatch = session.dispatches.length === beforePoison + 1;
        // The client raises `Structured content does not match the tool's
        // output schema`; anything else refused it for another reason and is
        // not evidence the validator ran.
        const refusedByValidator = !rejected.ok && (rejected.code ?? "").includes("output schema");
        schemaValidationMisses = servedByDispatch && refusedByValidator ? 0 : 1;
      }

      const durationMs = performance.now() - start;
      const sorted = [...latencies].sort((a, b) => a - b);
      await session.close();

      return {
        durationMs,
        metrics: {
          callCount: battery.length,
          advertisedToolCount: listedCount,
          schemaValidatedCallCount: schemaCarrying.size,
          structuredContentCount,
          dispatchCount: dispatched.length,
          requestWireBytes,
          responseWireBytes,
          callMs,
          p50CallMs: percentile(sorted, 0.5),
          p95CallMs: percentile(sorted, 0.95),
          callMisses,
          structuredContentMisses,
          argsMisses,
          auditRecordMisses,
          schemaValidationMisses,
        },
      };
    },
  },
  {
    id: "PERF-283",
    name: "MCP Tier Authorization - Graded Both Ways",
    description:
      "Every authorization gate a tool call crosses, graded in both directions across all four tiers: a permitted call must be admitted and a withheld one refused with TIER_NOT_PERMITTED. Adds the ownership ledger (a resource this session created may be cleaned up, another session's may not), the workspace-bound confirmation ceiling, and the real AbusePolicy driven to a trip so the session is genuinely revoked and every later request answers SESSION_GONE. A server that authorizes everything is fast and catastrophic; one that authorizes nothing is faster still.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 10 },
    warmups: 2,
    correctness: [
      "authFailOpenMisses",
      "authFailClosedMisses",
      "authCodeMisses",
      "decisionShortfallCount",
    ],
    async run() {
      const { mods, manifest } = await fixture();
      const start = performance.now();

      const outcomes: CallOutcome[] = [];
      const expected: Array<{ toolId: string; ok: boolean; code: string | null }> = [];

      const externalPermitted = manifest.actionModules.getTierPermittedActionIds("external");
      const confirmGated = manifest.entries
        .filter((entry) => externalPermitted.has(entry.id) && entry.danger === "confirm")
        .map((entry) => entry.id)
        .sort();

      // How many decisions this battery is supposed to reach, counted from the
      // manifest and the tier allowlists rather than from the rows the loops
      // below happen to produce. `gradeAuth` walks two arrays this scenario
      // pushes to in lockstep, so a section that silently stopped emitting rows
      // shortens both and grades clean — this is the reading that catches it.
      const plannedDecisions =
        MCP_TIERS.length * 2 * AUTH_SAMPLE_SIZE +
        2 + // ownership: the session's own resource, and a foreign id
        3 + // help.displayImage: no binding, bound, and a rejected URL
        confirmGated.length +
        1 + // one plain tool on the bound session
        ABUSE_MAX_DENIALS +
        1; // the call after the policy revoked the session

      const batteryStart = performance.now();

      // 1. The tier floor, both directions, on every tier.
      for (const tier of MCP_TIERS) {
        const session = await openSession(mods, manifest, { tier });
        const permitted = permittedCallSample(manifest, tier, AUTH_SAMPLE_SIZE);
        const forbidden = forbiddenCallSample(manifest, tier, AUTH_SAMPLE_SIZE);
        for (const toolId of permitted) {
          expected.push({ toolId, ok: true, code: null });
          outcomes.push(await probeCall(session, toolId, {}));
        }
        for (const toolId of forbidden) {
          expected.push({ toolId, ok: false, code: mods.TIER_NOT_PERMITTED_CODE });
          outcomes.push(await probeCall(session, toolId, {}));
        }
        await session.close();
      }

      // 2. The ownership ledger. The id comes out of the dispatch envelope the
      // creation returned, never from anything the caller said, so a session
      // can clean up what it made and nothing else.
      const owner = await openSession(mods, manifest, { tier: "system" });
      const created = await owner.client.callTool({
        name: "terminal.new",
        arguments: { cwd: "/tmp/daintree-perf" },
      });
      const createdId = readResultPayload(created).terminalId;
      const ownedId = typeof createdId === "string" ? createdId : undefined;
      const ownershipRecorded =
        ownedId !== undefined &&
        owner.store.resourceOwnership.owns(owner.sessionId, "terminal", ownedId);
      expected.push({ toolId: "terminal.closeOwned", ok: true, code: null });
      outcomes.push(await probeCall(owner, "terminal.closeOwned", { terminalId: ownedId ?? "" }));
      expected.push({
        toolId: "terminal.closeOwned",
        ok: false,
        code: mods.RESOURCE_NOT_OWNED_CODE,
      });
      outcomes.push(
        await probeCall(owner, "terminal.closeOwned", { terminalId: "perf-terminal-foreign" })
      );
      // The delegation rewrite: `closeOwned` must reach the renderer as
      // `terminal.close` carrying only the id, never the caller's other args.
      const delegated = owner.dispatches.filter((record) => record.actionId === "terminal.close");
      await owner.close();

      // 3. The help-session gate on `help.displayImage`, which the tier
      // allowlist admits and the handler then refuses without a help binding —
      // and whose URL allowlist is the only thing keeping arbitrary content out
      // of the assistant panel. Both are ceilings a fail-open server clears.
      const plainSession = await openSession(mods, manifest, { tier: "system" });
      expected.push({ toolId: "help.displayImage", ok: false, code: mods.TIER_NOT_PERMITTED_CODE });
      outcomes.push(await probeCall(plainSession, "help.displayImage", { url: DISPLAY_IMAGE_URL }));
      await plainSession.close();

      const helpSession = await openSession(mods, manifest, {
        tier: "system",
        helpSessionId: "perf-help-session",
      });
      expected.push({ toolId: "help.displayImage", ok: true, code: null });
      outcomes.push(await probeCall(helpSession, "help.displayImage", { url: DISPLAY_IMAGE_URL }));
      expected.push({ toolId: "help.displayImage", ok: false, code: mods.INVALID_URL_CODE });
      outcomes.push(
        await probeCall(helpSession, "help.displayImage", {
          url: "data:image/png;base64,AAAA",
        })
      );
      await helpSession.close();

      // 4. The workspace-bound confirmation ceiling. A confirm-gated tool has
      // nobody to approve it in a background workspace, so it is refused before
      // dispatch; a plain one on the same session still runs.
      const boundSession = await openSession(mods, manifest, {
        tier: "external",
        workspaceBinding: PERF_WORKSPACE_BINDING,
      });
      for (const toolId of confirmGated) {
        expected.push({ toolId, ok: false, code: mods.CONFIRMATION_REQUIRED_CODE });
        outcomes.push(await probeCall(boundSession, toolId, { worktreeId: "/tmp/x" }));
      }
      const boundPlain = permittedCallSample(manifest, "external", 1);
      for (const toolId of boundPlain) {
        expected.push({ toolId, ok: true, code: null });
        outcomes.push(await probeCall(boundSession, toolId, {}));
      }
      await boundSession.close();

      // 5. The abuse policy. Denials below the ceiling must still refuse on
      // tier; the one that trips it must revoke, after which every request
      // answers SESSION_GONE rather than the tier code.
      const abused = await openSession(mods, manifest, {
        tier: "external",
        abuseMaxDenials: ABUSE_MAX_DENIALS,
      });
      const abuseTargets = forbiddenCallSample(manifest, "external", ABUSE_MAX_DENIALS);
      for (const toolId of abuseTargets) {
        expected.push({ toolId, ok: false, code: mods.TIER_NOT_PERMITTED_CODE });
        outcomes.push(await probeCall(abused, toolId, {}));
      }
      const survivor = permittedCallSample(manifest, "external", 1)[0]!;
      expected.push({ toolId: survivor, ok: false, code: mods.SESSION_GONE });
      outcomes.push(await probeCall(abused, survivor, {}));
      const listAfterRevoke = await listOrRefusal(abused);
      const revoked = abused.revokedByPolicy;
      await abused.close();

      const batteryMs = performance.now() - batteryStart;
      const grade = gradeAuth(outcomes, expected);

      let authFailClosedMisses = grade.failClosed;
      let authFailOpenMisses = grade.failOpen;
      // A ledger that records nothing refuses every cleanup and scores a clean
      // fail-open sheet, so the recording half is graded too.
      if (!ownershipRecorded) authFailClosedMisses += 1;
      if (
        delegated.length !== 1 ||
        (delegated[0]?.args as { terminalId?: string })?.terminalId !== ownedId
      ) {
        authFailClosedMisses += 1;
      }
      // A policy that never trips leaves the session live; a listing that still
      // answers after revocation is the same failure seen from discovery.
      if (!revoked) authFailOpenMisses += 1;
      if (listAfterRevoke.ok) authFailOpenMisses += 1;

      const durationMs = performance.now() - start;
      return {
        durationMs,
        metrics: {
          authDecisionCount: outcomes.length,
          permittedAdmittedCount: outcomes.filter(
            (outcome, index) => expected[index]?.ok && outcome.ok
          ).length,
          refusedCount: outcomes.filter((outcome) => !outcome.ok).length,
          tierRefusalCount: outcomes.filter(
            (outcome) => outcome.code === mods.TIER_NOT_PERMITTED_CODE
          ).length,
          confirmationRefusalCount: outcomes.filter(
            (outcome) => outcome.code === mods.CONFIRMATION_REQUIRED_CODE
          ).length,
          sessionGoneRefusalCount: outcomes.filter((outcome) => outcome.code === mods.SESSION_GONE)
            .length,
          decisionShortfallCount: Math.max(0, plannedDecisions - outcomes.length),
          batteryMs,
          authFailOpenMisses,
          authFailClosedMisses,
          authCodeMisses: grade.codeMismatch,
        },
        notes:
          grade.failOpen > 0
            ? `${grade.failOpen} authorization decision(s) failed OPEN`
            : undefined,
      };
    },
  },
  {
    id: "PERF-284",
    name: "MCP Dedup - Concurrent Duplicates and TTL Replay",
    description:
      "The idempotency guard an agent's retry loop lands on. Eight concurrent calls on one requestKey must singleflight to a single dispatch and hand every caller the same created id; eight replays inside the TTL must dispatch nothing and return that same id; a reused key with different arguments must be refused as a collision. Graded in both directions — eight distinct keys and eight calls to a non-allowlisted tool must dispatch eight times each, because a cache that suppresses everything is the fastest wrong answer available.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 5, ci: 10, nightly: 14 },
    warmups: 2,
    correctness: ["dedupMisses", "dedupOverSuppressMisses"],
    async run() {
      const { mods, manifest } = await fixture();
      const session = await openSession(mods, manifest, { tier: "system" });
      const start = performance.now();

      const key = `perf-284-${Math.random().toString(36).slice(2)}`;
      const args = { cwd: "/tmp/daintree-perf", requestKey: key };

      const singleflightStart = performance.now();
      const concurrent = await Promise.all(
        Array.from({ length: DEDUP_BATCH }, () =>
          session.client.callTool({ name: DEDUP_TOOL, arguments: args })
        )
      );
      const singleflightMs = performance.now() - singleflightStart;
      const singleflightDispatches = session.dispatches.length;

      const replayStart = performance.now();
      const replays: Awaited<ReturnType<typeof session.client.callTool>>[] = [];
      for (let i = 0; i < DEDUP_BATCH; i += 1) {
        replays.push(await session.client.callTool({ name: DEDUP_TOOL, arguments: args }));
      }
      const replayMs = performance.now() - replayStart;
      const replayDispatches = session.dispatches.length - singleflightDispatches;

      const collision = await probeCall(session, DEDUP_TOOL, {
        cwd: "/tmp/daintree-perf/other",
        requestKey: key,
      });

      const distinctBefore = session.dispatches.length;
      for (let i = 0; i < DEDUP_BATCH; i += 1) {
        await session.client.callTool({
          name: DEDUP_TOOL,
          arguments: { cwd: "/tmp/daintree-perf", requestKey: `${key}-${i}` },
        });
      }
      const distinctKeyDispatchCount = session.dispatches.length - distinctBefore;

      const controlBefore = session.dispatches.length;
      for (let i = 0; i < DEDUP_BATCH; i += 1) {
        await session.client.callTool({
          name: DEDUP_CONTROL_TOOL,
          arguments: { requestKey: key },
        });
      }
      const controlDispatchCount = session.dispatches.length - controlBefore;

      const canonical = JSON.stringify(concurrent[0]);
      let dedupMisses = 0;
      if (singleflightDispatches !== 1) dedupMisses += Math.abs(singleflightDispatches - 1);
      if (replayDispatches !== 0) dedupMisses += replayDispatches;
      // The created id is the strongest reading here: a replay that re-ran the
      // action would hand back a different terminal, and a cache that returned
      // a well-formed but empty result would not carry one at all.
      for (const result of [...concurrent, ...replays]) {
        if (JSON.stringify(result) !== canonical) dedupMisses += 1;
      }
      if (typeof readResultPayload(concurrent[0]!).terminalId !== "string") dedupMisses += 1;
      if (collision.code !== mods.MCP_DEDUP_KEY_COLLISION_CODE) dedupMisses += 1;

      // Both tools' membership is the scenario's own premise. Asserting it here
      // means a change to the allowlist reads as a broken measurement rather
      // than as a dedup that quietly stopped or started deduping.
      if (!mods.MCP_DEDUP_ALLOWLIST.has(DEDUP_TOOL)) dedupMisses += 1;

      let dedupOverSuppressMisses = Math.abs(distinctKeyDispatchCount - DEDUP_BATCH);
      dedupOverSuppressMisses += Math.abs(controlDispatchCount - DEDUP_BATCH);
      if (mods.MCP_DEDUP_ALLOWLIST.has(DEDUP_CONTROL_TOOL)) dedupOverSuppressMisses += 1;

      const cacheEntryCount = session.store.dedupResultCache.get(session.sessionId)?.size ?? 0;
      const durationMs = performance.now() - start;
      await session.close();

      return {
        durationMs,
        metrics: {
          dedupCallCount: DEDUP_BATCH * 4 + 1,
          singleflightDispatchCount: singleflightDispatches,
          replayDispatchCount: replayDispatches,
          suppressedDispatchCount: DEDUP_BATCH * 2 - singleflightDispatches - replayDispatches,
          distinctKeyDispatchCount,
          controlDispatchCount,
          dedupCacheEntryCount: cacheEntryCount,
          singleflightMs,
          replayMs,
          dedupMisses,
          dedupOverSuppressMisses,
        },
      };
    },
  },
  {
    id: "PERF-285",
    name: "MCP Concurrent Session Fanout",
    description:
      "Twelve sessions at rotating tiers on one SessionStore, each completing a handshake, a tools/list and a call. Reports what a fleet of external agents costs the host in transport bytes and how much of the store each session leaves behind. Each session's listing must match its own tier exactly — an external session that sees a workbench tool is a leak, not a performance result. Each creating session also names the resource it asks for, so the ownership ledger is graded, after the whole fanout has run, against what the sessions requested rather than against what the ledger itself reports — then revoking must clear every one of those records.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 6, nightly: 8 },
    warmups: 2,
    correctness: ["fanoutMisses", "crossSessionLeakMisses", "ownershipMisses", "teardownMisses"],
    async run() {
      const { mods, manifest } = await fixture();
      const store = new mods.SessionStore(() => {});
      const start = performance.now();

      const sessions: McpSession[] = [];
      let crossSessionLeakMisses = 0;
      let fanoutMisses = 0;
      let ownershipMisses = 0;
      let listedToolTotal = 0;
      // What each session was ASKED to create, decided by this scenario before
      // the call goes out. Grading against ids read back off the replies (or off
      // the ledger) is what let a fanout of twelve minting one shared id score
      // clean: the ledger's newest-creator-wins eviction left a single live
      // record, and a self-derived expectation agreed with it.
      const requested: Array<{ sessionId: string; terminalId: string }> = [];

      const fanoutStart = performance.now();
      for (let index = 0; index < FANOUT_SESSIONS; index += 1) {
        const tier = MCP_TIERS[index % MCP_TIERS.length]!;
        const session = await openSession(mods, manifest, { tier, store });
        sessions.push(session);

        const tools = (await session.client.listTools()).tools;
        listedToolTotal += tools.length;
        crossSessionLeakMisses += symmetricDifference(
          listedIds(tools),
          expectedExposedIds(manifest, tier, false)
        );

        const target = permittedCallSample(manifest, tier, 1)[0]!;
        const outcome = await probeCall(session, target, {});
        if (!outcome.ok) fanoutMisses += 1;

        // One creation per session that can make one, so the teardown check
        // has a ledger entry to lose rather than an empty map to agree with.
        if (manifest.actionModules.getTierPermittedActionIds(tier).has("terminal.new")) {
          const tag = `${session.sessionId}-fanout-${index}`;
          const terminalId = taggedTerminalId(tag);
          requested.push({ sessionId: session.sessionId, terminalId });
          const created = await session.client.callTool({
            name: "terminal.new",
            arguments: {
              cwd: "/tmp/daintree-perf",
              [RESOURCE_TAG_ARG]: tag,
              requestKey: `fanout-${index}`,
            },
          });
          if (readResultPayload(created).terminalId !== terminalId) ownershipMisses += 1;
        }
      }
      const fanoutMs = performance.now() - fanoutStart;

      // Read once the whole fleet has created, never as each session goes: a
      // ledger holding one record at a time satisfies an inline check on every
      // iteration and still ends with eleven sessions owning nothing.
      let ownershipRecordedCount = 0;
      for (const owned of requested) {
        if (store.resourceOwnership.owns(owned.sessionId, "terminal", owned.terminalId)) {
          ownershipRecordedCount += 1;
        } else {
          ownershipMisses += 1;
        }
      }
      // A fanout that asked for nothing proves nothing about a fanout.
      if (requested.length === 0) ownershipMisses += 1;

      const totalServerWireBytes = sessions.reduce(
        (total, session) => total + session.serverOutBytes,
        0
      );

      for (const session of sessions) {
        session.revoke();
        await session.close();
      }

      let teardownMisses = store.sessions.size + store.sessionTierMap.size;
      teardownMisses += store.dedupResultCache.size + store.dedupInFlight.size;
      for (const owned of requested) {
        if (store.resourceOwnership.owns(owned.sessionId, "terminal", owned.terminalId)) {
          teardownMisses += 1;
        }
      }
      // A ledger that never recorded anything clears perfectly, so the count it
      // was holding before the revoke is part of this reading.
      if (ownershipRecordedCount === 0) teardownMisses += 1;

      const durationMs = performance.now() - start;
      disposeStore(store);

      return {
        durationMs,
        metrics: {
          sessionCount: FANOUT_SESSIONS,
          listedToolTotal,
          totalServerWireBytes,
          bytesPerSession: Math.round(totalServerWireBytes / FANOUT_SESSIONS),
          requestedResourceCount: requested.length,
          ownershipRecordedCount,
          residualSessionCount: store.sessions.size,
          fanoutMs,
          fanoutMisses,
          crossSessionLeakMisses,
          ownershipMisses,
          teardownMisses,
        },
      };
    },
  },
];
