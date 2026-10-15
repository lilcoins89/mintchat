# MintChat — Implementation Plan

## Product and architecture

Build a clean, smooth, responsive Solana research/trading-agent chat PWA. The browser talks only to this project's same-origin backend; it never receives Anthropic or plugin credentials. Use React + TypeScript + Vite for the UI and a small Node.js HTTP server built from Node's built-in APIs (no Express) for APIs, SSE, sessions, tool orchestration, and static production serving. Use the initialized managed MySQL database for durable anonymous session records, chat history, daily spend accounting, pending approvals, and tool-call audit records. Run deterministic migrations from the server startup path.

The backend calls Anthropic's Messages API with the MCP connector and `mcp-client-2025-04-04` beta header. A registry loads `plugins.json`; remote MCP entries provide server URL, token environment-variable name, and separate read/write tool allowlists. Paybox at `https://api.paybox.sh/mcp` supplies wallet/portfolio, token lookup, and swaps. A local, read-only DexScreener adapter supplies price, liquidity, volume, pair age, and pairs; its declaration remains in `plugins.json`. Adding a remote MCP plugin is configuration-only. The server exposes streaming replies over SSE and renders tool activity as user-visible, collapsible steps.

Create opaque, server-managed per-browser sessions. Keep each session's chat history, lock state, pending trade, and spend totals in MySQL; never trust client-side amounts or approval flags. A swap proposal becomes a one-use, expiring server-side approval record. The browser must display the full quote and collect Confirm/Cancel; the server verifies session ownership, exact proposal, expiry, lock status, one-time consumption, and `MAX_TRADE_USD`/`MAX_DAILY_USD` before dispatch. A write request is never retried; uncertain results transition to status polling. Unit tests use mocks and never call live money-moving tools. Tool outputs are untrusted data and must not become instructions.

Use only available/provider-returned facts. Always show full token addresses, never predict prices or recommend buying, and ask one short question when ambiguous. Surface liquidity, pair age, holder concentration, mint/freeze authority, and honeypot-pattern warnings when supported; report unavailable checks explicitly rather than inventing data. Rate-limit and validate API input, restrict cross-origin access to the app's own configured origin (same-origin by default), and log tool calls with timestamp and session ID without logging credentials.

## Project structure

- `src/`: React/TypeScript app shell, chat composer/transcript, collapsible tool steps, trade-approval card, header/lock state, portfolio sidebar, accessible responsive styling.
- `server/`: built-in Node HTTP routes, Anthropic streaming, session handling, plugin registry/MCP allowlists, DexScreener local adapter, trade approval/cap enforcement, input validation, audit logging, and database access.
- `db/migrations/`: repeatable schema migrations for session state, chat, approvals, daily totals, and audit trail.
- `public/`: app-owned web manifest, app icons, service worker, and `/manus-routes.json`.
- `tests/`: node:test suites for lock enforcement, trade/daily caps, input validation, and mock-based server behavior.
- Root: `plugins.json`, `.env.example`, `BUILD_PROMPT.md`, `README.md`, `package.json`, lockfile, `vite.config.ts`, `tsconfig.json`, `Dockerfile`, and `app.config.ts`.

## Design direction

Three distinct directions considered (sampled from the low-probability tail):

1. **Signalroom / calm instrument panel — 0.068** (chosen): a precise, quiet market cockpit that keeps the conversation primary and trade risks unmistakable.
2. **Solstice field-notes — 0.041**: an organic token-research notebook with warm paper-like surfaces and botanical accents.
3. **Arcade chain terminal — 0.019**: a nostalgic neon trading console with hard-edged panels and vivid status colors.

### Chosen style: Signalroom / calm instrument panel

- **Design movement:** Swiss International Typographic Style meets a contemporary flight-deck instrument panel; information density is controlled rather than decorative.
- **Core principles:** clear hierarchy; persistent, unmistakable safety state; calm surfaces with high-contrast data; responsive layouts that keep the next action obvious.
- **Color philosophy:** near-black ink and blue-charcoal create a low-glare workspace; soft mineral text avoids harsh white; one sea-glass green marks active/positive states, while amber and restrained coral are reserved for caution and danger.
- **Layout paradigm:** asymmetric three-zone frame—narrow navigation rail, conversation as the flexible central workspace, and a compact portfolio/risk inspector on the right; on mobile, collapse the inspector into a labeled drawer and preserve the conversation.
- **Signature elements:** a small orbital-ring MintChat mark; monospaced address/amount capsules; hairline connector rules and status dots that make tool activity feel traceable.
- **Interaction philosophy:** low-friction read-only exploration; explicit, high-salience confirmation for every money-moving action; no ambiguous toggles or silent state changes.
- **Animation:** short 140–200 ms fades/slides for panel and tool-step transitions, restrained stream cursor, no looping decoration; disable nonessential motion under `prefers-reduced-motion`.
- **Typography system:** Space Grotesk for interface/headings and IBM Plex Mono for addresses, amounts, signatures, and machine states, with system fallbacks and a consistent compact numeric scale.
- **Brand essence:** a measured Solana research desk for people who want token facts before any trade; personality: precise, calm, vigilant.
- **Brand voice:** plain and direct; e.g. “Trading is locked. Research is still available.” and “Review the full quote before you confirm.”
- **Wordmark & logo:** a custom two-orbit speech/coin glyph paired with a carefully spaced MintChat wordmark; not a default-font logo.
- **Signature brand color:** sea-glass mint `#8FFFD2`, used sparingly for active read-only states and focus accents, never as the only safety signal.

## Material constraints and decisions

- No Express; no API keys in browser bundles, logs, prompt files, or Git.
- Live Anthropic/Paybox execution depends on runtime credentials supplied outside source control. `.env.example` documents names and safe defaults; tests use mocks and do not submit transactions.
- `MAX_TRADE_USD` and `MAX_DAILY_USD` are mandatory server-side settings with conservative documented examples; invalid/missing caps fail closed for write actions.
- Daily cap accounting is per persistent server-side session, reflecting the requested per-session state. It resets at UTC day boundary.
- Provider availability determines which security checks can be populated. Missing provider data is labeled unavailable, not simulated.
- The app is same-origin; production/preview session cookies use `SameSite=None; Secure` for embedded HTTPS, with an explicit local-HTTP development override documented separately.
- The project is not published unless the user explicitly requests publication. A private GitHub canonical repository will be connected using the platform's owner-confirmed workflow, not by bypassing that flow with direct repository creation.
