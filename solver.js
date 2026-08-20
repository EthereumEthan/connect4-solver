/*
 * Connect 4 solver — pure game-tree calculation, no AI/ML.
 *
 * Board is a 7x6 bitboard: each column uses 7 bits (6 rows + 1 sentinel),
 * so a full position fits in 49 bits (BigInt).
 *   position = bitmask of the CURRENT player's discs
 *   mask     = bitmask of ALL discs
 *
 * Search: negamax + alpha-beta pruning + transposition table +
 * threat-based move ordering + iterative deepening. When the search
 * depth reaches the number of empty cells the result is mathematically
 * exact (a full solve of the remaining game tree).
 */
'use strict';

const WIDTH = 7;
const HEIGHT = 6;
const H1 = HEIGHT + 1; // bits per column

const ONE = 1n;

const BOTTOM = (() => {
  let b = 0n;
  for (let c = 0; c < WIDTH; c++) b |= ONE << BigInt(c * H1);
  return b;
})();
const BOARD_MASK = BOTTOM * BigInt((1 << HEIGHT) - 1);

const bottomMask = [];
const topMask = [];
const columnMask = [];
for (let c = 0; c < WIDTH; c++) {
  bottomMask.push(ONE << BigInt(c * H1));
  topMask.push(ONE << BigInt(c * H1 + HEIGHT - 1));
  columnMask.push(BigInt((1 << HEIGHT) - 1) << BigInt(c * H1));
}

// Center-out static ordering: middle columns are strongest on average.
const COL_ORDER = [3, 2, 4, 1, 5, 0, 6];

const WIN = 100000; // terminal scores are WIN - ply, dwarfing heuristic scores

function popcount(x) {
  let n = 0;
  while (x) { x &= x - ONE; n++; }
  return n;
}

// All empty squares that would complete a 4-in-a-row for `position`.
function winningPositions(position, mask) {
  // vertical
  let r = (position << 1n) & (position << 2n) & (position << 3n);

  // horizontal
  let p = (position << 7n) & (position << 14n);
  r |= p & (position << 21n);
  r |= p & (position >> 7n);
  p = (position >> 7n) & (position >> 14n);
  r |= p & (position << 7n);
  r |= p & (position >> 21n);

  // diagonal /
  p = (position << 6n) & (position << 12n);
  r |= p & (position << 18n);
  r |= p & (position >> 6n);
  p = (position >> 6n) & (position >> 12n);
  r |= p & (position << 6n);
  r |= p & (position >> 18n);

  // diagonal \
  p = (position << 8n) & (position << 16n);
  r |= p & (position << 24n);
  r |= p & (position >> 8n);
  p = (position >> 8n) & (position >> 16n);
  r |= p & (position << 8n);
  r |= p & (position >> 24n);

  return r & (BOARD_MASK ^ mask);
}

// Heuristic for non-terminal leaves: threat count difference + center control.
const CENTER_COL = columnMask[3];
function evaluate(position, mask) {
  const opp = position ^ mask;
  const myThreats = popcount(winningPositions(position, mask));
  const oppThreats = popcount(winningPositions(opp, mask));
  const myCenter = popcount(position & CENTER_COL);
  const oppCenter = popcount(opp & CENTER_COL);
  return (myThreats - oppThreats) * 12 + (myCenter - oppCenter) * 4;
}

// ---------------- transposition table ----------------
const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;
let tt = new Map();
const TT_MAX = 1 << 21;

// ---------------- search ----------------
let nodes = 0;
let deadline = Infinity;
let aborted = false;

function checkTime() {
  if ((nodes & 2047) === 0 && Date.now() > deadline) {
    aborted = true;
  }
  return aborted;
}

function negamax(position, mask, depth, alpha, beta, ply) {
  nodes++;
  if (checkTime()) return 0;

  const possible = (mask + BOTTOM) & BOARD_MASK;

  // Immediate win available?
  if (winningPositions(position, mask) & possible) return WIN - ply;

  if (mask === BOARD_MASK) return 0; // draw

  // Squares where the opponent wins if we don't act.
  const opp = position ^ mask;
  const oppWins = winningPositions(opp, mask) & possible;
  let moves = possible;
  if (oppWins) {
    if (popcount(oppWins) > 1) return -(WIN - ply - 1); // double threat: lost
    moves = oppWins; // forced block
  }

  if (depth <= 0) return evaluate(position, mask);

  const key = position + mask + BOTTOM;
  const entry = tt.get(key);
  let ttMove = -1;
  if (entry) {
    if (entry.d >= depth) {
      // Win/loss scores are stored ply-relative; convert to root-relative.
      let v = entry.v;
      if (v > WIN - 100) v -= ply;
      else if (v < -(WIN - 100)) v += ply;
      if (entry.f === TT_EXACT) return v;
      if (entry.f === TT_LOWER && v > alpha) alpha = v;
      else if (entry.f === TT_UPPER && v < beta) beta = v;
      if (alpha >= beta) return v;
    }
    ttMove = entry.m;
  }

  // Generate & order moves: TT move first, then by threats created, center-out.
  const cand = [];
  for (const col of COL_ORDER) {
    const move = moves & columnMask[col];
    if (!move) continue;
    const newMask = mask | (mask + bottomMask[col]);
    const threats = popcount(winningPositions(position | (newMask ^ mask), newMask));
    cand.push({ col, newMask, sort: (col === ttMove ? 1000 : 0) + threats });
  }
  cand.sort((a, b) => b.sort - a.sort);

  const alphaOrig = alpha;
  let best = -Infinity;
  let bestCol = cand.length ? cand[0].col : -1;

  for (const c of cand) {
    const score = -negamax(position ^ mask, c.newMask, depth - 1, -beta, -alpha, ply + 1);
    if (aborted) return 0;
    if (score > best) {
      best = score;
      bestCol = c.col;
      if (score > alpha) alpha = score;
    }
    if (alpha >= beta) break;
  }

  if (aborted) return 0; // don't store partial results

  if (tt.size > TT_MAX) tt.clear();
  const flag = best <= alphaOrig ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
  // Store win/loss scores ply-relative so entries are valid from any root.
  let stored = best;
  if (stored > WIN - 100) stored += ply;
  else if (stored < -(WIN - 100)) stored -= ply;
  tt.set(key, { d: depth, f: flag, v: stored, m: bestCol });

  return best;
}

// Root search: returns per-column scores too (for hints/eval display).
function searchRoot(position, mask, depth, prevBest) {
  const possible = (mask + BOTTOM) & BOARD_MASK;
  const results = [];
  let alpha = -Infinity;
  let best = -Infinity;
  let bestCol = -1;

  const cols = [...COL_ORDER];
  if (prevBest >= 0) {
    cols.splice(cols.indexOf(prevBest), 1);
    cols.unshift(prevBest);
  }

  for (const col of cols) {
    const move = possible & columnMask[col];
    if (!move) continue;
    const newMask = mask | (mask + bottomMask[col]);
    const placed = newMask ^ mask;
    let score;
    if (winningPositions(position, mask) & placed) {
      score = WIN; // winning move right now
    } else {
      score = -negamax(position ^ mask, newMask, depth - 1, -Infinity, -alpha, 1);
    }
    if (aborted) return null;
    results.push({ col, score });
    if (score > best) {
      best = score;
      bestCol = col;
      if (score > alpha) alpha = score;
    }
  }
  return { bestCol, best, results };
}

function solve(position, mask, maxDepth, timeMs) {
  nodes = 0;
  aborted = false;
  deadline = Date.now() + timeMs;

  const remaining = popcount(BOARD_MASK ^ mask);
  const depthCap = Math.min(maxDepth, remaining);

  let result = null;
  let reachedDepth = 0;
  let prevBest = -1;

  for (let d = Math.min(2, depthCap); d <= depthCap; d++) {
    const r = searchRoot(position, mask, d, prevBest);
    if (r === null || aborted) break;
    result = r;
    reachedDepth = d;
    prevBest = r.bestCol;
    // Stop early once a forced win/loss is proven.
    if (Math.abs(r.best) > WIN - 100) break;
  }

  return {
    col: result ? result.bestCol : -1,
    score: result ? result.best : 0,
    results: result ? result.results : [],
    depth: reachedDepth,
    exact: reachedDepth >= remaining || (result && Math.abs(result.best) > WIN - 100),
    nodes,
  };
}

self.onmessage = (e) => {
  const { id, position, mask, maxDepth, timeMs } = e.data;
  const res = solve(BigInt(position), BigInt(mask), maxDepth, timeMs);
  self.postMessage({ id, ...res });
};
