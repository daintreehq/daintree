import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  install,
  beginAttempt,
  observeStderrLine,
  observeMainProcessExit,
  observeRendererCrash,
  classify,
  writeSummary,
  dispose,
} from "../launchTelemetry";

const PW_PROTOCOL_SEND =
  '  pw:protocol SEND ► {"id":1,"method":"Browser.getVersion","params":{}} +0ms\n';
const PW_PROTOCOL_RECV = '  pw:protocol ◀ RECV {"id":1,"result":{"userAgent":"test"}} +5ms\n';
const PW_PROTOCOL_SEND_NO_ID =
  '  pw:protocol SEND ► {"method":"Target.setDiscoverTargets","params":{"discover":true}} +1ms\n';

function writeDebugLines(...lines: string[]) {
  for (const line of lines) {
    process.stderr.write(line);
  }
}

function mockStderr(): { mock: ReturnType<typeof vi.fn>; restore: () => void } {
  const real = process.stderr.write;
  const mock = vi.fn((..._args: unknown[]) => true);
  process.stderr.write = mock as unknown as typeof process.stderr.write;
  return {
    mock,
    restore: () => {
      process.stderr.write = real;
    },
  };
}

beforeEach(() => {
  dispose();
});

afterEach(() => {
  dispose();
  delete process.env.E2E_LAUNCH_TELEMETRY;
  delete process.env.E2E_LAUNCH_TELEMETRY_FILE;
  delete process.env.DEBUG;
});

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------
describe("install", () => {
  it("is a no-op when E2E_LAUNCH_TELEMETRY is not set", () => {
    delete process.env.E2E_LAUNCH_TELEMETRY;
    process.env.DEBUG = "pw:protocol";
    const original = process.stderr.write;
    install();
    expect(process.stderr.write).toBe(original);
  });

  it("is a no-op when DEBUG does not include pw:protocol or pw:browser", () => {
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "other:debug";
    const original = process.stderr.write;
    install();
    expect(process.stderr.write).toBe(original);
  });

  it("patches stderr.write when both env vars are set", () => {
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol,pw:browser";
    const original = process.stderr.write;
    install();
    expect(process.stderr.write).not.toBe(original);
  });

  it("does not double-wrap stderr", () => {
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol";
    install();
    const first = process.stderr.write;
    install();
    expect(process.stderr.write).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Protocol interception
// ---------------------------------------------------------------------------
describe("protocol interception", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("consumes pw:protocol SEND lines", () => {
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol";
    install();
    beginAttempt(1, 3);
    writeDebugLines(PW_PROTOCOL_SEND);

    // Not enough elapsed time for CDP-silent classification
    expect(classify()).toBe("unknown");
  });

  it("does not flag CDP-silent when receives arrive", () => {
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol";
    install();
    beginAttempt(1, 3);
    writeDebugLines(PW_PROTOCOL_SEND, PW_PROTOCOL_RECV);

    vi.advanceTimersByTime(3000);
    expect(classify()).not.toBe("cdp-handshake-silent");
  });

  it("swallows pw:protocol lines so they don't reach real stderr", () => {
    const { mock, restore } = mockStderr();

    try {
      process.env.E2E_LAUNCH_TELEMETRY = "1";
      process.env.DEBUG = "pw:protocol";
      dispose(); // reset after mockStderr replacement
      install();
      beginAttempt(1, 3);

      process.stderr.write("normal line\n");
      process.stderr.write(PW_PROTOCOL_SEND);

      const normalCalls = mock.mock.calls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("normal line")
      );
      const protocolCalls = mock.mock.calls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("pw:protocol")
      );
      expect(normalCalls.length).toBeGreaterThanOrEqual(1);
      expect(protocolCalls.length).toBe(0);
    } finally {
      restore();
    }
  });

  it("tolerates malformed JSON in debug lines", () => {
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol";
    install();
    beginAttempt(1, 3);

    expect(() => {
      process.stderr.write("  pw:protocol SEND ► {not valid json} +0ms\n");
    }).not.toThrow();
  });

  it("tolerates debug lines without JSON payload", () => {
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol";
    install();
    beginAttempt(1, 3);

    expect(() => {
      process.stderr.write("  pw:protocol some message without json\n");
    }).not.toThrow();
  });

  it("tracks method names from sent commands in summary", () => {
    const { mock, restore } = mockStderr();

    try {
      process.env.E2E_LAUNCH_TELEMETRY = "1";
      process.env.DEBUG = "pw:protocol";
      dispose();
      install();
      beginAttempt(1, 3);
      writeDebugLines(PW_PROTOCOL_SEND);

      vi.advanceTimersByTime(3000);
      writeSummary();

      const summaryCall = mock.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("e2e_launch_telemetry")
      );
      expect(summaryCall).toBeDefined();
      expect(summaryCall![0]).toContain("Browser.getVersion");
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Crashpad detection
// ---------------------------------------------------------------------------
describe("crashpad detection", () => {
  beforeEach(() => {
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol";
  });

  it("detects FATAL kr == KERN_SUCCESS signature", () => {
    beginAttempt(1, 3);
    observeStderrLine("FATAL kr == KERN_SUCCESS in exception_handler_server.cc");
    expect(classify()).toBe("crashpad-stderr");
  });

  it("detects generic crashpad signature", () => {
    beginAttempt(1, 3);
    observeStderrLine("[crashpad] handler startup failed");
    expect(classify()).toBe("crashpad-stderr");
  });

  it("detects Breakpad signature", () => {
    beginAttempt(1, 3);
    observeStderrLine("Breakpad exception handler started");
    expect(classify()).toBe("crashpad-stderr");
  });

  it("does not flag normal stderr as crashpad", () => {
    beginAttempt(1, 3);
    observeStderrLine("normal application stderr output");
    expect(classify()).not.toBe("crashpad-stderr");
  });

  it("caps stored signature list without throwing", () => {
    beginAttempt(1, 3);

    const signatures = [
      "crashpad",
      "Breakpad",
      "exception_handler_server",
      "EXCEPTION_",
      "handler_start",
      "Handler was started",
      "FATAL kr == KERN_SUCCESS",
    ];
    for (const sig of signatures) {
      observeStderrLine(sig);
    }

    expect(classify()).toBe("crashpad-stderr");
  });
});

// ---------------------------------------------------------------------------
// Classification priority
// ---------------------------------------------------------------------------
describe("classification priority", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("webcontents-crash beats main-process-exit", () => {
    beginAttempt(1, 3);
    observeMainProcessExit(1, null);
    observeRendererCrash();
    expect(classify()).toBe("webcontents-crash");
  });

  it("webcontents-crash beats crashpad-stderr", () => {
    beginAttempt(1, 3);
    observeStderrLine("FATAL kr == KERN_SUCCESS");
    observeRendererCrash();
    expect(classify()).toBe("webcontents-crash");
  });

  it("main-process-exit beats crashpad-stderr", () => {
    beginAttempt(1, 3);
    observeStderrLine("crashpad handler failure");
    observeMainProcessExit(1, null);
    expect(classify()).toBe("main-process-exit");
  });

  it("main-process-exit via signal beats crashpad-stderr", () => {
    beginAttempt(1, 3);
    observeStderrLine("crashpad handler failure");
    observeMainProcessExit(null, "SIGKILL");
    expect(classify()).toBe("main-process-exit");
  });

  it("main-process-exit with code 0 falls through to crashpad", () => {
    beginAttempt(1, 3);
    observeStderrLine("crashpad handler failure");
    observeMainProcessExit(0, null);
    expect(classify()).toBe("crashpad-stderr");
  });

  it("crashpad-stderr beats cdp-handshake-silent", () => {
    install();
    beginAttempt(1, 3);
    writeDebugLines(PW_PROTOCOL_SEND);
    observeStderrLine("FATAL kr == KERN_SUCCESS");

    vi.advanceTimersByTime(3000);
    expect(classify()).toBe("crashpad-stderr");
  });

  it("returns unknown when no signals are present", () => {
    beginAttempt(1, 3);
    expect(classify()).toBe("unknown");
  });

  it("main-process-exit beats cdp-handshake-silent", () => {
    install();
    beginAttempt(1, 3);
    writeDebugLines(PW_PROTOCOL_SEND);
    observeMainProcessExit(1, null);

    vi.advanceTimersByTime(3000);
    expect(classify()).toBe("main-process-exit");
  });
});

// ---------------------------------------------------------------------------
// CDP-handshake-silent
// ---------------------------------------------------------------------------
describe("cdp-handshake-silent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol";
    install();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("classifies when sends exist but no receives and enough time passes", () => {
    beginAttempt(1, 3);
    writeDebugLines(PW_PROTOCOL_SEND);
    vi.advanceTimersByTime(3000);
    expect(classify()).toBe("cdp-handshake-silent");
  });

  it("does not classify when receives arrived", () => {
    beginAttempt(1, 3);
    writeDebugLines(PW_PROTOCOL_SEND, PW_PROTOCOL_RECV);
    vi.advanceTimersByTime(3000);
    expect(classify()).not.toBe("cdp-handshake-silent");
  });

  it("does not classify before minimum elapsed time", () => {
    beginAttempt(1, 3);
    writeDebugLines(PW_PROTOCOL_SEND);
    expect(classify()).not.toBe("cdp-handshake-silent");
  });

  it("does not classify with zero sends", () => {
    beginAttempt(1, 3);
    vi.advanceTimersByTime(3000);
    expect(classify()).toBe("unknown");
  });

  it("handles send without id gracefully", () => {
    beginAttempt(1, 3);
    writeDebugLines(PW_PROTOCOL_SEND_NO_ID);
    vi.advanceTimersByTime(3000);
    expect(classify()).toBe("cdp-handshake-silent");
  });
});

// ---------------------------------------------------------------------------
// Summary output
// ---------------------------------------------------------------------------
describe("writeSummary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a compact line with the expected prefix and fields", () => {
    beginAttempt(2, 3);
    observeMainProcessExit(1, null);
    expect(classify()).toBe("main-process-exit");

    const { mock, restore } = mockStderr();

    try {
      writeSummary();
      const telLine = mock.mock.calls
        .map((c) => String(c[0]))
        .find((l: string) => l.includes("e2e_launch_telemetry"));
      expect(telLine).toBeDefined();
      expect(telLine!).toContain("mode=main-process-exit");
      expect(telLine!).toContain("attempt=2/3");
      expect(telLine!).toContain("exitCode=1");
    } finally {
      restore();
    }
  });

  it("does not leak raw protocol payloads into summary output", () => {
    install();
    beginAttempt(1, 3);
    writeDebugLines(
      '  pw:protocol SEND ► {"id":1,"method":"Browser.getVersion","params":{"userAgent":"secret-token"}} +0ms\n'
    );
    vi.advanceTimersByTime(3000);

    const { mock, restore } = mockStderr();

    try {
      writeSummary();
      const telLine = mock.mock.calls
        .map((c) => String(c[0]))
        .find((l: string) => l.includes("e2e_launch_telemetry"));
      expect(telLine).toBeDefined();
      expect(telLine!).not.toContain("secret-token");
      expect(telLine!).not.toContain("userAgent");
      expect(telLine!).not.toContain('"params"');
    } finally {
      restore();
    }
  });

  it("writes JSONL to E2E_LAUNCH_TELEMETRY_FILE when set", () => {
    const tmp = os.tmpdir();
    const file = path.join(tmp, `telemetry-test-${Date.now()}.jsonl`);
    process.env.E2E_LAUNCH_TELEMETRY_FILE = file;

    beginAttempt(1, 3);
    observeStderrLine("FATAL kr == KERN_SUCCESS");
    writeSummary();

    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain("crashpad-stderr");

    try {
      fs.unlinkSync(file);
    } catch {
      // best-effort
    }
  });

  it("returns the resolved mode", () => {
    beginAttempt(1, 3);
    observeRendererCrash();
    const result = writeSummary();
    expect(result).toBe("webcontents-crash");
  });
});

// ---------------------------------------------------------------------------
// Attempt reset
// ---------------------------------------------------------------------------
describe("beginAttempt reset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol";
    install();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resets all per-attempt state between attempts", () => {
    beginAttempt(1, 3);
    observeStderrLine("FATAL kr == KERN_SUCCESS");
    observeMainProcessExit(1, null);
    expect(classify()).toBe("main-process-exit");

    beginAttempt(2, 3);
    expect(classify()).toBe("unknown");
  });

  it("resets protocol counters between attempts", () => {
    beginAttempt(1, 3);
    writeDebugLines(PW_PROTOCOL_SEND);
    vi.advanceTimersByTime(3000);
    expect(classify()).toBe("cdp-handshake-silent");

    beginAttempt(2, 3);
    vi.advanceTimersByTime(3000);
    expect(classify()).toBe("unknown");
  });

  it("tracks correct attempt numbers in summaries", () => {
    const { mock, restore } = mockStderr();

    try {
      beginAttempt(1, 3);
      observeStderrLine("crashpad error");
      writeSummary();

      beginAttempt(2, 3);
      observeStderrLine("crashpad error");
      writeSummary();

      const lines = mock.mock.calls.map((c) => String(c[0]));
      const t1 = lines.find(
        (l: string) => l.includes("attempt=1/3") && l.includes("e2e_launch_telemetry")
      );
      const t2 = lines.find(
        (l: string) => l.includes("attempt=2/3") && l.includes("e2e_launch_telemetry")
      );
      expect(t1).toBeDefined();
      expect(t2).toBeDefined();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Dispose / cleanup
// ---------------------------------------------------------------------------
describe("dispose", () => {
  it("restores original stderr.write", () => {
    const original = process.stderr.write;
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol";
    install();
    expect(process.stderr.write).not.toBe(original);
    dispose();
    expect(process.stderr.write).toBe(original);
  });

  it("resets all state to defaults", () => {
    process.env.E2E_LAUNCH_TELEMETRY = "1";
    process.env.DEBUG = "pw:protocol";
    install();
    beginAttempt(1, 3);
    observeStderrLine("FATAL kr == KERN_SUCCESS");
    observeMainProcessExit(1, "SIGTERM");
    observeRendererCrash();

    dispose();

    install();
    beginAttempt(1, 1);
    expect(classify()).toBe("unknown");
  });

  it("is idempotent", () => {
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });
});
