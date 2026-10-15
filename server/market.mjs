import { sanitizeProviderText, validateMintAddress, validateSwapPreview } from './policy.mjs';

const DEFAULT_DEX = 'https://api.dexscreener.com';
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const DEFAULT_JUPITER = 'https://api.jup.ag/swap/v2/order';

function rpcUrl(env) {
  if (env.HELIUS_RPC_URL) return env.HELIUS_RPC_URL;
  if (env.HELIUS_API_KEY) {
    const url = new URL('https://mainnet.helius-rpc.com/');
    url.searchParams.set('api-key', env.HELIUS_API_KEY);
    return url.href;
  }
  return env.SOLANA_RPC_URL || DEFAULT_RPC;
}

function cleanLabel(value, limit = 80) {
  return sanitizeProviderText(String(value ?? ''), limit).replace(/[<>]/g, '');
}

async function readJson(url, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? 10000) });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
  return response.json();
}

export async function searchMarket(query, { env = process.env, fetchImpl = fetch } = {}) {
  const q = sanitizeProviderText(String(query ?? '').trim(), 120);
  if (!q) throw new Error('Enter a token name, symbol, or full mint address.');
  const base = (env.DEXSCREENER_API_BASE || DEFAULT_DEX).replace(/\/$/, '');
  const url = `${base}/latest/dex/search?q=${encodeURIComponent(q)}`;
  const data = await readJson(url, {}, fetchImpl);
  const pairs = (Array.isArray(data?.pairs) ? data.pairs : [])
    .filter((pair) => pair?.chainId === 'solana')
    .sort((a, b) => Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0))
    .slice(0, 6)
    .map((pair) => ({
      chain: 'Solana',
      dex: cleanLabel(pair.dexId),
      pairAddress: cleanLabel(pair.pairAddress, 64),
      pairUrl: typeof pair.url === 'string' && pair.url.startsWith('https://') ? pair.url : null,
      baseToken: { name: cleanLabel(pair.baseToken?.name), symbol: cleanLabel(pair.baseToken?.symbol, 24), address: cleanLabel(pair.baseToken?.address, 64) },
      quoteToken: { name: cleanLabel(pair.quoteToken?.name), symbol: cleanLabel(pair.quoteToken?.symbol, 24), address: cleanLabel(pair.quoteToken?.address, 64) },
      priceUsd: Number.isFinite(Number(pair.priceUsd)) ? Number(pair.priceUsd) : null,
      liquidityUsd: Number.isFinite(Number(pair.liquidity?.usd)) ? Number(pair.liquidity.usd) : null,
      volume24hUsd: Number.isFinite(Number(pair.volume?.h24)) ? Number(pair.volume.h24) : null,
      pairCreatedAt: Number.isFinite(Number(pair.pairCreatedAt)) ? Number(pair.pairCreatedAt) : null,
      pairAgeHours: Number.isFinite(Number(pair.pairCreatedAt)) ? Math.max(0, (Date.now() - Number(pair.pairCreatedAt)) / 3600000) : null,
    }));
  return { source: 'DexScreener', query: q, pairs, unavailable: pairs.length === 0 ? 'No Solana pairs were returned for that search.' : null };
}

async function rpc(method, params, { env = process.env, fetchImpl = fetch } = {}) {
  const response = await readJson(rpcUrl(env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'mintchat', method, params }),
  }, fetchImpl);
  if (response.error) throw new Error(`Solana RPC method ${method} failed.`);
  return response.result;
}

async function getHeliusTokenMetadata(mint, { env = process.env, fetchImpl = fetch } = {}) {
  if (!env.HELIUS_API_KEY) return null;
  const url = new URL(env.HELIUS_TOKEN_METADATA_URL || 'https://api.helius.xyz/v0/token-metadata');
  url.searchParams.set('api-key', env.HELIUS_API_KEY);
  const data = await readJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mintAccounts: [mint] }),
  }, fetchImpl);
  return Array.isArray(data) ? data[0] ?? null : null;
}

async function getJupiterShield(mint, { env = process.env, fetchImpl = fetch } = {}) {
  if (!env.JUPITER_API_KEY) return null;
  const url = new URL(env.JUPITER_SHIELD_API_URL || 'https://api.jup.ag/ultra/v1/shield');
  url.searchParams.set('mints', mint);
  return readJson(url, { headers: { 'x-api-key': env.JUPITER_API_KEY } }, fetchImpl);
}

export async function getTokenRisk(mint, { env = process.env, fetchImpl = fetch } = {}) {
  const address = validateMintAddress(mint);
  const results = await Promise.allSettled([
    rpc('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }], { env, fetchImpl }),
    rpc('getTokenSupply', [address, { commitment: 'confirmed' }], { env, fetchImpl }),
    rpc('getTokenLargestAccounts', [address, { commitment: 'confirmed' }], { env, fetchImpl }),
    searchMarket(address, { env, fetchImpl }),
    getJupiterShield(address, { env, fetchImpl }),
    getHeliusTokenMetadata(address, { env, fetchImpl }),
  ]);
  const account = results[0].status === 'fulfilled' ? results[0].value?.value?.data?.parsed?.info : null;
  const supply = results[1].status === 'fulfilled' ? results[1].value?.value : null;
  const largest = results[2].status === 'fulfilled' ? results[2].value?.value : null;
  const market = results[3].status === 'fulfilled' ? results[3].value : null;
  const shieldData = results[4].status === 'fulfilled' ? results[4].value : null;
  const heliusMetadata = results[5].status === 'fulfilled' ? results[5].value : null;
  const shieldStatus = env.JUPITER_API_KEY && results[4].status === 'fulfilled' && Array.isArray(shieldData?.warnings?.[address]) ? 'checked' : 'unavailable';
  const shieldWarnings = (shieldStatus === 'checked' ? shieldData.warnings[address] : []).slice(0, 12).map((warning) => ({
    type: cleanLabel(warning?.type, 64).toUpperCase(),
    severity: ['info', 'warning', 'critical'].includes(String(warning?.severity).toLowerCase()) ? String(warning.severity).toLowerCase() : 'info',
    message: cleanLabel(warning?.message || warning?.type || 'Provider warning', 220),
  }));
  const warnings = [];

  const mintAuthority = account ? (account.mintAuthority ? 'Active' : 'Revoked') : 'Unavailable';
  const freezeAuthority = account ? (account.freezeAuthority ? 'Active' : 'Revoked') : 'Unavailable';
  if (account?.mintAuthority) warnings.push('Mint authority is active; additional tokens may be minted.');
  if (account?.freezeAuthority) warnings.push('Freeze authority is active; token accounts may be frozen.');

  let topAccountsSharePct = null;
  if (supply?.amount && largest?.length) {
    const total = BigInt(supply.amount);
    const topTen = largest.slice(0, 10).reduce((sum, holder) => sum + BigInt(holder.amount || '0'), 0n);
    if (total > 0n) topAccountsSharePct = Number((topTen * 1000000n) / total) / 10000;
  }
  if (topAccountsSharePct !== null && topAccountsSharePct >= 30) {
    warnings.push(`The ten largest token accounts hold about ${topAccountsSharePct.toFixed(1)}% of supply; accounts are not consolidated into wallet owners.`);
  }

  const bestPair = market?.pairs?.[0];
  if (bestPair?.liquidityUsd !== null && bestPair?.liquidityUsd !== undefined && bestPair.liquidityUsd < 10000) {
    warnings.push('The highest-liquidity pair returned has less than $10,000 liquidity (rule-of-thumb warning).');
  }
  if (bestPair?.pairAgeHours !== null && bestPair?.pairAgeHours !== undefined && bestPair.pairAgeHours < 24) {
    warnings.push('The highest-liquidity pair returned is less than 24 hours old.');
  }

  for (const warning of shieldWarnings) warnings.push(`Jupiter Shield (${warning.severity}): ${warning.message}`);
  const sellRiskTypes = new Set(['NOT_SELLABLE', 'NON_TRANSFERABLE', 'MUTABLE_TRANSFER_FEES']);
  const hasSellRiskPattern = shieldWarnings.some((warning) => sellRiskTypes.has(warning.type) || warning.type.endsWith('_TRANSFER_FEES'));
  const honeypot = hasSellRiskPattern
    ? { status: 'warning', message: 'Jupiter Shield returned an explicit sellability or transfer-fee warning. This is not an independent or complete honeypot test.' }
    : shieldStatus === 'checked'
      ? { status: 'not_verified', message: 'Jupiter Shield returned no sellability-specific warning for this mint; this is not proof that the token is safe or sellable.' }
      : { status: 'unavailable', message: 'Jupiter Shield is unavailable until JUPITER_API_KEY is configured and the provider responds; honeypot status is not verified.' };
  if (results.some((result) => result.status === 'rejected')) {
    warnings.push('One or more independent risk checks were unavailable; review the status fields before acting.');
  }

  return {
    mint: address,
    source: env.HELIUS_API_KEY ? 'Helius RPC + Helius Token Metadata + DexScreener' : 'Solana RPC + DexScreener',
    metadata: heliusMetadata ? {
      name: cleanLabel(heliusMetadata.onChainMetadata?.metadata?.name || heliusMetadata.offChainMetadata?.name, 120) || null,
      symbol: cleanLabel(heliusMetadata.onChainMetadata?.metadata?.symbol || heliusMetadata.offChainMetadata?.symbol, 32) || null,
      verified: heliusMetadata.onChainAccountInfo?.accountInfo?.owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || null,
    } : null,
    mintAuthority,
    freezeAuthority,
    topTenTokenAccountSharePct: topAccountsSharePct,
    holderConcentrationNote: topAccountsSharePct === null ? 'Unavailable; the RPC did not return both supply and largest token accounts.' : 'Top-ten token-account share, not deduplicated wallet-holder concentration.',
    liquidityUsd: bestPair?.liquidityUsd ?? null,
    pairAgeHours: bestPair?.pairAgeHours ?? null,
    shieldStatus,
    shieldWarnings,
    honeypotPatternCheck: honeypot,
    warnings,
  };
}

function toRawAmount(amount, decimals) {
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places for this token.`);
  const raw = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (raw <= 0n) throw new Error('Amount must be greater than zero.');
  return raw.toString();
}

function fromRawAmount(raw, decimals) {
  const n = BigInt(raw);
  const unit = 10n ** BigInt(decimals);
  const whole = n / unit;
  const fraction = (n % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

async function tokenDecimals(mint, context) {
  const result = await rpc('getTokenSupply', [mint, { commitment: 'confirmed' }], context);
  const decimals = Number(result?.value?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Token decimals could not be verified on Solana.');
  return decimals;
}

export async function buildSwapQuote(input, { env = process.env, fetchImpl = fetch } = {}) {
  const request = validateSwapPreview(input);
  const context = { env, fetchImpl };
  const [inputDecimals, outputDecimals] = await Promise.all([
    tokenDecimals(request.inputMint, context),
    tokenDecimals(request.outputMint, context),
  ]);
  const rawAmount = toRawAmount(request.amount, inputDecimals);
  const url = new URL(DEFAULT_JUPITER);
  url.searchParams.set('inputMint', request.inputMint);
  url.searchParams.set('outputMint', request.outputMint);
  url.searchParams.set('amount', rawAmount);
  url.searchParams.set('slippageBps', String(request.slippageBps));
  const headers = {};
  if (env.JUPITER_API_KEY) headers['x-api-key'] = env.JUPITER_API_KEY;
  const quote = await readJson(url, { headers }, fetchImpl);
  if (quote?.error || !quote?.outAmount || !quote?.inAmount) throw new Error(cleanLabel(quote?.errorMessage || quote?.error || 'No executable quote was returned.', 240));
  const outAmount = fromRawAmount(quote.outAmount, outputDecimals);
  const usd = Number(quote.inUsdValue);
  const [inputMarket, outputMarket] = await Promise.all([
    searchMarket(request.inputMint, { env, fetchImpl }).catch(() => null),
    searchMarket(request.outputMint, { env, fetchImpl }).catch(() => null),
  ]);
  const tokenForMint = (market, mint) => {
    const pair = market?.pairs?.find((candidate) => candidate.baseToken.address === mint || candidate.quoteToken.address === mint);
    if (!pair) return null;
    return pair.baseToken.address === mint ? pair.baseToken : pair.quoteToken;
  };
  const inputToken = tokenForMint(inputMarket, request.inputMint);
  const outputToken = tokenForMint(outputMarket, request.outputMint);
  if (!inputToken?.name || !outputToken?.name) throw new Error('A verified token name could not be found for both mints; no swap review was created.');
  const inputPair = inputMarket?.pairs?.find((pair) => pair.baseToken.address === request.inputMint || pair.quoteToken.address === request.inputMint);
  const inputUsd = Number.isFinite(usd) && usd > 0 ? usd : (inputPair?.priceUsd && Number(request.amount) * inputPair.priceUsd);
  if (!Number.isFinite(inputUsd) || inputUsd <= 0) throw new Error('The input value in USD is unavailable, so the server cannot enforce trade caps.');
  const feeParts = [];
  if (Number(quote.feeBps) > 0) feeParts.push(`${(Number(quote.feeBps) / 100).toFixed(2)}% total route fee`);
  if (quote.platformFee?.amount && quote.platformFee.amount !== '0') feeParts.push(`platform fee ${quote.platformFee.amount} raw units`);
  for (const [field, label] of [['signatureFeeLamports', 'signature'], ['prioritizationFeeLamports', 'priority/tip'], ['rentFeeLamports', 'rent']]) {
    const lamports = Number(quote[field]);
    if (Number.isFinite(lamports) && lamports > 0) feeParts.push(`${(lamports / 1e9).toFixed(9)} SOL ${label} estimate`);
  }
  return {
    provider: 'Jupiter Swap V2 order quote',
    chain: 'Solana Mainnet',
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputName: inputToken.name,
    inputSymbol: inputToken.symbol,
    outputName: outputToken.name,
    outputSymbol: outputToken.symbol,
    amount: request.amount,
    amountRaw: rawAmount,
    inputDecimals,
    outputDecimals,
    estimatedOut: outAmount,
    estimatedOutRaw: quote.outAmount,
    minimumOut: quote.otherAmountThreshold ? fromRawAmount(quote.otherAmountThreshold, outputDecimals) : null,
    slippageBps: Number(quote.slippageBps ?? request.slippageBps),
    fees: feeParts.length ? feeParts.join('; ') : 'Provider did not return a fee estimate.',
    tradeUsd: Number(inputUsd),
    priceImpactPct: Number.isFinite(Number(quote.priceImpact)) ? Number(quote.priceImpact) : null,
    route: Array.isArray(quote.routePlan) ? quote.routePlan.slice(0, 5).map((step) => cleanLabel(step?.swapInfo?.label, 48)).filter(Boolean) : [],
    expiresAt: quote.expireAt ?? null,
    requestId: quote.requestId ?? null,
    quoteId: quote.quoteId ?? null,
    source: 'Jupiter',
  };
}
