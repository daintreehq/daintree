const { execSync } = require("child_process");

execSync("electron-rebuild -f -w node-pty,better-sqlite3", { stdio: "inherit" });
require("../node_modules/node-pty/scripts/post-install.js");
