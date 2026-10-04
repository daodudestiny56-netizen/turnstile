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
  canonicalizeSnapshotWithOrder,
  decodeSnapshot,
  encodeSnapshot,
} from "./snapshot.js";
export type { CanonicalSnapshot, SnapshotData } from "./snapshot.js";
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
  verifyGzipped,
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
  MAX_HORIZON_HOURS,
  MAX_LEGS,
  chooseLegs,
  hourlyActivity,
  linkedSums,
  measureDenominations,
  planExit,
  planToIcs,
  planVerdict,
} from "./planner.js";
export type { ExitPlan, PlanOptions, PlannedLeg } from "./planner.js";
export { STANDARD_DENOMINATIONS, bestCommonAmount } from "./denominations.js";
export type { Denomination } from "./denominations.js";
export {
  bech32mDecode,
  bech32mEncode,
  cleanAddress,
  evmAddressProblem,
  isBitcoinAddress,
  isNearAccount,
  isSolanaAddress,
  parseAddress,
  parseRefundAddress,
  toTex,
} from "./address.js";
export type { AddressKind, ParsedAddress, RefundAddress } from "./address.js";
export { paymentUri } from "./zip321.js";
export { keccak256 } from "./keccak.js";
export {
  AUDIT_MAX_ADDRESSES,
  AUDIT_MAX_EVENTS,
  AUDIT_VERSION,
  AuditIndex,
  AuditInputError,
  auditAddresses,
  encodeAudit,
  loadAudit,
  splitAddresses,
} from "./audit.js";
export type {
  AuditCode,
  AuditFinding,
  AuditRefs,
  AuditResult,
  AuditedAddress,
  AuditedDeposit,
  AuditedWithdrawal,
} from "./audit.js";
export { SHIELD_FEE_ZAT, planEntry } from "./entry.js";
export type { EntryAdvice, EntryCode, EntryOptions, EntryReason } from "./entry.js";
