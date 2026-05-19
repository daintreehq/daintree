const GRAVATAR_BASE = "https://www.gravatar.com/avatar";

function sha256hex(input: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);

  const words: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const wordIdx = i >> 2;
    const prev = words[wordIdx] ?? 0;
    words[wordIdx] = prev | (data[i]! << (24 - (i & 3) * 8));
  }

  const msgBitLen = data.length * 8;
  const msgLastWord = data.length >> 2;
  const prevLast = words[msgLastWord] ?? 0;
  words[msgLastWord] = prevLast | (0x80 << (24 - (data.length & 3) * 8));

  const blockWords = Math.ceil((msgBitLen + 1 + 64) / 512) * 16;
  for (let i = words.length; i < blockWords; i++) {
    words[i] = 0;
  }

  words[blockWords - 1] = msgBitLen;
  words[blockWords - 2] = 0;

  const H: [number, number, number, number, number, number, number, number] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const K: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  const w = new Array<number>(64);
  for (let i = 0; i < blockWords; i += 16) {
    for (let j = 0; j < 16; j++) w[j] = words[i + j]!;
    for (let j = 16; j < 64; j++) {
      const s0 = rr(w[j - 15]!, 7) ^ rr(w[j - 15]!, 18) ^ (w[j - 15]! >>> 3);
      const s1 = rr(w[j - 2]!, 17) ^ rr(w[j - 2]!, 19) ^ (w[j - 2]! >>> 10);
      w[j] = (w[j - 16]! + s0 + w[j - 7]! + s1) | 0;
    }

    let [a, b, c, d, e, f, g, h] = H;
    for (let j = 0; j < 64; j++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[j]! + w[j]!) | 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    H[0] = (H[0]! + a) | 0;
    H[1] = (H[1]! + b) | 0;
    H[2] = (H[2]! + c) | 0;
    H[3] = (H[3]! + d) | 0;
    H[4] = (H[4]! + e) | 0;
    H[5] = (H[5]! + f) | 0;
    H[6] = (H[6]! + g) | 0;
    H[7] = (H[7]! + h) | 0;
  }

  let hex = "";
  for (let i = 0; i < 8; i++) {
    const v = H[i]! >>> 0;
    hex += ((v >>> 24) & 0xff).toString(16).padStart(2, "0");
    hex += ((v >>> 16) & 0xff).toString(16).padStart(2, "0");
    hex += ((v >>> 8) & 0xff).toString(16).padStart(2, "0");
    hex += (v & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

function rr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

// `d=404` — Gravatar returns HTTP 404 (not a generic identicon) when the email
// has no custom image, so the avatar chain can fall through to coloured
// initials instead of ever painting a meaningless geometric placeholder.
export function getGravatarUrl(email: string, size: number): string {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return `${GRAVATAR_BASE}/00000000000000000000000000000000?s=${size}&d=404`;
  const hash = sha256hex(trimmed);
  return `${GRAVATAR_BASE}/${hash}?s=${size}&d=404`;
}

export function isBotAuthor(name: string): boolean {
  return name.endsWith("[bot]");
}
