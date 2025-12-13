import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { ManagedTerminal, MAX_WEBGL_RECOVERY_ATTEMPTS, WEBGL_DISPOSE_GRACE_MS } from "./types";
import { HardwareProfile } from "@/utils/hardwareDetection";

const TERMINAL_COUNT_THRESHOLD = 20;
const BUDGET_SCALE_FACTOR = 0.5;
const MIN_WEBGL_BUDGET = 2;
const MAX_WEBGL_CONTEXTS = 12;

export interface TerminalAddons {
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  webLinksAddon: WebLinksAddon;
  imageAddon: ImageAddon;
  searchAddon: SearchAddon;
}

export class TerminalAddonManager {
  private webglLru: string[] = [];
  private webglRecoverySeq = 0;

  constructor(
    private readonly hardwareProfile: HardwareProfile,
    private readonly getTerminal: (id: string) => ManagedTerminal | undefined,
    private readonly forEachTerminal: (cb: (t: ManagedTerminal, id: string) => void) => void
  ) {}

  public setupAddons(terminal: Terminal, openLink: (url: string) => void): TerminalAddons {
    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(serializeAddon);

    const webLinksAddon = new WebLinksAddon((_event, uri) => openLink(uri));
    terminal.loadAddon(webLinksAddon);

    const imageAddon = new ImageAddon();
    terminal.loadAddon(imageAddon);

    const searchAddon = new SearchAddon();
    terminal.loadAddon(searchAddon);

    return {
      fitAddon,
      serializeAddon,
      webLinksAddon,
      imageAddon,
      searchAddon,
    };
  }

  public acquireWebgl(id: string, managed: ManagedTerminal): void {
    if (managed.isTallCanvas) return;
    if (managed.hasWebglError || managed.webglRecoveryAttempts >= MAX_WEBGL_RECOVERY_ATTEMPTS) {
      return;
    }

    this.enforceWebglBudget();

    let activeCount = 0;
    this.forEachTerminal((t) => {
      if (t.webglAddon) activeCount++;
    });

    const effectiveBudget = Math.min(this.getWebGLBudget(), MAX_WEBGL_CONTEXTS);

    if (activeCount >= effectiveBudget) {
      return;
    }

    try {
      const webglAddon = new WebglAddon();
      const token = ++this.webglRecoverySeq;
      managed.webglRecoveryToken = token;

      webglAddon.onContextLoss(() => {
        console.warn(`[TerminalAddonManager] WebGL context lost for ${id}`);
        webglAddon.dispose();
        managed.webglAddon = undefined;
        this.webglLru = this.webglLru.filter((existing) => existing !== id);
        managed.hasWebglError = true;

        const attempt = managed.webglRecoveryAttempts + 1;
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);

        setTimeout(() => {
          const currentManaged = this.getTerminal(id);
          if (!currentManaged || currentManaged.webglRecoveryToken !== token) return;

          if (!currentManaged.isVisible) {
            console.log(`[TerminalAddonManager] Deferring WebGL recovery for ${id} (hidden)`);
            currentManaged.webglRecoveryAttempts = 0;
            currentManaged.hasWebglError = false;
            return;
          }

          requestAnimationFrame(() => {
            const retryManaged = this.getTerminal(id);
            if (
              !retryManaged ||
              retryManaged.webglRecoveryToken !== token ||
              !retryManaged.terminal.element
            )
              return;

            try {
              if (retryManaged.webglRecoveryAttempts < MAX_WEBGL_RECOVERY_ATTEMPTS) {
                retryManaged.webglRecoveryAttempts = attempt;
                retryManaged.hasWebglError = false;
                console.log(
                  `[TerminalAddonManager] Attempting WebGL recovery for ${id} (attempt ${attempt}/${MAX_WEBGL_RECOVERY_ATTEMPTS}, delay was ${delay}ms)`
                );
                this.acquireWebgl(id, retryManaged);
              } else {
                console.warn(
                  `[TerminalAddonManager] Max WebGL recovery attempts reached for ${id}, staying in canvas mode`
                );
              }
            } catch (error) {
              console.error(`[TerminalAddonManager] Recovery failed for ${id}:`, error);
            }
          });
        }, delay);
      });

      managed.terminal.loadAddon(webglAddon);
      managed.webglAddon = webglAddon;
      managed.hasWebglError = false;
      managed.webglRecoveryAttempts = 0;

      this.webglLru = this.webglLru.filter((existing) => existing !== id);
      this.webglLru.push(id);
    } catch (error) {
      console.warn("[TerminalAddonManager] WebGL addon failed to load:", error);
      managed.hasWebglError = true;
    }
  }

  public releaseWebgl(id: string, managed: ManagedTerminal): void {
    managed.webglRecoveryToken = ++this.webglRecoverySeq;
    if (managed.webglAddon) {
      managed.webglAddon.dispose();
      managed.webglAddon = undefined;
    }
    this.webglLru = this.webglLru.filter((existing) => existing !== id);
  }

  public disposeWebglWithGrace(id: string): void {
    const managed = this.getTerminal(id);
    if (!managed) return;

    if (managed.webglAddon && managed.webglDisposeTimer === undefined) {
      managed.webglDisposeTimer = window.setTimeout(() => {
        const current = this.getTerminal(id);
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

  public cancelWebglDispose(managed: ManagedTerminal): void {
    if (managed.webglDisposeTimer !== undefined) {
      clearTimeout(managed.webglDisposeTimer);
      managed.webglDisposeTimer = undefined;
    }
  }

  public resetRenderer(id: string): void {
    const managed = this.getTerminal(id);
    if (!managed) return;

    if (managed.isTallCanvas) return;
    if (!managed.hostElement.isConnected) return;
    if (managed.hostElement.clientWidth < 50 || managed.hostElement.clientHeight < 50) return;

    if (managed.webglAddon) {
      managed.webglAddon.dispose();
      managed.webglAddon = undefined;
      this.webglLru = this.webglLru.filter((existing) => existing !== id);
    }

    // Caller (TerminalInstanceService) handles fit() and policy re-application
    // but we can return true/false if webgl was present so caller knows to re-apply
  }

  public promoteInLru(id: string): void {
    const idx = this.webglLru.indexOf(id);
    if (idx !== -1 && idx < this.webglLru.length - 1) {
      this.webglLru.splice(idx, 1);
      this.webglLru.push(id);
    }
  }

  private getWebGLBudget(): number {
    let budget = this.hardwareProfile.baseWebGLBudget;
    let terminalCount = 0;
    this.forEachTerminal((term) => {
      if (!term.isTallCanvas) {
        terminalCount++;
      }
    });

    if (terminalCount > TERMINAL_COUNT_THRESHOLD) {
      const scaleFactor = Math.max(BUDGET_SCALE_FACTOR, TERMINAL_COUNT_THRESHOLD / terminalCount);
      budget = Math.floor(budget * scaleFactor);
    }

    return Math.max(MIN_WEBGL_BUDGET, budget);
  }

  private enforceWebglBudget(): void {
    const activeContexts: string[] = [];
    this.forEachTerminal((term, id) => {
      if (term.webglAddon) {
        activeContexts.push(id);
      }
    });

    const effectiveBudget = Math.min(this.getWebGLBudget(), MAX_WEBGL_CONTEXTS);

    if (activeContexts.length <= effectiveBudget) {
      return;
    }

    activeContexts.sort((aId, bId) => {
      const a = this.getTerminal(aId)!;
      const b = this.getTerminal(bId)!;

      if (a.isVisible !== b.isVisible) {
        return a.isVisible ? 1 : -1;
      }
      return a.lastActiveTime - b.lastActiveTime;
    });

    while (activeContexts.length > effectiveBudget) {
      const victimId = activeContexts.shift();
      if (!victimId) break;
      const victim = this.getTerminal(victimId);

      if (victim?.webglAddon) {
        console.log(
          `[TerminalAddonManager] Evicting WebGL context for ${victimId} (Visible: ${victim.isVisible})`
        );
        this.releaseWebgl(victimId, victim);
        victim.terminal.refresh(0, victim.terminal.rows - 1);
      }
    }
  }
}
