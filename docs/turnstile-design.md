# Turnstile — Design & Implementation Plan

> Zcash's shielded pool hides you inside, but its entrance and exit are public.
> Turnstile measures how badly that leaks, warns you before you leak, and plans your exit so you blend in.

- **Track:** Cross-Chain (eligible for Grand Prize)
- **Language:** TypeScript end to end (Node for data ingestion, browser + CLI for user-facing tools)
- **Status:** Design — nothing built yet

---

## 1. Problem statement

Every transaction that moves value between the transparent world and a shielded pool publishes the
**amount** and **time** of that crossing (the `valueBalance` field — required so consensus can check
no money is created). Most users must cross:

- **Entry:** exchanges withdraw to transparent `t1…` addresses → user shields.
- **Exit:** swaps (NEAR Intents, exchanges) take ZEC from a transparent deposit address → user deshields.

When the exit amount/time matches the entry amount/time, the two are trivially linkable
(Quesnelle 2017, *On the linkability of Zcash transactions*). The user sees a shield icon and believes
they are private. No wallet warns them.

Related leaks that follow the same pattern:

| Leak | What's public | Example |
|---|---|---|
| Round-trip | Shield amount ≈ deshield amount, close in time | 3.1742 in at 14:05, 3.1742 − fee out at 17:30 |
| Address reuse | Deshield goes back to the same t-address that shielded | Shield from `t1abc`, deshield to `t1abc` |
| Pool migration | Moving Sapling → Orchard publishes both pools' `valueBalance` | Sapling −5.2, Orchard +5.2 in one tx |
| Split re-linking | User splits exit but all pieces go to the same destination | 3 legs → same ETH address |
| Wallet fingerprint | Tx shape (action count, fee, expiry delta, version) narrows the crowd | Only 2% of txs use this shape |

## 2. Goals & non-goals

**Goals**
1. Quantify, with real mainnet data, how linkable boundary crossings are (network-wide).
2. Give an individual a local, private, pre-flight linkability score for a planned exit/entry.
3. Produce an exit plan (amounts, timing, destinations) that meets a target anonymity set, and help execute it.
4. Ship as an embeddable TS library so real wallets can adopt it.

**Non-goals (for the hackathon)**
- Holding user keys or auto-signing transactions (security + custody risk; see §7 stretch).
- Network-level privacy (IP ↔ lightwalletd). We recommend Tor; we don't build it.
- Publishing per-transaction deanonymization results (see §9 ethics).

## 3. Feature set

### Core (MVP — must ship)

| # | Feature | What it does |
|---|---|---|
| F1 | **Leak Meter** | Public dashboard: % of deshields in the last N days that are uniquely/near-uniquely linkable to a shield. Daily trend, per-pool breakdown. Aggregates only. |
| F2 | **Pre-flight Check** | User enters planned amount (+ optional time, destination). Runs locally against a downloaded snapshot. Returns anonymity set size, top risk reasons, verdict. |
| F3 | **Exit Planner** | Decomposes amount into common denominations with randomized, activity-shaped timing; simulates each leg's anonymity set; keeps remainder shielded. |
| F4 | **Address-reuse detector** | Flags deshielding to any t-address that previously shielded (or that is a known exchange deposit address the user supplied). |

### Strong additions (high value, moderate effort)

| # | Feature | Why it matters |
|---|---|---|
| F5 | **Entry Planner** | Same idea on the way *in*: advise shielding round amounts and leaving dust transparent, so the entry doesn't become a unique fingerprint for a later exit. Half of every round-trip leak is created at entry. |
| F6 | **NEAR Intents exit execution** | For each leg: request a 1Click quote at execution time, show the one-time deposit address, generate a ZIP-321 payment URI/QR the user pays from any shielded wallet, then track status. Warns if all legs pay out to the same destination address. |
| F7 | **Pool-migration planner** | Sapling→Orchard moves leak amounts too. Same decomposition logic applied to cross-pool transfers. |
| F8 | **Personal history audit** | User pastes their own t-addresses (already public). Tool lists past crossings from those addresses that were linkable. "You leaked on 3 of 5 exits." |
| F9 | **`@turnstile/core` SDK** | Pure-TS, dependency-light package any wallet (ZODL, Zingo, WebZjs web wallet, MetaMask snap) can embed to show the pre-flight warning. This is the real-world adoption path. |

### Stretch (only if ahead of schedule)

| # | Feature | Notes |
|---|---|---|
| S1 | **Wallet fingerprint lint** | Distribution of tx shapes on chain; warn when your wallet's shape is rare. |
| S2 | **Standard denominations proposal** | Publish a Schelling-point set of exit amounts (e.g. 0.1 / 0.5 / 1 / 5 / 10 ZEC) — if wallets adopt it, everyone's exits blend with no coordinator. Write as a draft ZIP. |
| S3 | **Scheduled execution via WebZjs** | Browser wallet integration that executes planned legs using PCZT (partially constructed transactions) so the user still signs. |
| S4 | **Split-linking (subset-sum) analysis** | Detect exits that sum to one entry (e.g. 2 + 1.1742 = 3.1742). Bounded to k=2–3 legs. |

## 4. System architecture

```
                 ┌──────────────────────── OUR INFRASTRUCTURE (public data only) ───────────────────────┐
                 │                                                                                       │
  Zcash mainnet  │  ┌──────────┐  JSON-RPC  ┌────────────┐   ┌──────────────┐   ┌─────────────────────┐  │
  ───────────────┼─▶│  Zebra   │──────────▶│  Ingestor  │──▶│  Event store │──▶│ Snapshot builder     │  │
                 │  │  node    │ getblock  │  (Node/TS) │   │ (SQLite)     │   │ + Leak Meter stats   │  │
                 │  └──────────┘ verb. 2   └────────────┘   └──────────────┘   └──────────┬──────────┘  │
                 │                                                                        │ signed,     │
                 └────────────────────────────────────────────────────────────────────────┼─────────────┘
                                                                                          │ content-hashed
                                                                    static hosting (GitHub Releases / CDN / IPFS)
                                                                                          │
                 ┌────────────────────────── USER'S DEVICE (private data never leaves) ───┼─────────────┐
                 │                                                                        ▼             │
                 │   ┌───────────────┐        ┌─────────────────────────────────────────────────────┐   │
                 │   │ Web app (SPA) │───────▶│ @turnstile/core  (in a Web Worker / Node process)   │   │
                 │   │ or CLI        │        │  • snapshot loader + verifier                       │   │
                 │   └───────┬───────┘        │  • matcher / anonymity scorer                       │   │
                 │           │                │  • exit & entry planner                             │   │
                 │           │                └─────────────────────────────────────────────────────┘   │
                 │           │ only at execution time, per leg                                          │
                 └───────────┼──────────────────────────────────────────────────────────────────────────┘
                             ▼
                  NEAR Intents 1Click API  ──▶  one-time ZEC deposit address  ──▶  user pays via ZIP-321 URI
```

**Core privacy principle: download everything, query nothing.** The user's planned amount is the secret.
If the client asked a server "is 3.1742 risky?", the server would learn it. Instead the client downloads the
entire public snapshot (the same file for every user) and computes locally. This is the trivial form of
private information retrieval, and it's affordable because the data is small (estimate below).

### 4.1 Components

| Component | Tech | Responsibility |
|---|---|---|
| **Zebra node** | `zebrad` (Rust, run as-is) | Source of truth. Needs to be fully synced — start on day 1. |
| **`zcash-rpc`** | TS, `undici`/fetch | Typed JSON-RPC client: `getblockchaininfo`, `getblockhash`, `getblock` (verbosity 2), `getrawtransaction` (verbose). Retries, batching, concurrency limit. |
| **Ingestor** | Node 20+, TS | Walks blocks from start height to tip, extracts boundary events, writes to the store; checkpoints; handles reorgs. |
| **Event store** | SQLite via `better-sqlite3` | Append-only table of boundary events + ingest checkpoint. DuckDB optional for ad-hoc analytics. |
| **Snapshot builder** | TS | Emits a compact, columnar, compressed snapshot of the last N days + stats JSON; signs + hashes it. |
| **`@turnstile/core`** | Pure TS, zero native deps | Matching, scoring, planning. Runs identically in browser and Node. The heart of the product. |
| **Web app** | Vite + React (static SPA) | Leak Meter dashboard, Pre-flight, Planner, Execution checklist. No backend. |
| **CLI** | Node, `commander` | `turnstile check`, `turnstile plan`, `turnstile audit`, `turnstile meter`. For power users + judges. |
| **Intents adapter** | TS | 1Click API client: tokens, quote, status. Isolated so it's the only module that talks to a third party. |

### 4.2 Monorepo layout

```
turnstile/
├─ packages/
│  ├─ core/            # @turnstile/core — matcher, scorer, planner, snapshot codec (browser+node)
│  ├─ zcash-rpc/       # typed Zebra JSON-RPC client
│  ├─ ingest/          # block walker, event extractor, SQLite store
│  └─ intents/         # NEAR Intents 1Click adapter
├─ apps/
│  ├─ web/             # Vite + React SPA
│  └─ cli/             # turnstile CLI
├─ research/           # notebooks/scripts for the Leak Meter methodology + validation
├─ docs/               # this doc, methodology write-up, threat model
└─ pnpm-workspace.yaml
```

Tooling: pnpm workspaces, TypeScript strict, Vitest, tsup (package builds), ESLint + Prettier, GitHub Actions CI.

## 5. Data model

### 5.1 Extracting boundary events from a transaction

For each transaction, the public fields that matter:

- `valueBalanceZat` (Sapling), `orchard.valueBalanceZat` (Orchard), `vjoinsplit[].vpub_old/new` (Sprout, legacy)
- transparent `vin` (prevout refs) and `vout` (value, address)

Sign convention: a pool's valueBalance is **positive when value leaves the pool** and **negative when it enters**.

```
netPoolFlow = saplingVB + orchardVB + sproutVpubNew − sproutVpubOld
```

| Case | Classification | Boundary amount |
|---|---|---|
| netPoolFlow < 0 | **SHIELD** (value entered shielded pools) | `−netPoolFlow` — exact, no fee math needed |
| netPoolFlow > 0 and tx has transparent outputs | **DESHIELD** | `Σ vout` (the amount that reached transparent addresses); fee = netPoolFlow − Σvout when no t-inputs |
| netPoolFlow > 0, no transparent outputs | fully-shielded tx (flow = fee only) | not a crossing; ignore |
| saplingVB and orchardVB have opposite signs | **POOL_MIGRATION** (also record) | `min(|saplingVB|, |orchardVB|)` |
| coinbase tx | tag `coinbase`, excluded from user-facing matching | — |

Note: Zebra's `getblock` verbosity 2 does not include prevout values/fees (verbosity 3 is an open feature
request), but we **don't need them** for amounts — valueBalance already gives the exact crossing. Prevouts are
only needed for F4/F8 (which t-address shielded), resolved lazily via `getrawtransaction`.

### 5.2 Tables

```sql
CREATE TABLE events (
  txid          TEXT    NOT NULL,
  height        INTEGER NOT NULL,
  time          INTEGER NOT NULL,          -- block time (unix)
  kind          TEXT    NOT NULL,          -- SHIELD | DESHIELD | POOL_MIGRATION
  pool          TEXT    NOT NULL,          -- sapling | orchard | sprout | mixed
  amount_zat    INTEGER NOT NULL,
  fee_zat       INTEGER,                   -- when derivable
  t_addrs       TEXT,                      -- JSON array: source addrs (SHIELD) or dest addrs (DESHIELD)
  shape         TEXT,                      -- fingerprint: version|nActions|nSapOut|nTin|nTout|expiryDelta
  is_coinbase   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (txid, kind)
);
CREATE INDEX events_kind_time   ON events(kind, time);
CREATE INDEX events_kind_amount ON events(kind, amount_zat);

CREATE TABLE ingest_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tip_height INTEGER, tip_hash TEXT
);
```

### 5.3 Snapshot format

- Window: last 90 days of SHIELD/DESHIELD/POOL_MIGRATION events (non-coinbase).
- Columnar arrays (`time[]`, `amount[]`, `kind[]`, `shape_id[]`) delta-encoded → gzip/brotli.
- Addresses included as hashed IDs only for F4/F8 matching (user's address hashed client-side the same way).
- Size estimate: ~20–40 bytes/event compressed; even 500k events ≈ 10–20 MB. **Measure in week 1**; if too large,
  drop addresses into a separate optional file.
- `manifest.json`: `{ fromHeight, toHeight, tipHash, sha256, eventCount, createdAt, signature }`.
  Anyone running Zebra can rebuild the snapshot with our ingestor and compare hashes → **verifiable, not trusted**.

## 6. Algorithms

### 6.1 Candidate matching (the adversary's view)

For a deshield `d` (amount `a_d`, time `t_d`), candidate shields `s` are:

```
t_d − W ≤ t_s < t_d                          # time window, W default 7 days
0 ≤ a_s − a_d ≤ F_max                        # shield ≥ deshield by at most accumulated fees
```

`F_max` covers fees from a few intermediate shielded txs (ZIP-317 marginal fee is 5,000 zat per logical
action; start with F_max = 100,000 zat and tune from data).

Each candidate gets a weight:

```
w(s) = K_time(t_d − t_s) × K_amount(a_s − a_d)
```

- `K_time`: decays with delay (fit to empirical distribution of confirmed round-trips from our validation set).
- `K_amount`: peaked near typical fee values; exact-minus-standard-fee matches weigh most.

Metrics per deshield:
- **Candidate count** `n`
- **Effective anonymity set** `k_eff = exp(H)`, `H = −Σ p_i ln p_i`, `p_i = w_i / Σw`
- **Linkable** if `n = 1` or `max p_i > 0.9`

Amount entropy matters: 1.0 ZEC has many candidates; 3.17420381 has almost none. The scorer naturally captures this.

### 6.2 Leak Meter (F1)

For every deshield in the window: compute `n`, `k_eff`, linkable flag. Publish:
- % linkable, histogram of `k_eff`, by pool, by day
- **Null model** (to prove it's real, not coincidence): shuffle deshield timestamps / shift window into the
  future (matching deshields to *later* shields, which can't be causal). The linkable rate under the null
  is the false-positive baseline. Report `observed − baseline`. This rigor is what separates us from a toy.

### 6.3 Pre-flight (F2)

Same scorer, but for a *hypothetical* deshield `(a, t_planned)` against the snapshot, plus rule checks:

| Check | Output |
|---|---|
| k_eff < 5 | 🔴 "Uniquely linkable" |
| amount has > 3 significant decimals and matches a recent shield | 🔴 "Exact round-trip" |
| destination ∈ addresses that shielded | 🔴 "Address reuse" |
| k_eff 5–50 | 🟡 "Weak crowd" |
| k_eff > 50 | 🟢 |

The user may optionally supply *their own* entry (amount/time) so the tool shows "you, specifically, would be
picked out". All local.

### 6.4 Exit Planner (F3)

Input: total `A`, horizon `H` (e.g. 72h), target `k_min`, max legs `L`.

1. Build denomination set `D` from the last 30 days' most frequent deshield amounts (plus round numbers).
2. Greedy/DP decomposition of `A` into ≤ `L` legs from `D`; remainder `< min(D)` stays shielded.
3. For each leg, sample a send time from the empirical hour-of-day activity distribution within `H`,
   enforcing a minimum gap and jitter.
4. Simulate each leg against the snapshot (as if it happened at that time) → per-leg `k_eff`.
5. Reject/resample until all legs ≥ `k_min` or report best achievable.
6. Destination hygiene: each leg must use a fresh destination; flag if the user's final recipient is shared.

Output: a plan table, before/after score, and an `.ics` calendar export (local reminders, no server).

### 6.5 Validation (ground truth)

- Perform ~10 controlled round-trips ourselves on mainnet with small amounts (various delays, exact vs round
  amounts) and confirm the matcher flags the exact ones and misses the planned ones.
- Unit tests with synthetic chains in Vitest.
- Rebuild snapshot twice from scratch → identical hash (determinism).

## 7. Execution flow with NEAR Intents (F6)

```
User plan leg i (e.g. 1.5 ZEC → USDC on Base, at 14:37 tomorrow)
  │  at scheduled time, user clicks "Execute leg"
  ▼
intents.quote({ originAsset: ZEC, destinationAsset, amount, recipient, refundTo })
  │  → one-time ZEC deposit address + expected output + deadline (ZEC gets a ~2h window)
  ▼
Pre-flight re-check leg against latest snapshot  ──(red?)──▶ suggest delay
  ▼
Generate ZIP-321 URI  zcash:<depositAddr>?amount=1.5  → QR code
  │  user pays from their shielded wallet (ZODL, Zingo, …) — we never touch keys
  ▼
intents.status(depositAddr) polling → SUCCESS / REFUNDED
```

Honest caveats (shown in UI):
- The 1Click API learns each leg's amount — inherent to using any swap service. We only request quotes at
  execution time, one leg at a time, so it never sees the full plan.
- Verify during week 1 whether 1Click ZEC deposit addresses are transparent (we expect so) and whether `refundTo`
  can be a shielded/unified address; if not, refunds re-enter via a transparent address and must be flagged.
- Destination-side linking (same ETH address for all legs) defeats splitting; the planner warns.

Stretch S3: replace the QR step with a WebZjs/PCZT flow so the web app builds the tx and the user signs.

## 8. Threat model

**Adversary:** chain analytics firm, exchange, or state actor that sees all public chain data, possibly KYC data
at exchanges, and possibly the swap provider's logs.

| Asset to protect | Where it could leak | Mitigation |
|---|---|---|
| Planned amount/time | Querying a server | Download-everything snapshot; all compute local |
| User's interest in Turnstile | Snapshot download | Same file for all users; mirror on IPFS; Tor-friendly |
| User's t-addresses (F4/F8) | Uploading them | Hashed and compared locally only |
| Leg amounts | 1Click API | Per-leg, just-in-time quotes; disclosed in UI |
| Keys | Any integration | Never handled (ZIP-321 hand-off); S3 uses PCZT with user signing |
| Snapshot integrity | Malicious host | Signed manifest + reproducible build from own Zebra node |
| Web app itself | Analytics/telemetry | Zero third-party scripts, no telemetry, CSP locked to self + 1Click |

## 9. Ethics & responsible publication

The Leak Meter is, by construction, a deanonymization heuristic. We:
- Publish **aggregates only** — never per-tx link lists or a lookup-by-txid tool.
- Frame results as a call for wallet-level fixes, and ship the fix (planner + SDK) alongside the measurement.
- Share methodology with wallet teams before/at submission.

This framing matters to judges: "we found the leak and built the fix" vs "we built a surveillance tool".

## 10. Implementation plan (30-day build window)

| Week | Deliverables | Exit criteria |
|---|---|---|
| **0 (before window)** | Read ZIP-317/ZIP-321, 1Click docs; provision a VPS/disk; start Zebra sync (code written in-window only — setup is fine) | Node syncing |
| **1 — Data** | Monorepo scaffold, `zcash-rpc`, ingestor + event extraction, SQLite store, reorg handling, first 90-day backfill. Verify 1Click ZEC address types. | Event counts per day look sane vs explorer spot-checks |
| **2 — Science** | `@turnstile/core` matcher + scorer, null model, Leak Meter numbers, controlled mainnet round-trips for validation, snapshot builder | Headline stat computed with a baseline; validation txs detected correctly |
| **3 — Product** | Web app: Leak Meter dashboard, Pre-flight, Exit Planner, Address-reuse check; CLI parity | End-to-end local check on a real snapshot in the browser |
| **4 — Cross-chain + polish** | Intents adapter + execution checklist with ZIP-321 QR, Entry Planner, docs, threat model, methodology write-up, demo video, public repo | Live demo: red score → plan → green legs → one leg executed through NEAR Intents |

Buffer rule: F1–F4 + F6 are the submission. F5, F7–F9 are added only if weeks 1–3 hit their exit criteria.
"Working beats ambitious."

### Team split (if 2–4 people)

- **Data/infra:** Zebra, ingestor, snapshot pipeline
- **Core/research:** matcher, scorer, planner, validation, methodology write-up
- **Frontend:** web app, CLI UX, dashboard
- **Integration/pitch:** NEAR Intents adapter, demo script, video, README

## 11. Demo script (3 minutes)

1. **Hook (20s):** "Zcash hides you inside the pool. But the doors are public." Show the headline Leak Meter stat vs null baseline.
2. **Pain (40s):** Replay one of *our own* controlled round-trips: Pre-flight shows 🔴 "1 candidate — you".
3. **Fix (60s):** Exit Planner splits it into 3 legs, scores go 🟢; show destination-hygiene warning.
4. **Cross-chain (40s):** Execute one leg via NEAR Intents → ZIP-321 QR → paid from ZODL → status SUCCESS.
5. **Why it's safe (20s):** Network tab is empty during the check — nothing leaves the device.

## 12. Real-world path (beyond the hackathon)

| Phase | What | How |
|---|---|---|
| Adoption | Wallets embed `@turnstile/core` | PRs/proposals to ZODL, Zingo, WebZjs web wallet, MetaMask Zcash snap; tiny API: `score(plannedTx, snapshot)` |
| Standards | Draft ZIP: "Wallet boundary-crossing hygiene" | Standard denominations (S2), wallet warnings, recommended delays |
| Public good | Leak Meter as a live ecosystem metric | Daily snapshot + dashboard, reproducible from any Zebra node |
| Sustainability | Zcash Community Grants application | Hackathon result is the proof-of-work for the grant |
| Hardening | Independent review of methodology; privacy audit of the web app | Before wallets ship it by default |

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Zebra sync takes days / large disk | Blocks week 1 | Start before window; meanwhile develop against a public RPC endpoint or explorer API for public data |
| Snapshot too big for browser | Pre-flight slow | Shorter window, drop addresses to side file, binary columnar encoding |
| Heuristic false positives | Credibility | Null model baseline + controlled ground-truth txs |
| 1Click API changes / ZEC unsupported route | F6 slips | Keep execution as a thin adapter; ZIP-321 QR alone still demonstrates the flow |
| Low actual leak rate | Weaker headline | Still a valid result ("X% linkable, here's who's safe"); pivot the pitch to prevention + address reuse + pool migration |

## References

- ZIP 317 (fees), ZIP 321 (payment request URIs), ZIP 316 (unified addresses) — https://zips.z.cash
- Quesnelle, *On the linkability of Zcash transactions* — https://arxiv.org/abs/1712.01210
- Zcash privacy best practices — https://zcash.readthedocs.io/en/master/rtd_pages/privacy_recommendations_best_practices.html
- Zebra RPC — https://docs.rs/zebra-rpc/latest/zebra_rpc/methods/index.html
- NEAR Intents 1Click API — https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api
- WebZjs — https://github.com/ChainSafe/WebZjs
- Zallet — https://github.com/zcash/zallet
