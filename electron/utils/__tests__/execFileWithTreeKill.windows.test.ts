import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { execFileWithTreeKill } from "../execFileWithTreeKill.js";

describe.skipIf(process.platform !== "win32")("Windows CLI process lifetime", () => {
  it.each(["timeout", "maxBuffer"])("reaps descendants on %s", async (reason) => {
    let pid: number | undefined;
    try {
      const source = [
        "const {spawn}=require('node:child_process')",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
        "console.log(child.pid)",
        reason === "maxBuffer" ? "setTimeout(()=>console.log('x'.repeat(4096)),250)" : "",
        "setInterval(()=>{},1000)",
      ]
        .filter(Boolean)
        .join(";");
      let failure: (Error & { stdout: string; code?: string; killed?: boolean }) | undefined;
      try {
        await execFileWithTreeKill(process.execPath, ["-e", source], {
          timeout: 1500,
          maxBuffer: 2048,
          windowsHide: true,
        });
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure).toBeDefined();
      pid = Number(failure!.stdout.split(/\r?\n/)[0]);
      expect(pid).toBeGreaterThan(0);
      if (reason === "maxBuffer") expect(failure!.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      else expect(failure!.killed).toBe(true);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      if (pid)
        spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(pid)], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 3000,
        });
    }
  });
});
