'use strict';

const FIXED_BETS = [20, 40, 60];
const RAISE_INCREMENTS = [20, 40, 60];
function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

// The amount paid in this action is based only on the previous player's
// actual last action. A seen player doubles that previous action first, then
// adds the selected raise increment. This player's cumulative hand contribution
// is deliberately not an input to this calculation.
function getActionBase(requiredBet, seen = false) {
  const previousAction = Math.max(20, asInt(requiredBet, 20));
  return previousAction * (seen ? 2 : 1);
}

function getBetOptions({ hasBetAction, requiredBet, chips, seen = false }) {
  const stack = asInt(chips);
  const base = getActionBase(requiredBet, seen);
  const options = !hasBetAction
    ? FIXED_BETS.map(amount => ({ mode: 'open', amount }))
    : [
        { mode: 'call', amount: base },
        ...RAISE_INCREMENTS.map(increment => ({ mode: 'raise', amount: base + increment }))
      ];
  return options.filter(option => option.amount <= stack);
}

function validateBetAction({ hasBetAction, requiredBet, chips, seen = false, mode, amount }) {
  const n = Number(amount);
  if (!Number.isSafeInteger(n) || n < 0) return { ok: false, reason: '下注金额必须是非负整数。' };
  const stack = asInt(chips);
  const base = getActionBase(requiredBet, seen);
  const options = getBetOptions({ hasBetAction, requiredBet, chips: stack, seen });
  const found = options.find(option => option.mode === mode && option.amount === n);
  if (found) return { ok: true, amount: found.amount, payAmount: found.amount, mode: found.mode };

  // Short stacks may commit their remaining chips as an all-in call/open.
  if (hasBetAction && mode === 'call' && n === base && stack > 0 && stack < base) {
    return { ok: true, amount: base, payAmount: stack, mode: 'allin-call', allIn: true };
  }
  if (!hasBetAction && mode === 'open' && FIXED_BETS.includes(n) && stack > 0 && stack < n) {
    return { ok: true, amount: n, payAmount: stack, mode: 'allin-open', allIn: true };
  }
  if (!hasBetAction && mode !== 'open') return { ok: false, reason: '本局首次下注只能选择下注20、下注40或下注60。' };
  if (hasBetAction && mode === 'open') return { ok: false, reason: '本局已开始下注，请选择跟注或加注20、40、60。' };
  if (n > stack) return { ok: false, reason: '本次下注金额超过当前可用筹码。' };
  return { ok: false, reason: '下注选项无效，请使用牌桌上的固定按钮。' };
}
module.exports = { FIXED_BETS, RAISE_INCREMENTS, getActionBase, getBetOptions, validateBetAction };
