import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWriteApproval,
  checkTradeCaps,
  modelAllowedTools,
  parseUsdCap,
  PolicyError,
  validateChatPayload,
  validateMintAddress,
  validateSwapPreview,
} from '../server/policy.mjs';

const mintA = 'So11111111111111111111111111111111111111112';
const mintB = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function expectPolicy(code, operation) {
  assert.throws(operation, (error) => error instanceof PolicyError && error.code === code);
}

test('chat input is trimmed, bounded, and rejects non-text values', () => {
  assert.deepEqual(validateChatPayload({ message: '  hi  ' }), { message: 'hi' });
  expectPolicy('invalid_input', () => validateChatPayload({ message: '  ' }));
  expectPolicy('invalid_input', () => validateChatPayload({ message: 'x'.repeat(4001) }));
  expectPolicy('invalid_input', () => validateChatPayload({ message: { text: 'hi' } }));
});

test('Solana mint and swap inputs are validated before provider calls', () => {
  assert.equal(validateMintAddress(mintA), mintA);
  expectPolicy('invalid_input', () => validateMintAddress('fake-token'));
  assert.deepEqual(validateSwapPreview({ inputMint: mintA, outputMint: mintB, amount: '1.25', slippageBps: 100 }), {
    inputMint: mintA, outputMint: mintB, amount: '1.25', slippageBps: 100,
  });
  expectPolicy('invalid_input', () => validateSwapPreview({ inputMint: mintA, outputMint: mintA, amount: '1', slippageBps: 100 }));
  expectPolicy('invalid_input', () => validateSwapPreview({ inputMint: mintA, outputMint: mintB, amount: '0', slippageBps: 100 }));
  expectPolicy('invalid_input', () => validateSwapPreview({ inputMint: mintA, outputMint: mintB, amount: '1', slippageBps: 501 }));
});

test('caps fail closed and reject per-trade and daily-limit overages', () => {
  assert.equal(parseUsdCap('25'), 25);
  assert.equal(parseUsdCap('Infinity'), null);
  expectPolicy('caps_not_configured', () => checkTradeCaps({ tradeUsd: 1, dailySpentUsd: 0, maxTradeUsd: null, maxDailyUsd: 100 }));
  expectPolicy('trade_cap_exceeded', () => checkTradeCaps({ tradeUsd: 25.01, dailySpentUsd: 0, maxTradeUsd: 25, maxDailyUsd: 100 }));
  expectPolicy('daily_cap_exceeded', () => checkTradeCaps({ tradeUsd: 10, dailySpentUsd: 95, maxTradeUsd: 25, maxDailyUsd: 100 }));
  assert.deepEqual(checkTradeCaps({ tradeUsd: 5.25, dailySpentUsd: 10, maxTradeUsd: 25, maxDailyUsd: 100 }), { chargedTradeUsd: 5.25, dailySpentUsd: 15.25 });
});

test('sub-cent trades reserve a cent so repeated quotes cannot bypass the daily cap', () => {
  const first = checkTradeCaps({ tradeUsd: 0.001, dailySpentUsd: 0, maxTradeUsd: 1, maxDailyUsd: 0.01 });
  assert.deepEqual(first, { chargedTradeUsd: 0.01, dailySpentUsd: 0.01 });
  expectPolicy('daily_cap_exceeded', () => checkTradeCaps({ tradeUsd: 0.001, dailySpentUsd: first.dailySpentUsd, maxTradeUsd: 1, maxDailyUsd: 0.01 }));
});

test('server approval rejects locked, unconfirmed, missing, and consumed approvals', () => {
  expectPolicy('trading_locked', () => assertWriteApproval({ tradingUnlocked: false, confirmed: true, pendingStatus: 'pending' }));
  expectPolicy('confirmation_required', () => assertWriteApproval({ tradingUnlocked: true, confirmed: false, pendingStatus: 'pending' }));
  expectPolicy('approval_not_pending', () => assertWriteApproval({ tradingUnlocked: true, confirmed: true, pendingStatus: 'submitted' }));
  assert.equal(assertWriteApproval({ tradingUnlocked: true, confirmed: true, pendingStatus: 'pending' }), undefined);
});

test('model connector never receives write tools, even after unlock', () => {
  const plugin = { readTools: ['get_portfolio', 'request_swap'], writeTools: ['request_swap', 'request_transfer'] };
  assert.deepEqual(modelAllowedTools(plugin), ['get_portfolio']);
});
