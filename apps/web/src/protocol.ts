import type {
  ExitPlan,
  Manifest,
  MeterStats,
  OwnDeposit,
  PlanOptions,
  PlannedExit,
} from "@turnstile/core";

export interface EngineInfo {
  manifest: Manifest;
  stats: MeterStats;
  /** Unix seconds; the snapshot covers [dataFrom, dataTo). */
  dataFrom: number;
  dataTo: number;
}

export interface PlanResult {
  plan: ExitPlan;
  ics: string;
}

export type WorkerRequest =
  | { id: number; type: "init"; base: string }
  | { id: number; type: "check"; exit: PlannedExit; own?: OwnDeposit }
  | { id: number; type: "plan"; options: PlanOptions };

export type WorkerResponse =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
