import { McpClient, textFromMcpResult } from './mcp.mjs';
import { sanitizeProviderText } from './policy.mjs';

function decodeResult(result) {
  const text = textFromMcpResult(result);
  if (!text) return result;
  try { return JSON.parse(text); } catch { return { message: sanitizeProviderText(text, 2400) }; }
}

function credentialRecord(result) {
  const data = decodeResult(result);
  const rows = data?.credentials ?? data?.items ?? data?.data ?? [];
  const credentials = Array.isArray(rows) ? rows : [];
  const wallets = credentials.filter((item) => {
    const body = item?.credential ?? item;
    const metadata = body?.metadata ?? item?.metadata ?? {};
    const kind = String(body?.kind ?? body?.type ?? item?.kind ?? item?.type ?? '').toLowerCase();
    const address = metadata?.address ?? body?.address ?? item?.address;
    const chains = metadata?.chains ?? body?.chains ?? item?.chains;
    const hasSolanaChain = Array.isArray(chains) && chains.some((chain) => String(chain).toLowerCase().includes('solana'));
    const unknownChainButBase58 = !Array.isArray(chains) && typeof address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    return kind === 'wallet' && (hasSolanaChain || unknownChainButBase58);
  });
  const record = wallets.length === 1 ? wallets[0] : null;
  if (!record) return { data, credentialId: null, walletAddress: null };
  const body = record.credential ?? record;
  const metadata = body.metadata ?? record.metadata ?? {};
  const credentialId = body.credential_id ?? record.credential_id ?? body.credentialId ?? record.credentialId ?? body.id ?? record.id ?? null;
  const candidateAddress = metadata.address ?? metadata.walletAddress ?? body.address ?? body.walletAddress ?? body.wallet_address ?? body.publicKey ?? record.address ?? record.walletAddress ?? null;
  const walletAddress = typeof candidateAddress === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(candidateAddress) ? candidateAddress : null;
  return { data, credentialId, walletAddress };
}

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function valueForProperty(key, schema, values) {
  const normalized = normalizedKey(key);
  if (normalized.includes('credential')) return values.credentialId ?? null;
  if (normalized.includes('requestid')) return values.requestId ?? null;
  if (normalized.includes('srcchain') || normalized.includes('sourcechain') || normalized === 'chain') {
    const options = schema?.enum ?? [];
    return options.find((value) => String(value).includes('solana')) ?? 'solana:mainnet';
  }
  if (normalized.includes('dstchain') || normalized.includes('destinationchain')) {
    const options = schema?.enum ?? [];
    return options.find((value) => String(value).includes('solana')) ?? 'solana:mainnet';
  }
  if (normalized.includes('valuecents')) return values.valueCents ?? null;
  if (normalized === 'swapdirection') return 'exact-amount-in';
  if (normalized.includes('src') || normalized.includes('inputmint') || normalized.includes('sourcetoken') || normalized.includes('tokenin') || normalized.includes('fromtoken')) return values.inputToken ?? values.inputMint ?? null;
  if (normalized.includes('dst') || normalized.includes('outputmint') || normalized.includes('destinationtoken') || normalized.includes('tokenout') || normalized.includes('totoken')) return values.outputToken ?? values.outputMint ?? null;
  if (normalized.includes('slippage')) return values.slippageBps ?? null;
  if (normalized.includes('amount')) {
    const description = String(schema?.description ?? '').toLowerCase();
    return description.includes('smallest') || description.includes('raw') ? values.amountRaw : values.amount;
  }
  if (normalized.includes('address') || normalized.includes('wallet')) return values.walletAddress ?? null;
  if (normalized.includes('network')) return schema?.enum?.find((value) => String(value).toLowerCase().includes('solana')) ?? 'solana';
  return null;
}

export function mapToolArguments(tool, values) {
  const properties = tool?.inputSchema?.properties ?? {};
  const required = tool?.inputSchema?.required ?? [];
  const args = {};
  for (const [key, schema] of Object.entries(properties)) {
    const value = valueForProperty(key, schema, values);
    if (value !== null && value !== undefined) args[key] = value;
  }
  const missing = required.filter((key) => args[key] === undefined);
  if (missing.length) {
    throw new Error(`PayBox tool schema requires unsupported fields: ${missing.join(', ')}. No request was sent.`);
  }
  return args;
}

export function createPayboxClient(plugin, env = process.env, fetchImpl = fetch) {
  const token = plugin.tokenEnv ? env[plugin.tokenEnv] : undefined;
  if (!token) throw new Error('PayBox is not configured. Add its server-side OAuth bearer access token to the project environment.');
  return new McpClient({ url: plugin.url, token, fetchImpl });
}

async function getTool(client, name) {
  const tools = await client.listTools();
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`The connected PayBox server does not expose ${name}.`);
  return tool;
}

export async function getPortfolio(plugin, { env = process.env, fetchImpl = fetch } = {}) {
  const client = createPayboxClient(plugin, env, fetchImpl);
  const credentialsTool = await getTool(client, 'list_credentials');
  if (!plugin.readTools.includes('list_credentials')) throw new Error('list_credentials is not enabled in plugins.json.');
  const credentials = credentialRecord(await client.callTool(credentialsTool.name, {}));
  if (!credentials.credentialId || !credentials.walletAddress) throw new Error('PayBox must grant exactly one recognizable Solana wallet to this session. Use a small dedicated wallet, not a main wallet.');
  const portfolioTool = await getTool(client, 'get_portfolio');
  if (!plugin.readTools.includes('get_portfolio')) throw new Error('get_portfolio is not enabled in plugins.json.');
  const args = mapToolArguments(portfolioTool, credentials);
  const portfolio = decodeResult(await client.callTool(portfolioTool.name, args));
  return {
    connected: true,
    walletAddress: credentials.walletAddress,
    portfolio,
  };
}

export async function submitSwap(plugin, proposal, { env = process.env, fetchImpl = fetch } = {}) {
  let requestSent = false;
  try {
    if (!plugin?.writeTools?.includes('request_swap')) throw new Error('request_swap is not enabled in plugins.json.');
    const client = createPayboxClient(plugin, env, fetchImpl);
    const tools = await client.listTools();
    const listTool = tools.find((item) => item.name === 'list_credentials');
    const swapTool = tools.find((item) => item.name === 'request_swap');
    if (!listTool || !swapTool) throw new Error('PayBox must expose list_credentials and request_swap.');
    const credentials = credentialRecord(await client.callTool(listTool.name, {}));
    if (!credentials.credentialId || !credentials.walletAddress) throw new Error('PayBox must grant exactly one recognizable Solana wallet. Use a small dedicated wallet, not a main wallet.');
    const args = mapToolArguments(swapTool, {
      ...credentials,
      inputMint: proposal.quote.inputMint,
      outputMint: proposal.quote.outputMint,
      inputToken: proposal.quote.inputMint === 'So11111111111111111111111111111111111111112' ? 'native' : proposal.quote.inputMint,
      outputToken: proposal.quote.outputMint === 'So11111111111111111111111111111111111111112' ? 'native' : proposal.quote.outputMint,
      amount: proposal.quote.amount,
      amountRaw: proposal.quote.amountRaw,
      slippageBps: proposal.quote.slippageBps,
      valueCents: Math.round(proposal.quote.tradeUsd * 100),
    });
    requestSent = true;
    const raw = await client.callTool(swapTool.name, args);
    const data = decodeResult(raw);
    const candidate = data?.request_id ?? data?.requestId ?? data?.id ?? null;
    const requestId = typeof candidate === 'string' && candidate.length <= 180 ? sanitizeProviderText(candidate, 180) : null;
    return { data, client, requestId };
  } catch (error) {
    const safe = error instanceof Error ? error : new Error('PayBox swap preflight failed.');
    if (!requestSent) safe.requestSent = false;
    throw safe;
  }
}

export async function pollSwap(plugin, requestId, { env = process.env, fetchImpl = fetch } = {}) {
  if (!plugin.readTools.includes('get_request')) throw new Error('get_request is not enabled in plugins.json.');
  const client = createPayboxClient(plugin, env, fetchImpl);
  const tool = await getTool(client, 'get_request');
  const args = mapToolArguments(tool, { requestId });
  const raw = await client.callTool(tool.name, args);
  return decodeResult(raw);
}
