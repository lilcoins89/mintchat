const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

export function validateChatPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyError('invalid_input', 'Send a JSON object with a message.');
  }
  if (typeof value.message !== 'string') {
    throw new PolicyError('invalid_input', 'Message must be text.');
  }
  const message = value.message.replace(CONTROL_CHARS, '').trim();
  if (!message || message.length > 4000) {
    throw new PolicyError('invalid_input', 'Message must contain 1–4,000 characters.');
  }
  return { message };
}

export function validateMintAddress(value, field = 'mint address') {
  if (typeof value !== 'string' || !BASE58.test(value)) {
    throw new PolicyError('invalid_input', `Enter a valid Solana ${field}.`);
  }
  return value;
}

export function validateSwapPreview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyError('invalid_input', 'Swap details are missing.');
  }
  const inputMint = validateMintAddress(value.inputMint, 'input mint');
  const outputMint = validateMintAddress(value.outputMint, 'output mint');
  if (inputMint === outputMint) {
    throw new PolicyError('invalid_input', 'Input and output tokens must be different.');
  }
  if (typeof value.amount !== 'string' || !/^(?:0|[1-9]\d{0,19})(?:\.\d{1,12})?$/.test(value.amount)) {
    throw new PolicyError('invalid_input', 'Amount must be a positive decimal string.');
  }
  if (!(Number(value.amount) > 0)) {
    throw new PolicyError('invalid_input', 'Amount must be greater than zero.');
  }
  const slippageBps = Number(value.slippageBps ?? 100);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) {
    throw new PolicyError('invalid_input', 'Slippage must be between 0 and 500 basis points.');
  }
  return { inputMint, outputMint, amount: value.amount, slippageBps };
}

export function parseUsdCap(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const cap = Number(value);
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

function cents(value) {
  const scaled = Number(value) * 100;
  if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER) {
    throw new PolicyError('invalid_trade_value', 'USD amount exceeds the supported cent precision.');
  }
  return Math.ceil(scaled - Number.EPSILON * Math.max(1, Math.abs(scaled)));
}

export function checkTradeCaps({ tradeUsd, dailySpentUsd, maxTradeUsd, maxDailyUsd }) {
  if (!Number.isFinite(tradeUsd) || tradeUsd <= 0) {
    throw new PolicyError('invalid_trade_value', 'The quote does not include a valid input value in USD.');
  }
  if (!Number.isFinite(dailySpentUsd) || dailySpentUsd < 0) {
    throw new PolicyError('invalid_spend_state', 'Daily spend state is invalid; trading is disabled until it is reviewed.');
  }
  if (!Number.isFinite(maxTradeUsd) || maxTradeUsd <= 0 || !Number.isFinite(maxDailyUsd) || maxDailyUsd <= 0) {
    throw new PolicyError('caps_not_configured', 'Trading is disabled until MAX_TRADE_USD and MAX_DAILY_USD are valid positive amounts.');
  }
  const tradeCents = cents(tradeUsd);
  const spentCents = cents(dailySpentUsd);
  const maxTradeCents = cents(maxTradeUsd);
  const maxDailyCents = cents(maxDailyUsd);
  if (tradeCents > maxTradeCents) {
    throw new PolicyError('trade_cap_exceeded', `This trade exceeds the per-trade limit of $${maxTradeUsd.toFixed(2)}.`);
  }
  if (spentCents + tradeCents > maxDailyCents) {
    throw new PolicyError('daily_cap_exceeded', `This trade exceeds the remaining daily limit of $${Math.max(0, maxDailyUsd - dailySpentUsd).toFixed(2)}.`);
  }
  return { chargedTradeUsd: tradeCents / 100, dailySpentUsd: (spentCents + tradeCents) / 100 };
}

export function assertWriteApproval({ tradingUnlocked, confirmed, pendingStatus }) {
  if (!tradingUnlocked) throw new PolicyError('trading_locked', 'Trading is locked. Unlock trading before confirming a swap.');
  if (confirmed !== true) throw new PolicyError('confirmation_required', 'The user must explicitly confirm this exact swap in the UI.');
  if (pendingStatus !== 'pending') throw new PolicyError('approval_not_pending', 'This swap approval is missing, expired, or already used.');
}

export function modelAllowedTools(plugin) {
  const writeTools = new Set(plugin.writeTools ?? []);
  return (plugin.readTools ?? []).filter((tool) => !writeTools.has(tool));
}

export function sanitizeProviderText(value, limit = 2000) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, '').replace(/<\/?(?:script|iframe|object|embed)[^>]*>/gi, '').slice(0, limit);
}

export function assertJsonObject(value, label = 'Request body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyError('invalid_input', `${label} must be a JSON object.`);
  }
  return value;
}
