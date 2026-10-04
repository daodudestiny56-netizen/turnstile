/**
 * All analysis runs here, off the main thread and on the user's device. The only network activity
 * is the one-time download of the public snapshot, the same files for every visitor. The audit index
 * follows in the background right after the tools are ready, for every visitor, so downloading it
 * says nothing about who runs an audit.
 */
import {
  auditAddresses,
  createPreflightContext,
  loadAudit,
  measureDenominations,
  planEntry,
  type AuditIndex,
  type Manifest,
  loadSnapshot,
  parseManifest,
  planExit,
  planToIcs,
  preflight,
  sha256Hex,
  type MeterStats,
  type PreflightContext,
} from "@turnstile/core";
import type { EngineInfo, WorkerRequest, WorkerResponse } from "./protocol";

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

let ctx: PreflightContext | undefined;
let audit: Promise<AuditIndex> | undefined;
let loadAuditIndex: (() => Promise<AuditIndex>) | undefined;

async function fetchBytes(url: URL): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url.pathname} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function init(base: string): Promise<EngineInfo> {
  // crypto.subtle only exists in secure contexts; without it nothing can be verified.
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "This page needs a secure connection (https:// or localhost) to verify the data. Open it over HTTPS.",
    );
  }
  const at = (name: string, version?: string): URL => {
    const url = new URL(name, base);
    // Versioned by content hash: a cache can never pair a new manifest with an old file.
    if (version) url.searchParams.set("v", version.slice(0, 16));
    return url;
  };
  const manifestRes = await fetch(at("manifest.json"), { cache: "no-cache" });
  if (!manifestRes.ok) throw new Error("The data snapshot is missing from this site.");
  const manifest = parseManifest(await manifestRes.text());
  const f = manifest.files;
  const [snapshot, addresses, stats] = await Promise.all([
    fetchBytes(at("snapshot.bin.gz", f["snapshot.bin.gz"].sha256)),
    fetchBytes(at("addresses.bin", f["addresses.bin"].sha256)),
    fetchBytes(at("stats.json", f["stats.json"].sha256)),
  ]);
  if (
    typeof DecompressionStream === "undefined" &&
    (await sha256Hex(snapshot)) === f["snapshot.bin.gz"].sha256
  ) {
    throw new Error("This browser is too old to open the data file. Please update it and reload.");
  }
  const verified = await loadSnapshot(manifest, { snapshot, addresses, stats });
  ctx = createPreflightContext(verified.data, verified.addresses);
  const data = verified.data;
  loadAuditIndex = async (): Promise<AuditIndex> =>
    loadAudit(
      manifest as Manifest,
      await fetchBytes(at("audit.bin.gz", f["audit.bin.gz"].sha256)),
      data,
    );
  // After replying: the common amounts every check and plan needs are computed while the user is
  // still typing, then the audit index downloads.
  const warm = ctx;
  setTimeout(() => {
    measureDenominations(warm);
    void startAudit().catch(() => undefined);
  }, 0);
  return {
    manifest,
    stats: verified.stats as MeterStats,
    dataFrom: verified.data.dataFrom,
    dataTo: verified.data.dataTo,
  };
}

/** Start (or, after a failure, restart) the background download of the audit index. */
function startAudit(): Promise<AuditIndex> {
  if (!loadAuditIndex)
    return Promise.reject(new Error("The data snapshot hasn't finished loading."));
  if (!audit) {
    audit = loadAuditIndex();
    // A failed download is retried on the next request instead of failing forever.
    audit.catch(() => (audit = undefined));
  }
  return audit;
}

function ready(): PreflightContext {
  if (!ctx) throw new Error("The data snapshot hasn't finished loading.");
  return ctx;
}

scope.onmessage = async (event) => {
  const req = event.data;
  try {
    switch (req.type) {
      case "init":
        scope.postMessage({ id: req.id, ok: true, value: await init(req.base) });
        break;
      case "check":
        scope.postMessage({
          id: req.id,
          ok: true,
          value: await preflight(ready(), req.exit, req.own),
        });
        break;
      case "entry":
        scope.postMessage({
          id: req.id,
          ok: true,
          value: planEntry(ready(), { balance: req.balance, time: req.time }),
        });
        break;
      case "audit-ready":
        scope.postMessage({ id: req.id, ok: true, value: (await startAudit()).size });
        break;
      case "audit":
        scope.postMessage({
          id: req.id,
          ok: true,
          value: await auditAddresses(ready(), await startAudit(), req.addresses),
        });
        break;
      case "plan": {
        const plan = await planExit(ready(), req.options);
        scope.postMessage({ id: req.id, ok: true, value: { plan, ics: planToIcs(plan) } });
        break;
      }
    }
  } catch (err) {
    scope.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
