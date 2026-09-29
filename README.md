# Turnstile

Zcash's shielded pool hides you inside, but its entrance and exit are public.
Turnstile measures how badly that leaks, warns you before you leak, and plans your exit so you blend in —
without ever sending your plans to a server.

Built for [Zecathon](https://thezecathon.com/) (Cross-Chain track). See [PRD.md](PRD.md) for scope and
[docs/turnstile-design.md](docs/turnstile-design.md) for the design.

## Development

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Layout

| Path | Purpose |
|---|---|
| `packages/core` | `@turnstile/core` — scoring and planning engine (browser + Node) |
| `packages/ingest` | Chain data ingestion and boundary-event derivation |
| `packages/intents` | NEAR Intents 1Click adapter |
| `apps/cli` | `turnstile` command-line interface |

## License

MIT
