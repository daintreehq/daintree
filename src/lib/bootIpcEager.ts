// Fire `app:boot` as early as the module graph allows. Importing this module
// first from the project shell (`src/projectWindow/projectShell.tsx`) moves the
// IPC send ahead of the rest of the shell's body, so the round-trip overlaps
// that evaluation plus React parse and the first commit; `App` reads the cached
// promise via `use()` (#8820). Warming the safe
// wrapper (not just `getBootPromise`) means its derived `.then` chain is also
// annotated before first render, so `use()` can read it synchronously when the
// IPC beats React's parse + commit. Production caveat: Rollup hoists
// cross-chunk static imports, so the shell chunk's vendor imports still
// evaluate before this inlined body — the fire only moves ahead of the
// remaining shell module bodies, not the vendor chunks.
import { getSafeBootPromise } from "./bootPromise";

void getSafeBootPromise();
