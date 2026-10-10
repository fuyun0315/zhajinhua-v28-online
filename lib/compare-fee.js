'use strict';

/**
 * The compare fee is the last actual bet action's amount. Contributions already
 * paid by the comparing player during this hand count toward that requirement.
 * Only the missing difference is charged; an already-satisfied fee is zero.
 */
function compareTopUp(lastBetAmount, alreadyPaidThisHand) {
  const required = Math.max(0, Math.floor(Number(lastBetAmount) || 0));
  const paid = Math.max(0, Math.floor(Number(alreadyPaidThisHand) || 0));
  return Math.max(0, required - paid);
}

module.exports = { compareTopUp };
