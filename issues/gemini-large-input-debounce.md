# Bug: Gemini Input Submission Timing (Hybrid Input Debounce)

## Summary
When pasting large inputs into a Gemini agent terminal (or any terminal that doesn't support bracketed paste), the input is chunked and written sequentially. Currently, `TerminalProcess.ts` waits for the write queue to drain and then waits a fixed 200ms (`SUBMIT_ENTER_DELAY_MS`) before sending the final `Enter` key (`\r`).

For very large inputs, or when the agent/system is slow to process/echo the input, the terminal might still be "busy" (processing input, echoing characters, or reflowing text) when the `Enter` key is sent. This can lead to the `Enter` key being processed prematurely or incorrectly mixed with the input stream, potentially causing the command to fail or execute partially.

We need to implement a "debounce" mechanism that waits for the terminal output to "settle" (i.e., stop producing output for a short period) *after* the input has been written, but *before* sending the final `Enter`.

## Current Behavior
1. `TerminalProcess.submit()` receives text.
2. It detects Gemini/non-bracketed-paste support.
3. It chunks the text (50 chars per 5ms) and writes it to the PTY.
4. It waits for the write queue to empty (`waitForInputWriteDrain`).
5. It waits a fixed 200ms (`delay(SUBMIT_ENTER_DELAY_MS)`).
6. It writes `\r`.

## Problem
The fixed 200ms delay is a "blind" wait. It doesn't account for:
- The agent being slow to echo characters.
- High system load causing PTY output delays.
- Large paste buffers filling up OS pipes.

If the terminal is still echoing the pasted text when `\r` is sent, the Enter key might effectively race with the tail end of the paste.

## Proposed Fix
Modify `performSubmit` in `electron/services/pty/TerminalProcess.ts` to include an "output settle" check.

Instead of just `await delay(SUBMIT_ENTER_DELAY_MS)`, we should:
1. Define a `OUTPUT_SETTLE_DEBOUNCE_MS` (e.g., 100ms or 200ms).
2. After `waitForInputWriteDrain()`, enter a loop or wait state.
3. Monitor `lastOutputTime` (which is updated in `onData`).
4. Wait until `Date.now() - lastOutputTime > OUTPUT_SETTLE_DEBOUNCE_MS`.
5. Add a reasonable timeout (e.g., 2000ms) to avoid hanging forever if the terminal is noisy (e.g., a spinner).

### Pseudo-code Change
```typescript
// Current
await this.waitForInputWriteDrain();
await delay(SUBMIT_ENTER_DELAY_MS);
this.write(enterSuffix);

// Proposed
await this.waitForInputWriteDrain();

// Wait for output to settle
const SETTLE_MS = 200;
const MAX_WAIT_MS = 2000;
const startWait = Date.now();

while (Date.now() - this.terminalInfo.lastOutputTime < SETTLE_MS) {
  if (Date.now() - startWait > MAX_WAIT_MS) break; // Don't wait forever
  await delay(50); // Small polling interval
}

this.write(enterSuffix);
```

## Affected Files
- `electron/services/pty/TerminalProcess.ts`

## Tasks
- [ ] Create a reproduction test case (optional but recommended) where output is slow.
- [ ] Implement the debounce/settle logic in `TerminalProcess.ts`.
- [ ] Verify that Gemini inputs still submit correctly (and don't hang).
- [ ] Verify that normal terminals (using bracketed paste) are unaffected (logic should be inside the `else` block or specific to the non-bracketed path).

## Acceptance Criteria
- Large pastes into Gemini wait for the terminal echo/output to pause before sending Enter.
- The submission doesn't hang indefinitely if the terminal is constantly outputting (max timeout).
