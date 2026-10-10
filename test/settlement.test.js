'use strict';
const assert = require('node:assert/strict');
const { settlePotLayers } = require('../lib/settlement');
const { rank, compareRanks, is235, compareHands } = require('../lib/hand-rank');
const { compareTopUp } = require('../lib/compare-fee');
const { botBetOptions } = require('../lib/bot-bets');
const { getBetOptions, validateBetAction } = require('../lib/betting-rules');

const cmp = (a, b) => (a.power || 0) - (b.power || 0);
const player = (id, totalBet, power, out = false, chips = 1000) => ({ id, name: id, totalBet, power, out, leftRoom: false, chips, cards: [] });
const sum = map => [...map.values()].reduce((n, x) => n + x, 0);


// Special 2-3-5 rule: 235 beats any leopard, regardless of suits.
{
  const hand235 = [{r:'2',s:'♠'},{r:'3',s:'♥'},{r:'5',s:'♦'}];
  const leopard = [{r:'A',s:'♠'},{r:'A',s:'♥'},{r:'A',s:'♦'}];
  const ordinary = [{r:'K',s:'♠'},{r:'Q',s:'♥'},{r:'9',s:'♦'}];
  assert.equal(is235(hand235), true);
  assert.equal(compareHands(hand235, leopard), 1);
  assert.equal(compareHands(leopard, hand235), -1);
  assert.equal(compareHands(hand235, ordinary), compareRanks(rank(hand235), rank(ordinary)));
  const r = settlePotLayers([
    { ...player('235', 100, 0), cards: hand235 },
    { ...player('AAA', 100, 0), cards: leopard }
  ], (a, b) => compareHands(a.cards, b.cards));
  assert.equal(r.payouts.get('235'), 200);
}

// Compare fee is the last actual bet amount minus contributions already paid this hand.
{
  assert.equal(compareTopUp(100, 80), 20);
  assert.equal(compareTopUp(100, 100), 0);
  assert.equal(compareTopUp(100, 120), 0);
  assert.equal(compareTopUp(100, 0), 100);
  assert.equal(compareTopUp(20, 50), 0);
}


// V38: action amount is based on the independent dark-bet baseline;
// seen players double that amount first, then add the selected raise increment.
// The current player's cumulative contribution never affects the next action.
{
  assert.deepEqual(botBetOptions(20, 1000), [20, 40, 60, 80]);
  assert.deepEqual(botBetOptions(20, 1000, true), [40, 60, 80, 100]);
  assert.deepEqual(botBetOptions(40, 1000), [40, 60, 80, 100]);
  assert.deepEqual(botBetOptions(40, 1000, true), [80, 100, 120, 140]);
  assert.deepEqual(botBetOptions(100, 100), [100]);
  assert.deepEqual(botBetOptions(100, 99), [99]); // short stack can commit its remaining chips

  assert.deepEqual(getBetOptions({ hasBetAction: false, requiredBet: 20, chips: 1000 }), [
    { mode: 'open', amount: 20 }, { mode: 'open', amount: 40 }, { mode: 'open', amount: 60 }
  ]);
  assert.deepEqual(getBetOptions({ hasBetAction: true, requiredBet: 40, chips: 1000, roundBet: 80 }), [
    { mode: 'call', amount: 40 }, { mode: 'raise', amount: 60 }, { mode: 'raise', amount: 80 }, { mode: 'raise', amount: 100 }
  ]);
  assert.deepEqual(getBetOptions({ hasBetAction: true, requiredBet: 20, chips: 1000, seen: true }), [
    { mode: 'call', amount: 40 }, { mode: 'raise', amount: 60 }, { mode: 'raise', amount: 80 }, { mode: 'raise', amount: 100 }
  ]);
  assert.deepEqual(getBetOptions({ hasBetAction: true, requiredBet: 60, chips: 1000, seen: true }), [
    { mode: 'call', amount: 120 }, { mode: 'raise', amount: 140 }, { mode: 'raise', amount: 160 }, { mode: 'raise', amount: 180 }
  ]);

  assert.equal(validateBetAction({ hasBetAction: false, requiredBet: 20, chips: 1000, mode: 'open', amount: 40 }).payAmount, 40);
  // Previous action was 40. Even though this player has contributed 80,
  // an unseen call costs 40, not 0 and not a cumulative-contribution delta.
  const callAfterLargeContribution = validateBetAction({ hasBetAction: true, requiredBet: 40, chips: 1000, roundBet: 80, mode: 'call', amount: 40 });
  assert.equal(callAfterLargeContribution.ok, true);
  assert.equal(callAfterLargeContribution.payAmount, 40);
  // Seen call doubles the previous action, while seen raise doubles only the
  // previous action and then adds the selected increment (not doubled).
  assert.equal(validateBetAction({ hasBetAction: true, requiredBet: 20, chips: 1000, seen: true, mode: 'call', amount: 40 }).payAmount, 40);
  assert.equal(validateBetAction({ hasBetAction: true, requiredBet: 20, chips: 1000, seen: true, mode: 'raise', amount: 60 }).payAmount, 60);
  assert.equal(validateBetAction({ hasBetAction: true, requiredBet: 60, chips: 1000, seen: true, mode: 'raise', amount: 100 }).ok, false);
  assert.equal(validateBetAction({ hasBetAction: true, requiredBet: 60, chips: 1000, seen: true, mode: 'raise', amount: 160 }).payAmount, 160);
  assert.equal(validateBetAction({ hasBetAction: false, requiredBet: 20, chips: 1000, mode: 'raise', amount: 40 }).ok, false);
  assert.equal(validateBetAction({ hasBetAction: true, requiredBet: 40, chips: 1000, mode: 'open', amount: 40 }).ok, false);
  const shortOpen = validateBetAction({ hasBetAction: false, requiredBet: 20, chips: 10, mode: 'open', amount: 60 });
  assert.equal(shortOpen.ok, true); assert.equal(shortOpen.mode, 'allin-open'); assert.equal(shortOpen.payAmount, 10);
  const shortCall = validateBetAction({ hasBetAction: true, requiredBet: 100, chips: 30, roundBet: 80, mode: 'call', amount: 100 });
  assert.equal(shortCall.ok, true); assert.equal(shortCall.mode, 'allin-call'); assert.equal(shortCall.payAmount, 30);
  const shortSeenCall = validateBetAction({ hasBetAction: true, requiredBet: 100, chips: 30, seen: true, mode: 'call', amount: 200 });
  assert.equal(shortSeenCall.ok, true); assert.equal(shortSeenCall.mode, 'allin-call'); assert.equal(shortSeenCall.payAmount, 30);
  assert.equal(validateBetAction({ hasBetAction: true, requiredBet: 100, chips: 30, mode: 'call', amount: 999 }).ok, false);
  assert.equal(validateBetAction({ hasBetAction: true, requiredBet: 40, chips: 1000, mode: 'raise', amount: 999 }).ok, false);
}

// V38 buttons show clean action labels; actual cost is calculated separately from dark baseline.
{
  const fs = require('node:fs');
  const client = fs.readFileSync(require('node:path').join(__dirname, '../public/client.js'), 'utf8');
  assert.match(client, /textContent = '跟注'/);
  assert.match(client, /textContent = '加注20'/);
  assert.match(client, /textContent = '加注40'/);
  assert.match(client, /textContent = '加注60'/);
  assert.match(client, /darkBetBase/);
  assert.doesNotMatch(client, /加注20（/);
  assert.doesNotMatch(client, /加注40（/);
  assert.doesNotMatch(client, /加注60（/);
  assert.match(client, /meSeen\(\) \? 2 : 1/);
  assert.doesNotMatch(client, /callTarget\s*\+\s*20\s*-\s*alreadyPaid/);
  assert.doesNotMatch(client, /callTarget\s*-\s*alreadyPaid/);
  const server = fs.readFileSync(require('node:path').join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /const fee = getActionBase\(room\.darkBetBase \|\| ANTE, !!p\.seen\)/);
  assert.doesNotMatch(server, /compareTopUp\(fee, p\.roundBet/);
  assert.match(server, /if \(a\.length <= 1\) finishRound\(room\);\s*else chooseNext\(room\)/);
}

// Uncalled excess is refunded; contested lower layer goes to the best eligible hand.
{
  const ps = [player('A', 100, 3), player('B', 100, 2), player('C', 200, 1)];
  const r = settlePotLayers(ps, cmp);
  assert.equal(r.totalPot, 400);
  assert.equal(r.payouts.get('A'), 300);
  assert.equal(r.payouts.get('C'), 100);
  assert.equal(r.refunds.get('C'), 100);
  assert.equal(sum(r.payouts), r.totalPot);
}

// All-in stacks create a main pot and a side pot; a short stack cannot win the side pot.
{
  const ps = [player('A', 20, 100), player('B', 50, 50), player('C', 50, 10)];
  const r = settlePotLayers(ps, cmp);
  assert.equal(r.layers.length, 2);
  assert.deepEqual(r.layers.map(x => x.amount), [60, 60]);
  assert.equal(r.payouts.get('A'), 60);
  assert.equal(r.payouts.get('B'), 60);
  assert.equal(sum(r.payouts), 120);
}

// Folded contributions remain in the pot, but folded hands cannot win it.
{
  const ps = [player('A', 100, 999, true), player('B', 100, 1), player('C', 100, 2)];
  const r = settlePotLayers(ps, cmp);
  assert.equal(r.payouts.get('C'), 300);
  assert.equal(r.payouts.has('A'), false);
}

// Split ties deterministically; remainder chips go to the earliest eligible seats.
{
  const ps = [player('A', 101, 5), player('B', 101, 5), player('C', 101, 1, true)];
  const r = settlePotLayers(ps, cmp);
  assert.equal(r.payouts.get('A'), 152);
  assert.equal(r.payouts.get('B'), 151);
  assert.equal(sum(r.payouts), 303);
}

// A layer whose contributors all folded is explicitly marked as dead money and still conserved.
{
  const ps = [player('A', 100, 1, true), player('B', 100, 2, true), player('C', 50, 3), player('D', 50, 1)];
  const r = settlePotLayers(ps, cmp);
  assert.equal(r.layers.some(x => x.type === 'dead-money' && x.eligibilityOverride), true);
  assert.equal(sum(r.payouts), r.totalPot);
}

// If every hand is folded/left, return contributions instead of destroying chips.
{
  const ps = [player('A', 30, 1, true), player('B', 70, 2, true)];
  const r = settlePotLayers(ps, cmp);
  assert.equal(r.payouts.get('A'), 30);
  assert.equal(r.payouts.get('B'), 70);
  assert.equal(sum(r.payouts), r.totalPot);
}

// Conservation across varied unequal stacks and folded states.
for (let seed = 1; seed <= 250; seed++) {
  let x = seed;
  const rnd = max => { x = (x * 48271) % 2147483647; return x % max; };
  const n = 2 + rnd(5);
  const ps = Array.from({ length: n }, (_, i) => player(`P${i}`, rnd(300), rnd(7), rnd(4) === 0));
  if (ps.every(p => p.out)) ps[0].out = false;
  const r = settlePotLayers(ps, cmp);
  assert.equal(sum(r.payouts), r.totalPot, `seed ${seed}`);
}

console.log('Settlement tests passed (250 randomized conservation cases + targeted regression groups).');
