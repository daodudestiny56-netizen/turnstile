# Turnstile

**Zcash's shielded pool hides you inside. Its doors are public.**

Turnstile measures how often Zcash users are traced at the boundary of the shielded pool, warns you before a
withdrawal gives you away, and plans an exit that blends in with everyone else — without your plans ever
leaving your device.

> Built for [Zecathon](https://thezecathon.com/) · Cross-Chain track · TypeScript · MIT

---

## The problem, in one story

Kemi buys 3.1742 ZEC on an exchange that knows her name and withdraws it to a transparent address.
She shields it at 14:05. The shielded pool is doing its job: inside, nobody can see her.

At 17:30 she swaps it for USDC through a cross-chain service, which means 3.1742 ZEC (minus a fee) leaves
the pool.

Nobody can see *inside* the pool, but everybody can see the doors. The chain records that 3.1742 ZEC went
in at 14:05 and that the same amount came out three and a half hours later. No one else moved that amount
that afternoon. The two events are the same person, and Kemi's identity at the exchange is now linked to
wherever the USDC went.

Her wallet showed a shield icon the whole time.

This isn't hypothetical. Every move between a transparent address and a shielded pool publishes its amount
and time — consensus needs that to prove no money was created. Researchers showed in 2017 that matching
amounts and timing links these trips ([Quesnelle, *On the linkability of Zcash transactions*](https://arxiv.org/abs/1712.01210)),
and the official [privacy best practices](https://zcash.readthedocs.io/en/master/rtd_pages/privacy_recommendations_best_practices.html)
acknowledge it. Most people still have to cross the boundary twice: in from an exchange, out through a swap.
No wallet warns them.

## What Turnstile does

| Feature | What you get |
|---|---|
| **Leak Meter** | A public, reproducible measurement: what share of recent mainnet exits can be linked to their entry by amount and timing alone, compared against a baseline that shows how much of that is mere coincidence. |
| **Pre-flight Check** | Type in the withdrawal you're about to make. Turnstile tells you how many other deposits it could plausibly belong to — and whether the answer is "just yours". |
| **Exit Planner** | Splits a withdrawal into amounts that are common on-chain, at times that match normal network activity, and scores each leg. What doesn't blend in stays shielded. |
| **Address-reuse Detector** | Catches the most common self-own: withdrawing to the same transparent address you shielded from. |
| **NEAR Intents execution** | Each leg of a plan becomes a real cross-chain swap: a just-in-time quote, a one-time deposit address, and a [ZIP-321](https://zips.z.cash/zip-0321) payment QR that you pay from your own wallet. |
| **`@turnstile/core`** | The engine as a small, dependency-free TypeScript library, so any wallet can show the warning to its users. |

## Privacy by construction

A tool that warns about leaks must not leak. These are hard requirements, and each one has a test:

- **Download everything, query nothing.** The amount you plan to withdraw is the secret. Instead of asking a
  server "is 3.1742 risky?", your device downloads the same public data file as every other user and does
  the maths locally. After that file loads, a check or plan makes **zero network requests**.
- **No keys, ever.** Turnstile never asks for a seed phrase or signs anything. Execution hands off to your own
  wallet through a standard payment request.
- **No third parties.** No analytics, no trackers, no remote fonts or scripts. The only external service is
  the swap provider, contacted one leg at a time, only when you click *Execute*.
- **Aggregates only.** The Leak Meter publishes statistics, never a list of which transactions are linked to
  which.
- **Verifiable data.** Every data file comes with a hash, and anyone can rebuild it from public chain data
  and get the same bytes.

## What we've found so far

Building a trustworthy measurement meant checking public Zcash data line by line first. These surfaced
before any matching was written; the details are in [docs/methodology.md](docs/methodology.md).

1. **A major explorer misses almost every shielded crossing.** Blockchair's `shielded_value_delta` only
   reflects the older Sapling and Sprout pools. Over July–September 2026 it reports no movement for
   **89.8%** of the 168,876 crossings Turnstile found: every one of them a v5 or v6 transaction, the versions
   that carry the Orchard and Ironwood pools. For an Orchard shield it books the entire amount as the fee.
   Turnstile never uses that column.
2. **Crossings can be detected from structure alone.** A transaction's transparent part has an exact byte
   size. Across 590,212 transactions, every purely transparent one has exactly 27 (v4), 23 (v5) or 24 (v6)
   bytes left over, and every shielded one has more than 200, with nothing in between. Turnstile uses this
   instead of guessing from fees, which fails: some wallets pay fees above 0.001 ZEC.
3. **Checked against a Zcash node.** 20 randomly chosen shields and deshields were compared with a node's
   own view of each transaction. All 20 match, across Sapling, Orchard and Ironwood, and every implied fee
   is an exact multiple of the 5,000-zat ZIP-317 unit.
4. **Public dumps repeat rows.** Across 90 days of Blockchair's outputs data, 118,086 lines are verbatim
   copies of other lines. Left in, they break the totals of hundreds of transactions a day. With them removed,
   every checked transaction's outputs add up exactly to its recorded total.
5. **Blank totals follow one rule.** Across 222,404 transactions checked, `input_total` and `output_total`
   are blank exactly when a transaction has no transparent inputs or outputs, and never otherwise. Turnstile
   treats those blanks as zero and rejects any other blank as an error.

## What the Leak Meter found

Across 36,129 exits from the shielded pool between July 22 and September 7, 2026, each checked against
two independent measures of coincidence:

| Exits traced to | Linked to their entry | By chance | Beyond chance |
|---|---|---|---|
| Services, precise amounts | **16.0%** | 0.04% to 0.73% | **+15.3 points** |
| Services, all amounts | 6.5% | 0.45% to 0.54% | +6.0 points |
| People | 4.4% | 3.7% to 4.8% | none measurable |

**Services leak.** Of all exits with a precise amount, one in six can be traced back to a deposit made by
a service (an exchange, bridge or payment processor), against well under 1% by chance. Everyone whose
funds pass through those services inherits that.

**People, as a whole, don't: but an individual can.** Across the population, exits traced to people are
no more common than coincidence. Yet in controlled tests, a person who withdraws exactly what they
deposited, on an amount nobody else used recently, is found **every time**: 1,269 of 1,269 trips, whether
they waited an hour or a day. The risk is behavioral and specific to the person, so it can't be read off a
population average. It has to be checked before each withdrawal, which is what the Pre-flight Check does.

The matcher is built to under-claim. It only links an exit when the gap to the entry is an exact multiple
of the 5,000-zat fee unit, it counts a service's thousands of deposits as one party, and it refuses to link
an amount that anyone else used in the previous two weeks. In 3,000 planted round trips it never blamed
the wrong deposit. The method, calibration and every figure are in [docs/methodology.md](docs/methodology.md).

## Status

Turnstile is being built in public sections, and each one must pass its acceptance tests before the next
begins. The full plan lives in [PRD.md](PRD.md).

| Section | Scope | Status |
|---|---|---|
| S0 | Foundation: monorepo, strict TypeScript, tests, CI | Done |
| S1 | Data ingestion: 90 days of mainnet data, verified against source files | Done |
| S2 | Boundary-event derivation: every shield and deshield, verified against a node | Done |
| S3 | Matcher, scorer, and Leak Meter, validated on planted and real round trips | Done, pending sign-off |
| S4 | Verifiable snapshot file | Next |
| S5 | Pre-flight Check, Exit Planner, reuse detector (CLI) | Planned |
| S6 | Web app | Planned |
| S7 | NEAR Intents execution | Planned |
| S9 | Docs, deployment, demo | Planned |

What S1 proved, on July 1 – September 28, 2026:

- **693,385** transactions, **1,277,780** transparent inputs and **1,012,475** transparent outputs loaded
- All **270** table-days match their source files, checked by an [independent script](scripts/verify-ingest.mjs)
  that reads the raw files without Turnstile's parser
- Re-running the ingest changes nothing: the database's content hash is identical before and after
- A full rebuild from the local cache takes **about 7 minutes** and produces the same content hash

What S2 proved, on the same 90 days:

- **85,560** shields and **83,316** deshields derived; 11,578 shields are miners shielding rewards and 146
  deshields are batch payouts, both tagged rather than dropped
- **20 of 20** randomly sampled events match a Zcash node exactly ([verify-events.mjs](scripts/verify-events.mjs))
- September's surge is real: three times July's crossings, driven partly by one address making 22% of
  September's shields and partly by thousands of new small withdrawals to distinct addresses

## Try it

You need Node 22.13 or later and [pnpm](https://pnpm.io/).

```sh
pnpm install
pnpm build
pnpm test
```

Load a week of mainnet data (from [Blockchair's free daily dumps](https://gz.blockchair.com/zcash/)) and
check it:

```sh
node apps/cli/dist/bin.js ingest --days 7 --to 2026-09-28
node apps/cli/dist/bin.js counts
node scripts/verify-ingest.mjs

node apps/cli/dist/bin.js derive --days 7 --to 2026-09-28
node apps/cli/dist/bin.js events --days 7 --to 2026-09-28
node apps/cli/dist/bin.js meter --days 90 --to 2026-09-28      # the Leak Meter (needs 90 days ingested)
node apps/cli/dist/bin.js validate --days 90 --to 2026-09-28   # planted trips and natural labels
node scripts/verify-events.mjs      # checks 20 random events against a public Zcash node
```

Downloads are cached in `data/`, so each file is fetched once. Blockchair limits free downloads to about
100 KB/s and one connection per IP address, so 90 days take a little over an hour the first time and about
seven minutes after that.

## How it works

```
Blockchair daily dumps ─▶ ingest ─▶ SQLite ─▶ boundary events ─▶ snapshot + manifest (public, hashed)
                                                                          │
                                         your browser or CLI ◀────────────┘
                                         @turnstile/core: score · plan · measure   (all local)
                                                  │  only when you click Execute, one leg at a time
                                                  ▼
                                         NEAR Intents quote ─▶ ZIP-321 QR ─▶ your own wallet
```

**Detecting crossings.** Turnstile doesn't trust a data source's claims about shielded value. It first
checks whether a transaction has shielded parts at all, by comparing its byte size with the exact size of
its transparent inputs and outputs. For those that do, it compares the transparent value going in with the
transparent value coming out. If more went in than came out (beyond a fee), the difference entered a
shielded pool. If more came out than went in, it left.

**Matching.** For every exit, Turnstile finds the entries that could have funded it: earlier in time, of
slightly larger value, with the gap consistent with fees. Entries are grouped by who made them, so a busy
service counts once, not thousands of times. Recent candidates, and gaps that are exact multiples of the
fee unit, weigh most. It then checks how often that exact amount turned up in the two weeks before; a
single match on a popular amount is treated as the coincidence it probably is. The result is an
*effective anonymity set*: roughly, how many parties you could plausibly be.

**Checking itself.** Any matcher finds some unique matches by chance, so Turnstile measures chance twice.
Once by running backwards in time, pairing exits with entries that happened *after* them, which can't be
real. Once by nudging each exit amount by a few hundredths of a ZEC, which keeps its roundness and timing
but removes the true match. The Leak Meter reports its result against the larger of the two.

## Repository layout

| Path | Purpose |
|---|---|
| [`packages/core`](packages/core) | `@turnstile/core`: scoring and planning engine; runs in the browser and Node |
| [`packages/ingest`](packages/ingest) | Data sources, verified ingestion, and boundary-event derivation |
| [`packages/intents`](packages/intents) | NEAR Intents 1Click adapter, the only code allowed to contact a third party |
| [`apps/cli`](apps/cli) | The `turnstile` command-line tool |
| [`scripts`](scripts) | Independent verification scripts |
| [`PRD.md`](PRD.md) | Scope, requirements, and the acceptance tests for every section |
| [`docs/turnstile-design.md`](docs/turnstile-design.md) | System design and algorithms |

## Development

```sh
pnpm build          # TypeScript project build
pnpm test           # type-check (including tests) and run the Vitest suite
pnpm lint           # ESLint, zero warnings allowed
pnpm format:check   # Prettier
```

CI runs all four on every push.

## Limitations

Turnstile measures what the public chain reveals; it can't see inside the shielded pool, and that is the
point. A transaction that shields and deshields in the same step nets out and is under-counted. Data comes
from Blockchair's dumps today; the ingestion layer is built so a Zcash node (Zebra) can replace them without
changing anything downstream. A low anonymity score is a warning about what an observer *could* infer, not
proof that anyone has.

## License

[MIT](LICENSE)
