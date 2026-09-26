import { describe, expect, it } from "vitest";
import {
  finalizeListeners,
  parseLsofListeners,
  parseProcNetTcp,
  scanHostListeners,
  type ProcFs,
} from "../listenerScan.js";

// `lsof -nP -iTCP -sTCP:LISTEN -F pcn` on macOS.
const LSOF_SAMPLE = [
  "p512",
  "cControlCe",
  "f9",
  "n*:7000",
  "f10",
  "n*:5000",
  "p4242",
  "cnode",
  "f23",
  "n[::1]:5173",
  "f24",
  "n127.0.0.1:5173",
  "p5000",
  "cpostgres",
  "f7",
  "n192.168.1.20:5432",
  "p6001",
  "cruby",
  "f12",
  "n[::]:3000",
  "",
].join("\n");

describe("parseLsofListeners", () => {
  it("keeps loopback and wildcard listeners with their process", () => {
    expect(parseLsofListeners(LSOF_SAMPLE)).toEqual([
      { port: 7000, pid: 512, processName: "ControlCe" },
      { port: 5000, pid: 512, processName: "ControlCe" },
      { port: 5173, pid: 4242, processName: "node" },
      { port: 5173, pid: 4242, processName: "node" },
      { port: 3000, pid: 6001, processName: "ruby" },
    ]);
  });

  it("ignores malformed lines", () => {
    expect(parseLsofListeners("p\nnnot-an-address\nn*:99999\nn*:abc")).toEqual([]);
  });
});

// /proc/net/tcp: 127.0.0.1:3000 listening (uid 1000), 0.0.0.0:8080 listening (uid 1000),
// 10.0.0.5:9000 listening (not reachable via localhost), 127.0.0.1:3000 established,
// 127.0.0.1:631 listening as root.
const PROC_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000000000000000 100 0 0 10 0
   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0000000000000000 100 0 0 10 0
   2: 0500000A:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 333 1 0000000000000000 100 0 0 10 0
   3: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 444 1 0000000000000000 100 0 0 10 0
   4: 0100007F:0277 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 555 1 0000000000000000 100 0 0 10 0
`;

// /proc/net/tcp6: [::1]:5173 and [::]:4000 listening (uid 1000), ::ffff:127.0.0.1:4100 listening,
// a global v6 address listening (not reachable).
const PROC_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 666 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:0FA0 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:1004 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 888 1 0000000000000000 100 0 0 10 0
   3: 20010DB8000000000000000000000001:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 999 1 0000000000000000 100 0 0 10 0
`;

describe("parseProcNetTcp", () => {
  it("keeps listening sockets reachable through localhost", () => {
    expect(parseProcNetTcp(PROC_TCP, 4)).toEqual([
      { port: 3000, uid: 1000, inode: 111 },
      { port: 8080, uid: 1000, inode: 222 },
      { port: 631, uid: 0, inode: 555 },
    ]);
    expect(parseProcNetTcp(PROC_TCP6, 6)).toEqual([
      { port: 5173, uid: 1000, inode: 666 },
      { port: 4000, uid: 1000, inode: 777 },
      { port: 4100, uid: 1000, inode: 888 },
    ]);
  });
});

function fakeProc(
  files: Record<string, string>,
  dirs: Record<string, string[]>,
  links: Record<string, string>
): ProcFs {
  const missing = () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  return {
    readFile: (path) => (path in files ? Promise.resolve(files[path]!) : missing()),
    readdir: (path) => (path in dirs ? Promise.resolve(dirs[path]!) : missing()),
    readlink: (path) => (path in links ? Promise.resolve(links[path]!) : missing()),
  };
}

describe("scanHostListeners", () => {
  it("reads the user's own Linux listeners and names their processes where it can", async () => {
    const procFs = fakeProc(
      {
        "/proc/net/tcp": PROC_TCP,
        "/proc/net/tcp6": PROC_TCP6,
        "/proc/300/comm": "vite\n",
        "/proc/400/comm": "python3\n",
      },
      {
        "/proc": ["1", "300", "400", "self", "999"],
        "/proc/300/fd": ["0", "1", "19"],
        "/proc/400/fd": ["5"],
      },
      {
        "/proc/300/fd/0": "/dev/null",
        "/proc/300/fd/1": "pipe:[12]",
        "/proc/300/fd/19": "socket:[666]",
        "/proc/400/fd/5": "socket:[111]",
      }
    );
    const ports = await scanHostListeners({
      platform: "linux",
      uid: 1000,
      procFs,
      excludePids: new Set([999]),
    });
    expect(ports).toEqual([
      { port: 3000, pid: 400, processName: "python3" },
      { port: 4000, pid: null, processName: null },
      { port: 4100, pid: null, processName: null },
      { port: 5173, pid: 300, processName: "vite" },
      { port: 8080, pid: null, processName: null },
    ]);
  });

  it("runs lsof on macOS, dedupes by port and leaves out this process", async () => {
    const ports = await scanHostListeners({
      platform: "darwin",
      lsof: async () => LSOF_SAMPLE,
      excludePids: new Set([512]),
    });
    expect(ports).toEqual([
      { port: 3000, pid: 6001, processName: "ruby" },
      { port: 5173, pid: 4242, processName: "node" },
    ]);
  });

  it("prefers the entry that names a process", () => {
    expect(
      finalizeListeners(
        [
          { port: 80, pid: null, processName: null },
          { port: 80, pid: 7, processName: "nginx" },
        ],
        new Set()
      )
    ).toEqual([{ port: 80, pid: 7, processName: "nginx" }]);
  });
});
