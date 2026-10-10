'use strict';
const { getActionBase, getBetOptions } = require('./betting-rules');
// Bot choices use the same server-side rule as human players, including the
// seen-card multiplier and per-action (not cumulative-contribution) amounts.
function botBetOptions(requiredBet, chips, seen = false, hasBetAction = true) {
  const stack = Math.max(0, Math.floor(Number(chips) || 0));
  if (hasBetAction && stack > 0 && stack < getActionBase(requiredBet, seen)) return [stack];
  return getBetOptions({ hasBetAction, requiredBet, chips: stack, seen }).map(option => option.amount);
}
module.exports = { botBetOptions };
