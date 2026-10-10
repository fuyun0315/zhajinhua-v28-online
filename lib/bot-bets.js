'use strict';

// A bot must always be able to choose the exact call amount when its stack
// covers the current required bet. Optional raises are increments above call.
function botBetOptions(requiredBet, chips) {
  const call = Math.max(0, Math.floor(Number(requiredBet) || 0));
  const stack = Math.max(0, Math.floor(Number(chips) || 0));
  if (call <= 0 || stack < call) return [];
  return [call, call + 20, call + 40].filter(amount => amount <= stack);
}

module.exports = { botBetOptions };
