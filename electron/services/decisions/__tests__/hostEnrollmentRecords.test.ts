import { describe, expect, it, vi } from "vitest";
import { HOST_RECORDS_META_KEY, HostRecords } from "../hostEnrollmentRecords.js";

function memoryMeta(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getMeta: vi.fn(async (key: string) => values.get(key) ?? null),
    setMeta: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

describe("HostRecords", () => {
  it("keeps a revocation until an enrollment of that Host succeeds, and the first sighting's time", async () => {
    const meta = memoryMeta();
    const records = new HostRecords(meta, "inst_one_000000001");
    await records.markEnrolled("studio", "dev_host_1", 100);
    await records.markRevoked("studio", "dev_host_1", 200);
    await records.markRevoked("studio", "dev_host_1", 300);
    expect(await records.get("studio")).toEqual({
      deviceId: "dev_host_1",
      enrolledAt: 100,
      revokedAt: 200,
    });

    // Read back by a fresh keeper, as after a restart.
    const reopened = new HostRecords(meta, "inst_one_000000001");
    expect((await reopened.get("studio"))?.revokedAt).toBe(200);
    await reopened.markEnrolled("studio", "dev_host_2", 400);
    expect(await reopened.get("studio")).toEqual({
      deviceId: "dev_host_2",
      enrolledAt: 400,
      revokedAt: null,
    });
  });

  it("reads another installation's records, or a damaged one, as none", async () => {
    const meta = memoryMeta();
    await new HostRecords(meta, "inst_one_000000001").markRevoked("studio", "dev_host_1", 100);
    const other = new HostRecords(meta, "inst_two_000000002");
    expect((await other.read()).size).toBe(0);
    // Its first write replaces them with its own.
    await other.markEnrolled("lab", "dev_lab_1", 200);
    expect(JSON.parse(meta.values.get(HOST_RECORDS_META_KEY)!)).toMatchObject({
      installationId: "inst_two_000000002",
      hosts: { lab: { deviceId: "dev_lab_1" } },
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const damaged = new HostRecords(
      memoryMeta({ [HOST_RECORDS_META_KEY]: "{not json" }),
      "inst_one_000000001"
    );
    expect((await damaged.read()).size).toBe(0);
    warn.mockRestore();
  });

  it("runs writes one at a time, each on what the last left", async () => {
    const meta = memoryMeta();
    const records = new HostRecords(meta, "inst_one_000000001");
    await Promise.all([
      records.markEnrolled("studio", "dev_host_1", 100),
      records.markEnrolled("lab", "dev_lab_1", 100),
      records.markRevoked("desk", null, 100),
    ]);
    expect([...(await records.read()).keys()].sort()).toEqual(["desk", "lab", "studio"]);
  });

  it("rejects when the store can't be read, so nothing is enrolled on a guess", async () => {
    const records = new HostRecords(
      { getMeta: async () => Promise.reject(new Error("closed")), setMeta: async () => {} },
      "inst_one_000000001"
    );
    await expect(records.read()).rejects.toThrow("closed");
  });
});
