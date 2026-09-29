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
4. **Ours (new, found Sep 29):** Blockchair's `shielded_value_delta` is wrong (reports 0) for ~1,488 of 7,186
   non-coinbase txs on Sep 28, 2026 — mostly v6 transactions. Ecosystem tooling under-reports shielded flows;
   Turnstile derives them correctly from the transparent side.

## 3. How we win — mapping to judging criteria

| Criterion (as published) | What the judges must see | Where it's delivered |
|---|---|---|
| **Privacy** — "does it actually preserve privacy… leaks are disqualifying" | Our tool finds a real leak **and** leaks nothing itself: all user checks run locally, zero network requests during a check, no telemetry, no keys handled | S5, S6 (automated "zero requests" test), threat model |
| **Usefulness** — "would someone use this on Monday" | A person about to swap ZEC opens the web app, gets a red/green verdict and a plan in < 1 min | S5, S6, S7 |
| **Execution** — "does it run. Working beats ambitious" | Live public URL, one-command CLI, CI green, every section verified, real mainnet swap in the demo | Every section's acceptance tests |
| **Originality** — "built for this hackathon" | Novel mainnet measurement + method + fix; no one else will have the number | S3, methodology doc |

**The demo moment:** "X% of Zcash exits last month were linkable. Here's a withdrawal I'm about to make —
Turnstile flags it red. Here's the plan that turns it green. Here's the first leg getting a live NEAR Intents
deposit address and a QR for my own wallet. And during all of this, the network tab shows nothing left my browser."

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
| P4 | User addresses (F4/F8) are compared as hashes, locally | Unit test + code review |
| P5 | 1Click API sees one leg at a time, only when the user clicks Execute | Integration test: no Intents call before click |
| P6 | Keys and seed phrases are never requested or handled | No input fields for them; ZIP-321 hand-off only |
| P7 | Leak Meter publishes aggregates only — no per-tx link lists, no lookup-by-txid | Output schema review |
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

### 7.2 Event derivation rules (from the transparent side — does not trust `shielded_value_delta`)

For each non-coinbase tx: `tIn = input_total` (0 if `\N`), `tOut = output_total`, `gap = tIn − tOut`,
`feeMax = 5000 × max(2, input_count, output_count)` (ZIP-317 upper bound for transparent-only shape; tune in S2).

| Condition | Event | Amount |
|---|---|---|
| `gap > feeMax` | **SHIELD** | `gap − fee_recorded` (± fee tolerance in matcher) |
| `gap < 0` | **DESHIELD** | `−gap` (= `tOut` when there are no t-inputs) |
| `|gap| ≤ feeMax` | transparent-only / fully shielded → ignored | — |
| `output_count ≥ BATCH_N` and no t-inputs | DESHIELD tagged `batch_payout` (e.g. mining pools), excluded from user matching, reported separately | — |

Known limitation (documented): a tx that shields and deshields simultaneously nets out and is under-counted.

### 7.3 Event store (SQLite)

`events(txid, height, time, kind, amount_zat, fee_recorded, t_addrs_json, version, tags)` + `ingest_days(day, sha256, rows)`.
See design doc §5.2.

### 7.4 Snapshot

Last 90 days of non-batch SHIELD/DESHIELD events, columnar + delta-encoded + gzip, addresses as salted-constant
hashes in a separate optional file. `manifest.json` = `{fromDay, toDay, eventCount, sha256, codecVersion, createdAt}`.
Target ≤ 15 MB.

## 8. Functional requirements

### F1 Leak Meter
- FR1.1 For each DESHIELD in window: candidate SHIELDs with `t_d − W ≤ t_s < t_d` and `0 ≤ a_s − a_d ≤ F_max`.
- FR1.2 Weight candidates by time and amount-gap kernels; compute `n`, `k_eff = exp(entropy)`, `linkable = n==1 || max p > 0.9`.
- FR1.3 Null model: repeat with time-reversed matching (shields *after* the deshield). Report observed, baseline, and difference.
- FR1.4 Output `stats.json`: overall %, daily series, `k_eff` histogram, amount-precision breakdown, batch-payout share.
- FR1.5 CLI `turnstile meter --days 90` prints the headline; web dashboard renders `stats.json`.

### F2 Pre-flight Check
- FR2.1 Inputs: amount (ZEC), planned time (default now), optional destination t-address, optional own entry (amount + date).
- FR2.2 Output: verdict (🔴/🟡/🟢), `n`, `k_eff`, list of reasons (exact round-trip, rare amount precision, address reuse, weak crowd), and "what would make it green".
- FR2.3 Runs in a Web Worker against the loaded snapshot; p95 < 500 ms.

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
- FR6.3 UI discloses: 1Click sees this leg's amount; refunds may return via transparent address (verify `refundTo` support in S7).

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
You confirm ✅, then we move on. A failing check means we fix it in that section — no carrying bugs forward.

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
**Build:** rules from §7.2; address joins (SHIELD sources from inputs, DESHIELD destinations from outputs); batch-payout tagging; `turnstile events --day` summary.
**Acceptance:**
- [ ] Unit tests for every row in the §7.2 table (fixtures built from real Sep 28 rows)
- [ ] 10 random SHIELD and 10 random DESHIELD events hand-checked against a block explorer — all correct
- [ ] Report: events/day, batch-payout share, count of txs where `shielded_value_delta` disagrees with ours (the Blockchair finding, reproduced)
- [ ] `feeMax` and `BATCH_N` tuned with a short written justification

### S3 — Matcher, scorer & Leak Meter
**Build:** `@turnstile/core` matcher + kernels + `k_eff`; null model; `stats.json`; `turnstile meter`.
**Ground truth at $0 (no transactions of our own):**
1. *Natural labels* — mainnet round-trips where the deshield destination equals the shield source address
   (same person with near certainty). Addresses are **hidden from the matcher**; we measure how many it
   recovers from amount + timing alone (recall) and how often it points at the wrong shield (precision).
2. *Planted trips* — inject synthetic round-trips into real mainnet background traffic:
   (a) exact amount out after 1h, (b) exact after 24h, (c) round amount after 3h, (d) split into 2 legs.
Labels stay in `research/` outputs as aggregates only (P7) — no per-tx lists committed.
**Acceptance:**
- [ ] Synthetic-chain unit tests: planted round-trips found, planted noise not
- [ ] Planted (a) and (b) scored linkable at ≥ 90%; (c) and (d) mostly not uniquely linkable
- [ ] Recall/precision on natural labels reported
- [ ] Observed linkable % is materially above null baseline (or, if not, we write that up honestly and adjust the pitch)
- [ ] `turnstile meter --days 90` prints headline + baseline in < 60 s

### S4 — Snapshot
**Build:** columnar codec (encode/decode), address-hash side file, manifest with sha256, `turnstile snapshot`; browser-compatible loader that verifies the hash.
**Acceptance:**
- [ ] Encode → decode round-trip equality test
- [ ] Two builds from the same days → identical sha256
- [ ] Snapshot ≤ 15 MB; loads in Node and in a headless browser < 3 s
- [ ] Tampered file is rejected by the loader

### S5 — Pre-flight, reuse detector, planner (core + CLI)
**Build:** `scoreExit`, address-reuse check, `planExit` (seeded), `.ics` export; CLI `turnstile check 3.1742 --at ... --to t1...`, `turnstile plan 3.1742 --hours 72 --k 50`.
**Acceptance:**
- [ ] Hypothetical exit that exactly matches a recent real shield amount → 🔴 with reason "exact round-trip"
- [ ] Destination = a known shielding address → 🔴 "address reuse"
- [ ] Planner: every leg ≥ `k_min` (or reports best achievable), legs sum ≤ total, remainder reported, same seed → same plan
- [ ] p95 `scoreExit` < 500 ms on full snapshot

### S6 — Web app
**Build:** Vite + React SPA; pages: Leak Meter dashboard, Pre-flight, Planner, (Execute placeholder); core runs in a Web Worker; strict CSP; no third-party assets.
**Acceptance:**
- [ ] Playwright: load app → run check → run plan → **zero network requests after snapshot load** (P1)
- [ ] Build-output scan finds no external URLs except the 1Click origin (P3)
- [ ] Works at 375 px width and desktop; light/dark
- [ ] Deployed preview URL works from a clean browser

### S7 — NEAR Intents execution
**Build:** `packages/intents` (tokens, dry quote, live quote, status); Execute flow per FR6.2; ZIP-321 QR; status polling; disclosure copy.
**Acceptance:**
- [ ] Dry quote for ZEC → USDC returns successfully from CLI
- [ ] Confirm and document: ZEC deposit address type; `refundTo` accepted formats
- [ ] Playwright: no Intents request before clicking Execute (P5)
- [ ] Live quote returns a real deposit address; ZIP-321 URI + QR render; status polling shows "waiting for deposit" ($0 — nothing is paid)
- [ ] *Optional, only if someone donates a small amount:* one real leg reaches SUCCESS

### S8 — Should-ship (conditional)
Only if S0–S7 are done by Oct 24. F5 Entry Planner and/or F8 Personal Audit, each with its own tests.

### S9 — Docs, deploy, demo
**Build:** README (what/why/how-to-run in 3 commands), `docs/methodology.md` (derivation, matcher, null model, limitations, Blockchair finding), `docs/threat-model.md`, `@turnstile/core` README with integration example; production deploy (GitHub Pages or Cloudflare Pages, no analytics); 3-minute demo video following §3's demo moment.
**Acceptance:**
- [ ] Fresh clone on a clean machine → README steps work end to end
- [ ] Live URL passes the S6 Playwright suite
- [ ] Video ≤ 3 min, uploaded, linked in README

### S10 — Submit
- [ ] Repo made public (rule 03)
- [ ] Submission entered in **Cross-Chain** only (rule 04), from the registered account (rule 01)
- [ ] All code dated within Sep 28 – Oct 28 (rule 02); libraries only, no pre-existing product
- [ ] Submitted by **Oct 27** (a day of buffer before Oct 28 23:59 UTC); edits allowed until deadline (rule 05)

## 12. Budget

| Item | Cost |
|---|---|
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
