/**
 * RequestResponseBroker - Generic request/response correlation for IPC.
 *
 * Provides a unified pattern for correlating requests with responses,
 * supporting timeouts and automatic cleanup. Used by PtyClient and WorkspaceClient.
 */

export interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  createdAt: number;
}

export interface BrokerOptions {
  /** Default timeout in milliseconds (default: 5000) */
  defaultTimeoutMs?: number;
  /** Prefix for generated request IDs */
  idPrefix?: string;
  /** Called when a request times out */
  onTimeout?: (requestId: string) => void;
}

const DEFAULT_OPTIONS: Required<BrokerOptions> = {
  defaultTimeoutMs: 5000,
  idPrefix: "req",
  onTimeout: () => {},
};

export class RequestResponseBroker {
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private options: Required<BrokerOptions>;

  constructor(options: BrokerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Generate a unique request ID.
   */
  generateId(suffix?: string): string {
    const id = `${this.options.idPrefix}-${Date.now()}-${++this.requestCounter}`;
    return suffix ? `${id}-${suffix}` : id;
  }

  /**
   * Register a pending request and return a promise that resolves with the response.
   *
   * @param requestId - Unique request identifier
   * @param timeoutMs - Optional timeout override
   * @returns Promise that resolves with the response or rejects on timeout/error
   */
  register<T>(requestId: string, timeoutMs?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const existing = this.pendingRequests.get(requestId);
      if (existing) {
        clearTimeout(existing.timeout);
        existing.reject(new Error(`Duplicate request ID: ${requestId}`));
        this.pendingRequests.delete(requestId);
      }

      const effectiveTimeout = this.getEffectiveTimeout(timeoutMs);

      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId);
        if (!pending) return;

        this.pendingRequests.delete(requestId);
        try {
          this.options.onTimeout(requestId);
        } catch {
          // onTimeout is a best-effort callback and must not block timeout rejection.
        }
        pending.reject(new Error(`Request timeout: ${requestId}`));
      }, effectiveTimeout);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        createdAt: Date.now(),
      });
    });
  }

  private getEffectiveTimeout(timeoutMs?: number): number {
    if (timeoutMs === undefined) {
      return this.options.defaultTimeoutMs;
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return this.options.defaultTimeoutMs;
    }

    return Math.floor(timeoutMs);
  }

  /**
   * Resolve a pending request with a successful result.
   *
   * @param requestId - The request ID to resolve
   * @param result - The result value
   * @returns true if the request was found and resolved, false otherwise
   */
  resolve<T>(requestId: string, result: T): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);
    pending.resolve(result);
    return true;
  }

  /**
   * Reject a pending request with an error.
   *
   * @param requestId - The request ID to reject
   * @param error - The error to reject with
   * @returns true if the request was found and rejected, false otherwise
   */
  reject(requestId: string, error: Error): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);
    pending.reject(error);
    return true;
  }

  /**
   * Check if a request is pending.
   */
  has(requestId: string): boolean {
    return this.pendingRequests.has(requestId);
  }

  /**
   * Get the number of pending requests.
   */
  get size(): number {
    return this.pendingRequests.size;
  }

  /**
   * Clear all pending requests, optionally rejecting them with an error.
   *
   * @param error - If provided, all pending requests will be rejected with this error
   */
  clear(error?: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      if (error) {
        pending.reject(error);
      }
    }
    this.pendingRequests.clear();
  }

  /**
   * Dispose of the broker, rejecting all pending requests.
   */
  dispose(): void {
    this.clear(new Error("Broker disposed"));
  }
}
