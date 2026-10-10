'use strict';

/**
 * Settle a hand from each player's cumulative contribution (totalBet).
 * comparePlayers(a, b) must return >0 when a wins, 0 for a tie, <0 when b wins.
 * The function does not mutate players or their chip balances.
 */
function settlePotLayers(players, comparePlayers) {
  const seatOrder = new Map(players.map((p, i) => [p.id, i]));
  const contribution = p => Math.max(0, Math.floor(Number(p.totalBet) || 0));
  const totalPot = players.reduce((sum, p) => sum + contribution(p), 0);
  const payouts = new Map();
  const refunds = new Map();
  const layers = [];
  const live = players.filter(p => !p.out && !p.leftRoom);

  const add = (map, id, amount) => {
    if (amount > 0) map.set(id, (map.get(id) || 0) + amount);
  };
  const rankedWinners = contestants => {
    if (!contestants.length) return [];
    let best = contestants[0];
    let tied = [best];
    for (const p of contestants.slice(1)) {
      const c = comparePlayers(p, best);
      if (c > 0) { best = p; tied = [p]; }
      else if (c === 0) tied.push(p);
    }
    return tied.sort((a, b) => seatOrder.get(a.id) - seatOrder.get(b.id));
  };
  const split = (amount, winners) => {
    if (!winners.length || amount <= 0) return [];
    const each = Math.floor(amount / winners.length);
    const remainder = amount % winners.length;
    const result = [];
    winners.forEach((p, i) => {
      const share = each + (i < remainder ? 1 : 0);
      add(payouts, p.id, share);
      result.push({ playerId: p.id, amount: share });
    });
    return result;
  };

  // If everyone has folded/left (possible after disconnect/leave edge cases),
  // refund each player's own contribution rather than destroy virtual chips.
  if (live.length === 0) {
    for (const p of players) {
      const amount = contribution(p);
      add(payouts, p.id, amount);
      add(refunds, p.id, amount);
      if (amount > 0) layers.push({ type: 'refund-no-live-player', from: 0, to: amount, amount, contributors: [p.id], eligible: [], winners: [{ playerId: p.id, amount }] });
    }
    return { totalPot, payouts, refunds, layers };
  }

  const levels = [...new Set(players.map(contribution).filter(v => v > 0))].sort((a, b) => a - b);
  let previous = 0;
  for (const level of levels) {
    const contributors = players.filter(p => contribution(p) >= level);
    const amount = (level - previous) * contributors.length;
    if (amount <= 0) { previous = level; continue; }

    // A layer contributed by exactly one player is uncalled excess, not a pot.
    if (contributors.length === 1) {
      const p = contributors[0];
      add(payouts, p.id, amount);
      add(refunds, p.id, amount);
      layers.push({ type: 'uncalled-refund', from: previous, to: level, amount, contributors: [p.id], eligible: [], winners: [{ playerId: p.id, amount }], refundTo: p.id });
      previous = level;
      continue;
    }

    let eligible = contributors.filter(p => !p.out && !p.leftRoom);
    let type = previous === 0 ? 'main' : 'side';
    let eligibilityOverride = false;

    // When all contributors to a layer folded, the layer is dead money. It must
    // still go to the best remaining hand; this exception is explicitly marked.
    if (eligible.length === 0) {
      eligible = live;
      type = 'dead-money';
      eligibilityOverride = true;
    }

    const winners = rankedWinners(eligible);
    const shares = split(amount, winners);
    layers.push({
      type,
      from: previous,
      to: level,
      amount,
      contributors: contributors.map(p => p.id),
      eligible: eligible.map(p => p.id),
      winners: shares,
      eligibilityOverride
    });
    previous = level;
  }

  const paidTotal = [...payouts.values()].reduce((sum, n) => sum + n, 0);
  if (paidTotal !== totalPot) {
    throw new Error(`Settlement invariant failed: contributions=${totalPot}, payouts=${paidTotal}`);
  }
  return { totalPot, payouts, refunds, layers };
}

module.exports = { settlePotLayers };
