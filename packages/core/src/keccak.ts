/**
 * Keccak-256 (the original Keccak padding, as Ethereum uses; not SHA3-256). Only used for EIP-55
 * address checksums, so it favours brevity over speed: 64-bit lanes as BigInt.
 */

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];
/** Rotation offsets r[x][y]. */
const R = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const rot = (v: bigint, n: number): bigint =>
  n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK;

function keccakF(a: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c = Array.from(
      { length: 5 },
      (_, x) => a[x]! ^ a[x + 5]! ^ a[x + 10]! ^ a[x + 15]! ^ a[x + 20]!,
    );
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rot(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y++) a[x + 5 * y]! ^= d;
    }
    const b = new Array<bigint>(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rot(a[x + 5 * y]!, R[x]![y]!);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        a[x + 5 * y] =
          b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & MASK & b[((x + 2) % 5) + 5 * y]!);
      }
    }
    a[0] = a[0]! ^ RC[round]!;
  }
}

export function keccak256(input: Uint8Array): Uint8Array {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length]! ^= 0x01;
  padded[padded.length - 1]! ^= 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]!);
      state[i] = state[i]! ^ lane;
    }
    keccakF(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i]!;
    for (let k = 0; k < 8; k++) {
      out[i * 8 + k] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}
