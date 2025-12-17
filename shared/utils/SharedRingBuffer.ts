/**
 * Lock-free SharedArrayBuffer ring buffer for zero-copy terminal I/O.
 * Single producer (PtyHost), single consumer (Renderer).
 * Uses Atomics for thread-safe read/write coordination.
 */
export class SharedRingBuffer {
  private buffer: Uint8Array;
  private meta: Int32Array;
  private capacity: number;

  private static readonly READ_IDX = 0;
  private static readonly WRITE_IDX = 1;
  static readonly SIGNAL_IDX = 2;
  private static readonly META_SIZE = 12; // 3 * 4 bytes for Int32Array

  constructor(sharedBuffer: SharedArrayBuffer) {
    // Validate buffer size
    if (sharedBuffer.byteLength <= SharedRingBuffer.META_SIZE) {
      throw new Error(
        `SharedArrayBuffer too small: ${sharedBuffer.byteLength} bytes (need > ${SharedRingBuffer.META_SIZE})`
      );
    }
    this.meta = new Int32Array(sharedBuffer, 0, 3);
    this.buffer = new Uint8Array(sharedBuffer, SharedRingBuffer.META_SIZE);
    this.capacity = this.buffer.length;
    if (this.capacity < 2) {
      throw new Error("Ring buffer capacity must be >= 2 bytes");
    }
  }

  /**
   * Create a new SharedArrayBuffer for the ring buffer.
   * Call from Main process and share with PtyHost and Renderer.
   */
  static create(size: number = 4 * 1024 * 1024): SharedArrayBuffer {
    return new SharedArrayBuffer(size + SharedRingBuffer.META_SIZE);
  }

  /**
   * Get raw SharedArrayBuffer for sharing via IPC.
   */
  static getBuffer(ringBuffer: SharedRingBuffer): SharedArrayBuffer {
    return ringBuffer.buffer.buffer as SharedArrayBuffer;
  }

  /**
   * Write data to the buffer (Single Producer - PtyHost).
   * Returns bytes written. Returns 0 if buffer is full.
   */
  write(data: Uint8Array): number {
    const writeIndex = Atomics.load(this.meta, SharedRingBuffer.WRITE_IDX);
    const readIndex = Atomics.load(this.meta, SharedRingBuffer.READ_IDX);

    // Calculate available space (leave 1 byte to distinguish full from empty)
    let availableSpace: number;
    if (writeIndex >= readIndex) {
      availableSpace = this.capacity - (writeIndex - readIndex) - 1;
    } else {
      availableSpace = readIndex - writeIndex - 1;
    }

    // Atomic write: never partially write a packet
    if (availableSpace < data.length) return 0;

    const toWrite = data.length;

    // First chunk: from writeIndex to end of buffer
    const firstChunk = Math.min(toWrite, this.capacity - writeIndex);
    this.buffer.set(data.subarray(0, firstChunk), writeIndex);

    // Second chunk: wrap around to start if needed
    if (firstChunk < toWrite) {
      this.buffer.set(data.subarray(firstChunk, toWrite), 0);
    }

    // Update write index atomically
    const newWriteIndex = (writeIndex + toWrite) % this.capacity;
    Atomics.store(this.meta, SharedRingBuffer.WRITE_IDX, newWriteIndex);

    return toWrite;
  }

  /**
   * Read all available data from the buffer (Single Consumer - Renderer).
   * Returns new data as Uint8Array or null if empty.
   * CAUTION: Can allocate arbitrarily large buffers when renderer is behind.
   * Prefer readUpTo() for main-thread consumers to cap allocations.
   */
  read(): Uint8Array | null {
    const writeIndex = Atomics.load(this.meta, SharedRingBuffer.WRITE_IDX);
    const readIndex = Atomics.load(this.meta, SharedRingBuffer.READ_IDX);

    if (readIndex === writeIndex) return null;

    let availableToRead: number;
    if (writeIndex > readIndex) {
      availableToRead = writeIndex - readIndex;
    } else {
      availableToRead = this.capacity - readIndex + writeIndex;
    }

    const result = new Uint8Array(availableToRead);

    // Read first chunk
    const firstChunk = Math.min(availableToRead, this.capacity - readIndex);
    result.set(this.buffer.subarray(readIndex, readIndex + firstChunk), 0);

    // Read wrap-around chunk
    if (firstChunk < availableToRead) {
      result.set(this.buffer.subarray(0, availableToRead - firstChunk), firstChunk);
    }

    // Update read index atomically
    const newReadIndex = (readIndex + availableToRead) % this.capacity;
    Atomics.store(this.meta, SharedRingBuffer.READ_IDX, newReadIndex);

    return result;
  }

  /**
   * Read up to maxBytes from the buffer (Single Consumer).
   * Returns new data as Uint8Array or null if empty.
   * Bounds allocations to prevent GC spikes when catching up from behind.
   *
   * @param maxBytes Maximum bytes to read (must be > 0)
   * @returns Uint8Array with up to maxBytes, or null if no data available
   */
  readUpTo(maxBytes: number): Uint8Array | null {
    if (maxBytes <= 0) {
      throw new Error(`maxBytes must be > 0, got ${maxBytes}`);
    }

    const writeIndex = Atomics.load(this.meta, SharedRingBuffer.WRITE_IDX);
    const readIndex = Atomics.load(this.meta, SharedRingBuffer.READ_IDX);

    if (readIndex === writeIndex) return null;

    let availableToRead: number;
    if (writeIndex > readIndex) {
      availableToRead = writeIndex - readIndex;
    } else {
      availableToRead = this.capacity - readIndex + writeIndex;
    }

    const toRead = Math.min(availableToRead, maxBytes);
    const result = new Uint8Array(toRead);

    // Read first chunk
    const firstChunk = Math.min(toRead, this.capacity - readIndex);
    result.set(this.buffer.subarray(readIndex, readIndex + firstChunk), 0);

    // Read wrap-around chunk
    if (firstChunk < toRead) {
      result.set(this.buffer.subarray(0, toRead - firstChunk), firstChunk);
    }

    // Update read index atomically
    const newReadIndex = (readIndex + toRead) % this.capacity;
    Atomics.store(this.meta, SharedRingBuffer.READ_IDX, newReadIndex);

    return result;
  }

  /**
   * Check if buffer has data available without consuming it.
   */
  hasData(): boolean {
    const writeIndex = Atomics.load(this.meta, SharedRingBuffer.WRITE_IDX);
    const readIndex = Atomics.load(this.meta, SharedRingBuffer.READ_IDX);
    return readIndex !== writeIndex;
  }

  /**
   * Get current buffer utilization as a percentage.
   */
  getUtilization(): number {
    const writeIndex = Atomics.load(this.meta, SharedRingBuffer.WRITE_IDX);
    const readIndex = Atomics.load(this.meta, SharedRingBuffer.READ_IDX);

    let used: number;
    if (writeIndex >= readIndex) {
      used = writeIndex - readIndex;
    } else {
      used = this.capacity - readIndex + writeIndex;
    }

    return (used / this.capacity) * 100;
  }

  /**
   * Get buffer capacity in bytes.
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Get the signal view for Atomics.wait/notify operations.
   * Used by consumers to wait for new data efficiently.
   */
  getSignalView(): Int32Array {
    return this.meta;
  }

  /**
   * Notify waiting consumers that new data is available.
   * Call this after successful write() operations.
   */
  notifyConsumer(): void {
    Atomics.add(this.meta, SharedRingBuffer.SIGNAL_IDX, 1);
    Atomics.notify(this.meta, SharedRingBuffer.SIGNAL_IDX, 1);
  }

  /**
   * Get current signal value for use with Atomics.wait.
   */
  getSignalValue(): number {
    return Atomics.load(this.meta, SharedRingBuffer.SIGNAL_IDX);
  }
}

/**
 * Binary packet framing for multiplexing terminal streams.
 * Packet format: [ID_LEN:1byte][DATA_LEN:2bytes][ID:Nbytes][DATA:Mbytes]
 */
export class PacketFramer {
  private encoder = new TextEncoder();

  /**
   * Create a framed packet for a terminal.
   * Accepts both string and Uint8Array for future compatibility with binary output.
   *
   * @param id Terminal ID (max 255 bytes when encoded)
   * @param data Terminal output data (string from node-pty or binary)
   * @returns Framed packet as Uint8Array, or null if ID is too long or data exceeds max size
   */
  frame(id: string, data: string | Uint8Array): Uint8Array | null {
    const idBytes = this.encoder.encode(id);
    const dataBytes = typeof data === "string" ? this.encoder.encode(data) : data;

    if (idBytes.length > 255) {
      console.warn(`[PacketFramer] Terminal ID too long: ${idBytes.length} bytes`);
      return null;
    }

    // Reject packets exceeding max data size - caller must chunk
    if (dataBytes.length > 65535) {
      console.error(
        `[PacketFramer] Data too long: ${dataBytes.length} bytes (max 65535). ` +
          `Caller must chunk large writes.`
      );
      return null;
    }

    const totalSize = 1 + 2 + idBytes.length + dataBytes.length;
    const packet = new Uint8Array(totalSize);

    // Header: ID length (1 byte)
    packet[0] = idBytes.length;

    // Header: Data length (2 bytes, big-endian)
    const dataView = new DataView(packet.buffer);
    dataView.setUint16(1, dataBytes.length, false);

    // Payload: ID
    packet.set(idBytes, 3);

    // Payload: Data
    packet.set(dataBytes, 3 + idBytes.length);

    return packet;
  }
}

/**
 * Parse framed packets from binary data.
 * Handles partial packets across buffer reads.
 */
export class PacketParser {
  private decoder = new TextDecoder();
  private partialPacket = new Uint8Array(0);
  private static readonly MAX_PACKET_SIZE = 1 + 2 + 255 + 65535; // ~65KB

  /**
   * Parse packets from raw buffer data.
   * @param data Raw data from ring buffer
   * @returns Array of parsed packets with terminal ID and data
   */
  parse(data: Uint8Array): Array<{ id: string; data: string }> {
    // Prepend any partial packet from previous read
    const fullData = this.partialPacket.length > 0 ? this.concat(this.partialPacket, data) : data;

    const packets: Array<{ id: string; data: string }> = [];
    let offset = 0;

    while (offset < fullData.length) {
      // Need at least 3 bytes for header
      if (offset + 3 > fullData.length) {
        this.partialPacket = fullData.slice(offset);
        return packets;
      }

      const idLen = fullData[offset];
      const dataView = new DataView(fullData.buffer, fullData.byteOffset + offset);
      const dataLen = dataView.getUint16(1, false);

      // Validate header sanity to prevent stalling on corrupted data
      if (idLen > 255 || dataLen > 65535) {
        console.error(
          `[PacketParser] Corrupted header: idLen=${idLen}, dataLen=${dataLen}. ` +
            `Resetting parser state.`
        );
        this.partialPacket = new Uint8Array(0);
        return packets; // Discard corrupted stream segment
      }

      const packetSize = 3 + idLen + dataLen;

      // Sanity check: reject unreasonably large packets
      if (packetSize > PacketParser.MAX_PACKET_SIZE) {
        console.error(
          `[PacketParser] Packet size ${packetSize} exceeds max ${PacketParser.MAX_PACKET_SIZE}. ` +
            `Resetting parser state.`
        );
        this.partialPacket = new Uint8Array(0);
        return packets;
      }

      // Check if we have the full packet
      if (offset + packetSize > fullData.length) {
        this.partialPacket = fullData.slice(offset);
        return packets;
      }

      // Extract packet
      const idBytes = fullData.slice(offset + 3, offset + 3 + idLen);
      const dataBytes = fullData.slice(offset + 3 + idLen, offset + packetSize);

      packets.push({
        id: this.decoder.decode(idBytes),
        data: this.decoder.decode(dataBytes),
      });

      offset += packetSize;
    }

    // All packets consumed
    this.partialPacket = new Uint8Array(0);
    return packets;
  }

  /**
   * Reset parser state. Call when switching projects or on error.
   */
  reset(): void {
    this.partialPacket = new Uint8Array(0);
  }

  private concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.length + b.length);
    result.set(a, 0);
    result.set(b, a.length);
    return result;
  }
}
