import { describe, it, expect, beforeEach } from "vitest";
import { SharedRingBuffer, PacketFramer, PacketParser } from "../SharedRingBuffer.js";

describe("SharedRingBuffer", () => {
  let buffer: SharedRingBuffer;
  const bufferSize = 1024;

  beforeEach(() => {
    const sab = SharedRingBuffer.create(bufferSize);
    buffer = new SharedRingBuffer(sab);
  });

  describe("basic operations", () => {
    it("creates buffer with correct capacity", () => {
      expect(buffer.getCapacity()).toBe(bufferSize);
    });

    it("returns null when reading from empty buffer", () => {
      expect(buffer.read()).toBeNull();
      expect(buffer.readUpTo(100)).toBeNull();
    });

    it("writes and reads data", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const written = buffer.write(data);
      expect(written).toBe(5);

      const read = buffer.read();
      expect(read).toEqual(data);
    });

    it("returns 0 when writing to full buffer", () => {
      const largeData = new Uint8Array(bufferSize);
      const written = buffer.write(largeData);
      expect(written).toBe(0);
    });
  });

  describe("readUpTo", () => {
    it("throws error for maxBytes <= 0", () => {
      expect(() => buffer.readUpTo(0)).toThrow("maxBytes must be > 0, got 0");
      expect(() => buffer.readUpTo(-1)).toThrow("maxBytes must be > 0, got -1");
    });

    it("reads up to maxBytes when available data exceeds cap", () => {
      const data = new Uint8Array(500);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }
      buffer.write(data);

      const read1 = buffer.readUpTo(200);
      expect(read1?.length).toBe(200);
      expect(read1).toEqual(data.subarray(0, 200));

      const read2 = buffer.readUpTo(200);
      expect(read2?.length).toBe(200);
      expect(read2).toEqual(data.subarray(200, 400));

      const read3 = buffer.readUpTo(200);
      expect(read3?.length).toBe(100);
      expect(read3).toEqual(data.subarray(400, 500));

      expect(buffer.readUpTo(100)).toBeNull();
    });

    it("reads all available data when less than maxBytes", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      buffer.write(data);

      const read = buffer.readUpTo(100);
      expect(read).toEqual(data);
    });

    it("preserves remainder after partial read", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      buffer.write(data);

      const read1 = buffer.readUpTo(3);
      expect(read1).toEqual(new Uint8Array([1, 2, 3]));

      const read2 = buffer.readUpTo(3);
      expect(read2).toEqual(new Uint8Array([4, 5, 6]));

      const read3 = buffer.readUpTo(10);
      expect(read3).toEqual(new Uint8Array([7, 8, 9, 10]));
    });

    it("handles wrap-around correctly with bounded reads", () => {
      const firstData = new Uint8Array(bufferSize - 100);
      for (let i = 0; i < firstData.length; i++) {
        firstData[i] = 1;
      }
      buffer.write(firstData);
      buffer.read();

      const wrapData = new Uint8Array(200);
      for (let i = 0; i < wrapData.length; i++) {
        wrapData[i] = i % 256;
      }
      buffer.write(wrapData);

      const read1 = buffer.readUpTo(100);
      expect(read1?.length).toBe(100);
      expect(read1).toEqual(wrapData.subarray(0, 100));

      const read2 = buffer.readUpTo(100);
      expect(read2?.length).toBe(100);
      expect(read2).toEqual(wrapData.subarray(100, 200));
    });

    it("handles multiple partial reads to reconstruct full data", () => {
      const originalData = new Uint8Array(1000);
      for (let i = 0; i < originalData.length; i++) {
        originalData[i] = i % 256;
      }
      buffer.write(originalData);

      const chunks: Uint8Array[] = [];
      let chunk: Uint8Array | null;
      while ((chunk = buffer.readUpTo(100)) !== null) {
        chunks.push(chunk);
      }

      const reconstructed = new Uint8Array(
        chunks.reduce((sum, c) => sum + c.length, 0)
      );
      let offset = 0;
      for (const c of chunks) {
        reconstructed.set(c, offset);
        offset += c.length;
      }

      expect(reconstructed).toEqual(originalData);
      expect(chunks.length).toBe(10);
    });
  });

  describe("utilization", () => {
    it("reports correct utilization", () => {
      expect(buffer.getUtilization()).toBe(0);

      const halfSize = Math.floor(bufferSize / 2);
      const data = new Uint8Array(halfSize);
      buffer.write(data);

      const utilization = buffer.getUtilization();
      expect(utilization).toBeCloseTo(50, 0);
    });
  });
});

describe("PacketParser", () => {
  let parser: PacketParser;
  let framer: PacketFramer;

  beforeEach(() => {
    parser = new PacketParser();
    framer = new PacketFramer();
  });

  describe("partial packet handling", () => {
    it("handles packet split across multiple reads", () => {
      const id = "term1";
      const data = "Hello, World!";
      const packet = framer.frame(id, data);
      expect(packet).not.toBeNull();

      const chunk1 = packet!.subarray(0, 5);
      const chunk2 = packet!.subarray(5, 10);
      const chunk3 = packet!.subarray(10);

      const result1 = parser.parse(chunk1);
      expect(result1).toEqual([]);

      const result2 = parser.parse(chunk2);
      expect(result2).toEqual([]);

      const result3 = parser.parse(chunk3);
      expect(result3).toEqual([{ id, data }]);
    });

    it("handles multiple packets split across reads", () => {
      const packet1 = framer.frame("term1", "First");
      const packet2 = framer.frame("term2", "Second");
      expect(packet1).not.toBeNull();
      expect(packet2).not.toBeNull();

      const combined = new Uint8Array(packet1!.length + packet2!.length);
      combined.set(packet1!, 0);
      combined.set(packet2!, packet1!.length);

      const chunk1 = combined.subarray(0, 10);
      const chunk2 = combined.subarray(10);

      const result1 = parser.parse(chunk1);
      const result2 = parser.parse(chunk2);

      const allPackets = [...result1, ...result2];
      expect(allPackets).toHaveLength(2);
      expect(allPackets[0]).toEqual({ id: "term1", data: "First" });
      expect(allPackets[1]).toEqual({ id: "term2", data: "Second" });
    });

    it("handles header split across reads", () => {
      const packet = framer.frame("term1", "Test");
      expect(packet).not.toBeNull();

      const chunk1 = packet!.subarray(0, 1);
      const chunk2 = packet!.subarray(1);

      const result1 = parser.parse(chunk1);
      expect(result1).toEqual([]);

      const result2 = parser.parse(chunk2);
      expect(result2).toEqual([{ id: "term1", data: "Test" }]);
    });

    it("preserves partial packet state across many reads", () => {
      const largeData = "x".repeat(5000);
      const packet = framer.frame("term1", largeData);
      expect(packet).not.toBeNull();

      let allResults: Array<{ id: string; data: string }> = [];
      for (let i = 0; i < packet!.length; i += 100) {
        const chunk = packet!.subarray(i, Math.min(i + 100, packet!.length));
        const results = parser.parse(chunk);
        allResults = allResults.concat(results);
      }

      expect(allResults).toHaveLength(1);
      expect(allResults[0]).toEqual({ id: "term1", data: largeData });
    });

    it("resets partial packet state after complete parse", () => {
      const packet1 = framer.frame("term1", "First");
      const packet2 = framer.frame("term2", "Second");
      expect(packet1).not.toBeNull();
      expect(packet2).not.toBeNull();

      parser.parse(packet1!);

      const result = parser.parse(packet2!);
      expect(result).toEqual([{ id: "term2", data: "Second" }]);
    });
  });

  describe("corruption handling", () => {
    it("does not emit packets for garbage prefix", () => {
      const invalidData = new Uint8Array([255, 255, 255, 0, 0]);
      const result = parser.parse(invalidData);
      expect(result).toEqual([]);
    });

    it("can recover after manual reset", () => {
      const invalidData = new Uint8Array([255, 255, 255]);
      parser.parse(invalidData);
      parser.reset();

      const validPacket = framer.frame("term1", "Valid");
      expect(validPacket).not.toBeNull();
      const result = parser.parse(validPacket!);
      expect(result).toEqual([{ id: "term1", data: "Valid" }]);
    });
  });

  describe("reset", () => {
    it("clears partial packet state", () => {
      const packet = framer.frame("term1", "Test");
      expect(packet).not.toBeNull();

      const chunk1 = packet!.subarray(0, 5);
      parser.parse(chunk1);
      parser.reset();

      const chunk2 = packet!.subarray(5);
      const result = parser.parse(chunk2);
      expect(result).toEqual([]);
    });
  });
});
