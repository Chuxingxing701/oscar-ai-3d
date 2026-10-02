// Deterministic, stateless noise. Every value is a pure hash of
// (seed, channel, sim_time_s, index): no mutable RNG state, so a restarted
// process reproduces the exact same sequence for the same inputs.

/** xmur3 string hash -> 32-bit integer. */
function xmur3(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** splitmix64-style finalizer over three 64-bit inputs. */
function mix(a: bigint, b: bigint, c: bigint): bigint {
  let z = BigInt.asUintN(64, a ^ b ^ c ^ 0x9e3779b97f4a7c15n);
  z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
  z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
  return BigInt.asUintN(64, z ^ (z >> 31n));
}

const seedBig = (seed: number): bigint => BigInt(Math.floor(seed) >>> 0);

/** Uniform double in [0, 1). Stateless: same inputs -> same output, always. */
export function uniform(seed: number, channel: string, simTimeS: number, index: number): number {
  const h = mix(seedBig(seed), BigInt(xmur3(channel)), BigInt(Math.floor(simTimeS)) * 1000003n + BigInt(Math.floor(index)));
  return Number(h & 0xffffffffffffn) / 281474976710656.0; // 48-bit mask / 2^48
}

/** Uniform integer in [0, n). */
export function uniformInt(seed: number, channel: string, simTimeS: number, index: number, n: number): number {
  return Math.min(Math.floor(uniform(seed, channel, simTimeS, index) * n), n - 1);
}

/** Standard normal via Box-Muller from two independent uniforms (stateless). */
export function normal(seed: number, channel: string, simTimeS: number, index: number): number {
  const u1 = Math.max(uniform(seed, `${channel}#bm1`, simTimeS, index), 1e-12);
  const u2 = uniform(seed, `${channel}#bm2`, simTimeS, index);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
