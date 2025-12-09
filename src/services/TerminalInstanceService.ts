import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ImageAddon } from "@xterm/addon-image";
import { terminalClient, systemClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import { detectHardware, HardwareProfile } from "@/utils/hardwareDetection";
import { SharedRingBuffer, PacketParser } from "@shared/utils/SharedRingBuffer";

type RefreshTierProvider = () => TerminalRefreshTier;

type ResizeJobId = { type: "timeout"; id: number } | { type: "idle"; id: number };

interface ManagedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  webglAddon?: WebglAddon;
  serializeAddon: SerializeAddon;
  webLinksAddon: WebLinksAddon;
  imageAddon: ImageAddon;
  hostElement: HTMLDivElement;
  isOpened: boolean;
  listeners: Array<() => void>;
  exitSubscribers: Set<(exitCode: number) => void>;
  throttledWriter: ReturnType<typeof createThrottledWriter>;
  getRefreshTier: RefreshTierProvider;
  keyHandlerInstalled: boolean;
  lastAttachAt: number;
  lastDetachAt: number;
  webglRecoveryAttempts: number;
  // Visibility-aware LRU tracking
  isVisible: boolean;
  lastActiveTime: number;
  hasWebglError: boolean;
  // Geometry caching for resize optimization
  lastWidth: number;
  lastHeight: number;
  // WebGL dispose grace period timer
  webglDisposeTimer?: number;
  // Renderer policy hysteresis state
  lastAppliedTier?: TerminalRefreshTier; // The tier currently in effect
  pendingTier?: TerminalRefreshTier; // Target tier for scheduled downgrade
  tierChangeTimer?: number;
  // Resize debouncing state
  resizeXJob?: ResizeJobId;
  resizeYJob?: ResizeJobId;
  lastYResizeTime: number;
  latestCols: number;
  latestRows: number;
  latestWasAtBottom: boolean;
  // Smart Sticky Scrolling state
  agentState: "working" | "idle" | "waiting" | "completed" | "failed";
  userScrolledUp: boolean;
  suppressScrollEvents: boolean;
}

const MAX_WEBGL_RECOVERY_ATTEMPTS = 4; // Supports full 1s → 2s → 4s → 8s backoff sequence
const WEBGL_DISPOSE_GRACE_MS = 10000; // 10s grace period before releasing WebGL on hide
const TIER_DOWNGRADE_HYSTERESIS_MS = 500; // Delay before applying tier downgrades to prevent flapping

const START_DEBOUNCING_THRESHOLD = 200;
const HORIZONTAL_DEBOUNCE_MS = 100;
const VERTICAL_THROTTLE_MS = 150;
const IDLE_CALLBACK_TIMEOUT_MS = 1000;

/**
 * Creates a simple writer that passes data directly to xterm.
 *
 * VS Code's approach: All batching is done at the PTY host level (OutputThrottler
 * with 4ms delay for focused terminals). The renderer just writes directly to xterm.
 * This avoids complex heuristics that can add latency to keystroke echoes.
 */
function createThrottledWriter(
  id: string,
  terminal: Terminal,
  _initialProvider: RefreshTierProvider = () => TerminalRefreshTier.FOCUSED
) {
  let pendingWrites = 0;
  return {
    get pendingWrites() {
      return pendingWrites;
    },
    write: (data: string | Uint8Array) => {
      // Direct write to xterm - all batching happens in the backend OutputThrottler
      pendingWrites++;
      terminal.write(data, () => {
        pendingWrites--;
        // Flow Control: Acknowledge processed data to backend
        // This allows the backend to resume the PTY if it was paused
        terminalClient.acknowledgeData(id, data.length);
      });
    },
    dispose: () => {
      // Nothing to clean up - we don't buffer
    },
    updateProvider: (_provider: RefreshTierProvider) => {
      // No-op - we don't use tiers for batching anymore
    },
    notifyInput: () => {
      // No-op - keystroke timing not needed without renderer-side batching
    },
    getDebugInfo: () => {
      return {
        tierName: "DIRECT",
        fps: 0,
        isBurstMode: false,
        effectiveDelay: 0,
        bufferSize: 0,
        pendingWrites,
      };
    },
    boost: () => {
      // No-op - we don't buffer
    },
    clear: () => {
      // No-op - we don't buffer
      pendingWrites = 0;
    },
  };
}

class TerminalInstanceService {
  private instances = new Map<string, ManagedTerminal>();
  private webglLru: string[] = [];
  private hardwareProfile: HardwareProfile;

  // Zero-copy ring buffer polling state
  private ringBuffer: SharedRingBuffer | null = null;
  private packetParser = new PacketParser();
  private pollingActive = false;
  private rafId: number | null = null;
  private pollTimeoutId: number | null = null;
  private sharedBufferEnabled = false;
  // Per-terminal coalescing buffers for SAB data
  private sabBuffers = new Map<
    string,
    { chunks: (string | Uint8Array)[]; timeoutId: number | null }
  >();

  // Small coalescing delay for SAB data, similar to VS Code's TerminalDataBufferer.
  private static readonly BUFFER_FLUSH_DELAY_MS = 4;
  private static readonly TERMINAL_COUNT_THRESHOLD = 20;
  private static readonly BUDGET_SCALE_FACTOR = 0.5;
  private static readonly MIN_WEBGL_BUDGET = 2;
  private static readonly MAX_WEBGL_CONTEXTS = 12; // Conservative limit below browser max (16)

  constructor() {
    this.hardwareProfile = detectHardware();
    console.log("[TerminalInstanceService] Hardware profile:", this.hardwareProfile);

    // Initialize SharedArrayBuffer polling
    this.initializeSharedBuffer();
  }

  /**
   * Initialize SharedArrayBuffer for zero-copy terminal I/O.
   * Falls back to IPC if unavailable.
   */
  private async initializeSharedBuffer(): Promise<void> {
    try {
      const buffer = await terminalClient.getSharedBuffer();
      if (buffer) {
        this.ringBuffer = new SharedRingBuffer(buffer);
        this.sharedBufferEnabled = true;
        this.startPolling();
        console.log("[TerminalInstanceService] SharedArrayBuffer polling enabled");
      } else {
        console.log("[TerminalInstanceService] SharedArrayBuffer unavailable, using IPC");
      }
    } catch (error) {
      console.warn("[TerminalInstanceService] Failed to initialize SharedArrayBuffer:", error);
    }
  }

  /**
   * Start the polling loop for reading from the shared ring buffer.
   * Uses requestAnimationFrame for smooth 60fps synchronization.
   */
  private startPolling(): void {
    if (this.pollingActive || !this.ringBuffer) return;
    this.pollingActive = true;
    this.poll();
  }

  /**
   * Stop the polling loop (called on service disposal).
   */
  stopPolling(): void {
    this.pollingActive = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.pollTimeoutId !== null) {
      clearTimeout(this.pollTimeoutId);
      this.pollTimeoutId = null;
    }
  }

  /**
   * Poll the ring buffer and dispatch data to terminals.
   *
   * VS Code-style strategy: Read small chunks and buffer them briefly per
   * terminal, then flush with a short timeout. This smooths out bursts and
   * avoids building large frame-sized writes that can cause visible flicker.
   */
  private poll = (): void => {
    if (!this.pollingActive || !this.ringBuffer) return;

    let hasData = false;

    // Read until the ring buffer is empty, writing each packet through to
    // the appropriate terminal as we go. This favours many smaller writes
    // over a single large "atomic" write per frame.
    // If we ever need to guard against pathological cases, we can add
    // a simple max-reads-per-poll, but keep it simple for now.

    while (true) {
      const data = this.ringBuffer.read();
      if (!data) {
        break; // Buffer exhausted
      }

      hasData = true;
      const packets = this.packetParser.parse(data);

      for (const packet of packets) {
        const managed = this.instances.get(packet.id);
        if (!managed) {
          continue;
        }
        // Buffer the packet per terminal and flush shortly, similar to VS Code's
        // TerminalDataBufferer behaviour.
        this.bufferTerminalData(packet.id, packet.data);
      }
    }

    // Schedule the next poll. When data was seen, use requestAnimationFrame
    // to stay in sync with rendering; otherwise use a modest idle timeout.
    if (hasData) {
      this.rafId = window.requestAnimationFrame(() => {
        this.rafId = null;
        this.poll();
      });
    } else {
      // Small idle timeout to detect new bursts without a tight loop.
      this.pollTimeoutId = window.setTimeout(this.poll, 8);
    }
  };

  /**
   * Buffer data for a terminal with a short timeout, then flush as a single
   * write. This mirrors VS Code's TerminalDataBufferer behaviour on IPC.
   */
  private bufferTerminalData(id: string, data: string | Uint8Array): void {
    let entry = this.sabBuffers.get(id);
    if (!entry) {
      entry = { chunks: [], timeoutId: null };
      this.sabBuffers.set(id, entry);
    }
    entry.chunks.push(data);

    if (entry.timeoutId !== null) {
      return;
    }

    entry.timeoutId = window.setTimeout(() => {
      const managed = this.instances.get(id);
      const current = this.sabBuffers.get(id);
      if (!managed || !current) {
        if (current) {
          this.sabBuffers.delete(id);
        }
        return;
      }

      const chunks = current.chunks;
      this.sabBuffers.delete(id);

      if (chunks.length === 0) {
        return;
      }

      // Check scroll decision before writing to avoid race with async processing
      const shouldScroll = this.shouldSnapToBottom(managed);

      if (chunks.length === 1) {
        managed.throttledWriter.write(chunks[0]);
      } else {
        // If all chunks are strings, join as a single string; otherwise fall
        // back to writing each chunk in sequence.
        const allStrings = chunks.every((c) => typeof c === "string");
        if (allStrings) {
          managed.throttledWriter.write((chunks as string[]).join(""));
        } else {
          for (const chunk of chunks) {
            managed.throttledWriter.write(chunk);
          }
        }
      }

      // Apply smart sticky scrolling after writes
      // Only scroll if still at bottom (avoid redundant scrolls in TUI mode)
      if (shouldScroll) {
        const buffer = managed.terminal.buffer.active;
        const isAtBottom = buffer.baseY - buffer.viewportY < 1;
        if (!isAtBottom) {
          this.scrollToBottom(id);
        }
      }
    }, TerminalInstanceService.BUFFER_FLUSH_DELAY_MS);
  }

  /**
   * Check if SharedArrayBuffer-based I/O is enabled.
   */
  isSharedBufferEnabled(): boolean {
    return this.sharedBufferEnabled;
  }

  private getWebGLBudget(): number {
    let budget = this.hardwareProfile.baseWebGLBudget;

    // Reduce budget when many terminals are open
    const terminalCount = this.instances.size;
    if (terminalCount > TerminalInstanceService.TERMINAL_COUNT_THRESHOLD) {
      const scaleFactor = Math.max(
        TerminalInstanceService.BUDGET_SCALE_FACTOR,
        TerminalInstanceService.TERMINAL_COUNT_THRESHOLD / terminalCount
      );
      budget = Math.floor(budget * scaleFactor);
    }

    return Math.max(TerminalInstanceService.MIN_WEBGL_BUDGET, budget);
  }

  /**
   * Enforce WebGL context budget using visibility-aware LRU eviction.
   * Prioritizes visible terminals over hidden ones.
   */
  private enforceWebglBudget(): void {
    const activeContexts: string[] = [];
    this.instances.forEach((term, id) => {
      if (term.webglAddon) {
        activeContexts.push(id);
      }
    });

    // Use the lesser of dynamic budget and hard limit
    const effectiveBudget = Math.min(
      this.getWebGLBudget(),
      TerminalInstanceService.MAX_WEBGL_CONTEXTS
    );

    if (activeContexts.length < effectiveBudget) {
      return;
    }

    // Sort by priority (lowest first - index 0 is evicted first):
    // 1. Hidden terminals sorted by lastActiveTime (oldest first)
    // 2. Visible terminals sorted by lastActiveTime (oldest first)
    activeContexts.sort((aId, bId) => {
      const a = this.instances.get(aId)!;
      const b = this.instances.get(bId)!;

      if (a.isVisible !== b.isVisible) {
        return a.isVisible ? 1 : -1;
      }
      return a.lastActiveTime - b.lastActiveTime;
    });

    // Evict contexts until under budget (handles sharp budget drops)
    while (activeContexts.length >= effectiveBudget) {
      const victimId = activeContexts.shift();
      if (!victimId) break;
      const victim = this.instances.get(victimId);

      if (victim?.webglAddon) {
        console.log(
          `[TerminalInstanceService] Evicting WebGL context for ${victimId} (Visible: ${victim.isVisible})`
        );
        this.releaseWebgl(victimId, victim);
        victim.terminal.refresh(0, victim.terminal.rows - 1);
      }
    }
  }

  /**
   * Update visibility state for a terminal.
   * Called by React's IntersectionObserver when terminal enters/leaves viewport.
   */
  setVisible(id: string, isVisible: boolean): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    if (managed.isVisible !== isVisible) {
      managed.isVisible = isVisible;
      managed.lastActiveTime = Date.now();

      if (isVisible) {
        // Cancel pending WebGL disposal if becoming visible again
        if (managed.webglDisposeTimer !== undefined) {
          clearTimeout(managed.webglDisposeTimer);
          managed.webglDisposeTimer = undefined;
        }

        // Reset WebGL recovery state when becoming visible so deferred recovery can proceed
        if (managed.hasWebglError) {
          managed.webglRecoveryAttempts = 0;
          managed.hasWebglError = false;
        }

        // Only bust geometry cache if dimensions actually changed
        // This prevents redundant reflows on quick tab switches where container size is unchanged
        // The XtermAdapter's performFit() will handle the actual resize and IPC
        const rect = managed.hostElement.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const widthChanged = Math.abs(managed.lastWidth - rect.width) >= 1;
          const heightChanged = Math.abs(managed.lastHeight - rect.height) >= 1;

          if (widthChanged || heightChanged) {
            // Bust cache so performFit() will trigger a resize
            managed.lastWidth = 0;
            managed.lastHeight = 0;
          }
        }
        // If becoming visible, try to upgrade to WebGL
        this.applyRendererPolicy(id, managed.getRefreshTier());

        // Force snap to bottom on tab switch if working or TUI
        // This fixes the "jump to top" bug by resetting viewport after DOM layout
        requestAnimationFrame(() => {
          const current = this.instances.get(id);
          if (current && current.isVisible && this.shouldSnapToBottom(current)) {
            this.scrollToBottom(id);
          }
        });
      } else {
        // If hiding, wait grace period before releasing WebGL (prevents flicker on quick tab switches)
        if (managed.webglAddon && managed.webglDisposeTimer === undefined) {
          managed.webglDisposeTimer = window.setTimeout(() => {
            // Re-check: terminal might have become visible or been destroyed during grace period
            const current = this.instances.get(id);
            if (current && !current.isVisible && current.webglAddon) {
              this.releaseWebgl(id, current);
              current.terminal.refresh(0, current.terminal.rows - 1);
            }
            if (current) {
              current.webglDisposeTimer = undefined;
            }
          }, WEBGL_DISPOSE_GRACE_MS);
        }
      }
    }
  }

  getOrCreate(
    id: string,
    options: ConstructorParameters<typeof Terminal>[0],
    getRefreshTier: RefreshTierProvider = () => TerminalRefreshTier.FOCUSED
  ): ManagedTerminal {
    const existing = this.instances.get(id);
    if (existing) {
      existing.getRefreshTier = getRefreshTier;
      return existing;
    }

    const openLink = (url: string) => {
      let normalizedUrl = url;
      if (!/^https?:\/\//i.test(url)) {
        normalizedUrl = `https://${url}`;
      }
      console.log("[TerminalInstanceService] Opening external URL:", normalizedUrl);
      systemClient.openExternal(normalizedUrl).catch((error) => {
        console.error("[TerminalInstanceService] Failed to open URL:", error);
      });
    };

    const terminal = new Terminal({
      ...options,
      linkHandler: {
        activate: (_event, text) => openLink(text),
      },
    });
    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(serializeAddon);

    const webLinksAddon = new WebLinksAddon((_event, uri) => openLink(uri));
    terminal.loadAddon(webLinksAddon);

    const imageAddon = new ImageAddon();
    terminal.loadAddon(imageAddon);

    const hostElement = document.createElement("div");
    hostElement.style.width = "100%";
    hostElement.style.height = "100%";
    hostElement.style.display = "flex";
    hostElement.style.flexDirection = "column";

    const throttledWriter = createThrottledWriter(id, terminal, getRefreshTier);

    const listeners: Array<() => void> = [];
    const exitSubscribers = new Set<(exitCode: number) => void>();

    // Subscribe to IPC data events only when SharedArrayBuffer is unavailable.
    // When SharedArrayBuffer is enabled, data comes exclusively through polling.
    // The main process pauses PTYs during buffer backpressure, so IPC fallback
    // is not needed for normal operation.
    const unsubData = terminalClient.onData(id, (data: string | Uint8Array) => {
      // Skip IPC data when SharedArrayBuffer polling is active
      if (this.sharedBufferEnabled && this.pollingActive) return;
      throttledWriter.write(data);
    });
    listeners.push(unsubData);

    const unsubExit = terminalClient.onExit((termId, exitCode) => {
      if (termId !== id) return;
      throttledWriter.dispose();
      terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
      exitSubscribers.forEach((cb) => cb(exitCode));
    });
    listeners.push(unsubExit);

    const managed: ManagedTerminal = {
      terminal,
      fitAddon,
      webglAddon: undefined,
      serializeAddon,
      webLinksAddon,
      imageAddon,
      hostElement,
      isOpened: false,
      listeners,
      exitSubscribers,
      throttledWriter,
      getRefreshTier,
      keyHandlerInstalled: false,
      lastAttachAt: 0,
      lastDetachAt: 0,
      webglRecoveryAttempts: 0,
      isVisible: false,
      lastActiveTime: Date.now(),
      hasWebglError: false,
      lastWidth: 0,
      lastHeight: 0,
      lastYResizeTime: 0,
      latestCols: 0,
      latestRows: 0,
      latestWasAtBottom: true,
      agentState: "idle",
      userScrolledUp: false,
      suppressScrollEvents: false,
    };

    const inputDisposable = terminal.onData((data) => {
      throttledWriter.notifyInput();
      terminalClient.write(id, data);
    });
    listeners.push(() => inputDisposable.dispose());

    this.instances.set(id, managed);

    const initialTier = getRefreshTier ? getRefreshTier() : TerminalRefreshTier.FOCUSED;
    this.applyRendererPolicy(id, initialTier);
    return managed;
  }

  /**
   * Get an existing managed instance without creating it.
   */
  get(id: string): ManagedTerminal | null {
    return this.instances.get(id) ?? null;
  }

  /**
   * Attach terminal DOM to the provided container. Opens the terminal on first attach.
   */
  attach(id: string, container: HTMLElement): ManagedTerminal | null {
    const managed = this.instances.get(id);
    if (!managed) return null;

    if (managed.hostElement.parentElement !== container) {
      container.appendChild(managed.hostElement);
    }

    if (!managed.isOpened) {
      managed.terminal.open(managed.hostElement);
      managed.isOpened = true;

      // Add scroll event listener to detect user interaction
      const scrollDisposable = managed.terminal.onScroll(() => {
        // Ignore system-triggered scroll events
        if (managed.suppressScrollEvents) {
          return;
        }

        const buffer = managed.terminal.buffer.active;
        const isAtBottom = buffer.baseY - buffer.viewportY < 1;

        if (!isAtBottom) {
          // User scrolled up - mark persistent flag
          managed.userScrolledUp = true;
        } else {
          // User returned to bottom - clear flag
          managed.userScrolledUp = false;
        }
      });

      managed.listeners.push(() => scrollDisposable.dispose());
    }
    managed.lastAttachAt = Date.now();

    return managed;
  }

  /**
   * Detach the terminal DOM from its parent without disposing.
   */
  detach(id: string, container: HTMLElement | null): void {
    const managed = this.instances.get(id);
    if (!managed || !container) return;

    if (managed.hostElement.parentElement === container) {
      container.removeChild(managed.hostElement);
    }
    managed.lastDetachAt = Date.now();
  }

  /**
   * Trigger a fit and send resize to backend.
   * Consolidates xterm fit and IPC in single call.
   */
  fit(id: string): { cols: number; rows: number } | null {
    const managed = this.instances.get(id);
    if (!managed) return null;

    try {
      managed.fitAddon.fit();
      const { cols, rows } = managed.terminal;
      terminalClient.resize(id, cols, rows);
      return { cols, rows };
    } catch (error) {
      console.warn("Terminal fit failed:", error);
      return null;
    }
  }

  /**
   * Force flush any pending resize operations for a terminal.
   */
  flushResize(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    if (managed.resizeXJob || managed.resizeYJob) {
      this.clearResizeJobs(managed);
      this.applyResize(id, managed.latestCols, managed.latestRows);
    }
  }

  /**
   * Smart resize: accepts explicit dimensions from ResizeObserver.
   * Handles geometry caching, debouncing, xterm resize, and backend IPC.
   * Preserves scroll position if user was scrolled up viewing history.
   * Returns {cols, rows} if resized, null if skipped (cached) or error.
   */
  resize(
    id: string,
    width: number,
    height: number,
    options: { immediate?: boolean } = {}
  ): { cols: number; rows: number } | null {
    const managed = this.instances.get(id);
    if (!managed) return null;

    // Geometry caching check - ignore sub-pixel changes
    if (Math.abs(managed.lastWidth - width) < 1 && Math.abs(managed.lastHeight - height) < 1) {
      return null;
    }

    // Capture scroll state before resize to preserve position when viewing history
    // If viewportY < baseY, user is scrolled up (not at bottom)
    const buffer = managed.terminal.buffer.active;
    const wasAtBottom = buffer.baseY - buffer.viewportY < 1;

    // Calculate cols/rows using proposeDimensions if available (avoids DOM read)
    try {
      // FitAddon.proposeDimensions accepts optional dimensions override
      // @ts-expect-error - internal API, may not be in type definitions
      const proposed = managed.fitAddon.proposeDimensions?.({ width, height });

      if (!proposed) {
        // Fallback to fit() if proposeDimensions not available
        managed.fitAddon.fit();
        const { cols, rows } = managed.terminal;
        managed.lastWidth = width;
        managed.lastHeight = height;
        managed.latestCols = cols;
        managed.latestRows = rows;
        managed.latestWasAtBottom = wasAtBottom;
        // Apply smart scroll behavior
        const shouldPreservePosition = !wasAtBottom && managed.userScrolledUp;
        if (!shouldPreservePosition) {
          this.scrollToBottom(id);
        }
        terminalClient.resize(id, cols, rows);
        return { cols, rows };
      }

      const { cols, rows } = proposed;

      // Skip if dimensions unchanged
      if (managed.terminal.cols === cols && managed.terminal.rows === rows) {
        return null;
      }

      // Update cache
      managed.lastWidth = width;
      managed.lastHeight = height;
      managed.latestCols = cols;
      managed.latestRows = rows;
      managed.latestWasAtBottom = wasAtBottom;

      const bufferLineCount = this.getBufferLineCount(id);

      // Immediate resize for small buffers or explicit immediate flag
      if (options.immediate || bufferLineCount < START_DEBOUNCING_THRESHOLD) {
        this.clearResizeJobs(managed);
        this.applyResize(id, cols, rows);
        return { cols, rows };
      }

      // Invisible terminals: defer to idle callback
      if (!managed.isVisible) {
        this.scheduleIdleResize(id, managed);
        return { cols, rows };
      }

      // Visible terminals: throttle Y, debounce X
      this.throttleResizeY(id, managed, rows);
      this.debounceResizeX(id, managed, cols);

      return { cols, rows };
    } catch (error) {
      console.warn(`[TerminalInstanceService] Resize failed for ${id}:`, error);
      return null;
    }
  }

  /**
   * Force the terminal to scroll to the bottom.
   * Used when a terminal goes to background or user clicks "Scroll to Bottom".
   */
  scrollToBottom(id: string): void {
    const managed = this.instances.get(id);
    if (managed) {
      managed.suppressScrollEvents = true;
      managed.terminal.scrollToBottom();
      requestAnimationFrame(() => {
        managed.suppressScrollEvents = false;
      });
    }
  }

  /**
   * Determines whether terminal should auto-scroll to bottom based on:
   * - Buffer type (TUI alternate buffer always snaps)
   * - Agent state (working terminals snap unless user scrolled up)
   * - Current scroll position (standard terminals only snap if already at bottom)
   */
  private shouldSnapToBottom(managed: ManagedTerminal): boolean {
    const buffer = managed.terminal.buffer.active;
    const isAlternateBuffer = buffer.type === "alternate";

    // CASE 1: TUI Mode (Claude Code, Vim, etc.)
    // TUIs manage their own viewport. Always ensure alignment with cursor/bottom.
    if (isAlternateBuffer) {
      return true;
    }

    // CASE 2: Agent Working
    // If the agent is actively outputting, force scroll to bottom
    // UNLESS the user explicitly scrolled up and hasn't returned to bottom.
    if (managed.agentState === "working") {
      // If user is scrolled up, respect their position until they return to bottom
      if (managed.userScrolledUp) {
        return false;
      }
      return true;
    }

    // CASE 3: Standard Terminal Behavior
    // Only snap if we were already at the bottom (preserve xterm default behavior)
    return buffer.baseY - buffer.viewportY < 1;
  }

  /**
   * Update agent state for a terminal.
   * Called by React components to sync agent state to the service layer.
   * Triggers scroll behavior based on state transitions.
   */
  setAgentState(id: string, state: ManagedTerminal["agentState"]): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.agentState = state;

    // When agent completes work, snap to bottom to show final output
    // Don't snap on transition to working - respect user scroll position
    if (state === "completed") {
      if (this.shouldSnapToBottom(managed)) {
        this.scrollToBottom(id);
      }
    }
  }

  private applyResize(id: string, cols: number, rows: number): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.terminal.resize(cols, rows);

    // Recalculate scroll decision at execution time
    const buffer = managed.terminal.buffer.active;
    const isCurrentlyAtBottom = buffer.baseY - buffer.viewportY < 1;
    const shouldPreservePosition = !isCurrentlyAtBottom && managed.userScrolledUp;

    if (!shouldPreservePosition) {
      this.scrollToBottom(id);
    }
    terminalClient.resize(id, cols, rows);
  }

  private shouldScrollAfterResize(managed: ManagedTerminal): boolean {
    // Recalculate at execution time to avoid stale state
    const buffer = managed.terminal.buffer.active;
    const isAtBottom = buffer.baseY - buffer.viewportY < 1;
    // Only preserve position if user is actively scrolled up
    return !(managed.userScrolledUp && !isAtBottom);
  }

  private clearResizeJobs(managed: ManagedTerminal): void {
    if (managed.resizeXJob) {
      this.clearJob(managed.resizeXJob);
      managed.resizeXJob = undefined;
    }
    if (managed.resizeYJob) {
      this.clearJob(managed.resizeYJob);
      managed.resizeYJob = undefined;
    }
  }

  private clearJob(job: ResizeJobId): void {
    if (job.type === "idle") {
      const win = window as typeof window & {
        cancelIdleCallback?: (handle: number) => void;
      };
      win.cancelIdleCallback?.(job.id);
    } else {
      clearTimeout(job.id);
    }
  }

  private scheduleIdleResize(id: string, managed: ManagedTerminal): void {
    const win = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const hasIdleCallback = typeof win.requestIdleCallback === "function";

    if (!managed.resizeXJob) {
      if (hasIdleCallback && win.requestIdleCallback) {
        const idleId = win.requestIdleCallback(
          () => {
            const current = this.instances.get(id);
            if (current) {
              current.terminal.resize(current.latestCols, current.terminal.rows);
              if (this.shouldScrollAfterResize(current)) this.scrollToBottom(id);
              terminalClient.resize(id, current.latestCols, current.terminal.rows);
              current.resizeXJob = undefined;
            }
          },
          { timeout: IDLE_CALLBACK_TIMEOUT_MS }
        );
        managed.resizeXJob = { type: "idle", id: idleId };
      } else {
        const timeoutId = window.setTimeout(() => {
          const current = this.instances.get(id);
          if (current) {
            current.terminal.resize(current.latestCols, current.terminal.rows);
            if (this.shouldScrollAfterResize(current)) this.scrollToBottom(id);
            terminalClient.resize(id, current.latestCols, current.terminal.rows);
            current.resizeXJob = undefined;
          }
        }, IDLE_CALLBACK_TIMEOUT_MS);
        managed.resizeXJob = { type: "timeout", id: timeoutId };
      }
    }

    if (!managed.resizeYJob) {
      if (hasIdleCallback && win.requestIdleCallback) {
        const idleId = win.requestIdleCallback(
          () => {
            const current = this.instances.get(id);
            if (current) {
              current.terminal.resize(current.latestCols, current.latestRows);
              if (this.shouldScrollAfterResize(current)) this.scrollToBottom(id);
              terminalClient.resize(id, current.latestCols, current.latestRows);
              current.resizeYJob = undefined;
            }
          },
          { timeout: IDLE_CALLBACK_TIMEOUT_MS }
        );
        managed.resizeYJob = { type: "idle", id: idleId };
      } else {
        const timeoutId = window.setTimeout(() => {
          const current = this.instances.get(id);
          if (current) {
            current.terminal.resize(current.latestCols, current.latestRows);
            if (this.shouldScrollAfterResize(current)) this.scrollToBottom(id);
            terminalClient.resize(id, current.latestCols, current.latestRows);
            current.resizeYJob = undefined;
          }
        }, IDLE_CALLBACK_TIMEOUT_MS);
        managed.resizeYJob = { type: "timeout", id: timeoutId };
      }
    }
  }

  private debounceResizeX(id: string, managed: ManagedTerminal, cols: number): void {
    if (managed.resizeXJob) {
      this.clearJob(managed.resizeXJob);
      managed.resizeXJob = undefined;
    }

    const timeoutId = window.setTimeout(() => {
      const current = this.instances.get(id);
      if (current) {
        current.terminal.resize(cols, current.terminal.rows);
        if (this.shouldScrollAfterResize(current)) this.scrollToBottom(id);
        terminalClient.resize(id, cols, current.terminal.rows);
        current.resizeXJob = undefined;
      }
    }, HORIZONTAL_DEBOUNCE_MS);
    managed.resizeXJob = { type: "timeout", id: timeoutId };
  }

  private throttleResizeY(id: string, managed: ManagedTerminal, rows: number): void {
    const now = Date.now();
    const timeSinceLastY = now - managed.lastYResizeTime;

    if (timeSinceLastY >= VERTICAL_THROTTLE_MS) {
      managed.lastYResizeTime = now;
      if (managed.resizeYJob) {
        this.clearJob(managed.resizeYJob);
        managed.resizeYJob = undefined;
      }
      managed.terminal.resize(managed.latestCols, rows);
      if (this.shouldScrollAfterResize(managed)) this.scrollToBottom(id);
      terminalClient.resize(id, managed.latestCols, rows);
      return;
    }

    if (!managed.resizeYJob) {
      const remainingTime = VERTICAL_THROTTLE_MS - timeSinceLastY;
      const timeoutId = window.setTimeout(() => {
        const current = this.instances.get(id);
        if (current) {
          current.lastYResizeTime = Date.now();
          current.terminal.resize(current.latestCols, current.latestRows);
          if (this.shouldScrollAfterResize(current)) this.scrollToBottom(id);
          terminalClient.resize(id, current.latestCols, current.latestRows);
          current.resizeYJob = undefined;
        }
      }, remainingTime);
      managed.resizeYJob = { type: "timeout", id: timeoutId };
    }
  }

  focus(id: string): void {
    const managed = this.instances.get(id);
    managed?.terminal.focus();
  }

  refresh(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    try {
      managed.fitAddon.fit();
    } catch (error) {
      console.warn("[TerminalInstanceService] Refresh fit failed:", error);
    }
  }

  /**
   * Reset the WebGL renderer by disposing and recreating the WebGL addon.
   * Forces a full WebGL context reset to resolve rendering artifacts.
   * Used after drag operations where the canvas may have incorrect dimensions.
   */
  resetRenderer(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    // Skip if terminal is detached or container has invalid dimensions
    if (!managed.hostElement.isConnected) return;
    if (managed.hostElement.clientWidth < 50 || managed.hostElement.clientHeight < 50) return;

    const hadWebgl = !!managed.webglAddon;

    // Dispose existing WebGL addon
    if (managed.webglAddon) {
      managed.webglAddon.dispose();
      managed.webglAddon = undefined;
      this.webglLru = this.webglLru.filter((existing) => existing !== id);
    }

    // Force fit to recalculate dimensions and sync to backend PTY
    const dims = this.fit(id);
    if (dims) {
      terminalClient.resize(id, dims.cols, dims.rows);
    }

    // Recreate WebGL if it was active
    if (hadWebgl) {
      const tier = managed.getRefreshTier();
      this.applyRendererPolicy(id, tier);
    }

    // Rely on xterm to repaint after resize and renderer changes
  }

  /**
   * Reset renderers for all terminal instances with active WebGL.
   * Used after drag operations to ensure all terminals render correctly.
   * Only resets terminals that have WebGL enabled to avoid unnecessary overhead.
   */
  resetAllRenderers(): void {
    this.instances.forEach((managed, id) => {
      // Only reset terminals with active WebGL addons to avoid unnecessary overhead
      if (managed.webglAddon) {
        this.resetRenderer(id);
      }
    });
  }

  refreshAll(): void {
    this.instances.forEach((managed) => {
      try {
        managed.fitAddon.fit();
      } catch (error) {
        console.warn("[TerminalInstanceService] RefreshAll fit failed:", error);
      }
    });
  }

  /**
   * Update terminal options in place (theme/font/reactive settings).
   */
  updateOptions(id: string, options: Partial<Terminal["options"]>): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    // Check if any text metric options are changing (affects cell size)
    const textMetricKeys = ["fontSize", "fontFamily", "lineHeight", "letterSpacing", "fontWeight"];
    const textMetricsChanged = textMetricKeys.some((key) => key in options);

    Object.entries(options).forEach(([key, value]) => {
      // @ts-expect-error xterm options are indexable
      managed.terminal.options[key] = value;
    });

    // Bust geometry cache when text metrics change so resize recalculates cols/rows
    if (textMetricsChanged) {
      managed.lastWidth = 0;
      managed.lastHeight = 0;
    }
  }

  /**
   * Broadcast option changes (theme, font size) to all active terminals.
   */
  applyGlobalOptions(options: Partial<Terminal["options"]>): void {
    // Check if any text metric options are changing (affects cell size)
    const textMetricKeys = ["fontSize", "fontFamily", "lineHeight", "letterSpacing", "fontWeight"];
    const textMetricsChanged = textMetricKeys.some((key) => key in options);

    this.instances.forEach((managed) => {
      Object.entries(options).forEach(([key, value]) => {
        // @ts-expect-error xterm options are indexable
        managed.terminal.options[key] = value;
      });

      if (textMetricsChanged) {
        managed.lastWidth = 0;
        managed.lastHeight = 0;
      }
    });
  }

  /**
   * Apply renderer policy based on priority tier and visibility.
   * Visible terminals with FOCUSED/BURST/VISIBLE tier get WebGL.
   * BACKGROUND terminals and hidden terminals surrender WebGL to save resources.
   * Also propagates activity tier to main process for IPC batching.
   *
   * Uses hysteresis for downgrades: tier changes from higher to lower priority
   * are delayed by TIER_DOWNGRADE_HYSTERESIS_MS to prevent rapid WebGL churn
   * during MCP state transitions.
   */
  applyRendererPolicy(id: string, tier: TerminalRefreshTier): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    // Update activity timestamp on focus/burst events
    if (tier === TerminalRefreshTier.FOCUSED || tier === TerminalRefreshTier.BURST) {
      managed.lastActiveTime = Date.now();
      // Clear error flag on explicit user interaction
      managed.hasWebglError = false;
    }

    // Use the last actually applied tier as baseline (not pending or getRefreshTier)
    // Lower tier values = higher priority (BURST=8 < FOCUSED=16 < VISIBLE=100 < BACKGROUND=1000)
    const currentAppliedTier =
      managed.lastAppliedTier ?? managed.getRefreshTier() ?? TerminalRefreshTier.FOCUSED;

    // Same tier as currently applied: nothing to do
    if (tier === currentAppliedTier) {
      // Cancel any pending downgrade since we're staying at current tier
      if (managed.tierChangeTimer !== undefined) {
        clearTimeout(managed.tierChangeTimer);
        managed.tierChangeTimer = undefined;
        managed.pendingTier = undefined;
      }
      return;
    }

    const isUpgrade = tier < currentAppliedTier;

    // For upgrades: apply immediately and cancel any pending downgrade
    if (isUpgrade) {
      if (managed.tierChangeTimer !== undefined) {
        clearTimeout(managed.tierChangeTimer);
        managed.tierChangeTimer = undefined;
      }
      managed.pendingTier = undefined;
      this.applyRendererPolicyImmediate(id, managed, tier);
      return;
    }

    // For downgrades: apply with hysteresis to prevent flapping
    // If already pending the same tier, skip scheduling another timer
    if (managed.pendingTier === tier && managed.tierChangeTimer !== undefined) {
      return;
    }

    // Cancel any existing timer and schedule new one
    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
    }

    managed.pendingTier = tier;
    managed.tierChangeTimer = window.setTimeout(() => {
      const current = this.instances.get(id);
      if (current && current.pendingTier === tier) {
        this.applyRendererPolicyImmediate(id, current, tier);
        current.pendingTier = undefined;
      }
      if (current) {
        current.tierChangeTimer = undefined;
      }
    }, TIER_DOWNGRADE_HYSTERESIS_MS);
  }

  /**
   * Internal: Apply renderer policy immediately without hysteresis.
   */
  private applyRendererPolicyImmediate(
    id: string,
    managed: ManagedTerminal,
    tier: TerminalRefreshTier
  ): void {
    // Track the last applied tier for hysteresis baseline
    managed.lastAppliedTier = tier;

    // Terminal must be visible AND have appropriate tier to want WebGL
    const wantsWebgl =
      managed.isVisible &&
      (tier === TerminalRefreshTier.BURST ||
        tier === TerminalRefreshTier.FOCUSED ||
        tier === TerminalRefreshTier.VISIBLE);

    if (wantsWebgl) {
      if (!managed.webglAddon) {
        this.acquireWebgl(id, managed);
      } else if (tier === TerminalRefreshTier.FOCUSED || tier === TerminalRefreshTier.BURST) {
        // Promote FOCUSED/BURST terminals to end of LRU to protect from eviction
        const idx = this.webglLru.indexOf(id);
        if (idx !== -1 && idx < this.webglLru.length - 1) {
          this.webglLru.splice(idx, 1);
          this.webglLru.push(id);
        }
      }
    } else if (tier === TerminalRefreshTier.BACKGROUND && managed.webglAddon) {
      // Release WebGL for BACKGROUND tier (hidden tabs)
      this.releaseWebgl(id, managed);
    }

    // Map refresh tier to IPC activity tier and propagate to main process
    const activityTier = this.mapToActivityTier(tier);
    terminalClient.setActivityTier(id, activityTier);
  }

  /**
   * Map TerminalRefreshTier to IPC activity tier.
   */
  private mapToActivityTier(tier: TerminalRefreshTier): "focused" | "visible" | "background" {
    switch (tier) {
      case TerminalRefreshTier.BURST:
      case TerminalRefreshTier.FOCUSED:
        return "focused";
      case TerminalRefreshTier.VISIBLE:
        return "visible";
      case TerminalRefreshTier.BACKGROUND:
      default:
        return "background";
    }
  }

  private acquireWebgl(id: string, managed: ManagedTerminal): void {
    // Don't retry if we've hit an error state or exhausted recovery attempts
    if (managed.hasWebglError || managed.webglRecoveryAttempts >= MAX_WEBGL_RECOVERY_ATTEMPTS) {
      return;
    }

    // Use visibility-aware budget enforcement
    this.enforceWebglBudget();

    // Double-check budget (in case enforce failed or we're at limit)
    let activeCount = 0;
    this.instances.forEach((t) => {
      if (t.webglAddon) activeCount++;
    });

    const effectiveBudget = Math.min(
      this.getWebGLBudget(),
      TerminalInstanceService.MAX_WEBGL_CONTEXTS
    );

    if (activeCount >= effectiveBudget) {
      // Over budget - stay with DOM renderer
      return;
    }

    try {
      const webglAddon = new WebglAddon();

      webglAddon.onContextLoss(() => {
        console.warn(`[TerminalInstanceService] WebGL context lost for ${id}`);
        webglAddon.dispose();
        managed.webglAddon = undefined;
        this.webglLru = this.webglLru.filter((existing) => existing !== id);

        // Mark as error state to prevent thrashing loop
        managed.hasWebglError = true;

        // Calculate exponential backoff delay: 1s → 2s → 4s → 8s → 10s cap
        const attempt = managed.webglRecoveryAttempts + 1;
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);

        // Schedule recovery with exponential backoff
        setTimeout(() => {
          // PRE-CHECK: Is terminal still registered and visible?
          const currentManaged = this.instances.get(id);
          if (!currentManaged) return;

          // Skip recovery if terminal is hidden - will retry when it becomes visible
          if (!currentManaged.isVisible) {
            console.log(`[TerminalInstanceService] Deferring WebGL recovery for ${id} (hidden)`);
            // Reset state so visibility change triggers fresh attempt
            currentManaged.webglRecoveryAttempts = 0;
            currentManaged.hasWebglError = false;
            return;
          }

          // Align recovery with animation frame for stable DOM dimensions
          requestAnimationFrame(() => {
            const retryManaged = this.instances.get(id);
            if (!retryManaged || !retryManaged.terminal.element) return;

            try {
              // Retry WebGL if under retry limit
              if (retryManaged.webglRecoveryAttempts < MAX_WEBGL_RECOVERY_ATTEMPTS) {
                retryManaged.webglRecoveryAttempts = attempt;
                retryManaged.hasWebglError = false; // Clear error flag for retry
                console.log(
                  `[TerminalInstanceService] Attempting WebGL recovery for ${id} (attempt ${attempt}/${MAX_WEBGL_RECOVERY_ATTEMPTS}, delay was ${delay}ms)`
                );
                this.acquireWebgl(id, retryManaged);
              } else {
                console.warn(
                  `[TerminalInstanceService] Max WebGL recovery attempts reached for ${id}, staying in canvas mode`
                );
              }
            } catch (error) {
              console.error(`[TerminalInstanceService] Recovery failed for ${id}:`, error);
            }
          });
        }, delay);
      });

      managed.terminal.loadAddon(webglAddon);
      managed.webglAddon = webglAddon;
      managed.hasWebglError = false;
      managed.webglRecoveryAttempts = 0; // Reset counter after successful load

      this.webglLru = this.webglLru.filter((existing) => existing !== id);
      this.webglLru.push(id);
    } catch (error) {
      console.warn("[TerminalInstanceService] WebGL addon failed to load:", error);
      managed.hasWebglError = true;
    }
  }

  private releaseWebgl(id: string, managed: ManagedTerminal): void {
    if (managed.webglAddon) {
      managed.webglAddon.dispose();
      managed.webglAddon = undefined;
    }
    this.webglLru = this.webglLru.filter((existing) => existing !== id);
  }

  /**
   * Update refresh tier provider for the throttled writer.
   */
  updateRefreshTierProvider(id: string, provider: RefreshTierProvider): void {
    const managed = this.instances.get(id);
    if (!managed) return;
    managed.getRefreshTier = provider;
    managed.throttledWriter.updateProvider(provider);
  }

  /**
   * Boosts the refresh rate for a specific terminal.
   * Call this when a terminal is focused or interacted with to ensure
   * immediate rendering of any buffered background output.
   */
  boostRefreshRate(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    managed.throttledWriter.boost();

    // Also ensure WebGL is acquired if it was dropped in background
    this.applyRendererPolicy(id, TerminalRefreshTier.BURST);
  }

  addExitListener(id: string, cb: (exitCode: number) => void): () => void {
    const managed = this.instances.get(id);
    if (!managed) return () => {};
    managed.exitSubscribers.add(cb);
    return () => managed.exitSubscribers.delete(cb);
  }

  destroy(id: string): void {
    const managed = this.instances.get(id);
    if (!managed) return;

    // Clear pending resize jobs
    this.clearResizeJobs(managed);

    // Clear pending WebGL dispose timer
    if (managed.webglDisposeTimer !== undefined) {
      clearTimeout(managed.webglDisposeTimer);
      managed.webglDisposeTimer = undefined;
    }

    // Clear pending tier change timer
    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
      managed.tierChangeTimer = undefined;
    }

    managed.listeners.forEach((cleanup) => cleanup());
    managed.throttledWriter.dispose();
    managed.webglAddon?.dispose();
    managed.webLinksAddon.dispose();
    managed.imageAddon.dispose();
    this.webglLru = this.webglLru.filter((existing) => existing !== id);

    managed.terminal.dispose();
    managed.hostElement.remove();
    this.instances.delete(id);
  }

  has(id: string): boolean {
    return this.instances.has(id);
  }

  /**
   * Get the buffer line count for a terminal (used for resize debouncing decisions).
   * Uses active buffer to handle full-screen apps running in alternate buffer.
   */
  getBufferLineCount(id: string): number {
    const managed = this.instances.get(id);
    if (!managed) return 0;
    return managed.terminal.buffer.active.length ?? managed.terminal.buffer.normal.length ?? 0;
  }

  getInstanceCount(): number {
    return this.instances.size;
  }

  getDebugInfo(id: string) {
    const managed = this.instances.get(id);
    if (!managed) return null;
    return managed.throttledWriter.getDebugInfo();
  }

  /**
   * Restore terminal state from a serialized string (from headless backend).
   * Writes the serialized state directly to the terminal for instant visual restoration.
   * @param id Terminal ID
   * @param serializedState Serialized state from backend headless xterm
   * @returns true if restoration succeeded, false otherwise
   */
  restoreFromSerialized(id: string, serializedState: string): boolean {
    const managed = this.instances.get(id);
    if (!managed) {
      console.warn(`[TerminalInstanceService] Cannot restore: terminal ${id} not found`);
      return false;
    }

    try {
      // Clear pending output and reset terminal state for idempotent restoration
      managed.throttledWriter.clear();
      managed.terminal.reset();

      // The serialized state is a sequence of escape codes that reconstructs
      // the terminal buffer, colors, and cursor position when written
      managed.terminal.write(serializedState);
      return true;
    } catch (error) {
      console.error(`[TerminalInstanceService] Failed to restore terminal ${id}:`, error);
      return false;
    }
  }

  /**
   * Fetch serialized state from backend and restore terminal.
   * Convenience method that combines IPC call and restoration.
   * @param id Terminal ID
   * @returns Promise resolving to true if restoration succeeded
   */
  async fetchAndRestore(id: string): Promise<boolean> {
    try {
      const serializedState = await terminalClient.getSerializedState(id);
      if (!serializedState) {
        console.warn(`[TerminalInstanceService] No serialized state for terminal ${id}`);
        return false;
      }
      return this.restoreFromSerialized(id, serializedState);
    } catch (error) {
      console.error(`[TerminalInstanceService] Failed to fetch state for terminal ${id}:`, error);
      return false;
    }
  }
}

export const terminalInstanceService = new TerminalInstanceService();
