export const VERSION = "0.0.0";

export { ZAT_PER_ZEC, MAX_ZAT, zecToZat, formatZat } from "./amount.js";
export { clusterEntities, serviceEntities } from "./entities.js";
export {
  DEFAULT_MATCH_PARAMS,
  ShieldIndex,
  expectedChanceMatches,
  feeShapedEntities,
  historyNeededSec,
  scoreExit,
} from "./matcher.js";
export type { Direction, ExitQuery, ExitScore, MatchParams, ShieldPoint } from "./matcher.js";
export {
  CROWD_BUCKETS,
  crowdBucket,
  meterStats,
  precisionBand,
  shiftedExit,
  zecDecimals,
} from "./meter.js";
export type {
  Breakdown,
  Comparison,
  CrowdBucket,
  MeterStats,
  PrecisionBand,
  Rate,
} from "./meter.js";
export {
  SNAPSHOT_VERSION,
  SnapshotFormatError,
  canonicalizeSnapshot,
  decodeSnapshot,
  encodeSnapshot,
} from "./snapshot.js";
export type { SnapshotData } from "./snapshot.js";
export {
  ADDRESS_HASH_BYTES,
  AddressSet,
  MANIFEST_FORMAT,
  SnapshotIntegrityError,
  buildAddressSet,
  gunzip,
  hashAddress,
  loadSnapshot,
  parseManifest,
  sha256Hex,
} from "./integrity.js";
export type { Manifest, ManifestFile, VerifiedSnapshot } from "./integrity.js";
