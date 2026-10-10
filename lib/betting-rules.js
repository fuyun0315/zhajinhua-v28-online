'use strict';

const FIXED_BETS = [20, 40, 60];
const RAISE_INCREMENTS = [20, 40, 60];

function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

// `amount` is the target contribution for this hand, not the amount to deduct.
// The server deducts only the difference between the target and this player's
// existing contribution, so a player never pays the same contribution twice.
function getBetOptions({ hasBetAction, requiredBet, chips, roundBet = 0 }) {
  const stack = asInt(chips);
  const paid = asInt(roundBet);
  const callTarget = Math.max(20, asInt(requiredBet, 20));
  const targets = !hasBetAction
    ? FIXED_BETS.map(amount => ({ mode: 'open', amount }))
    : [
        { mode: 'call', amount: callTarget },
        ...RAISE_INCREMENTS.map(increment => ({ mode: 'raise', amount: callTarget + increment }))
      ];
  return targets.filter(option => Math.max(0, option.amount - paid) <= stack);
}

function validateBetAction({ hasBetAction, requiredBet, chips, roundBet = 0, mode, amount }) {
  const n = Number(amount);
  if (!Number.isSafeInteger(n) || n < 0) return { ok: false, reason: '下注金额必须是非负整数。' };
  const stack = asInt(chips);
  const paid = asInt(roundBet);
  const callTarget = Math.max(20, asInt(requiredBet, 20));
  const options = getBetOptions({ hasBetAction, requiredBet: callTarget, chips: stack, roundBet: paid });
  const found = options.find(option => option.mode === mode && option.amount === n);
  if (found) {
    const payAmount = Math.max(0, found.amount - paid);
    return { ok: true, amount: found.amount, payAmount, mode: found.mode };
  }

  // Short-stack call: only a genuine call request is allowed to commit the
  // remaining stack. The client cannot choose an arbitrary amount to force it.
  if (hasBetAction && mode === 'call' && n === callTarget) {
    const due = Math.max(0, callTarget - paid);
    if (stack > 0 && stack < due) return { ok: true, amount: callTarget, payAmount: stack, mode: 'allin-call', allIn: true };
  }

  // A short stack may choose one of the fixed opening buttons and commit its
  // remaining chips. The client cannot submit a custom amount: the requested
  // button must still be exactly 20, 40, or 60.
  if (!hasBetAction && mode === 'open' && FIXED_BETS.includes(n) && stack > 0) {
    const due = Math.max(0, n - paid);
    if (stack < due) return { ok: true, amount: n, payAmount: stack, mode: 'allin-open', allIn: true };
  }
  if (!hasBetAction && mode !== 'open') return { ok: false, reason: '本局首次下注只能选择下注20、下注40或下注60。' };
  if (hasBetAction && mode === 'open') return { ok: false, reason: '本局已开始下注，请选择跟注或加注20、40、60。' };
  if (n > stack + paid) return { ok: false, reason: '本次金额超过当前可用筹码。' };
  return { ok: false, reason: '下注选项无效，请使用牌桌上的固定按钮。' };
}

module.exports = { FIXED_BETS, RAISE_INCREMENTS, getBetOptions, validateBetAction };
