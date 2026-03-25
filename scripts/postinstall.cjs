const { execSync } = require("child_process");

// Windows: node-pty ships complete N-API prebuilds — only rebuild better-sqlite3.
// macOS/Linux: node-pty needs electron-rebuild for the correct Electron ABI,
// plus the post-install script that compiles spawn-helper.
const modules = process.platform === "win32" ? "better-sqlite3" : "node-pty,better-sqlite3";

execSync(`electron-rebuild -f -w ${modules}`, { stdio: "inherit" });

if (process.platform !== "win32") {
  require("../node_modules/node-pty/scripts/post-install.js");
}
