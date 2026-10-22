import { describe, expect, it, vi } from "vitest";
import type {
  HostSourceResolver,
  ResolveRequest,
} from "../../../../shared/elementPicker/resolver.js";
import type { HostOutbound } from "../hostProtocol.js";
import { createHostRuntime, type ResolverLoaders } from "../worker/runtime.js";
import { candidate, observation, request, stubResolver } from "./fixtures.js";

function runtime(loaders: ResolverLoaders) {
  const sent: HostOutbound[] = [];
  const subject = createHostRuntime((message) => sent.push(message), loaders);
  const next = async (type: HostOutbound["type"]) => {
    await vi.waitFor(() => expect(sent.some((message) => message.type === type)).toBe(true));
    const index = sent.findIndex((message) => message.type === type);
    return sent.splice(index, 1)[0]!;
  };
  return { subject, sent, next };
}

function recording(framework: "svelte" | "react", seen: ResolveRequest[]): HostSourceResolver {
  return {
    framework,
    resolve: async (req) => {
      seen.push(req);
      return {
        requestId: req.requestId,
        documentEpoch: req.documentEpoch,
        outcomes: req.observations.map((obs) => ({
          elementId: obs.elementId,
          results: [
            ...obs.sourceCandidates,
            ...obs.componentChain.components.flatMap((r) => r.sourceCandidates),
          ].map((source) => ({
            state: "observed" as const,
            candidateId: source.candidateId,
            claim: source.kind,
            target: { file: { workspaceId: req.workspaceId, path: source.file }, location: null },
            fileRevision: null,
          })),
        })),
      };
    },
  };
}

describe("host runtime", () => {
  it("routes each candidate to its framework's resolver and merges in candidate order", async () => {
    const seen: ResolveRequest[] = [];
    const { subject, next } = runtime({
      svelte: async () => recording("svelte", seen),
      react: async () => recording("react", seen),
    });
    const req = request("ws", [
      observation(
        "el-1",
        [candidate("c-1", "a.tsx", "react"), candidate("c-2", "b.svelte")],
        [candidate("c-3", "c.svelte"), candidate("c-4", "d.vue", "vue")]
      ),
    ]);
    subject.handle({ type: "resolve", jobId: 1, request: req });
    const message = await next("resolved");
    const response =
      message.type === "resolved"
        ? (message.response as {
            outcomes: { results: { candidateId: string; state: string; reason?: string }[] }[];
          })
        : null;
    expect(response?.outcomes[0]?.results.map((r) => [r.candidateId, r.state, r.reason])).toEqual([
      ["c-1", "observed", undefined],
      ["c-2", "observed", undefined],
      ["c-3", "observed", undefined],
      ["c-4", "unavailable", "unsupported"],
    ]);
    const byFramework = Object.fromEntries(
      seen.map((r) => [
        r.observations[0]!.sourceCandidates[0]?.framework ?? "none",
        [
          ...r.observations[0]!.sourceCandidates,
          ...r.observations[0]!.componentChain.components.flatMap((c) => c.sourceCandidates),
        ].map((c) => c.candidateId),
      ])
    );
    expect(byFramework).toEqual({ react: ["c-1"], svelte: ["c-2", "c-3"] });
  });

  it("asks main for bytes and resolves the read with main's answer", async () => {
    const { subject, next } = runtime({ svelte: async () => stubResolver() });
    subject.handle({
      type: "resolve",
      jobId: 7,
      request: request("ws", [observation("el-1", [candidate("c-1", "src/A.svelte")])]),
    });
    const ask = await next("read-source");
    expect(ask).toMatchObject({ jobId: 7, file: { workspaceId: "ws", path: "src/A.svelte" } });
    subject.handle({
      type: "access-result",
      jobId: 7,
      accessId: ask.type === "read-source" ? ask.accessId : 0,
      result: { ok: false, reason: "file-missing" },
    });
    const done = await next("resolved");
    expect(done).toMatchObject({
      response: { outcomes: [{ results: [{ state: "unavailable", reason: "file-missing" }] }] },
    });
  });

  it("answers a cancelled job with every unanswered candidate cancelled", async () => {
    const { subject, next } = runtime({ svelte: async () => stubResolver() });
    subject.handle({
      type: "resolve",
      jobId: 2,
      request: request("ws", [observation("el-1", [candidate("c-1", "src/A.svelte")])]),
    });
    await next("read-source");
    subject.handle({ type: "cancel", jobId: 2 });
    const done = await next("resolved");
    expect(done).toMatchObject({
      response: { outcomes: [{ results: [{ state: "unavailable", reason: "cancelled" }] }] },
    });
  });

  it("fails the job when a resolver cannot load, and loads it again next time", async () => {
    const loader = vi
      .fn<() => Promise<HostSourceResolver>>()
      .mockRejectedValueOnce(new Error("chunk missing"))
      .mockResolvedValue(recording("svelte", []));
    const { subject, next } = runtime({ svelte: loader });
    const req = () => request("ws", [observation("el-1", [candidate("c-1", "a.svelte")])]);
    subject.handle({ type: "resolve", jobId: 3, request: req() });
    await expect(next("failed")).resolves.toMatchObject({ jobId: 3, message: "chunk missing" });
    subject.handle({ type: "resolve", jobId: 4, request: req() });
    await expect(next("resolved")).resolves.toMatchObject({ jobId: 4 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("fails the job when a resolver throws", async () => {
    const { subject, next } = runtime({
      svelte: async () => ({
        framework: "svelte",
        resolve: async () => {
          throw new Error("parse exploded");
        },
      }),
    });
    subject.handle({
      type: "resolve",
      jobId: 5,
      request: request("ws", [observation("el-1", [candidate("c-1", "a.svelte")])]),
    });
    await expect(next("failed")).resolves.toMatchObject({ jobId: 5, message: "parse exploded" });
  });

  it("fails the job when a resolver answers a different request", async () => {
    const { subject, next } = runtime({
      svelte: async () => ({
        framework: "svelte",
        resolve: async (req) => ({
          requestId: "stale",
          documentEpoch: req.documentEpoch,
          outcomes: [],
        }),
      }),
    });
    subject.handle({
      type: "resolve",
      jobId: 6,
      request: request("ws", [observation("el-1", [candidate("c-1", "a.svelte")])]),
    });
    await expect(next("failed")).resolves.toMatchObject({ jobId: 6 });
  });

  it("ends a read on cancel even when the resolver passed a signal of its own", async () => {
    let read: Promise<unknown> | undefined;
    const { subject, next } = runtime({
      svelte: async () => ({
        framework: "svelte",
        resolve: async (req, access) => {
          read = access.readSource(
            { workspaceId: req.workspaceId, path: "a.svelte" },
            new AbortController().signal
          );
          await read;
          return { requestId: req.requestId, documentEpoch: req.documentEpoch, outcomes: [] };
        },
      }),
    });
    subject.handle({
      type: "resolve",
      jobId: 8,
      request: request("ws", [observation("el-1", [candidate("c-1", "a.svelte")])]),
    });
    await next("read-source");
    subject.handle({ type: "cancel", jobId: 8 });
    await expect(read).resolves.toEqual({ ok: false, reason: "cancelled" });
    await expect(next("resolved")).resolves.toMatchObject({
      response: { outcomes: [{ results: [{ reason: "cancelled" }] }] },
    });
  });
});
