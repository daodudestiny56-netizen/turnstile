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

## Bugs these tests found

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

## Not covered by automated tests

- A real HTTPS deployment and its response headers (S9, against the live URL).
- Real screen readers (NVDA, VoiceOver); axe and the keyboard test cover the machine-checkable part.
- Very old browsers; the worker reports missing APIs instead of failing silently.
