# Turnstile methodology

This document explains how Turnstile turns public Zcash data into shield and deshield events, why each
threshold has the value it has, and how the results were checked. Every number here comes from the
90 days July 1 – September 28, 2026 unless stated otherwise, and every check can be rerun from the
repository.

## 1. Data

Source: Blockchair's free daily dumps of Zcash `transactions`, `inputs` and `outputs`
(`https://gz.blockchair.com/zcash/`). Ingestion is covered in the PRD (section S1). Facts established
while loading them:

| Observation | Evidence | Handling |
|---|---|---|
| `input_total` / `output_total` are blank exactly when the input / output count is 0 | 222,404 transactions checked, no other case | Blank becomes 0; blank with a non-zero count is rejected |
| Output files repeat some lines verbatim | 118,086 duplicate lines in 90 days; with them removed, every checked transaction's outputs sum exactly to its `output_total` | Verbatim repeats dropped and counted; two different rows with the same key are rejected |
| The server allows one download per IP at a time | A second concurrent request returns HTTP 402 | Downloads are sequential and retried |

The independent check `scripts/verify-ingest.mjs` compares every table-day with its source file without
using Turnstile's parser: 270 of 270 match.

## 2. Blockchair's shielded value is not usable

Blockchair publishes `shielded_value_delta`, meant to be the net value moving into shielded pools
(positive = in). It only reflects the Sapling and Sprout pools. It reads 0 for Orchard and for
Ironwood, the pool used by v6 transactions, and it books an Orchard shield's entire value as the fee.

Measured against Turnstile's derivation (section 3) over 90 days:

| | Crossings |
|---|---|
| Direction agrees | 17,268 (10.2%) |
| Blockchair reports no movement | 151,586 (89.8%): 22,197 v5, 129,389 v6 |
| Blockchair reports the opposite direction | 22 |

Blockchair also reports movement on 8,025 transactions that don't cross the transparent boundary.
They are fully shielded transfers between pools, for example Sapling to Orchard, where Blockchair sees
only the Sapling half. Two were checked against a node: `570938fe…` moves 965,000 zat from Orchard to
Sapling and `fd3a8899…` moves 5 ZEC from Sapling to Orchard; in both, only the 20,000 zat fee leaves
the pools. (Pool-to-pool amounts are themselves visible and are a separate leak; see the PRD, F7.)

Turnstile therefore never uses `shielded_value_delta` except to report this comparison.

## 3. Deriving boundary events

Each transaction is classified in two independent steps.

### 3.1 Does it have shielded components?

A transaction's transparent part has an exact serialized size. Each input is a 32-byte previous
transaction id, a 4-byte index, a length-prefixed scriptSig and a 4-byte sequence number. Each output is
an 8-byte value and a length-prefixed script. Both lists carry a CompactSize count prefix. The dumps
provide every scriptSig and script, so this size is computed exactly.

`residual = transaction size − transparent size` is what remains: the fixed header plus any shielded
data. Over the 590,212 non-coinbase transactions with complete data (of 590,226):

| Version | Residual of transparent-only txs | Txs with residual 31–200 | Txs with residual > 200 |
|---|---|---|---|
| v4 | exactly 27 (182,609 txs) | 0 | 1,599 |
| v5 | exactly 23 (73,239 txs) | 0 | 38,768 |
| v6 | exactly 24 (22,664 txs) | 0 | 271,333 |

27 and 23 are precisely the v4 and v5 header sizes for a transaction with no shielded parts. The
smallest shielded bundle, a single Sapling spend, adds several hundred bytes, and an Orchard or Ironwood
bundle adds several kilobytes. **Threshold: `shieldedResidualMin = 200` bytes.** Nothing lies anywhere
near it. 14 transactions are missing some input or output rows in the dumps; they are marked
`INCOMPLETE` and never guessed.

This step matters. An amount-only rule ("more went in than came out, beyond a fee") misclassified 3 of
4 sampled transactions, because wallets sometimes pay fees above 0.001 ZEC: `0000fb33…` pays 130,000
zat on a purely transparent 9-input transaction.

### 3.2 Direction and amount

For transactions with shielded components, with `gap = transparent inputs − transparent outputs`:

| Condition | Event | Amount |
|---|---|---|
| no transparent inputs, some outputs | DESHIELD | transparent outputs |
| `gap < 0` | DESHIELD (tagged `mixed`) | `−gap` |
| `gap > 20,000` zat | SHIELD | `gap` |
| no transparent inputs or outputs, or `0 ≤ gap ≤ 20,000` | none | — |

A SHIELD's amount includes its fee and a DESHIELD's excludes it, because both are what the transparent
side shows. In a round trip the shield amount is therefore at least the deshield amount, and the
difference is the fees paid in between.

**Threshold: `shieldMinZat = 20,000`.** Among shielded transactions with transparent inputs, positive
gaps cluster at 10,000–20,000 zat. That is the ZIP-317 fee for a few logical actions, paid from
transparent funds. Above that the distribution is continuous. The most common small shield is exactly
100,000 zat (0.001 ZEC, 144 transactions), which a higher threshold would wrongly drop.

### 3.3 Tags

| Tag | Rule | 90-day count |
|---|---|---|
| `coinbase` | SHIELD spending at least one coinbase output (a miner shielding rewards) | 11,578 of 85,560 shields (13.5%) |
| `batch` | DESHIELD with at least 3 transparent outputs | 146 of 83,316 deshields (0.2%) |
| `mixed` | DESHIELD that also spends transparent inputs | — |

**Threshold: `batchMinOutputs = 3`.** Among transactions with no transparent inputs and some
transparent outputs, 83,058 have one output and 33 have two. The rest (3 to more than 20 outputs) look
like payouts: `0927b422…` pays 22 addresses. A person withdrawing to themselves rarely pays three or
more transparent addresses at once. Tags are recorded, not filtered; the matcher decides how to use them.

## 4. Validation against a Zcash node

`scripts/verify-events.mjs` draws 10 SHIELD and 10 DESHIELD events at random (seed 2026) and compares
each with the node's `getrawtransaction`, which reports every pool's value balance directly. For each
event it checks the direction, the transparent totals, the destination addresses (for deshields), and
that the implied fee `amount − value into pools` (or `value out of pools − amount`) is between 0 and
1,000,000 zat.

Result: **20 of 20 confirmed.** Every implied fee is a multiple of 5,000 zat (10,000 – 75,000),
the ZIP-317 fee unit, which is what an exact derivation should produce. The sample covers Sapling,
Orchard and Ironwood, including a deshield that draws from Orchard and Ironwood in the same transaction.

## 5. What the events show

- 85,560 shields (1.64M ZEC in, counting repeated movements) and 83,316 deshields (1.17M ZEC out)
  in 90 days.
- September had about three times as many crossings as July or August, at much smaller average sizes
  (7.6 ZEC against 20–54 ZEC). Two things drive it:
  - A single transparent address accounts for 11,721 of September's 53,441 shields (22%), against 1–4
    a month before. It behaves like a service, not a person.
  - Deshields went to 36,948 distinct addresses in September, and those under 0.01 ZEC grew from about
    1,500 a month to 10,398. That is broad-based activity, not one actor.

A service that shields thousands of times inflates the apparent crowd any single exit hides in. The
matcher (PRD section S3) has to account for that rather than count every shield as an independent
person.

## 6. Matching exits to entries

For every exit (a deshield that is not a batch payout), Turnstile asks what an observer would: which
earlier shields could have funded it?

### 6.1 Candidates

A shield is a candidate for an exit if it happened within the 7 days before it and
`0 ≤ shield amount − exit amount ≤ 200,000` zat, which is the room fees take up. Shields are grouped
into **entities** with the common-input-ownership heuristic: addresses spent together in one
transaction belong to one party. The crowd is counted in entities, so a service that shielded 11,721
times in September is one member of it, not 11,721. The 85,560 shields form 26,476 entities.

### 6.2 Weights

Each candidate gets a weight `amount weight / (1 + Δt / 1 hour)`, summed per entity:

- **Time.** 1 hour is close to the median delay of the natural round trips (1.2 hours, section 7); the
  p90 is 53 hours, so the weight falls off slowly rather than cutting off.
- **Amount.** 91.8% of exact natural round trips differ by a multiple of 5,000 zat, the ZIP-317 fee unit
  (2,298 of 2,503). A chance match is spread evenly over the ~200,000 possible differences. Per
  candidate, a fee-shaped difference is therefore about 4,500 times likelier to come from the real
  funder than from chance, and any other difference about 0.08 times. Off-unit candidates get a
  relative weight of 0.00002. They still count toward the size of the crowd but barely dilute a
  fee-shaped match.

### 6.3 Verdict

An exit is **linkable** when the top entity has a fee-shaped candidate and either is the only
candidate entity or holds at least 90% of the weight. Requiring the fee shape gives up the ~8% of true
round trips whose fees are non-standard, so every figure below is a lower bound.

### 6.4 Two measures of coincidence

A matcher run over any data finds some unique matches by chance. Turnstile measures that rate twice
and reports its result against the larger of the two:

- **Reversed time:** the same test against shields in the 7 days *after* the exit, which cannot have
  funded it. This also counts services that exit and later re-enter the same amount, which is real
  behavior, so it overstates chance.
- **Shifted amount:** the exit amount moved by 0.05–0.5 ZEC in steps of 0.01 ZEC. Its decimal
  precision, its remainder modulo 5,000 and its timing are unchanged, but any true match is gone.
  Round amounts move into sparser territory, which makes this baseline high for them.

## 7. Validation of the matcher

`turnstile validate` runs both checks below. Everything is seeded and reproducible.

**Planted trips.** 200 synthetic round trips per scenario, placed at random times into the real
mainnet background, with amounts drawn from real user shields and two 15,000 zat fees:

| Scenario | Linked | Precise amounts (6–8 decimals) | 3–5 decimals | Round |
|---|---|---|---|---|
| (a) exact amount out after 1 hour | 89.5% | 100% (155/155) | 53.3% (24/45) | — |
| (b) exact amount out after 24 hours | 81.0% | 91.8% (146/159) | 39.0% (16/41) | — |
| (c) round amount out after 3 hours | 4.0% | — | — | 4.0% (8/200) |
| (d) split into two legs | 0.0% | 0% (0/137) | 0% (0/63) | 0% (0/200) |

Exact trips with 3–5 decimal amounts are often not linked because another entity shielded the same
amount in the same week (services repeat amounts), so the true entry isn't unique. That is the crowd
working as intended, not a miss.

**Natural labels.** 8,203 exits went to an address that shielded in the preceding 7 days; 2,326 of
them are exact round trips. The matcher never sees addresses; the label only says which entry was the
real funder.

| | Recall on exact trips | Precision of linkable verdicts |
|---|---|---|
| All labels | 68.3% (1,588 of 2,326); precise amounts 93.0% | 78.2% (1,588 of 2,030) |
| Excluding 6 busy addresses | 41.2% (261 of 634); precise amounts 68.5% | 53.4% (261 of 489) |

Labels assume the most recent same-address shield was the funder, which isn't always true, so
precision here is a floor.

## 8. Leak Meter result

66,131 exits with a full 7-day window on both sides (July 8 – September 21, 2026):

| | Linkable |
|---|---|
| Exits linkable to their entry | **15.98%** (10,567) |
| Coincidence, reversed time | 10.71% |
| Coincidence, shifted amount | 10.43% |
| **Beyond coincidence** | **at least 5.27 percentage points** |

By amount precision:

| Exit amount | Observed | Reversed | Shifted | Exits |
|---|---|---|---|---|
| Precise (6–8 decimals) | **20.98%** | 7.75% | 0.14% | 22,232 |
| 3–5 decimals | 14.72% | 12.78% | 17.12% | 23,460 |
| Round (0–2 decimals) | 11.98% | 11.54% | 13.94% | 20,439 |

**About one in five exits with a precise amount can be traced to its entry**, against 0.14% by chance
(shifted amount), and 7.75% even when services' re-entries are counted as chance. Round amounts and
amounts with a few decimals show no measurable leak beyond coincidence: they blend in. That is the
basis for the Exit Planner's advice.

## 9. Limitations

- A transaction that both shields and deshields nets out on the transparent side and is under-counted.
- A shield of 20,000 zat or less, paid alongside its fee, is indistinguishable from a fee and is not
  counted. At current prices that is about $0.30.
- Days are UTC calendar days from the dumps; a transaction's inputs, outputs and header always fall on
  the same day, so this doesn't split transactions.
- Validation is a random sample of 20. It confirms the rules on every pool, but it isn't exhaustive.
- Common-input clustering can merge unrelated parties that co-spend (for example through a service),
  which shrinks the crowd and can overstate linkability for their exits.
- The matcher tests one entry against one exit. Someone who splits an exit, or combines several
  entries, is invisible to it, so the Leak Meter undercounts those patterns.
