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

A service that shields thousands of times would inflate the apparent crowd any single exit hides in.
The matcher counts entities, not shields, and reports services separately (section 6.1).

## 6. Matching exits to entries

For every exit (a deshield that is not a batch payout), Turnstile asks what an observer would: which
earlier shields could have funded it, and can one of them be singled out?

### 6.1 Entities, people and services

Shields are grouped into **entities** with the common-input-ownership heuristic: addresses spent
together in one transaction belong to one party. The 85,560 shields form 26,476 entities, and the crowd
is always counted in entities, not transactions.

The size distribution has a sharp tail:

| Shields per entity (90 days) | Entities | Shields |
|---|---|---|
| 1 | 20,285 | 20,285 |
| 2–5 | 5,306 | 13,732 |
| 6–20 | 722 | 6,739 |
| 21–100 | 144 | 5,704 |
| more than 100 | **19** | **39,100** |

An entity with more than 100 shields in 90 days deposits more than once a day, every day. No person
does that. These 19 are treated as **services**; they made 45.7% of all shields. Every result is
reported separately for exits traced to people and exits traced to services.

### 6.2 Candidates and weights

A shield is a candidate for an exit if it happened in the 7 days before it (not in the same block, which
can't fund it) and `0 ≤ shield amount − exit amount ≤ 200,000` zat, the room fees take up. Each
candidate is weighted `amount weight / (1 + Δt / 1 hour)`, summed per entity:

- **Time.** The median delay of natural round trips is 1.2 hours and the p90 is 53 hours, so the weight
  favors recent entries without cutting off older ones.
- **Amount.** 91.8% of exact natural round trips differ by a multiple of 5,000 zat, the ZIP-317 fee unit
  (2,298 of 2,503). A chance match is spread evenly over ~200,000 possible differences. Per candidate,
  a fee-shaped difference is about 4,500 times likelier to come from the real funder than from chance,
  and any other difference about 0.08 times, so off-unit candidates get a relative weight of 0.00002.

### 6.3 The chance gate

Thousands of people shield "1 ZEC plus a standard fee". A single fee-shaped match on an amount like
that proves nothing. For each exit, Turnstile therefore estimates how many parties match its exact
amount by chance: the distinct entities with a fee-shaped shield for that amount in the **14 days
before the search window**. The true funder can't be there. Looking only at the past, this works
identically for the Leak Meter and for a live pre-flight check.

### 6.4 Verdict

An exit is **linkable** when all of these hold:

1. the top entity has a fee-shaped candidate;
2. it is the only candidate entity, or holds at least 90% of the weight;
3. nobody used this amount (plus fees) in the background period.

The threshold in (3) was chosen for accuracy, not for the size of the result (section 7.1). Condition
(1) gives up the ~8% of true round trips with non-standard fees, so every figure is a lower bound.

### 6.5 Two measures of coincidence

Turnstile measures chance twice and reports its result against the larger of the two:

- **Reversed time:** the same test against shields in the 7 days *after* the exit (with its own
  background after that), which cannot have funded it. It also counts parties who exit and later
  re-enter the same amount, which is real behavior, so it overstates chance.
- **Shifted amount:** the exit amount moved by 0.05–0.5 ZEC in steps of 0.01 ZEC. Its decimal
  precision, its remainder modulo 5,000 and its timing are unchanged, but any true match is gone.

Scoring an exit needs 21 days of data on each side (7-day window plus 14-day background), so from 90
days of data the meter scores exits between July 22 and September 7, 2026.

## 7. Validation of the matcher

`turnstile validate` runs both checks; everything is seeded and reproducible.

### 7.1 Calibrating the chance gate

The gate allows a number of chance parties in the background. With a 14-day background it moves in
steps of one party, and three settings were compared:

| Allowed chance parties | Wrong links on exits with no true funder (planted split legs) | Precision on natural labels | Identifiable planted trips linked |
|---|---|---|---|
| **none (chosen)** | **3.95%** | **89.7%** | **100%** |
| one | 6.20% | 87.6% | — |
| any (no gate) | 10.10% | 78.0% | — |

Only the strictest setting keeps linkable verdicts right about 90% of the time, the same standard as
the 90% weight share in the verdict. Without the gate, one exit in ten that has no true funder would be
pinned on an unrelated party.

### 7.2 Planted trips

1,000 synthetic round trips per scenario, placed at random times into the real mainnet background, with
amounts drawn from ordinary users' shields (not services) and two 15,000 zat fees. A trip is
**identifiable** when nobody else shielded its amount (plus fees) in the three weeks before the exit, so
amount and timing can single out the entry; otherwise it is **crowded**.

| Scenario | Linked to the right entry | Linked to a **wrong** one | Identifiable: linked | Crowded: hidden |
|---|---|---|---|---|
| (a) exact amount out after 1 hour | 70.7% | 0 | **100%** (641 of 641) | 81.6% (of 359) |
| (b) exact amount out after 24 hours | 62.8% | 0 | **100%** (628 of 628) | 100% (of 372) |
| (c) round amount out after 3 hours | 0% | 0 | none identifiable | 100% (of 1,000) |
| (d) split into two legs | 0% | 79 (3.95%) | 0% (no leg matches) | 89.3% (of 737) |

Every trip that amount and timing can single out is found. None of the 3,000 trips in (a)–(c) is ever
blamed on the wrong entry. In (d) the true depositor never matches either leg, so any link is a false
one: 3.95% of legs happen to match someone else uniquely. That is the irreducible error of
amount-and-timing analysis, and it cuts both ways: an observer relying on it would wrongly blame an
innocent party about as often.

### 7.3 Natural labels

Exits paid to an address that shielded in the preceding 7 days. The matcher never sees addresses; the
label only says which entry was the funder. It assumes the most recent same-address shield was the
funder, which isn't always true, so precision here is a floor.

| | Labelled exits | Exact round trips | Recall on exact trips | Precision of linkable verdicts |
|---|---|---|---|---|
| All | 7,098 | 1,981 | 61.7%; precise amounts 88.2% | **89.7%** (1,222 of 1,362) |
| Funder is a person | 5,357 | 541 | 31.2%; precise amounts 58.5% | 55.2% (169 of 306) |

Person-funded labels are the weak spot: only about half of the matcher's verdicts on them name the
labelled funder. Some "misses" may be the same person shielding from a second address the heuristic
doesn't connect, but the result is reported as it stands.

## 8. Leak Meter result

36,129 exits scored (July 22 – September 7, 2026):

| Exits traced to | Linked | Chance (reversed) | Chance (shifted) | Beyond chance |
|---|---|---|---|---|
| **Services** | 6.53% | 0.45% | 0.54% | **+5.99 points** |
| Services, precise amounts (6–8 decimals) | **15.99%** | 0.73% | 0.04% | **+15.26 points** |
| **People** | 4.38% | 3.72% | 4.78% | none measurable |
| Everyone | 10.91% | 4.16% | 5.32% | +5.59 points |

What this means:

1. **Services leak.** Of all exits with a precise amount, 16% can be traced back to a deposit made by a
   service (an exchange, bridge or payment processor), against under 1% by chance. Their users' funds
   pass through those flows.
2. **For people, amount-and-timing analysis finds nothing beyond chance at population scale.** Most
   people don't withdraw exactly what they deposited, and the ones who do are outnumbered by
   coincidences. That is good news for Zcash users as a whole.
3. **But an individual who does withdraw their exact deposit is found every time** when the amount is
   one nobody else used recently (section 7.2: 100% of identifiable trips, after 1 hour or a day). The risk
   is behavioral and specific to the person, which is exactly what a pre-flight check can see and a
   population average can't.

An earlier version of this analysis did not separate people from services and did not have the chance
gate. It reported that one in five precise-amount exits by people could be traced. That was wrong: most
of those links pointed at services, and many of the rest were coincidences.

## 9. Limitations

- A transaction that both shields and deshields nets out on the transparent side and is under-counted.
- A shield of 20,000 zat or less, paid alongside its fee, is indistinguishable from a fee and is not
  counted. At current prices that is about $0.30.
- Days are UTC calendar days from the dumps; a transaction's inputs, outputs and header always fall on
  the same day, so this doesn't split transactions.
- Validation is a random sample of 20. It confirms the rules on every pool, but it isn't exhaustive.
- Common-input clustering can merge unrelated parties that co-spend (for example through a service),
  and can fail to join one person's separate addresses. The first shrinks the crowd; the second makes
  some correct links look wrong on natural labels.
- The service threshold (more than 100 shields in 90 days) is a judgment call; the entity-size table in
  section 6.1 shows there is a wide empty gap around it.
- The matcher tests one entry against one exit. Someone who splits an exit, or combines several
  entries, is invisible to it, so the Leak Meter undercounts those patterns.
