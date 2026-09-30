/**
 * Transparent destination addresses: validation, and TEX (ZIP 320) conversion.
 *
 * Exchanges increasingly require TEX addresses ("tex1..."), which are the same P2PKH key hash as a
 * "t1..." address in Bech32m form. The address-reuse check must see through that, so TEX addresses
 * are converted to their t1 form before hashing.
 */

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

/** Mainnet Base58Check version prefixes. */
const P2PKH_PREFIX = [0x1c, 0xb8]; // t1
const P2SH_PREFIX = [0x1c, 0xbd]; // t3

interface Subtle {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}
const subtle = (): Subtle =>
  (globalThis as unknown as { crypto: { subtle: Subtle } }).crypto.subtle;

async function sha256d(bytes: Uint8Array): Promise<Uint8Array> {
  const once = new Uint8Array(await subtle().digest("SHA-256", bytes));
  return new Uint8Array(await subtle().digest("SHA-256", once));
}

function base58Decode(s: string): Uint8Array | undefined {
  let n = 0n;
  for (const ch of s) {
    const v = BASE58.indexOf(ch);
    if (v < 0) return undefined;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** Decode a Base58Check string; undefined if malformed or the checksum is wrong. */
async function base58CheckDecode(s: string): Promise<Uint8Array | undefined> {
  const raw = base58Decode(s);
  if (!raw || raw.length < 5) return undefined;
  const payload = raw.slice(0, -4);
  const check = (await sha256d(payload)).slice(0, 4);
  return check.every((b, i) => b === raw[raw.length - 4 + i]) ? payload : undefined;
}

async function base58CheckEncode(payload: Uint8Array): Promise<string> {
  const check = (await sha256d(payload)).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(check, payload.length);
  return base58Encode(full);
}

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | undefined {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return undefined;
  }
  return out;
}

/** Decode a Bech32m string (BIP 350); undefined if malformed or the checksum is wrong. */
export function bech32mDecode(s: string): { hrp: string; bytes: Uint8Array } | undefined {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return undefined;
  const lower = s.toLowerCase();
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) return undefined;
  const hrp = lower.slice(0, sep);
  const data: number[] = [];
  for (const ch of lower.slice(sep + 1)) {
    const v = BECH32.indexOf(ch);
    if (v < 0) return undefined;
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST) return undefined;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  return bytes ? { hrp, bytes: new Uint8Array(bytes) } : undefined;
}

export function bech32mEncode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits([...bytes], 8, 5, true)!;
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((v) => BECH32[v]).join("")}`;
}

export type AddressKind = "t1" | "t3" | "tex" | "shielded" | "testnet" | "invalid";

export interface ParsedAddress {
  kind: AddressKind;
  /** For t1, t3 and tex: the transparent address the funds actually arrive at (tex -> t1). */
  transparent?: string;
  /** For kinds other than t1/t3/tex: why it can't be checked. */
  problem?: string;
}

/** Classify a destination address and, for transparent ones, verify its checksum. */
export async function parseAddress(input: string): Promise<ParsedAddress> {
  const s = input.trim();
  const lower = s.toLowerCase();
  if (/^(zs1|zc|u1)/.test(lower)) {
    return {
      kind: "shielded",
      problem:
        "This is a shielded (or unified) address. Sending to it keeps the funds shielded, so " +
        "there's nothing to check here; this check is for transparent destinations (t1, t3 or tex1).",
    };
  }
  if (/^(tm|t2|textest1|ztestsapling|utest1)/.test(lower)) {
    return { kind: "testnet", problem: "This is a testnet address; Turnstile checks mainnet." };
  }
  if (lower.startsWith("tex1")) {
    const decoded = bech32mDecode(s);
    if (!decoded || decoded.hrp !== "tex" || decoded.bytes.length !== 20) {
      return { kind: "invalid", problem: "This tex1 address isn't valid: check it for typos." };
    }
    const payload = new Uint8Array([...P2PKH_PREFIX, ...decoded.bytes]);
    return { kind: "tex", transparent: await base58CheckEncode(payload) };
  }
  if (/^t[13]/.test(s)) {
    const payload = await base58CheckDecode(s);
    const prefix = payload?.slice(0, 2);
    const kind =
      prefix && payload!.length === 22
        ? prefix[0] === P2PKH_PREFIX[0] && prefix[1] === P2PKH_PREFIX[1]
          ? "t1"
          : prefix[0] === P2SH_PREFIX[0] && prefix[1] === P2SH_PREFIX[1]
            ? "t3"
            : undefined
        : undefined;
    if (!kind) {
      return {
        kind: "invalid",
        problem: "This address doesn't pass its checksum: check it for typos.",
      };
    }
    return { kind, transparent: s };
  }
  return {
    kind: "invalid",
    problem: "Transparent Zcash addresses start with t1, t3 or tex1.",
  };
}

/** The TEX form of a t1 address (for display and tests). */
export async function toTex(t1: string): Promise<string | undefined> {
  const payload = await base58CheckDecode(t1.trim());
  if (!payload || payload.length !== 22 || payload[0] !== 0x1c || payload[1] !== 0xb8) {
    return undefined;
  }
  return bech32mEncode("tex", payload.slice(2));
}
