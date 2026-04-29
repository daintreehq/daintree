// In production, `enforceIpcSenderValidation()` is called once at startup and
// flips a guard flag that all IPC handler registrations assert against. Unit
// tests don't run that bootstrap path, so we mark the guard ready here. Tests
// that need to verify the throwing behavior (e.g. `ipcGuard.test.ts`) reset
// the flag explicitly via `_resetIpcGuardForTesting()`.

import { markIpcSecurityReady } from "./electron/ipc/ipcGuard.js";

markIpcSecurityReady();
