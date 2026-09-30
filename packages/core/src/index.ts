export const VERSION = "0.0.0";

export { ZAT_PER_ZEC, MAX_ZAT, formatZat, parsePositiveZec, zecToZat } from "./amount.js";
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
export { listCandidates } from "./matcher.js";
export type { Candidate } from "./matcher.js";
export { seededRandom } from "./random.js";
export {
  CROWD_TARGET,
  PreflightRangeError,
  STALE_AFTER_SEC,
  createPreflightContext,
  preflight,
  roundDownAmount,
} from "./preflight.js";
export type {
  OwnDeposit,
  PlannedExit,
  PreflightContext,
  PreflightResult,
  Reason,
  ReasonCode,
  Verdict,
} from "./preflight.js";
export {
  hourlyActivity,
  measureDenominations,
  planExit,
  planToIcs,
  planVerdict,
} from "./planner.js";
export type { ExitPlan, PlanOptions, PlannedLeg } from "./planner.js";
export { STANDARD_DENOMINATIONS, bestCommonAmount } from "./denominations.js";
export type { Denomination } from "./denominations.js";
