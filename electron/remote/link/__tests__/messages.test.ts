import { describe, expect, it } from "vitest";
import { FrameDecoder, Lane, encodeFrame } from "../frames.js";
import {
  BulkKind,
  ControlKind,
  InteractiveKind,
  RpcKind,
  frameToMessage,
  messageToFrame,
} from "../messages.js";
import { parseInboundFrame } from "../schemas.js";
import {
  MAX_HOST_SUMMARY_DRIVERS,
  type HostMetricsSummary,
} from "../../../../shared/types/remoteHosts.js";

const hostSummary = (extra: object) =>
  parseInboundFrame(
    messageToFrame({
      lane: Lane.CONTROL,
      kind: ControlKind.HOST_SUMMARY,
      body: {
        hostId: "local",
        sampledAt: 1,
        platform: "darwin",
        cpuPercent: null,
        memoryPressure: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        swapUsedBytes: null,
        swapTotalBytes: null,
        thermal: null,
        cpuPressure: null,
        agentsObserved: null,
        projectCount: null,
        worktreeCount: null,
        driver: null,
        agentClis: [],
        ...extra,
      },
    } as never)
  ).body as HostMetricsSummary;

describe("link messages", () => {
  it("carries a summary's CPU scale and clusters, and one from a host that sends none", () => {
    const cpu = {
      cpuLogicalCoreCount: 14,
      cpuLoadAverage1m: 6.4,
      cpuPerformanceCoreCount: 10,
      cpuEfficiencyCoreCount: 4,
      cpuPerformancePercent: 65,
      cpuEfficiencyPercent: 9.5,
    };
    expect(hostSummary(cpu)).toMatchObject(cpu);
    const unknown = Object.fromEntries(Object.keys(cpu).map((key) => [key, null]));
    expect(hostSummary(unknown)).toMatchObject(unknown);
    const legacy = hostSummary({});
    for (const key of Object.keys(cpu)) expect(legacy).not.toHaveProperty(key);
    expect(() => hostSummary({ cpuLogicalCoreCount: 0 })).toThrow();
    expect(() => hostSummary({ cpuPerformancePercent: 101 })).toThrow();
    expect(() => hostSummary({ cpuLoadAverage1m: -1 })).toThrow();
  });

  it("carries a Linux host's raw observations, and one from a host that sends none", () => {
    const linux = {
      metricsScope: "cgroup",
      cpuCapacityCores: 1.5,
      memoryPressureSomeAvg10: 2.5,
      temperatureCelsius: 55,
      temperatureZone: "x86_pkg_temp (thermal_zone0)",
    };
    expect(hostSummary(linux)).toMatchObject(linux);
    const unknown = { ...linux, metricsScope: null, cpuCapacityCores: null };
    expect(hostSummary({ ...unknown, memoryPressureSomeAvg10: null })).toMatchObject({
      metricsScope: null,
      memoryPressureSomeAvg10: null,
    });
    const legacy = hostSummary({});
    for (const key of Object.keys(linux)) expect(legacy).not.toHaveProperty(key);
    expect(() => hostSummary({ metricsScope: "container" })).toThrow();
    expect(() => hostSummary({ cpuCapacityCores: 0 })).toThrow();
    expect(() => hostSummary({ memoryPressureSomeAvg10: 101 })).toThrow();
  });

  it("carries a summary's drivers, and one from a host that sends none, within its bound", () => {
    const summary = (extra: object) =>
      parseInboundFrame(
        messageToFrame({
          lane: Lane.CONTROL,
          kind: ControlKind.HOST_SUMMARY,
          body: {
            hostId: "local",
            sampledAt: 1,
            platform: "linux",
            cpuPercent: null,
            memoryPressure: null,
            memoryUsedBytes: null,
            memoryTotalBytes: null,
            swapUsedBytes: null,
            swapTotalBytes: null,
            thermal: null,
            cpuPressure: null,
            agentsObserved: null,
            projectCount: null,
            worktreeCount: null,
            driver: null,
            agentClis: [],
            ...extra,
          },
        } as never)
      ).body as { drivers?: unknown };
    const holder = {
      leaseId: 1,
      endpointId: "s1:e1",
      clientId: "c1",
      clientName: "greg-mbp",
      isHostLocal: false,
      acquiredAt: 1,
    };
    const driver = {
      projectId: "p1",
      projectName: "daintree",
      holder,
      state: "away",
      awayUntil: 9,
    };
    expect(summary({ drivers: [driver] }).drivers).toEqual([driver]);
    expect(summary({})).not.toHaveProperty("drivers");
    expect(summary({ drivers: null }).drivers).toBeNull();
    expect(() =>
      summary({ drivers: Array.from({ length: MAX_HOST_SUMMARY_DRIVERS + 1 }, () => driver) })
    ).toThrow();
  });

  it("round-trips a structured message through frame bytes", () => {
    const frame = messageToFrame({
      lane: Lane.RPC,
      kind: RpcKind.INVOKE,
      body: {
        requestId: 3,
        endpointId: "e1",
        channel: "worktree:get-all",
        args: [{ x: new Uint8Array([1]) }],
      },
    });
    const [decoded] = new FrameDecoder().push(encodeFrame(frame));
    const msg = frameToMessage(decoded!);
    expect(msg.lane).toBe(Lane.RPC);
    expect(msg.kind).toBe(RpcKind.INVOKE);
    expect((msg.body as { channel: string }).channel).toBe("worktree:get-all");
  });

  it("carries bulk chunks as raw payload bytes with their stream id", () => {
    const bytes = new Uint8Array([5, 6, 7]);
    const frame = messageToFrame({
      lane: Lane.BULK,
      kind: BulkKind.TRANSFER_CHUNK,
      body: bytes,
      streamId: 42,
    });
    expect(frame.payload).toBe(bytes);
    const msg = frameToMessage(frame);
    expect(msg).toMatchObject({ kind: BulkKind.TRANSFER_CHUNK, streamId: 42 });
  });

  it("carries an open's openId, and takes an open from a Shell that names none", () => {
    const open = (body: object) =>
      parseInboundFrame(
        messageToFrame({ lane: Lane.CONTROL, kind: ControlKind.ENDPOINT_OPEN, body } as never)
      ).body;
    expect(open({ endpointId: "view-1", projectId: "p", openId: "o1" })).toEqual({
      endpointId: "view-1",
      projectId: "p",
      openId: "o1",
    });
    expect(open({ endpointId: "view-1", projectId: null })).toEqual({
      endpointId: "view-1",
      projectId: null,
    });
  });

  it("lets a host that reads opens without openId take one that names it", () => {
    // Such a host reads OPEN with the shape REBIND still has.
    const frame = messageToFrame({
      lane: Lane.CONTROL,
      kind: ControlKind.ENDPOINT_REBIND,
      body: { endpointId: "view-1", projectId: "p", openId: "o1" },
    } as never);
    expect(parseInboundFrame(frame).body).toEqual({ endpointId: "view-1", projectId: "p" });
  });

  it("keeps a terminal reset's continuation, and the reset when its continuation is unreadable", () => {
    const reset = (continuation: unknown): unknown =>
      Reflect.get(
        parseInboundFrame(
          messageToFrame({
            lane: Lane.INTERACTIVE,
            kind: InteractiveKind.TERMINAL_RESET,
            body: {
              endpointId: "e1",
              terminalId: "t1",
              incarnation: 1,
              seq: 4,
              snapshot: { data: "S", cols: 80, rows: 24, continuation },
            },
          } as never)
        ).body,
        "snapshot"
      );

    const continuation = { pendingEscapeTail: "\x1b[3", streamOffset: 42 };
    expect(reset(continuation)).toEqual({ data: "S", cols: 80, rows: 24, continuation });
    // A host build that shapes it differently must not end the session over it.
    expect(reset({ pendingEscapeTail: 7, streamOffset: "42" })).toEqual({
      data: "S",
      cols: 80,
      rows: 24,
    });
  });

  it("uses distinct kind codes within each lane", () => {
    for (const kinds of [ControlKind, RpcKind]) {
      const values = Object.values(kinds);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});
