# Turnstile — Product Requirements Document

| | |
|---|---|
| **Product** | Turnstile — privacy firewall for Zcash's shielded-pool boundary |
| **Hackathon** | Zecathon — submissions due **Oct 28, 2026 23:59 UTC** |
| **Track** | Cross-Chain ($15,000) — eligible for Grand Prize ($20,000) |
| **Team** | Solo |
| **Stack** | TypeScript end to end (Node 20+, pnpm monorepo, Vite + React, SQLite) |
| **Companion doc** | [docs/turnstile-design.md](docs/turnstile-design.md) — algorithms & architecture detail. Where the two conflict, **this PRD wins**. |

---

## 1. One-liner

> Zcash's shielded pool hides you inside, but its entrance and exit are public.
> **Turnstile measures how badly that leaks, warns you before you leak, and plans your exit so you blend in** —
> without ever sending your plans to a server.

## 2. Problem

Every time ZEC moves between a transparent address (`t1…`) and a shielded pool, the **amount and time are public**.
Most users must cross twice: in from an exchange, out through a swap (NEAR Intents) or exchange.
If the exit amount/time matches the entry, the trip is trivially linkable — the user saw a shield icon and got no privacy.
No wallet warns about this today.

**Evidence we will present**
1. Academic: Quesnelle 2017, *On the linkability of Zcash transactions* (round-trip heuristic).
2. Official: Zcash docs privacy best-practices acknowledge boundary leakage.
3. **Ours (new):** the Leak Meter figure — % of current mainnet exits that are linkable, vs. a null-model baseline.
4. **Ours (new, verified against a Zcash node):** Blockchair's `shielded_value_delta` only reflects the Sapling and
   Sprout pools. It reports no movement for 89.8% of boundary crossings over Jul–Sep 2026, all of them v5/v6
   transactions (the versions that carry Orchard and Ironwood). Turnstile derives every crossing structurally and confirmed 20 of 20 sampled events against a node.

## 3. How we win — mapping to judging criteria

| Criterion (as published) | What the judges must see | Where it's delivered |
|---|---|---|
| **Privacy** — "does it actually preserve privacy… leaks are disqualifying" | Our tool finds a real leak **and** leaks nothing itself: all user checks run locally, zero network requests during a check, no telemetry, no keys handled | S5, S6 (automated "zero requests" test), threat model |
| **Usefulness** — "would someone use this on Monday" | A person about to swap ZEC opens the web app, gets a red/green verdict and a plan in < 1 min | S5, S6, S7 |
| **Execution** — "does it run. Working beats ambitious" | Live public URL, one-command CLI, CI green, every section verified, a real NEAR Intents deposit address and QR in the demo (a completed swap needs funds; shown only if someone donates a small amount) | Every section's acceptance tests |
| **Originality** — "built for this hackathon" | Novel mainnet measurement + method + fix; no one else will have the number | S3, methodology doc |

**The demo moment:** "Of all Zcash exits with a precise amount, one in six traces back to a service's deposit.
People as a whole look safe, but that average hides the individual: withdraw exactly what you deposited and
you are found every time. Here's a withdrawal I'm about to make: Turnstile flags it red. Here's the plan that
turns it green. Here's the first leg getting a live NEAR Intents deposit address and a QR for my own wallet.
And during all of this, the network tab shows nothing left my browser."

## 4. Users

| User | Job to be done |
|---|---|
| **ZEC holder cashing out / swapping** (primary) | "Before I withdraw from shielded, tell me if I'll be linkable and how to avoid it." |
| **Wallet developer** (adoption path) | "Give me a small library I can call to warn my users." |
| **Ecosystem / researchers / judges** | "How much does Zcash actually leak at the boundary right now?" |

## 5. Scope

### 5.1 Must ship (the submission)

| ID | Feature | Summary |
|---|---|---|
| **F1** | Leak Meter | Aggregate linkability of mainnet exits over the last 90 days, with null baseline. Dashboard + CLI. |
| **F2** | Pre-flight Check | Local anonymity-set score for a planned exit (amount, time, optional destination, optional own entry). |
| **F3** | Exit Planner | Split into common denominations with activity-shaped random timing; per-leg score; remainder stays shielded. |
| **F4** | Address-reuse Detector | Flags exits to any t-address that previously shielded. |
| **F6** | NEAR Intents Execution | Per-leg just-in-time quote → ZIP-321 URI + QR → user pays from own wallet → status tracking. |
| **F9** | `@turnstile/core` | The analysis engine as a standalone TS package usable by any wallet. |

### 5.2 Should ship (only if the section schedule is on time)

| ID | Feature |
|---|---|
| F5 | Entry Planner — advise round amounts when shielding |
| F8 | Personal history audit — paste own t-addresses, see which past exits leaked |

### 5.3 Won't ship (explicitly out of scope)

- **Pool-migration analysis (F7)** — Blockchair data doesn't expose per-pool value balances. Future work with a Zebra node.
- Wallet fingerprint lint, standard-denominations ZIP, WebZjs in-browser signing — future work.
- Running our own Zebra node — optional late add-on for "reproducible from a node" credibility; not required.
- Holding keys or auto-signing — never.

## 6. Hard privacy requirements (non-negotiable)

| ID | Requirement | How it's verified |
|---|---|---|
| P1 | User inputs (amounts, times, addresses) never leave the device | Playwright test: after snapshot load, a full check+plan issues **zero** network requests |
| P2 | Every user downloads the identical snapshot file | Snapshot served as a static file; no query params, no per-user variants |
| P3 | No third-party scripts, fonts, analytics or telemetry | CSP `default-src 'self'`; `connect-src` adds only the 1Click API; build-output grep test |
| P4 | User addresses (F4/F8) are compared as hashes, locally; the audit index is downloaded by every visitor, so fetching it reveals nothing | Unit test + `audit.spec` (zero requests while auditing) |
| P5 | 1Click API sees one leg at a time, only when the user clicks Execute | Integration test: no Intents call before click |
| P6 | Keys and seed phrases are never requested or handled | No input fields for them; ZIP-321 hand-off only |
| P7 | Leak Meter publishes aggregates only — no per-tx link lists, no lookup-by-txid. The Personal Audit gives details only for links between the addresses the user enters; for any other address it says that a link exists, never where it leads | Output schema review; unit tests; `verify-audit.mjs` (200 real deposit-only addresses) |
| P8 | Snapshot integrity is verifiable | `manifest.json` with sha256; client verifies before use; rebuild is deterministic |

## 7. Data

### 7.1 Source: Blockchair daily dumps (free, public)

`https://gz.blockchair.com/zcash/{transactions|inputs|outputs}/blockchair_zcash_{table}_YYYYMMDD.tsv.gz`
(~1 MB/day for transactions; history available at least back to June 2026). Values are in zatoshi (1 ZEC = 10⁸ zat).

| File | Columns we use |
|---|---|
| transactions | `block_id, hash, time, version, is_coinbase, input_count, output_count, input_total, output_total, fee, shielded_value_delta` (`\N` = null) |
| inputs | `spending_transaction_hash, recipient` (the t-address that funded a tx), `value` |
| outputs | `transaction_hash, recipient, value, is_from_coinbase` |

Observed data facts (verified in S1):
- `input_total` / `output_total` are `\N` exactly when `input_count` / `output_count` is 0 (222,404 txs checked); normalized to 0.
- Free downloads are ~100 KB/s and **one connection per IP**; a second concurrent request gets HTTP 402. The downloader is sequential and retries 402/429 with backoff.

Ingest sits behind a `DataSource` interface so a `ZebraRpcSource` can be added later without touching anything else.

### 7.2 Event derivation rules (verified in S2; full rationale in [docs/methodology.md](docs/methodology.md))

`shielded_value_delta` is never trusted. Each non-coinbase tx is classified in two steps:

1. **Structure.** `residual = size − exact transparent size` (computed from every scriptSig and script).
   Transparent-only txs have residual exactly 27 (v4), 23 (v5) or 24 (v6); anything above
   `shieldedResidualMin = 200` bytes has shielded components. Without them a tx is never a crossing.
2. **Direction and amount**, for txs with shielded components, where `gap = tIn − tOut`:

| Condition | Event | Amount |
|---|---|---|
| no t-inputs, some t-outputs | **DESHIELD** | `tOut` |
| `gap < 0` | **DESHIELD**, tagged `mixed` | `−gap` |
| `gap > shieldMinZat` (20,000) | **SHIELD** | `gap` (includes fee) |
| otherwise | none (fully shielded, or t-inputs only pay the fee) | — |

Tags: `coinbase` (SHIELD spending a coinbase output), `batch` (DESHIELD with ≥ 3 t-outputs), `mixed`.
Txs missing input/output rows are `INCOMPLETE` (14 in 90 days) and never guessed.

Known limitation: a tx that shields and deshields at once nets out and is under-counted.

### 7.3 Event store (SQLite)

`events(day, txid, height, time, kind, amount, addresses, tags, version, input_count, output_count, source_delta)` + `derive_days` (per-day counts and the config used) + `ingest_days(tbl, day, fingerprint, rows, duplicates)`.
See design doc §5.2.

### 7.4 Snapshot (built in S4)

`turnstile snapshot` writes four files; every client downloads the same ones:

| File | Contents | Size (Jul 1 - Sep 28) |
|---|---|---|
| `snapshot.bin.gz` | Columnar, delta-encoded varints: every shield (time, amount, entity), the service entity ids, every non-batch exit (time, amount) | 787 KB (1,028 KB raw) |
| `addresses.bin` | Sorted 8-byte truncated SHA-256 hashes of every address that funded a shield (domain-separated) | 290 KB |
| `stats.json` | The Leak Meter result (MeterStats) | 9 KB |
| `manifest.json` | Counts, sizes and SHA-256 of each file, plus the SHA-256 of the uncompressed snapshot | 1 KB |

The encoding is canonical (sorted, entities renumbered by first appearance), so the same events always
give the same bytes. The reproducible fingerprint is the hash of the **uncompressed** content, because
gzip output can differ between zlib builds; the compressed file's hash only checks the download. The
manifest carries no timestamp for the same reason. The loader verifies every hash and every count before
using anything.

## 8. Functional requirements

### F1 Leak Meter
- FR1.1 For each DESHIELD in window: candidate SHIELDs with `t_d − W ≤ t_s < t_d` and `0 ≤ a_s − a_d ≤ F_max`.
- FR1.2 Weight candidates by time and amount-gap kernels; compute `n`, `k_eff = exp(entropy)`, `linkable = n==1 || max p > 0.9`.
- FR1.3 Null model: repeat with time-reversed matching (shields *after* the deshield). Report observed, baseline, and difference.
- FR1.4 Output `stats.json`: overall %, daily series, `k_eff` histogram, amount-precision breakdown, batch-payout share.
- FR1.5 CLI `turnstile meter --days 90` prints the headline; web dashboard renders `stats.json`.

### F2 Pre-flight Check
- FR2.1 Inputs: amount (ZEC), planned time (default now), optional destination t-address, optional own entry (amount + date).
- FR2.2 Output: verdict (red / amber / green), `n`, `k_eff`, list of reasons (exact round-trip, rare amount precision, address reuse, weak crowd), and "what would make it green".
- FR2.3 Runs in a Web Worker against the loaded snapshot; p95 < 500 ms.
- FR2.4 Shows the data's date range; warns (amber) when the withdrawal is more than 2 days after the data ends.

### F3 Exit Planner
- FR3.1 Inputs: total, horizon (hours), target `k_min`, max legs.
- FR3.2 Denominations from the snapshot's most common DESHIELD amounts + round numbers.
- FR3.3 Leg times sampled from empirical hour-of-day activity, min gap enforced, seeded RNG (reproducible in tests).
- FR3.4 Each leg re-scored; plan reports before/after; remainder stays shielded.
- FR3.5 Destination-hygiene warning if legs share a final recipient.
- FR3.6 Export `.ics` for local reminders.

### F4 Address-reuse Detector
- FR4.1 Hash user-entered destination locally; check against hashed SHIELD source addresses in snapshot; red flag on hit.

### F6 NEAR Intents Execution
- FR6.1 Adapter for 1Click: token list, dry quote, live quote (deposit address), status.
- FR6.2 On Execute: re-run pre-flight for the leg → live quote → ZIP-321 URI `zcash:<addr>?amount=<x>` + QR → poll status.
- FR6.3 UI discloses before any request: NEAR Intents sees this leg's amount, the recipient, the refund address and the user's IP address; the 0.25% fee without an API key. Refunds default to a shielded unified address (verified accepted in S7); Sapling is refused because NEAR Intents rejects it.

### F9 `@turnstile/core`
- FR9.1 Zero native deps; runs in browser + Node; public API: `loadSnapshot`, `scoreExit`, `planExit`, `meterStats`.
- FR9.2 README with a 10-line wallet integration example.

## 9. Non-functional requirements

| Area | Requirement |
|---|---|
| Correctness | Unit tests for every derivation rule and scoring function; synthetic-chain fixtures |
| Reproducibility | Same input days → byte-identical snapshot (sha256 match) |
| Performance | 90-day ingest < 10 min on a laptop; snapshot load < 3 s on broadband |
| Portability | Runs on Windows (your machine), Linux CI |
| Code quality | TS strict, ESLint, Prettier, CI on every push |
| Licensing | MIT or Apache-2.0; repo public by deadline (rule 03) |

## 10. Architecture (summary)

```
Blockchair dumps ──▶ packages/ingest ──▶ SQLite events ──▶ snapshot builder ──▶ static files (snapshot + manifest + stats.json)
                                                                                         │
                                          user's browser / CLI ◀─────────────────────────┘
                                          @turnstile/core (Web Worker): score · plan · meter
                                                   │ only on "Execute leg"
                                                   ▼
                                          NEAR Intents 1Click API → ZIP-321 QR → user's own wallet
```

```
turnstile/
├─ packages/core        @turnstile/core — codec, matcher, scorer, planner (browser + node)
├─ packages/ingest      DataSource interface, BlockchairDumpSource, event derivation, SQLite, snapshot builder
├─ packages/intents     1Click adapter
├─ apps/cli             turnstile meter | check | plan | ingest | snapshot
├─ apps/web             Vite + React SPA (dashboard, pre-flight, planner, execute)
├─ research/            validation scripts, notebooks
└─ docs/                design, methodology, threat model
```

## 11. Build sections — each must pass before the next starts

**Working agreement:** at the end of each section I run every acceptance check and show you the output.
You confirm, then we move on. A failing check means we fix it in that section — no carrying bugs forward.

| # | Section | Dates | Depends on |
|---|---|---|---|
| S0 | Foundation | Sep 29–30 | — |
| S1 | Data ingestion | Sep 30 – Oct 3 | S0 |
| S2 | Event derivation | Oct 3–6 | S1 |
| S3 | Matcher, scorer & Leak Meter | Oct 6–10 | S2 |
| S4 | Snapshot | Oct 10–12 | S3 |
| S5 | Pre-flight, reuse detector, planner (core + CLI) | Oct 12–16 | S4 |
| S6 | Web app | Oct 16–21 | S5 |
| S7 | NEAR Intents execution | Oct 21–24 | S6 |
| S8 | Should-ship features (F5, F8) — only if on schedule | Oct 24–25 | S7 |
| S9 | Docs, deploy, demo video | Oct 25–27 | S7 |
| S10 | Submit + buffer | Oct 27–28 | S9 |

---

### S0 — Foundation
**Build:** pnpm workspace, TS strict config, Vitest, ESLint/Prettier, tsup, GitHub repo (private until submission), GitHub Actions CI, empty packages with one smoke test each, `LICENSE`, `README` stub.
**Acceptance:**
- [x] `pnpm install && pnpm build && pnpm test` passes locally on Windows
- [x] CI run green on GitHub
- [x] `pnpm lint` passes with zero warnings

### S1 — Data ingestion
**Build:** `DataSource` interface; `BlockchairDumpSource` (download with cache dir, retry, polite rate limit, gzip stream → TSV parser with `\N` handling); SQLite raw tables; `turnstile ingest --from YYYY-MM-DD --to YYYY-MM-DD`; idempotent per day.
**Acceptance:**
- [x] Ingest 2026-09-28: DB row counts == file line counts − 1 for all 3 tables
- [x] Re-running the same day changes nothing (idempotent)
- [x] Full 90-day ingest from the local cache completes in < 10 min; per-day counts table printed
      (the one-time download is throttled by Blockchair to ~100 KB/s and one connection per IP — ~1 h for 90 days)
- [x] Parser unit tests: nulls, big values, malformed line rejected with a clear error

### S2 — Event derivation
**Build:** rules from §7.2; address joins (SHIELD sources from inputs, DESHIELD destinations from outputs); tagging; `turnstile derive` and `turnstile events`.
**Acceptance:**
- [x] Unit tests for every row in the §7.2 table (fixtures built from real mainnet rows)
- [x] 10 random SHIELD and 10 random DESHIELD events checked against a Zcash node (`scripts/verify-events.mjs`) — 20/20 correct
- [x] Report: events/day, batch-payout share, count of txs where `shielded_value_delta` disagrees with ours (the Blockchair finding, reproduced)
- [x] Thresholds (`shieldedResidualMin`, `shieldMinZat`, `batchMinOutputs`) tuned with written justification ([docs/methodology.md](docs/methodology.md))

### S3 — Matcher, scorer & Leak Meter
**Build:** `@turnstile/core` matcher (entities, people vs services, fee-shaped weighting, chance gate, `k_eff`); two coincidence baselines; `stats.json`; `turnstile meter` and `turnstile validate`. Method and results: [docs/methodology.md](docs/methodology.md) sections 6-8.
**Ground truth at $0 (no transactions of our own):**
1. *Natural labels* — mainnet round-trips where the deshield destination equals the shield source address. Addresses are **hidden from the matcher**; we measure recall and precision.
2. *Planted trips* — synthetic round-trips in real mainnet background traffic, amounts from ordinary users: (a) exact amount out after 1h, (b) exact after 24h, (c) round amount after 3h, (d) split into 2 legs.
Labels are computed on the fly and reported as aggregates only (P7).

**Decision (Sep 30):** the original criterion "(a) and (b) linked at ≥ 90%" assumed every exact round trip can be singled out. The data shows 36-37% of them can't: someone else shielded the same amount in the same three weeks, so no amount-and-timing analysis can tell the two apart. Forcing 90% there means guessing, and guessing blames innocent parties (10.1% wrong links without the chance gate). For a privacy tool a false accusation is worse than a miss, so the criterion is restated as safety first, then detection on the trips that are actually identifiable.

**Acceptance:**
- [x] Synthetic-chain unit tests: planted round-trips found, planted noise not (78 tests)
- [x] Safety: no planted trip in (a)-(c) blamed on the wrong entry — 0 of 3,000
- [x] Safety: wrong links on exits whose depositor is absent ((d) split legs) ≤ 5% — 3.95%
- [x] Safety: precision of linkable verdicts on natural labels ≥ 85% — 89.7% (person-funded labels: 55.2%, reported as a known weakness)
- [x] Detection: identifiable planted trips (nobody else used the amount in the prior 3 weeks) linked ≥ 95% — (a) 100% of 641, (b) 100% of 628
- [x] (c) and (d) not linked to their entry — 0% and 0%
- [x] Recall/precision on natural labels reported, overall and for person-funded labels
- [x] Leak Meter compared with both baselines, split into people and services: services +5.99 points beyond chance (precise amounts +15.26); people: nothing measurable beyond chance
- [x] `turnstile meter --days 90` prints headline + baselines in < 60 s (5 s)

### S4 — Snapshot
**Build:** canonical columnar codec in `@turnstile/core` (encode/decode), address-hash side file, manifest with content and file hashes, `turnstile snapshot`; a loader using only Web APIs (crypto.subtle, DecompressionStream) that verifies everything before decoding. Independent check: `scripts/verify-snapshot.mjs`.
**Acceptance:**
- [x] Encode → decode round-trip equality test (unit tests, and on the real snapshot: decode then encode reproduces all 1,052,319 bytes)
- [x] Two builds from the same days → identical sha256 (all four files byte-identical)
- [x] Snapshot ≤ 15 MB; loads in Node and in a headless browser < 3 s (1.06 MB total; Node 337 ms, Chromium 512 ms including fetch, verify, decode and index)
- [x] Tampered file is rejected by the loader (one flipped byte in any file; altered content with a forged file hash; wrong counts)

### S5 — Pre-flight, reuse detector, planner (core + CLI)
**Build:** `preflight` (verdict, reasons, crowd, matched deposit, suggested common amount, data freshness), address-reuse check on locally hashed addresses, `planExit` (seeded; random seed by default so users' schedules don't align), `.ics` export (RFC 5545, folded lines); CLI `turnstile check 3.1742 --at ... --to t1... --deposit ... --deposit-at ...` and `turnstile plan 3.1742 --hours 72`. Both read the verified snapshot bundle, exactly as a browser would. Independent check: `scripts/verify-preflight.mjs`.
**Acceptance:**
- [x] Hypothetical exit that exactly matches a recent real shield amount → red, with reason "exact round-trip" (25 of 25 real identifiable deposits; without the deposit entered, 25 of 25 red "unique-match" naming that exact deposit)
- [x] Destination = a known shielding address → red, "address reuse" (50 of 50; 0 of 50 non-depositing addresses flagged)
- [x] Planner: every leg meets the crowd target (or reports best achievable), legs sum ≤ total, remainder reported, same seed → same plan (12 plans across 4 totals and 3 seeds)
- [x] p95 check time < 500 ms on the full snapshot (0.08 ms)
- [x] Freshness: the data's date range is always shown; a withdrawal more than 2 days after the data ends gets an amber "stale-data" warning, and the crowd is measured over the last full week of data

### S6 — Web app
**Build:** Vite + React SPA (`apps/web`) with a landing page, Pre-flight Check, Exit Planner and Leak Meter dashboard; all analysis in a Web Worker against the verified snapshot; hash routing so any static host works; strict CSP injected at build (`default-src 'none'`, only the 1Click API allowed besides self); self-hosted Inter font, no third-party assets. Design follows the dark-green reference: near-black surfaces, green glow, green pill buttons, glass cards; light theme selected, not inverted. Chart colors validated for colorblind safety in both themes. End-to-end suite: `e2e/` (`pnpm e2e`), 219 tests in Chromium, Firefox and WebKit against a fault-injecting server; every failure mode and its test is listed in [docs/web-test-plan.md](docs/web-test-plan.md).
**Acceptance:**
- [x] Playwright: load app → run check (a real round trip, red) → run plan → download calendar → Leak Meter table and theme switch: **0 network requests after snapshot load** (P1), 0 to any other origin, 0 console errors or CSP violations
- [x] Build-output scan finds no external origins except the allowlist: the 1Click API, github.com links, and two never-fetched identifier strings (www.w3.org SVG namespace, react.dev error text) (P3)
- [x] Works at 375 px width and desktop; light/dark: no horizontal overflow on any page, and the axe accessibility audit reports no serious or critical issues on any page, in either theme, at either size (16 of 16 combinations)
- [x] Router race fixed (Oct 2, found by the S7 run): a navigation right after the first render could be missed; regression test fails without the fix
- [x] Hardening (added Sep 30): load failures (missing, tampered, slow, flaky, crashed engine, in-transit decompression) show a reason and recover with Try again; every input error is explained; TEX (ZIP 320) and checksummed destination addresses; amounts removed from URL and history; nothing stored but the theme; per-page titles and focus; no sideways scrolling from 320 to 1440 px. 219 of 219 e2e tests pass in all three browsers
- [x] Planner never produces legs that add up to the deposit minus fees (found on review; search-based leg choice, unit, e2e and real-data tests)
- [x] Production build verified locally from a clean browser context. **Decision (Sep 30):** the public deploy moves to S9, so the project isn't exposed before judging (submissions are sealed); S9's checks already cover the live URL

### S7 — NEAR Intents execution
**Build:** `@turnstile/intents` (1Click client: dry quote, live quote, status; built-in destinations; recipient checks); core ZIP 321 payment URIs and refund-address validation; CLI `turnstile quote` / `turnstile status`; web Execute panel per leg (disclosure, price, deposit address, QR, status polling, signed-quote download). Independent checks: `scripts/verify-intents.mjs` (live API, no funds) and `e2e/execute.spec.ts`.

**Facts established against the live API (Oct 2, 2026):**
- ZEC deposit addresses are **one-time transparent t1 addresses** (checksum-verified by Turnstile). Paying one from a shielded wallet is a withdrawal from the pool, which is exactly what Turnstile plans.
- Refund addresses: **unified (u1, including Orchard-only), t1, t3 and tex1 are accepted; Sapling (zs) is rejected** ("refundTo is not valid"). Turnstile refuses Sapling up front and recommends a fresh unified address so refunds stay shielded.
- The API allows browser calls (`Access-Control-Allow-Origin: *`), so the page calls it directly: no proxy that could log anything.
- No API key: a static site can't keep one secret. NEAR Intents then adds 0.25%, which the UI and CLI disclose.
- Requested deadlines of 3 hours come back as about 3 days for ZEC; the UI shows the deadline returned.

**Acceptance:**
- [x] Dry quote for ZEC → USDC returns successfully from CLI (and a dry quote to each of the 8 built-in destinations)
- [x] Confirm and document: ZEC deposit address type; `refundTo` accepted formats (above)
- [x] Playwright: no Intents request before clicking Execute, nor before asking for a price; invalid recipients and Sapling refunds are refused with zero requests (P5)
- [x] Live quote returns a real deposit address; ZIP-321 URI + QR render; status polling shows "waiting for deposit" ($0, nothing is paid). Live from the CLI and the acceptance script; the browser flow against a mocked API in Chromium, Firefox and WebKit; a real dry quote from the page in all three browsers (`LIVE_INTENTS=1`)
- [ ] *Optional, only if someone donates a small amount:* one real leg reaches SUCCESS

### S8 — Should-ship (conditional)
Only if S0–S7 are done by Oct 24 (they were done by Oct 3). F5 Entry Planner and F8 Personal Audit, each with its own tests.

**Build:** core `planEntry` (F5) and `auditAddresses` with the `audit.bin.gz` index (F8): every address, hashed, mapped to the deposits it funded and the withdrawals it received; pinned in the manifest, canonical and reproducible, downloaded by every visitor in the background after the tools are ready. CLI `turnstile enter` and `turnstile audit`; web pages Entry Planner (`#/enter`) and Personal Audit (`#/audit`). Independent checks: `scripts/verify-entry.mjs`, `scripts/verify-audit.mjs`, `e2e/enter.spec.ts`, `e2e/audit.spec.ts`.

**Found while building S8, and fixed in the Pre-flight Check (S5) too:** timing leaks on its own. In the F5 backtest, a withdrawal an hour after a deposit of a *common* amount was the observer's single best guess 84.9% of the time (after a day 10.8%, after three days 3.5%). The matcher rightly refuses to *link* such a withdrawal, but the Check called it green. The Check and the audit now add an amber "Closest in time" reason when the user's own deposit would be the observer's best guess.

**Decision (Oct 3):** the first design recommended up to three common deposits; the backtest showed it moved only 22.8% of balances into the pool, and several deposits from one address can be summed back up. The Entry Planner instead offers (1) deposit everything and leave through the Exit Planner, whose legs never add up to the deposit, and (2) for someone who will withdraw everything at once, one common deposit, plus a waiting rule backed by the measured timing figures.

**Acceptance:**
- [x] F5 unit tests: unique, thin and common amounts; a common amount never exceeds the balance with its fee; stale data; amounts that can't pay a fee
- [x] F5 backtest on mainnet (600 planted precise deposits): as-is, identifiable exact round trips linked 100% (429 of 429); with the common amount or the Exit Planner, 0% linked at 1 hour, 1 day and 3 days; best guess after 3 days 3.5% and 0.0%, within 1 in 10
- [x] F8 index: canonical, byte-identical on rebuild; altered byte refused; 1,000 of 1,000 sampled real deposits and withdrawals found from their address; existing snapshot files unchanged
- [x] F8 agrees with the matcher on natural labels: 177 of 177 same-address round trips it links are reported traced
- [x] F8 discloses nothing about other people's money: 200 real deposit-only addresses yield no withdrawal amount, time or address (unit tests check the same for both directions)
- [x] F8 speed: p95 under 500 ms per address on real data (226 ms on the label sample)
- [x] Web: both pages in Chromium, Firefox and WebKit; zero requests while auditing; altered audit file refused while the other tools keep working; accessibility; no sideways scrolling at 320 px. Full suite: 298 of 298 e2e tests pass in three browsers (3 live NEAR Intents tests skipped by default)
- [x] Speed: every tool answers in under 1 s in every browser, measured inside the page (13 to 110 ms); the common amounts are now computed right after the data loads instead of on the first click

### S9 — Docs, deploy, demo
**Build:** README (what/why/how-to-run in 3 commands), `docs/methodology.md` (derivation, matcher, null model, limitations, Blockchair finding), `docs/threat-model.md`, `@turnstile/core` README with integration example; production deploy (GitHub Pages or Cloudflare Pages, no analytics); **daily data update**: a scheduled GitHub Actions job that ingests the newest Blockchair day (cached between runs), rebuilds the rolling 90-day snapshot and republishes it; 3-minute demo video following §3's demo moment.
**Acceptance:**
- [ ] Fresh clone on a clean machine → README steps work end to end
- [ ] Live URL passes the S6 Playwright suite
- [ ] Daily update job runs on schedule and the live snapshot is never more than 1 day behind Blockchair
- [ ] Video ≤ 3 min, uploaded, linked in README

### S10 — Submit
- [ ] Repo made public (rule 03)
- [ ] Submission entered in **Cross-Chain** only (rule 04), from the registered account (rule 01)
- [ ] All code dated within Sep 28 – Oct 28 (rule 02); libraries only, no pre-existing product
- [ ] Submitted by **Oct 27** (a day of buffer before Oct 28 23:59 UTC); edits allowed until deadline (rule 05)

## 12. Budget

**Total: $0.**

| Item | Cost |
|---|---|
| Data (Blockchair dumps) | $0 |
| Ground truth (natural labels + planted trips) | $0 |
| NEAR Intents (dry + live quotes, no payment) | $0 |
| Hosting (GitHub Pages / Cloudflare Pages) | $0 |
| Optional: testnet transaction for the video (faucet coins) | $0 |

## 13. Risks

| Risk | Mitigation |
|---|---|
| Blockchair dumps throttled/unavailable | Local cache of every day downloaded; `DataSource` swap to hosted RPC or Zebra |
| Derivation rules misclassify some tx shapes | S2 hand-checks + explicit limitations section |
| Leak rate turns out low | Still a valid, novel measurement; pitch shifts to prevention + address reuse + the Blockchair finding |
| 1Click minimums/route issues for ZEC | Adapter is thin; ZIP-321 QR + dry quote still demonstrate the flow |
| Solo schedule slip | Sections are ordered so any cut still leaves a working product: S0–S6 alone is submittable |

## 14. Success metrics (for the submission)

- Headline Leak Meter number with baseline, reproducible from public data by anyone
- Planted trips detected as expected; recall/precision reported on natural (same-address) labels
- Zero-request privacy test passing on the live URL
- Full cross-chain flow demonstrated up to payment (live quote → ZIP-321 QR → status)
- Every section's acceptance checklist ticked
