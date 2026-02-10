/**
 * Terminal Serializer Service
 *
 * Provides async terminal serialization that yields to the event loop,
 * preventing blocking of the pty-host message handling during large
 * terminal serialization.
 *
 * Uses a threshold-based approach:
 * - Small terminals (<1000 lines): Sync serialization (lower overhead)
 * - Large terminals (>=1000 lines): Async with event loop yield
 *
 * Also implements single-flight per terminal to prevent request pileup.
 */

const ASYNC_SERIALIZATION_THRESHOLD_LINES = 1000;

export class TerminalSerializerService {
  private inFlightRequests = new Map<string, Promise<string | null>>();
  private isDisposed = false;

  shouldUseAsync(lineCount: number): boolean {
    return lineCount >= ASYNC_SERIALIZATION_THRESHOLD_LINES;
  }

  /**
   * Serialize terminal state asynchronously.
   * Uses setImmediate to yield to the event loop, allowing message handling
   * to continue during serialization of large terminals.
   *
   * Implements single-flight per terminal - if a serialization is already
   * in progress for a terminal, returns the existing promise.
   */
  async serializeAsync(id: string, serializeFn: () => string | null): Promise<string | null> {
    if (this.isDisposed) {
      return null;
    }

    const existingRequest = this.inFlightRequests.get(id);
    if (existingRequest) {
      return existingRequest;
    }

    const promise = new Promise<string | null>((resolve) => {
      setImmediate(() => {
        try {
          if (this.isDisposed) {
            resolve(null);
            return;
          }
          const result = serializeFn();
          resolve(result);
        } catch (error) {
          console.error(`[TerminalSerializerService] Serialization failed for ${id}:`, error);
          resolve(null);
        } finally {
          this.inFlightRequests.delete(id);
        }
      });
    });

    this.inFlightRequests.set(id, promise);
    return promise;
  }

  dispose(): void {
    this.isDisposed = true;
    this.inFlightRequests.clear();

    if (process.env.CANOPY_VERBOSE) {
      console.log("[TerminalSerializerService] Disposed");
    }
  }
}

let serializerInstance: TerminalSerializerService | null = null;

export function getTerminalSerializerService(): TerminalSerializerService {
  if (!serializerInstance) {
    serializerInstance = new TerminalSerializerService();
  }
  return serializerInstance;
}

export function disposeTerminalSerializerService(): void {
  if (serializerInstance) {
    serializerInstance.dispose();
    serializerInstance = null;
  }
}
