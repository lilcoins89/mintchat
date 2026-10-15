# MintChat — Solana Research Desk

A dark, responsive chat PWA for Solana token research and wallet balances. Swaps are locked by default; a quote is read-only, and a PayBox swap request is sent only after a user confirms the full review card. The backend uses Node's built-in HTTP server—**no Express**.

## Stack and safety model

- React + TypeScript + Vite frontend; Node 22 HTTP/SSE backend.
- Anthropic Messages API and remote MCP connector run only on the server; browser bundles never contain API keys.
- PayBox remote MCP supplies `discover_tokens`, wallet/portfolio reads, and request status. Its `request_swap` and `request_transfer` write tools are never exposed to the model. MintChat calls `request_swap` once, only after the server validates a one-use approval created by a user click.
- DexScreener supplies read-only market pairs. Jupiter Swap V2 is used for read-only quotes; it does not return a transaction when MintChat omits `taker`.
- Server-managed MySQL stores opaque browser-session state and tool audit entries. Development and production share the managed database, so migrations and test writes affect the same project database.
- No wallet private key is requested or stored. Grant MintChat exactly one small dedicated Solana wallet in PayBox and keep PayBox's passkey flow enabled; the app fails closed if zero or multiple Solana wallets are granted. Never connect a main wallet.

## Run locally

Requirements: Node 22 and pnpm 11.25.0 (Corepack can activate the pinned package manager).

```sh
pnpm install
cp .env.example .env
# Fill the server-only values in .env; for local plain HTTP use APP_ORIGIN=http://localhost:3000,
# SESSION_COOKIE_SECURE=false, and SESSION_COOKIE_SAMESITE=Lax.
pnpm db:migrate   # only when DATABASE_URL is available; local no-DB mode uses in-memory state
pnpm dev
```

Open `http://localhost:3000`. Live chat needs `ANTHROPIC_API_KEY`; live portfolio/swap requests need a valid scoped PayBox OAuth bearer token in `PAYBOX_ACCESS_TOKEN`; quote retrieval uses Jupiter. Without those credentials, the app displays a setup/unavailable state rather than inventing provider data. Set valid positive `MAX_TRADE_USD` and `MAX_DAILY_USD` values before unlocking trading. Missing or invalid caps fail closed.

The deployed/HTTPS Preview cookie defaults to `SameSite=None; Secure` for embedded use. Do not copy the local HTTP cookie override into Preview or deployment. Configure `APP_ORIGIN` to the app's own public origin when the platform's forwarded host is not available.

## Checks

```sh
pnpm test
pnpm build
pnpm check
```

The tests use local policy/store fakes and do not contact Anthropic, PayBox, Jupiter, DexScreener, or submit live transactions.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required server-side key for chat. |
| `ANTHROPIC_MODEL` | Optional model override; defaults to a Claude Sonnet model. |
| `ANTHROPIC_MCP_BETA` | MCP connector beta header; `.env.example` uses the requested `mcp-client-2025-04-04`. Anthropic's current docs describe that beta as deprecated; update the request format and this setting together if the provider rejects it. |
| `PAYBOX_ACCESS_TOKEN` | Server-only PayBox OAuth bearer access token with a narrowly scoped Solana wallet grant; rotate when it expires. |
| `JUPITER_API_KEY` | Optional for research/chat, but required for Jupiter Shield; without it, quotes use Jupiter's keyless 0.5-request/second tier. Set a key server-side for production quote limits. |
| `MAX_TRADE_USD` | Required positive per-trade USD cap. |
| `MAX_DAILY_USD` | Required positive daily USD cap. |
| `DATABASE_URL` | Managed MySQL DSN supplied by the project runtime; do not commit it. |
| `APP_ORIGIN` | Optional exact origin allowlist, e.g. `https://mintchat.example`. |
| `SESSION_COOKIE_SECURE` / `SESSION_COOKIE_SAMESITE` | Local HTTP override only; HTTPS Preview defaults are Secure + None. |
| `SOLANA_RPC_URL` | Optional trusted Solana JSON-RPC HTTPS endpoint. |
| `DEXSCREENER_API_BASE` | Optional DexScreener API base override. |
| `PORT` | HTTP listen port; defaults to 3000. |

## Adding a plugin

Add a plugin object to `plugins.json` with `name`, HTTPS `url`, `tokenEnv`, `readTools`, and `writeTools`. `transport` is `mcp` for a remote MCP server or `local` for the built-in market adapter. `tokenEnv` is the name of a server environment variable, never the credential value itself. The backend discovers remote tool schemas at runtime and passes the configured **read** tools to Anthropic. Read-only remote plugins can be added by editing configuration only. Write tools remain unavailable to the model; a new money-moving plugin requires a typed, server-enforced confirmation adapter before it can be invoked.

`market-data` is a local adapter declared in the same registry. It calls DexScreener's pair-search API for price, liquidity, volume, pair age, and full token addresses. No API key is required for this read adapter. PayBox `discover_tokens` provides token catalog lookup; avoid the generic `use_plugin` tool because it can invoke dynamically enabled operations.

## Trading lock and caps

1. Every session starts locked. Read-only chat and research remain available.
2. Unlocking trading in the header only enables quote review; it does not execute a transaction.
3. MintChat displays token name, full mint, chain, amount in, estimated output, slippage, fees, and available risk checks. Unavailable fields are labeled.
4. The user must press **Confirm swap** on that exact, expiring review. The backend then re-checks the session lock, one-use approval, quote expiry, and both USD caps before calling PayBox `request_swap` once.
5. The app never retries a money-moving request. It uses the returned `request_id` with PayBox `get_request` for status, and links a confirmed transaction signature to Solscan.

Cap accounting rounds each quoted trade up to the next cent before adding it to daily spend. Even a sub-cent quote therefore consumes at least one cent of cap, and repeated tiny swaps cannot round their spend to zero.

The current anonymous scope tracks daily spend per persistent browser session and resets at 00:00 UTC. Clearing the session cookie starts a new anonymous session; use an authenticated, wallet-scoped cap service before opening this prototype to a broad public audience. A submission with an unknown provider outcome reserves its cap amount until resolved, to avoid a second spend through an uncertain retry.

## Risk-data limitations

Mint/freeze authority comes from parsed Solana mint data. Concentration is the sum of the ten largest **token accounts**, not deduplicated wallet owners; it is labeled as such. Liquidity and pair age refer to the highest-liquidity pair returned for the mint. When `JUPITER_API_KEY` is configured, the app also displays Jupiter Shield warnings, including `NOT_SELLABLE` and suspicious-activity flags; Jupiter marks its Ultra API as no longer actively maintained, so treat Shield as a supplementary best-effort screen. A missing key or provider outage is labeled unavailable. No warning feed proves that a token is safe or sellable. MintChat gives facts only and does not recommend buys or predict prices.

## PWA and deployment

The service worker caches only the public application shell; `/api/*` and private session/chat responses are never cached. A managed container uses the repository's `Dockerfile` and `/api/health` readiness endpoint. HTTPS deployment uses the secure cookie defaults. Do not expose the anonymous trading preview publicly without adding authentication and a wallet-scoped spending policy.

See [`docs/integrations.md`](docs/integrations.md) for source links and provider-specific notes, including why the supplied Jupiter MCP repository's private-key signing example is not used here.
