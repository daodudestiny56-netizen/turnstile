# Web app: how it can fail, and the test for each

Every way we found for the web app to fail, what Turnstile does about it, and the test that proves it.
The end-to-end tests (`e2e/`) run the production build in **Chromium, Firefox and WebKit** (Safari's
engine) against a test server that can inject faults (`e2e/serve.mjs`).

```sh
pnpm build
pnpm e2e                      # all three browsers
LIVE_INTENTS=1 pnpm e2e execute.spec.ts -g "real NEAR Intents"   # also call the real API (no funds)
pnpm e2e --project=chromium   # one browser
```

## Loading the data

| Failure | What happens | Test |
|---|---|---|
| The host decompresses the snapshot in transit (`Content-Encoding: gzip`) | Accepted: the decompressed bytes must match the manifest's content hash | `load.spec` Content-Encoding |
| The snapshot is served exactly as stored | Accepted: file hash, then content hash | `load.spec` as stored |
| Snapshot missing (404) | Clear error, "Try again", tools disabled | `load.spec` missing |
| Snapshot altered (one byte) | Refused before use: "matches neither" hash | `load.spec` tampered; unit tests |
| A CDN pairs a new manifest with an old cached file | Can't happen: every file is fetched with its hash in the URL, the manifest with `no-cache` | worker code; `load.spec` suite |
| Slow connection | Progress message, tools disabled until verified | `load.spec` slow |
| Download fails once | "Try again" starts over with a fresh worker and succeeds | `load.spec` Try again (flaky server) |
| The analysis worker can't start or crashes | Error shown, pending requests rejected (never a silent hang) | `load.spec` broken engine |
| Page not served over HTTPS (no `crypto.subtle`) | Clear message: open it over HTTPS | worker code |
| Browser too old to decompress | Clear message: update the browser | worker code |
| JavaScript disabled | `<noscript>` explains why it's needed | index.html |
| The landing page opened before the data arrives | Fully usable; the check runs once data is ready | `load.spec` landing |
| The route changes right after the page renders, before the app listens for changes | Caught: the router re-checks the path after subscribing (the test fails in WebKit without this) | `load.spec` navigation right after load |

## Input

| Failure | What happens | Test |
|---|---|---|
| Amount empty, `0`, `-1`, `1,5`, 9 decimals, above total supply, text | Specific message under the field, marked invalid, no result | `check.spec` 7 cases |
| `.5` or `2.` | Accepted as 0.5 and 2 | unit tests |
| Deposit dated after the withdrawal (or after the plan starts) | "Has to be before" | `check.spec`, `plan.spec` |
| Deposit amount without its time | "When did you make this deposit?" | `check.spec` |
| Withdrawal before the data covers | Explains the 21 days of history needed | `check.spec` |
| Withdrawal long after the data ends | Amber "data may be out of date"; also a page banner when the data itself is over 2 days old | `check.spec` |
| Destination typo | Base58Check checksum fails: "check it for typos" | `check.spec`; unit tests |
| TEX address (`tex1...`, ZIP 320, used by exchanges) | Converted to its t1 account before the reuse check | `check.spec`; unit test with the ZIP 320 vector |
| Shielded, unified or testnet destination | Explained: nothing to check / mainnet only | `check.spec` |
| Rapid repeated submits | One consistent result; only the latest request can update the page | `check.spec` |
| Inputs edited after a result | "You've changed the inputs since this result" | `check.spec` |
| Planner total too small / very large | Keeps it shielded with a reason / explains the leg limit and the withdrawals needed | `plan.spec` |

## Planner correctness

| Failure | What happens | Test |
|---|---|---|
| Legs add up to the deposit minus fees (grouping attack) | Never: the planner searches for the most it can withdraw with no such group, and says what it held back | `plan.spec`; unit tests; real-data check (12 plans) |
| Same schedule for everyone | Fresh random seed per plan | `plan.spec` new schedule |
| Invalid calendar file | RFC 5545, lines folded at 75 octets, one event per leg | `plan.spec`; unit tests |

## Execute through NEAR Intents

| Failure | What happens | Test |
|---|---|---|
| A request to NEAR Intents before the user acts | None: not on opening Execute, not while typing; only on "Get a price" | `execute.spec` |
| Recipient in the wrong format for the chosen chain | Refused locally, zero requests | `execute.spec` |
| Sapling refund address (NEAR Intents rejects it) | Refused locally with a fix (use u1), zero requests | `execute.spec`; `verify-intents.mjs` |
| Transparent refund address | Allowed, with a note that refunds would be public | `execute.spec` |
| NEAR Intents returns an error | Its message is shown | `execute.spec`; unit tests |
| Network failure | "Couldn't reach NEAR Intents" | unit tests |
| Executing a leg before its planned time | Timing warning | `execute.spec` |
| Deposit address, QR or payment link wrong | Address shown verbatim, `zcash:` URI with the exact leg amount, QR drawn from it | `execute.spec`; unit tests |
| Status never updates or never stops | Polled every 15 s until SUCCESS, REFUNDED or FAILED; manual "Check status now" | `execute.spec` |
| CORS or the CSP blocks the real API | A real dry quote from the page works in all three browsers | `execute.spec` with `LIVE_INTENTS=1` |
| The built-in asset list goes stale | Checked against the live token list | `verify-intents.mjs` |

## Money safety (Execute)

| Failure | What happens | Test |
|---|---|---|
| The plan changes while a deposit address is open (reshuffle, new plan) | Impossible: re-planning, reshuffling and other legs are disabled until the payment is closed; each plan remounts its panel | `execute.spec` |
| Closing an open payment loses the swap | Closing asks first and offers "Save and close", which downloads the signed quote | `execute.spec` |
| NEAR Intents returns a quote for another amount, recipient or refund address | Refused; no address, QR or payment link is shown | `execute.spec`; unit tests |
| The returned deposit address is not a valid transparent Zcash address | Refused with "Don't pay it" | `execute.spec`; unit tests |
| The payment link's amount differs from the quote | Can't: the link and QR are built from the verified quote's own amount | `execute.spec` |
| A response arrives after the inputs changed | Dropped; inputs are disabled while a request is in flight; a double click makes one request | code; `execute.spec` |
| A deposit address created days early expires before the planned time | Not offered more than a day before the leg; an expired address hides its QR and link | `execute.spec` |
| A red leg is paid anyway | The deposit address isn't offered for a red leg; a price still is | code |
| A mistyped recipient | Checksums: EIP-55 for mixed-case EVM, Bech32/Bech32m and Base58Check for Bitcoin; length for Solana and NEAR | `execute.spec`; BIP 173/350 and EIP-55 vectors |
| Fees are misstated | The fee NEAR Intents reports in each quote is shown, with the refund fee, value in and out, and a warning above a 5% loss | `execute.spec` |
| A request never answers | Abandoned after 20 s with a clear message; status polling backs off after errors and stops once an unpaid quote expires | unit tests |

## Robustness

| Failure | What happens | Test |
|---|---|---|
| A random user types hostile input everywhere, clicks twice, navigates and resizes | No page error, console error or CSP violation; a heading always on screen; no sideways scrolling | `fuzz.spec` (seeded, 80 steps) |
| An absurdly long pasted address | Refused at once instead of freezing the page or the worker | `robustness.spec`; unit tests |
| Invisible characters pasted with an address | Removed before checking | unit tests |
| A mistyped route (`#/Check/`, `#/nowhere`) | Case and trailing slashes are ignored; unknown pages say so and link to the real ones | `robustness.spec` |
| The phone menu after Back, on Escape, at 400% zoom | Closes on any navigation and on Escape; scrolls when taller than the screen | `robustness.spec` |
| A download stalls | Abandoned after 90 s with "Try again" | code |
| The stale-data banner | Hidden while the data is fresh, shown once it is over two days old (tested with a fixed clock) | `robustness.spec` |
| High-contrast mode | Chart bars and legend swatches keep system colours | CSS |

## Entry Planner and Personal Audit

| Failure | What happens | Test |
|---|---|---|
| The audit index fails to download or is altered | Only the audit is unavailable, with the reason and "Try again"; every other tool keeps working | `audit.spec` altered audit file |
| Running an audit reveals who audits | The index downloads in the background for every visitor; auditing makes zero requests and leaves nothing in the URL | `audit.spec`, `privacy.spec` |
| The audit is pointed at someone else's address | For addresses not entered, only "a link exists" is shown, never the amount, time or address | unit tests; `verify-audit.mjs` |
| Shielded, invalid or duplicate addresses | Explained one by one; a tex1 and its t1 count once | `audit.spec`; unit tests |
| An address that never crossed | "No crossings found", with the dates covered | `audit.spec` |
| Very busy addresses | The most recent 300 deposits and withdrawals are audited, and the page says so | unit tests; `verify-audit.mjs` |
| A long address in a message overflows a phone screen | Messages wrap anywhere | `audit.spec` 320 px |
| Deposit amount empty, invalid or too small for the fee | Specific message, nothing computed | `enter.spec` |
| Advice that moves too little into the pool, or can be summed back up | Replaced: the first option is to deposit everything and leave through the Exit Planner | `verify-entry.mjs` |

## Privacy

| Failure | What happens | Test |
|---|---|---|
| Any request after the snapshot loads | Zero, across a full journey: check with a TEX destination, plan, meter, table, theme | `privacy.spec` |
| Any request to another origin | Zero | `privacy.spec` |
| Amounts left in the address bar or history | Read, then removed with `history.replaceState` | `privacy.spec`, `check.spec` |
| Anything stored except the theme | Nothing: no other localStorage, no sessionStorage, no cookies | `privacy.spec` |
| Third-party code or a policy violation | Strict CSP (`default-src 'none'`), no referrer, no console errors | `privacy.spec` |

## Accessibility

| Failure | What happens | Test |
|---|---|---|
| Automated issues | axe finds no serious or critical issue on every page, both themes, and on a red result | `a11y.spec` (9 audits x 3 browsers) |
| Keyboard-only use | Skip link, form, submit with Enter, focus lands on the result | `a11y.spec` |
| Screen readers don't hear results | Result region is `aria-live`; result heading receives focus | `check.spec` |
| Pages indistinguishable | Each route has its own title; focus moves to the content on navigation | `a11y.spec` |
| Charts unreadable | Every bar focusable with a full text description; table view | `meter.spec` |

## Layout and appearance

| Failure | What happens | Test |
|---|---|---|
| Sideways scrolling | None on any page at 320, 375, 768, 1024 or 1440 px, nor with a red result at 320 px | `layout.spec` |
| Squashed form fields | Side-by-side fields only when the form is wide enough | `layout.spec` |
| Phone menu | Opens, closes on navigation, reports `aria-expanded`; hidden on desktop | `layout.spec` |
| Theme | Dark by default, light persists across reloads, works when storage is blocked | `theme.spec` |

## Speed

| Failure | What happens | Test |
|---|---|---|
| A tool feels slow | Every tool answers within a second in every browser, measured inside the page (median of three; measured: 15 to 95 ms) | `speed.spec`, run last and one browser at a time so nothing competes for the CPU |
| The first check after loading waits for one-time work | The common amounts are computed right after the data loads, while the user is still typing | `speed.spec` |
| The background audit download delays the other tools | It starts after that work, and the tools answer while it runs | `speed.spec`, `audit.spec` |

Playwright's WebKit on Windows is far slower to *drive* than the page is to respond (a click can take
seconds of automation overhead while the app answers in under 100 ms), so WebKit tests get a longer
timeout. `speed.spec` keeps the app itself to a strict budget.

## Bugs these tests found

- Reshuffling a plan while a deposit address was open made the QR ask for the new leg's amount
  against a quote for the old one (found in the October 4 review).
- NEAR Intents' responses were trusted unchecked; the fee shown (0.25%) was not the fee charged
  (0.20%).
- A long pasted address froze the page for seconds; a stalled download spun forever.
- The phone menu stayed open after Back and couldn't reach its last links at 400% zoom.
- The snapshot was rejected when the host decompressed it in transit (Vite preview, many CDNs).
- The phone menu button showed on desktop.
- Deposit fields were squashed inside the form card.
- At 320 px the header, and the form's fieldsets, overflowed the screen by 13–22 px (a fieldset's
  default `min-width: min-content`).
- Amounts passed between pages stayed in the browser history.
- A deposit dated after the withdrawal gave a misleading green instead of an error.
- The planner could choose legs that add up to the deposit minus fees.
- A navigation in the moment between the first render and the router subscribing was missed,
  leaving the old page on screen (reproducible in WebKit).
- NEAR Intents rejects Sapling refund addresses; Turnstile accepted them until the live check
  showed it.
- The Pre-flight Check called a withdrawal an hour after a common deposit green, while an observer
  picking the closest deposit in time would be right 85% of the time (found by the S8 backtest).
- On a phone, an address quoted in an audit message pushed the page 64 px wider than the screen.

## Not covered by automated tests

- A real HTTPS deployment and its response headers (S9, against the live URL).
- Real screen readers (NVDA, VoiceOver); axe and the keyboard test cover the machine-checkable part.
- Very old browsers; the worker reports missing APIs instead of failing silently.
