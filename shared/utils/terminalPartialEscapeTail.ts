/**
 * Written first at a restore boundary. CAN returns xterm's parser to ground
 * from every state — an unfinished CSI, or an OSC/DCS/APC string, which it
 * aborts without dispatching — and is a no-op in ground. `Terminal.reset()`
 * does not touch the parser (xterm.js #5019), so without it a terminal left
 * mid-sequence eats the head of the snapshot written after the reset.
 */
export const PARSER_GROUND = "\x18";

const enum S {
  Ground,
  Escape,
  EscapeIntermediate,
  CsiEntry,
  CsiParam,
  CsiIntermediate,
  CsiIgnore,
  SosPmString,
  OscString,
  DcsEntry,
  DcsParam,
  DcsIntermediate,
  DcsIgnore,
  DcsPassthrough,
  ApcEntry,
  ApcIntermediate,
  ApcPassthrough,
}

// Result of one code unit: the next state, and what that unit does to the
// retained tail. Units xterm executes mid-sequence (C0 controls inside
// ESC/CSI) have already taken effect and are dropped — replaying them would
// run them twice.
const enum T {
  Drop,
  Append,
  Start,
}

const HEADER_CAP = 4096;
const STRING_CAP = 65536;

function isExecutable(c: number): boolean {
  return c <= 0x17 || c === 0x19 || (c >= 0x1c && c <= 0x1f);
}

const decoder = new TextDecoder();

function isAnywhere(c: number): boolean {
  return c === 0x1b || c === 0x18 || c === 0x1a || (c >= 0x80 && c <= 0x9f);
}

function isStringState(state: S): boolean {
  return state === S.OscString || state === S.DcsPassthrough || state === S.ApcPassthrough;
}

/**
 * Tracks the unfinished escape sequence at the end of a terminal byte stream,
 * following the transition table of xterm 6.1's `EscapeSequenceParser`.
 *
 * A snapshot serialized from a terminal holds only committed state; bytes the
 * parser has consumed into a sequence it has not finished are in no cell and
 * no mode, so the snapshot drops them. Replaying `tail` after the snapshot
 * puts a fresh parser back in the same state, and the next live chunk
 * finishes the sequence the way it would have on the source.
 */
export class PartialEscapeTracker {
  private state: S = S.Ground;
  private buffer = "";
  private overflowed = false;

  /**
   * The code units to replay after a snapshot: `""` when the parser is in
   * ground, `null` when the pending sequence outgrew the cap and cannot be
   * reproduced (the consumer must not replay a truncated sequence).
   */
  get tail(): string | null {
    if (this.state === S.Ground) return "";
    return this.overflowed ? null : this.buffer;
  }

  reset(): void {
    this.state = S.Ground;
    this.buffer = "";
    this.overflowed = false;
  }

  /** Put the tracker in the state `tail` leaves a fresh parser in. */
  seed(tail: string | null | undefined): void {
    this.reset();
    if (tail) this.feed(tail);
  }

  feed(data: string): void {
    // Every ESC, CAN, SUB and C1 control moves the parser to a state that does
    // not depend on the one it was in, so only the text from the last of them
    // matters. Searching backwards keeps a long run of plain output cheap.
    let from = data.length - 1;
    while (from >= 0 && !isAnywhere(data.charCodeAt(from))) from--;
    if (from < 0) {
      if (this.state !== S.Ground) this.run(data, 0);
      return;
    }
    this.run(data, from);
  }

  /** Feed whatever a terminal write accepts. */
  feedAny(data: string | Uint8Array): void {
    if (typeof data === "string") this.feed(data);
    else this.feedBytes(data);
  }

  /**
   * UTF-8 variant for MessagePort chunks. Only the suffix from the last
   * state-resetting control is decoded; the C1 controls appear as the two-byte
   * sequences C2 80..C2 9F.
   */
  feedBytes(data: Uint8Array): void {
    let from = data.length - 1;
    for (; from >= 0; from--) {
      const b = data[from]!;
      if (b === 0x1b || b === 0x18 || b === 0x1a) break;
      if (b >= 0x80 && b <= 0x9f && from > 0 && data[from - 1] === 0xc2) {
        from--;
        break;
      }
    }
    if (from < 0) {
      if (this.state !== S.Ground) this.run(decoder.decode(data), 0);
      return;
    }
    this.run(decoder.decode(data.subarray(from)), 0);
  }

  private run(data: string, begin: number): void {
    let start = -1;
    for (let i = begin; i < data.length; i++) {
      const c = data.charCodeAt(i);
      const prev = this.state;
      const op = this.step(c);
      if (this.state === S.Ground) {
        start = -1;
        if (prev !== S.Ground) this.clear();
        continue;
      }
      if (op === T.Start) {
        this.clear();
        start = i;
        continue;
      }
      if (op === T.Append) {
        if (start === -1) start = i;
        continue;
      }
      // Drop: flush what precedes this unit and skip it.
      if (start !== -1) {
        this.append(data, start, i);
        start = -1;
      }
    }
    if (start !== -1 && this.state !== S.Ground) this.append(data, start, data.length);
  }

  private clear(): void {
    this.buffer = "";
    this.overflowed = false;
  }

  private append(data: string, from: number, to: number): void {
    if (this.overflowed) return;
    const cap = isStringState(this.state) ? STRING_CAP : HEADER_CAP;
    if (this.buffer.length + (to - from) > cap) {
      this.buffer = "";
      this.overflowed = true;
      return;
    }
    this.buffer += data.slice(from, to);
  }

  private go(state: S, op: T): T {
    this.state = state;
    return op;
  }

  private step(c: number): T {
    const state = this.state;

    // "Anywhere" transitions. The string states' own terminators land here
    // too: ESC ends an OSC/DCS/APC string and leaves the parser in ESCAPE.
    if (c === 0x1b) return this.go(S.Escape, T.Start);
    if (c >= 0x80 && c <= 0x9f) {
      switch (c) {
        case 0x90:
          return this.go(S.DcsEntry, T.Start);
        case 0x98:
        case 0x9e:
          return this.go(S.SosPmString, T.Start);
        case 0x9b:
          return this.go(S.CsiEntry, T.Start);
        case 0x9d:
          return this.go(S.OscString, T.Start);
        case 0x9f:
          return this.go(S.ApcEntry, T.Start);
        default:
          return this.go(S.Ground, T.Drop);
      }
    }
    if (c === 0x18 || c === 0x1a) return this.go(S.Ground, T.Drop);

    // Everything at or above 0xA0 shares one table column in xterm.
    const printable = c >= 0xa0;

    switch (state) {
      case S.Ground:
        return T.Drop;

      case S.Escape:
        if (isExecutable(c) || c === 0x7f) return T.Drop;
        if (c >= 0x20 && c <= 0x2f) return this.go(S.EscapeIntermediate, T.Append);
        if (c === 0x5b) return this.go(S.CsiEntry, T.Append);
        if (c === 0x5d) return this.go(S.OscString, T.Append);
        if (c === 0x50) return this.go(S.DcsEntry, T.Append);
        if (c === 0x5f) return this.go(S.ApcEntry, T.Append);
        if (c === 0x58 || c === 0x5e) return this.go(S.SosPmString, T.Append);
        return this.go(S.Ground, T.Drop);

      case S.EscapeIntermediate:
        if (isExecutable(c) || c === 0x7f) return T.Drop;
        if (c >= 0x20 && c <= 0x2f) return T.Append;
        return this.go(S.Ground, T.Drop);

      case S.CsiEntry:
      case S.CsiParam:
      case S.CsiIntermediate:
        if (isExecutable(c) || c === 0x7f) return T.Drop;
        if (c >= 0x40 && c <= 0x7e) return this.go(S.Ground, T.Drop);
        if (c >= 0x20 && c <= 0x2f) return this.go(S.CsiIntermediate, T.Append);
        if (c >= 0x30 && c <= 0x3f) {
          if (state === S.CsiIntermediate) return this.go(S.CsiIgnore, T.Append);
          if (c <= 0x3b) return this.go(S.CsiParam, T.Append);
          return this.go(state === S.CsiEntry ? S.CsiParam : S.CsiIgnore, T.Append);
        }
        return this.go(S.Ground, T.Drop);

      case S.CsiIgnore:
        if (c >= 0x40 && c <= 0x7e) return this.go(S.Ground, T.Drop);
        return T.Drop;

      case S.SosPmString:
        return T.Drop;

      case S.OscString:
        if (c === 0x07) return this.go(S.Ground, T.Drop);
        if (c < 0x20) return T.Drop;
        return T.Append;

      case S.DcsEntry:
      case S.DcsParam:
      case S.DcsIntermediate:
        if (isExecutable(c) || c === 0x7f) return T.Drop;
        if (printable) return this.go(S.Ground, T.Drop);
        if (c >= 0x40 && c <= 0x7e) return this.go(S.DcsPassthrough, T.Append);
        if (c >= 0x20 && c <= 0x2f) return this.go(S.DcsIntermediate, T.Append);
        if (state === S.DcsIntermediate) return this.go(S.DcsIgnore, T.Append);
        if (c <= 0x3b) return this.go(S.DcsParam, T.Append);
        return this.go(state === S.DcsEntry ? S.DcsParam : S.DcsIgnore, T.Append);

      case S.DcsIgnore:
        return T.Drop;

      case S.DcsPassthrough:
        return c === 0x7f ? T.Drop : T.Append;

      case S.ApcEntry:
      case S.ApcIntermediate:
        if (isExecutable(c) || c === 0x7f) return T.Drop;
        if (printable) return this.go(S.Ground, T.Drop);
        if (c >= 0x20 && c <= 0x2f) return this.go(S.ApcIntermediate, T.Append);
        return this.go(S.ApcPassthrough, T.Append);

      case S.ApcPassthrough:
        if (printable || (c >= 0x20 && c <= 0x7e) || (c >= 0x08 && c <= 0x0d)) return T.Append;
        return T.Drop;
    }
    return T.Drop;
  }
}
