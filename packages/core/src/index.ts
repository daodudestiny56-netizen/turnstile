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
