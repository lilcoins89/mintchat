import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../server/store.mjs';
import { confirmSwap } from '../server/trading.mjs';
import { getPortfolio, mapToolArguments } from '../server/paybox.mjs';
import { getTokenRisk } from '../server/market.mjs';

const mintA = 'So11111111111111111111111111111111111111112';
const mintB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('PayBox portfolio uses only a granted Solana wallet and negotiates MCP headers', async () => {
  const requests = [];
  let portfolioArgs;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ method: body.method, headers: init.headers, body });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers: { 'Mcp-Session-Id': 'mcp-session-1' } });
    if (body.method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'paybox', version: 'test' } } }, 200, { 'Mcp-Session-Id': 'mcp-session-1' });
    }
    if (body.method === 'tools/list') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [
        { name: 'list_credentials', inputSchema: { type: 'object', properties: {}, required: [] } },
        { name: 'get_portfolio', inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] } },
      ] } }, 200, { 'Mcp-Session-Id': 'mcp-session-1' });
    }
    if (body.method === 'tools/call' && body.params.name === 'list_credentials') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ credentials: [
        { credential_id: 'wallet-1', kind: 'wallet', metadata: { chains: ['solana'], address: mintA } },
        { credential_id: 'secret-1', kind: 'secret', metadata: { encrypted: true } },
      ] }) }] } }, 200, { 'Mcp-Session-Id': 'mcp-session-1' });
    }
    if (body.method === 'tools/call' && body.params.name === 'get_portfolio') {
      portfolioArgs = body.params.arguments;
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ balances: [{ symbol: 'SOL', amount: 1.5 }] }) }] } }, 200, { 'Mcp-Session-Id': 'mcp-session-1' });
    }
    throw new Error(`Unexpected mocked MCP method: ${body.method}`);
  };
  const plugin = { url: 'https://api.paybox.sh/mcp', tokenEnv: 'PAYBOX_ACCESS_TOKEN', readTools: ['list_credentials', 'get_portfolio'], writeTools: ['request_swap'] };
  const result = await getPortfolio(plugin, { env: { PAYBOX_ACCESS_TOKEN: 'test-token' }, fetchImpl });

  assert.equal(result.walletAddress, mintA);
  assert.deepEqual(portfolioArgs, { address: mintA });
  assert.equal('credentialId' in result, false);
  assert.equal(requests[0].headers.Authorization, 'Bearer test-token');
  assert.equal(requests[0].headers['MCP-Protocol-Version'], undefined);
  for (const request of requests.slice(1)) {
    assert.equal(request.headers['MCP-Protocol-Version'], '2025-06-18');
    assert.equal(request.headers['Mcp-Session-Id'], 'mcp-session-1');
  }
});

test('PayBox swap arguments use smallest-unit amounts, native SOL, and value cents', () => {
  const tool = {
    inputSchema: {
      type: 'object',
      properties: {
        credential_id: { type: 'string' },
        src_chain: { type: 'string' },
        dst_chain: { type: 'string' },
        src_token: { type: 'string' },
        dst_token: { type: 'string' },
        amount: { type: 'string', description: 'Amount in smallest token units.' },
        slippage_bps: { type: 'integer' },
        value_cents: { type: 'integer' },
        swap_direction: { type: 'string' },
      },
      required: ['credential_id', 'src_chain', 'src_token', 'dst_token', 'amount'],
    },
  };
  assert.deepEqual(mapToolArguments(tool, {
    credentialId: 'wallet-1',
    inputMint: mintA,
    outputMint: mintB,
    inputToken: 'native',
    outputToken: mintB,
    amount: '0.1',
    amountRaw: '100000000',
    slippageBps: 75,
    valueCents: 125,
  }), {
    credential_id: 'wallet-1',
    src_chain: 'solana:mainnet',
    dst_chain: 'solana:mainnet',
    src_token: 'native',
    dst_token: mintB,
    amount: '100000000',
    slippage_bps: 75,
    value_cents: 125,
    swap_direction: 'exact-amount-in',
  });
});

test('server confirmation is rejected while locked or unconfirmed and concurrent confirms submit once', async () => {
  const store = new MemoryStore();
  const sessionId = 'approval-session';
  const approval = {
    id: 'approval-1',
    status: 'pending',
    expiresAt: Date.now() + 60_000,
    quote: { tradeUsd: 10 },
  };
  await store.mutateSession(sessionId, (state) => { state.pendingApproval = structuredClone(approval); });
  const env = { MAX_TRADE_USD: '25', MAX_DAILY_USD: '100' };
  let submissions = 0;
  const submitSwapImpl = async () => {
    submissions += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { data: { status: 'pending_approval', approval_url: 'https://app.paybox.sh/approve/req-1' }, requestId: 'req-1' };
  };
  const args = { sessionId, approvalId: approval.id, confirmed: true, store, payboxPlugin: {}, env, submitSwapImpl };

  await assert.rejects(confirmSwap(args), (error) => error.code === 'trading_locked');
  await store.mutateSession(sessionId, (state) => { state.tradingUnlocked = true; });
  await assert.rejects(confirmSwap({ ...args, confirmed: false }), (error) => error.code === 'confirmation_required');
  assert.equal(submissions, 0);

  const results = await Promise.allSettled([confirmSwap(args), confirmSwap(args)]);
  assert.equal(submissions, 1);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'approval_not_pending');
  const state = await store.loadSession(sessionId);
  assert.equal(state.dailySpentUsd, 10);
  assert.equal(state.pendingApproval.status, 'submitted');
  assert.equal(state.requests.length, 1);
});

test('Jupiter Shield sellability warnings are surfaced as warnings, not a definitive honeypot verdict', async () => {
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    if (target.hostname === 'api.mainnet-beta.solana.com') {
      const request = JSON.parse(init.body);
      let result;
      if (request.method === 'getAccountInfo') result = { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } };
      else if (request.method === 'getTokenSupply') result = { value: { amount: '1000000', decimals: 6 } };
      else if (request.method === 'getTokenLargestAccounts') result = { value: [{ amount: '10000' }, { amount: '9000' }] };
      else throw new Error(`Unexpected RPC method ${request.method}`);
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result });
    }
    if (target.hostname === 'api.dexscreener.com') {
      return jsonResponse({ pairs: [{ chainId: 'solana', dexId: 'test', pairAddress: 'pair', url: 'https://dexscreener.com/solana/pair', baseToken: { name: 'Test Token', symbol: 'TEST', address: mintA }, quoteToken: { name: 'USD Coin', symbol: 'USDC', address: mintB }, priceUsd: '1', liquidity: { usd: 20000 }, volume: { h24: 5000 }, pairCreatedAt: Date.now() - 48 * 60 * 60 * 1000 }] });
    }
    if (target.hostname === 'api.jup.ag') {
      assert.equal(init.headers['x-api-key'], 'jupiter-test-key');
      assert.equal(target.pathname, '/ultra/v1/shield');
      return jsonResponse({ warnings: { [mintB]: [{ type: 'NOT_SELLABLE', message: 'This token is not sellable.', severity: 'critical' }] } });
    }
    throw new Error(`Unexpected mocked provider URL: ${target.href}`);
  };
  const risk = await getTokenRisk(mintB, { env: { JUPITER_API_KEY: 'jupiter-test-key' }, fetchImpl });
  assert.equal(risk.shieldStatus, 'checked');
  assert.equal(risk.honeypotPatternCheck.status, 'warning');
  assert.match(risk.honeypotPatternCheck.message, /not an independent or complete honeypot test/);
  assert.match(risk.warnings.join(' '), /This token is not sellable/);
});


test('swap quote carries verified names and exact addresses for both assets', async () => {
  const { buildSwapQuote } = await import('../server/market.mjs');
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    if (target.hostname === 'api.mainnet-beta.solana.com') {
      const request = JSON.parse(init.body);
      const decimals = request.params[0] === mintA ? 9 : 6;
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { value: { decimals } } });
    }
    if (target.hostname === 'api.dexscreener.com') {
      const query = target.searchParams.get('q');
      const isInput = query === mintA;
      return jsonResponse({ pairs: [{
        chainId: 'solana', dexId: 'test', pairAddress: 'pair', url: 'https://dexscreener.com/solana/pair',
        baseToken: isInput ? { name: 'Wrapped SOL', symbol: 'SOL', address: mintA } : { name: 'USD Coin', symbol: 'USDC', address: mintB },
        quoteToken: isInput ? { name: 'USD Coin', symbol: 'USDC', address: mintB } : { name: 'Wrapped SOL', symbol: 'SOL', address: mintA },
        priceUsd: '100', liquidity: { usd: 50000 }, volume: { h24: 12000 }, pairCreatedAt: Date.now() - 100000000,
      }] });
    }
    if (target.hostname === 'api.jup.ag' && target.pathname === '/swap/v2/order') {
      return jsonResponse({ inAmount: '100000000', outAmount: '1000000', inUsdValue: '10', otherAmountThreshold: '990000', slippageBps: 100, signatureFeeLamports: 5000 });
    }
    throw new Error(`Unexpected mocked provider URL: ${target.href}`);
  };
  const quote = await buildSwapQuote({ inputMint: mintA, outputMint: mintB, amount: '0.1', slippageBps: 100 }, { env: {}, fetchImpl });
  assert.equal(quote.inputName, 'Wrapped SOL');
  assert.equal(quote.inputSymbol, 'SOL');
  assert.equal(quote.outputName, 'USD Coin');
  assert.equal(quote.outputSymbol, 'USDC');
  assert.equal(quote.inputMint, mintA);
  assert.equal(quote.outputMint, mintB);
  assert.equal(quote.estimatedOut, '1');
  assert.equal(quote.minimumOut, '0.99');
});

test('an uncertain PayBox submission is not retried and its cap remains reserved', async () => {
  const store = new MemoryStore();
  const sessionId = 'unknown-outcome-session';
  await store.mutateSession(sessionId, (state) => {
    state.tradingUnlocked = true;
    state.pendingApproval = { id: 'approval-unknown', status: 'pending', expiresAt: Date.now() + 60_000, quote: { tradeUsd: 7 } };
  });
  let submissions = 0;
  const args = {
    sessionId,
    approvalId: 'approval-unknown',
    confirmed: true,
    store,
    payboxPlugin: {},
    env: { MAX_TRADE_USD: '25', MAX_DAILY_USD: '100' },
    submitSwapImpl: async () => { submissions += 1; throw new Error('connection closed after request'); },
  };
  await assert.rejects(confirmSwap(args), (error) => error.code === 'execution_unknown');
  const state = await store.loadSession(sessionId);
  assert.equal(submissions, 1);
  assert.equal(state.dailySpentUsd, 7);
  assert.equal(state.pendingApproval.status, 'unknown');
  await assert.rejects(confirmSwap(args), (error) => error.code === 'approval_not_pending');
  assert.equal(submissions, 1);
});


test('PayBox write path rejects multiple Solana wallets even when the tool schema marks wallet fields optional', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'paybox', version: 'test' } } }, 200, { 'Mcp-Session-Id': 'mcp-multi-wallet' });
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers: { 'Mcp-Session-Id': 'mcp-multi-wallet' } });
    if (body.method === 'tools/list') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [
        { name: 'list_credentials', inputSchema: { type: 'object', properties: {}, required: [] } },
        { name: 'request_swap', inputSchema: { type: 'object', properties: {}, required: [] } },
      ] } }, 200, { 'Mcp-Session-Id': 'mcp-multi-wallet' });
    }
    if (body.method === 'tools/call') {
      calls.push(body.params.name);
      if (body.params.name === 'list_credentials') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ credentials: [
          { credential_id: 'wallet-1', kind: 'wallet', metadata: { chains: ['solana'], address: mintA } },
          { credential_id: 'wallet-2', kind: 'wallet', metadata: { chains: ['solana'], address: mintB } },
        ] }) }] } }, 200, { 'Mcp-Session-Id': 'mcp-multi-wallet' });
      }
    }
    throw new Error(`Unexpected mocked MCP method: ${body.method}`);
  };
  const { submitSwap } = await import('../server/paybox.mjs');
  const plugin = { url: 'https://api.paybox.sh/mcp', tokenEnv: 'PAYBOX_ACCESS_TOKEN', readTools: ['list_credentials'], writeTools: ['request_swap'] };
  const proposal = { quote: { inputMint: mintA, outputMint: mintB, amount: '1', amountRaw: '1000000000', slippageBps: 100, tradeUsd: 10 } };
  await assert.rejects(submitSwap(plugin, proposal, { env: { PAYBOX_ACCESS_TOKEN: 'test-token' }, fetchImpl }), (error) => error.requestSent === false && /exactly one recognizable Solana wallet/.test(error.message));
  assert.deepEqual(calls, ['list_credentials']);
});

test('definite PayBox preflight failure restores the pending approval and releases reserved cents', async () => {
  const store = new MemoryStore();
  const sessionId = 'preflight-session';
  await store.mutateSession(sessionId, (state) => {
    state.tradingUnlocked = true;
    state.pendingApproval = { id: 'approval-preflight', status: 'pending', expiresAt: Date.now() + 60_000, quote: { tradeUsd: 0.001 } };
  });
  const args = {
    sessionId,
    approvalId: 'approval-preflight',
    confirmed: true,
    store,
    payboxPlugin: { url: 'https://api.paybox.sh/mcp', tokenEnv: 'PAYBOX_ACCESS_TOKEN', readTools: ['list_credentials'], writeTools: ['request_swap'] },
    env: { MAX_TRADE_USD: '1', MAX_DAILY_USD: '0.01' },
  };
  await assert.rejects(confirmSwap(args), (error) => error.code === 'submit_preflight_failed' && /No swap request was sent/.test(error.message));
  const state = await store.loadSession(sessionId);
  assert.equal(state.dailySpentUsd, 0);
  assert.equal(state.pendingApproval.status, 'pending');
});
