'use strict';

function rank(cards) {
  const vm = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
  const vals = (cards || []).map(c => vm[c.r]).sort((a,b) => b-a);
  if (vals.length !== 3 || vals.some(v => !v)) return [0];
  const flush = cards.every(c => c.s === cards[0].s);
  const counts = {};
  vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
  let sh = 0;
  if (new Set(vals).size === 3) {
    if (vals[0]-vals[1] === 1 && vals[1]-vals[2] === 1) sh = vals[0];
    else if (vals[0] === 14 && vals[1] === 3 && vals[2] === 2) sh = 3;
  }
  if (vals[0] === vals[2]) return [6, vals[0]];
  if (flush && sh) return [5, sh];
  if (flush) return [4, vals[0], vals[1], vals[2]];
  if (sh) return [3, sh];
  const pair = Object.keys(counts).map(Number).find(v => counts[v] === 2);
  if (pair !== undefined) return [2, pair, vals.find(v => v !== pair)];
  return [1, vals[0], vals[1], vals[2]];
}

function compareRanks(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i=0;i<n;i++) {
    if ((a[i]||0) > (b[i]||0)) return 1;
    if ((a[i]||0) < (b[i]||0)) return -1;
  }
  return 0;
}

function is235(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) return false;
  const vals = cards.map(c => ({2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14})[c.r]).sort((a,b)=>a-b);
  return vals[0] === 2 && vals[1] === 3 && vals[2] === 5;
}

// Special rule: 2-3-5 beats any three-of-a-kind (leopard), regardless of suits.
function compareHands(cardsA, cardsB) {
  const a235 = is235(cardsA);
  const b235 = is235(cardsB);
  const aLeopard = rank(cardsA)[0] === 6;
  const bLeopard = rank(cardsB)[0] === 6;
  if (a235 && bLeopard && !b235) return 1;
  if (b235 && aLeopard && !a235) return -1;
  return compareRanks(rank(cardsA), rank(cardsB));
}

module.exports = { rank, compareRanks, is235, compareHands };
