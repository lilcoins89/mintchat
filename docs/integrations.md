# Integration Notes

## PayBox

The PayBox MCP endpoint in the requested configuration is `https://api.paybox.sh/mcp`. PayBox describes it as streamable HTTP using protocol version `2025-06-18`; MCP authentication uses OAuth 2.1 + PKCE bearer access tokens. `list_credentials` returns a `credential_id`, `kind`, and wallet metadata including chains/address. MintChat requires exactly one recognizable Solana wallet, and it uses a small dedicated wallet. `discover_tokens` is read-only. `get_portfolio` takes a wallet address. `request_swap` takes exact Solana mint addresses (or `native` for SOL), a smallest-unit amount, and optional slippage/value-cent fields. The app reads `PAYBOX_ACCESS_TOKEN` only on the server. Runtime tool schemas are discovered from `tools/list`; unsupported required arguments fail closed. The generic `use_plugin` tool is intentionally not allowlisted because it can invoke dynamically enabled operations.

PayBox's documented operation lifecycle is submit once, keep the returned `request_id`, surface any approval URL, and poll `get_request` until a terminal status. A second `request_swap` can start a second operation, so MintChat never retries it. PayBox reports pending approval/signature/settlement/confirmation states; `success` means confirmed on-chain. Signing is handled in PayBox's signing window, and PayBox may require a passkey approval after MintChat's own explicit confirmation.

Sources: [PayBox MCP connector](https://docs.paybox.sh/connect/mcp), [PayBox MCP tools](https://docs.paybox.sh/reference/mcp-tools), [PayBox SDK & CLI](https://docs.paybox.sh/sdk-cli), [PayBox request lifecycle](https://docs.paybox.sh/concepts/requests).

## Anthropic Messages API

The supplied build requirements name the `mcp-client-2025-04-04` beta and `tool_configuration.allowed_tools`. Anthropic's current connector documentation marks that beta as deprecated and shows a newer MCP toolset format where tool allowlists live in `tools` entries. The app keeps the requested legacy beta selectable by default through `ANTHROPIC_MCP_BETA`; the connector builder can be migrated by changing this setting and its request shape. Anthropic streaming uses named SSE events such as `content_block_start`, `content_block_delta`, `content_block_stop`, and `message_stop`.

Sources: [Anthropic MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector), [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).

## DexScreener and Jupiter

DexScreener's API reference includes pair search and token/pair endpoints. Pair data exposes `priceUsd`, `liquidity.usd`, `volume`, `pairCreatedAt`, `chainId`, and token addresses, which MintChat uses for read-only Solana market summaries.

Jupiter's current Swap V2 order endpoint is `GET https://api.jup.ag/swap/v2/order`. A quote request can omit `taker`, in which case the response contains a quote but no transaction. The quote has amounts, slippage, price impact, route fees, and available network-fee estimates. Jupiter documents keyless requests as rate-limited to 0.5 requests per second; a `JUPITER_API_KEY` can be sent in the `x-api-key` header for higher production limits.

Sources: [DexScreener API reference](https://docs.dexscreener.com/api/reference), [Jupiter Swap V2 Get Order](https://developers.jup.ag/docs/api-reference/swap/order), [Jupiter API key setup](https://developers.jup.ag/docs/portal/setup).

Jupiter's documented Shield endpoint is `/ultra/v1/shield?mints=...` and requires `x-api-key`. It returns warning codes such as `NOT_SELLABLE`, `LOW_LIQUIDITY`, `HAS_MINT_AUTHORITY`, `HAS_FREEZE_AUTHORITY`, `SUSPICIOUS_DEV_ACTIVITY`, and `SUSPICIOUS_TOP_HOLDER_ACTIVITY`. The official Shield page is under Ultra, which Jupiter marks as no longer actively maintained, so treat these as supplementary best-effort provider warnings, not a definitive honeypot verdict. Without the key or a successful response, the relevant check is unavailable/not verified.

Source: [Jupiter Shield API reference](https://developers.jup.ag/docs/api-reference/ultra/shield).

## User-referenced Jupiter MCP repository

The linked [araa47/jupiter-mcp](https://github.com/araa47/jupiter-mcp) README describes a local Python MCP server with token search, balance, security, quote, and transaction-execution tools. Its example configuration requests a `PRIVATE_KEY`, and the repository page does not display a license. MintChat does not copy its implementation, execute its signing tool, or request/store a raw wallet private key. It uses read-only market/quote calls and the PayBox approval path for any later swap request.
