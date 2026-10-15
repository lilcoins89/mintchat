import { randomUUID } from 'node:crypto';
import { buildSwapQuote, getTokenRisk } from './market.mjs';
import { assertWriteApproval, checkTradeCaps, parseUsdCap, PolicyError, sanitizeProviderText } from './policy.mjs';
import { pollSwap, submitSwap } from './paybox.mjs';

function capsFromEnv(env) {
  return {
    maxTradeUsd: parseUsdCap(env.MAX_TRADE_USD),
    maxDailyUsd: parseUsdCap(env.MAX_DAILY_USD),
  };
}

function normalizeStatus(value) {
  if (typeof value !== 'string') return 'unknown';
  const raw = sanitizeProviderText(value, 48).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (['success', 'succeeded', 'completed', 'confirmed'].includes(raw)) return 'success';
  if (['denied', 'rejected', 'cancelled', 'canceled'].includes(raw)) return 'denied';
  if (['error', 'failed', 'failure'].includes(raw)) return 'error';
  return raw || 'unknown';
}

function safeApprovalUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (url.hostname !== 'paybox.sh' && !url.hostname.endsWith('.paybox.sh')) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function createSwapPreview(input, { sessionId, store, env = process.env, fetchImpl = fetch }) {
  const state = await store.loadSession(sessionId);
  if (!state.tradingUnlocked) throw new PolicyError('trading_locked', 'Trading is locked. Unlock it before requesting a swap review.');
  const [quote, risk] = await Promise.all([
    buildSwapQuote(input, { env, fetchImpl }),
    getTokenRisk(input.outputMint, { env, fetchImpl }).catch(() => ({
      mint: input.outputMint,
      source: 'Solana RPC + DexScreener',
      mintAuthority: 'Unavailable',
      freezeAuthority: 'Unavailable',
      topTenTokenAccountSharePct: null,
      holderConcentrationNote: 'Unavailable; the risk provider did not return this check.',
      liquidityUsd: null,
      pairAgeHours: null,
      shieldStatus: 'unavailable',
      shieldWarnings: [],
      honeypotPatternCheck: { status: 'unavailable', message: 'Risk provider unavailable; no honeypot conclusion can be made.' },
      warnings: ['Risk provider unavailable; review the token independently.'],
    })),
  ]);
  const caps = capsFromEnv(env);
  checkTradeCaps({ tradeUsd: quote.tradeUsd, dailySpentUsd: state.dailySpentUsd, ...caps });
  const id = randomUUID();
  const expiresAt = quote.expiresAt && Number.isFinite(Date.parse(quote.expiresAt))
    ? Math.min(Date.parse(quote.expiresAt), Date.now() + 120000)
    : Date.now() + 120000;
  const proposal = { id, status: 'pending', createdAt: Date.now(), expiresAt, quote, risk };
  await store.mutateSession(sessionId, (current) => {
    if (!current.tradingUnlocked) throw new PolicyError('trading_locked', 'Trading was locked before the swap review could be saved.');
    current.pendingApproval = proposal;
  });
  return proposal;
}

export async function confirmSwap({ sessionId, approvalId, confirmed, store, payboxPlugin, env = process.env, fetchImpl = fetch, submitSwapImpl = submitSwap }) {
  if (typeof approvalId !== 'string' || approvalId.length > 64) throw new PolicyError('invalid_input', 'Swap approval ID is invalid.');
  const caps = capsFromEnv(env);
  const { result: reservation } = await store.mutateSession(sessionId, (state) => {
    const pending = state.pendingApproval;
    assertWriteApproval({
      tradingUnlocked: state.tradingUnlocked,
      confirmed,
      pendingStatus: pending?.id === approvalId ? pending.status : null,
    });
    if (pending.expiresAt <= Date.now()) throw new PolicyError('approval_expired', 'This quote has expired. Create a fresh swap review.');
    const updated = checkTradeCaps({ tradeUsd: pending.quote.tradeUsd, dailySpentUsd: state.dailySpentUsd, ...caps });
    state.dailyDate = new Date().toISOString().slice(0, 10);
    state.dailySpentUsd = updated.dailySpentUsd;
    pending.status = 'submitting';
    pending.submittedAt = Date.now();
    return { proposal: structuredClone(pending), reservedSpendUsd: updated.chargedTradeUsd };
  });
  const { proposal, reservedSpendUsd } = reservation;

  try {
    const response = await submitSwapImpl(payboxPlugin, proposal, { env, fetchImpl });
    const request = response.data && typeof response.data === 'object' ? response.data : {};
    const requestId = typeof response.requestId === 'string' && response.requestId.length <= 180 ? response.requestId : null;
    const status = normalizeStatus(request.status ?? 'submitted');
    const approvalUrl = safeApprovalUrl(request.approval_url ?? request.approvalUrl);
    await store.mutateSession(sessionId, (state) => {
      if (state.pendingApproval?.id === approvalId) state.pendingApproval.status = requestId ? 'submitted' : 'unknown';
      if (requestId) {
        state.requests.unshift({
          requestId,
          approvalId,
          proposal,
          createdAt: Date.now(),
          status,
          approvalUrl,
          signature: null,
        });
        state.requests = state.requests.slice(0, 20);
      }
    });
    if (!requestId) {
      return { status: 'unknown', message: 'PayBox did not return a request ID. The swap was not retried; check PayBox before taking any further action.' };
    }
    return {
      status,
      requestId,
      approvalUrl,
      message: 'PayBox received the request. Poll its status; no second swap request will be sent.',
    };
  } catch (error) {
    if (error?.requestSent === false) {
      await store.mutateSession(sessionId, (state) => {
        const pending = state.pendingApproval;
        if (pending?.id !== approvalId || pending.status !== 'submitting') return;
        state.dailySpentUsd = Math.max(0, Math.round((state.dailySpentUsd - reservedSpendUsd) * 100) / 100);
        pending.status = 'pending';
        delete pending.submittedAt;
      });
      const message = sanitizeProviderText(error?.message || 'PayBox preflight did not pass.', 240);
      throw new PolicyError('submit_preflight_failed', `${message} No swap request was sent. Fix the setup and confirm again before the quote expires.`);
    }
    await store.mutateSession(sessionId, (state) => {
      if (state.pendingApproval?.id === approvalId) state.pendingApproval.status = 'unknown';
    });
    throw new PolicyError('execution_unknown', 'The swap request result could not be confirmed. It was not retried. Check PayBox request history before trying again.');
  }
}

export async function cancelSwap({ sessionId, approvalId, store }) {
  return store.mutateSession(sessionId, (state) => {
    if (state.pendingApproval?.id !== approvalId || state.pendingApproval.status !== 'pending') {
      throw new PolicyError('approval_not_pending', 'This swap can no longer be cancelled from MintChat.');
    }
    state.pendingApproval.status = 'cancelled';
    state.pendingApproval.cancelledAt = Date.now();
    return { status: 'cancelled' };
  });
}

export async function refreshSwapStatus({ sessionId, requestId, store, payboxPlugin, env = process.env, fetchImpl = fetch }) {
  if (typeof requestId !== 'string' || requestId.length > 180) throw new PolicyError('invalid_input', 'Request ID is invalid.');
  const state = await store.loadSession(sessionId);
  const request = state.requests.find((item) => item.requestId === requestId);
  if (!request) throw new PolicyError('not_found', 'This request is not part of the current session.');
  const status = await pollSwap(payboxPlugin, requestId, { env, fetchImpl });
  const updated = normalizeStatus(status?.status ?? status?.request?.status ?? 'unknown');
  let signature = status?.output?.signature ?? status?.output?.transaction_hash ?? status?.transaction_hash ?? status?.signature ?? null;
  if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{40,100}$/.test(signature)) signature = null;
  const approvalUrl = safeApprovalUrl(status?.approval_url ?? status?.approvalUrl ?? request.approvalUrl);
  const terminal = ['success', 'denied', 'error'].includes(updated);
  const message = sanitizeProviderText(typeof status?.reason === 'string' ? status.reason : (typeof status?.message === 'string' ? status.message : ''), 240) || null;
  await store.mutateSession(sessionId, (current) => {
    const target = current.requests.find((item) => item.requestId === requestId);
    if (target) {
      target.status = updated;
      target.signature = signature;
      target.approvalUrl = approvalUrl;
      target.lastPolledAt = Date.now();
    }
    if (terminal && current.pendingApproval?.id === request.approvalId) current.pendingApproval.status = updated;
  });
  return {
    requestId,
    status: updated,
    approvalUrl,
    signature,
    explorerUrl: signature ? `https://solscan.io/tx/${encodeURIComponent(signature)}` : null,
    message,
  };
}
