/*
 * Connect 4 solver — pure game-tree calculation, no AI/ML, no dependencies.
 * Classic Web Worker script (no modules, no imports).
 *
 * Board geometry (unchanged from the original solver, so app.js needs no edit):
 *   7 columns x 6 rows, 7 bits per column (6 rows + 1 sentinel) = 49 bits.
 *   bit index of (col c, row r counting from the bottom) = c*7 + r
 *   position = bitmask of the side-to-move's discs, mask = bitmask of all discs.
 *
 * Representation: the 49-bit board lives in TWO 32-bit words
 *   lo = bits 0..31, hi = bits 32..48
 * kept as int32 throughout. There is no BigInt anywhere in the search.
 *
 * Search: negamax + alpha-beta + principal-variation (null-window) search,
 * open-addressed typed-array transposition table with mirror-canonical keys,
 * allocation-free staged move ordering, non-losing move generation, and
 * iterative deepening under a time budget.
 *
 * Worker protocol (byte-for-byte the same as the original solver.js):
 *   in  {id, position, mask, maxDepth, timeMs}   position/mask decimal strings
 *   out {id, col, score, results:[{col,score}], depth, exact, nodes}
 *
 * What the reply guarantees:
 *   score   the EXACT value of the position at search depth `depth`, on the
 *           side-to-move's scale, WIN = 100000 and a forced win at ply p
 *           scoring WIN - p (so |score| > 99900 means a proven forced result).
 *   col     a column attaining `score`. Never a move that loses on the spot
 *           unless every legal move does.
 *   depth   the number of plies actually completed. Iterative deepening stops
 *           early once a forced win/loss is proven or the whole remaining tree
 *           has been searched; `depth` always tells the truth about that.
 *   exact   true when `score` is the game-theoretic value: either the search
 *           covered every remaining move, or it proved a forced win/loss.
 *   results one entry per legal column. For maxDepth <= EXACT_RESULTS_MAX_DEPTH
 *           (which covers every budget app.js reads results[] for) each score
 *           is that column's EXACT value at `depth`. For deeper budgets they
 *           are upper bounds at `depth`, clamped so no column can ever claim
 *           to beat the chosen move. The old solver reported raw alpha-beta
 *           bounds here with no distinction, which is the defect this fixes.
 */
'use strict';

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */
var WIDTH = 7;
var HEIGHT = 6;
var H1 = HEIGHT + 1;              // bits per column
var CELLS = WIDTH * HEIGHT;       // 42

var WIN = 100000;                 // terminal score is WIN - ply (UI depends on this)
var MATE_MIN = WIN - 100;         // |score| > MATE_MIN  =>  proven win/loss
var INF = 1 << 20;                // search infinity (finite so it stays int32)
var MAX_PLY = 64;

/* ---- bit tables ---- */
var BIT_LO = new Int32Array(49);
var BIT_HI = new Int32Array(49);
for (var _b = 0; _b < 49; _b++) {
  if (_b < 32) BIT_LO[_b] = (1 << _b) | 0; else BIT_HI[_b] = (1 << (_b - 32)) | 0;
}

var COL_LO = new Int32Array(WIDTH);
var COL_HI = new Int32Array(WIDTH);
var BOARD_LO = 0, BOARD_HI = 0, BOTTOM_LO = 0, BOTTOM_HI = 0;
for (var _c = 0; _c < WIDTH; _c++) {
  var _lo = 0, _hi = 0;
  for (var _r = 0; _r < HEIGHT; _r++) {
    var _i = _c * H1 + _r;
    _lo |= BIT_LO[_i]; _hi |= BIT_HI[_i];
  }
  COL_LO[_c] = _lo; COL_HI[_c] = _hi;
  BOARD_LO |= _lo; BOARD_HI |= _hi;
  BOTTOM_LO |= BIT_LO[_c * H1]; BOTTOM_HI |= BIT_HI[_c * H1];
}
var CENTER_LO = COL_LO[3], CENTER_HI = COL_HI[3];

// Center-out static ordering: middle columns are strongest on average.
var COL_ORDER = new Int32Array([3, 2, 4, 1, 5, 0, 6]);
var CENTER_BONUS = new Int32Array([0, 1, 2, 3, 2, 1, 0]);

/* ------------------------------------------------------------------ *
 * two-word bit primitives
 * ------------------------------------------------------------------ */

// Results of winningPositions() land here (no allocation, no object return).
var wLo = 0, wHi = 0;

/*
 * All EMPTY squares that would complete a 4-in-a-row for `position`.
 * Identical semantics to the BigInt version; every shift is unrolled over the
 * two words. Bits shifted past bit 63 are simply lost, which is harmless
 * because the result is masked back down to the board at the end.
 */
function winningPositions(pLo, pHi, mLo, mHi) {
  var rLo, rHi, aLo, aHi, bLo, bHi;

  /* vertical: (p<<1) & (p<<2) & (p<<3) */
  rLo = (pLo << 1) & (pLo << 2) & (pLo << 3);
  rHi = ((pHi << 1) | (pLo >>> 31)) & ((pHi << 2) | (pLo >>> 30)) & ((pHi << 3) | (pLo >>> 29));

  /* horizontal (step 7) */
  var l7Lo = pLo << 7, l7Hi = (pHi << 7) | (pLo >>> 25);
  var l14Lo = pLo << 14, l14Hi = (pHi << 14) | (pLo >>> 18);
  var l21Lo = pLo << 21, l21Hi = (pHi << 21) | (pLo >>> 11);
  var r7Lo = (pLo >>> 7) | (pHi << 25), r7Hi = pHi >>> 7;
  var r14Lo = (pLo >>> 14) | (pHi << 18), r14Hi = pHi >>> 14;
  var r21Lo = (pLo >>> 21) | (pHi << 11), r21Hi = pHi >>> 21;

  aLo = l7Lo & l14Lo; aHi = l7Hi & l14Hi;
  rLo |= aLo & l21Lo; rHi |= aHi & l21Hi;
  rLo |= aLo & r7Lo;  rHi |= aHi & r7Hi;
  bLo = r7Lo & r14Lo; bHi = r7Hi & r14Hi;
  rLo |= bLo & l7Lo;  rHi |= bHi & l7Hi;
  rLo |= bLo & r21Lo; rHi |= bHi & r21Hi;

  /* diagonal "/" (step 6) */
  var l6Lo = pLo << 6, l6Hi = (pHi << 6) | (pLo >>> 26);
  var l12Lo = pLo << 12, l12Hi = (pHi << 12) | (pLo >>> 20);
  var l18Lo = pLo << 18, l18Hi = (pHi << 18) | (pLo >>> 14);
  var r6Lo = (pLo >>> 6) | (pHi << 26), r6Hi = pHi >>> 6;
  var r12Lo = (pLo >>> 12) | (pHi << 20), r12Hi = pHi >>> 12;
  var r18Lo = (pLo >>> 18) | (pHi << 14), r18Hi = pHi >>> 18;

  aLo = l6Lo & l12Lo; aHi = l6Hi & l12Hi;
  rLo |= aLo & l18Lo; rHi |= aHi & l18Hi;
  rLo |= aLo & r6Lo;  rHi |= aHi & r6Hi;
  bLo = r6Lo & r12Lo; bHi = r6Hi & r12Hi;
  rLo |= bLo & l6Lo;  rHi |= bHi & l6Hi;
  rLo |= bLo & r18Lo; rHi |= bHi & r18Hi;

  /* diagonal "\" (step 8) */
  var l8Lo = pLo << 8, l8Hi = (pHi << 8) | (pLo >>> 24);
  var l16Lo = pLo << 16, l16Hi = (pHi << 16) | (pLo >>> 16);
  var l24Lo = pLo << 24, l24Hi = (pHi << 24) | (pLo >>> 8);
  var r8Lo = (pLo >>> 8) | (pHi << 24), r8Hi = pHi >>> 8;
  var r16Lo = (pLo >>> 16) | (pHi << 16), r16Hi = pHi >>> 16;
  var r24Lo = (pLo >>> 24) | (pHi << 8), r24Hi = pHi >>> 24;

  aLo = l8Lo & l16Lo; aHi = l8Hi & l16Hi;
  rLo |= aLo & l24Lo; rHi |= aHi & l24Hi;
  rLo |= aLo & r8Lo;  rHi |= aHi & r8Hi;
  bLo = r8Lo & r16Lo; bHi = r8Hi & r16Hi;
  rLo |= bLo & l8Lo;  rHi |= bHi & l8Hi;
  rLo |= bLo & r24Lo; rHi |= bHi & r24Hi;

  /* keep only empty board squares */
  wLo = rLo & (BOARD_LO ^ mLo);
  wHi = rHi & (BOARD_HI ^ mHi);
}

/* two-word SWAR popcount */
function popcount2(lo, hi) {
  lo = lo - ((lo >>> 1) & 0x55555555);
  lo = (lo & 0x33333333) + ((lo >>> 2) & 0x33333333);
  lo = (lo + (lo >>> 4)) & 0x0f0f0f0f;
  hi = hi - ((hi >>> 1) & 0x55555555);
  hi = (hi & 0x33333333) + ((hi >>> 2) & 0x33333333);
  hi = (hi + (hi >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(lo, 0x01010101) >>> 24) + (Math.imul(hi, 0x01010101) >>> 24);
}

/*
 * Heuristic for non-terminal leaves — byte-for-byte the same formula as the
 * original solver, so the eval bar in the UI keeps its calibration.
 */
function evaluate(pLo, pHi, mLo, mHi) {
  winningPositions(pLo, pHi, mLo, mHi);
  var my = popcount2(wLo, wHi);
  var oLo = pLo ^ mLo, oHi = pHi ^ mHi;
  winningPositions(oLo, oHi, mLo, mHi);
  var op = popcount2(wLo, wHi);
  var myC = popcount2(pLo & CENTER_LO, pHi & CENTER_HI);
  var opC = popcount2(oLo & CENTER_LO, oHi & CENTER_HI);
  return (my - op) * 12 + (myC - opC) * 4;
}

/* ------------------------------------------------------------------ *
 * transposition table (open addressing, typed arrays, no Map/BigInt)
 * ------------------------------------------------------------------ */
var TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;

var TT_BITS = 0;
var ttArr = null;
(function allocTT() {
  var tries = [21, 20, 18, 16, 14];
  for (var i = 0; i < tries.length; i++) {
    try {
      ttArr = new Int32Array((1 << tries[i]) * 4);
      TT_BITS = tries[i];
      return;
    } catch (e) { /* fall back to a smaller table */ }
  }
  ttArr = new Int32Array((1 << 12) * 4);
  TT_BITS = 12;
})();
// two entries per bucket: [depth-preferred slot, always-replace slot]
var TT_BUCKET_MASK = (1 << (TT_BITS - 1)) - 1;
var ttGeneration = 0;

/* probe output (module globals — no allocation) */
var ttHit = false, ttDepth = 0, ttFlag = 0, ttValue = 0, ttMove = 7, ttClass = 0;

function ttProbe(kLo, kHi, h) {
  var b = (h & TT_BUCKET_MASK) << 3;
  var o = b;
  if (ttArr[o] === kLo && ttArr[o + 1] === kHi) {
    var m = ttArr[o + 3];
    ttHit = true; ttValue = ttArr[o + 2];
    ttDepth = m & 63; ttFlag = (m >>> 6) & 3; ttMove = (m >>> 8) & 7; ttClass = (m >>> 11) & 63;
    return;
  }
  o = b + 4;
  if (ttArr[o] === kLo && ttArr[o + 1] === kHi) {
    var m2 = ttArr[o + 3];
    ttHit = true; ttValue = ttArr[o + 2];
    ttDepth = m2 & 63; ttFlag = (m2 >>> 6) & 3; ttMove = (m2 >>> 8) & 7; ttClass = (m2 >>> 11) & 63;
    return;
  }
  ttHit = false; ttMove = 7;
}

function ttStore(kLo, kHi, h, depth, flag, value, move, cls) {
  var b = (h & TT_BUCKET_MASK) << 3;
  var meta = (depth & 63) | (flag << 6) | ((move & 7) << 8) | ((cls & 63) << 11) | ((ttGeneration & 255) << 17);
  var o;
  if (ttArr[b] === kLo && ttArr[b + 1] === kHi) o = b;
  else if (ttArr[b + 4] === kLo && ttArr[b + 5] === kHi) o = b + 4;
  else {
    // key 0 can never occur for a real position (key >= BOTTOM and every column
    // contributes at least its bottom bit), so keyLo === 0 marks an empty slot.
    var k0 = ttArr[b];
    if (k0 === 0) o = b;
    else {
      var m0 = ttArr[b + 3];
      var sameGen = ((m0 >>> 17) & 255) === (ttGeneration & 255);
      if (!sameGen || depth >= (m0 & 63)) o = b;      // depth-preferred / aging slot
      else o = b + 4;                                  // always-replace slot
    }
  }
  ttArr[o] = kLo; ttArr[o + 1] = kHi; ttArr[o + 2] = value; ttArr[o + 3] = meta;
}

/* ------------------------------------------------------------------ *
 * mirror-canonical key
 *
 * key = position + mask + BOTTOM.  Within one column the sum is
 * position_c + mask_c + 1 <= 63 + 63 + 1 = 127, so it fits in that column's
 * 7 bits and NEVER carries into the next column. The key is therefore an
 * injective per-column encoding, and mirroring the board left-to-right is
 * exactly a permutation of the key's seven 7-bit groups.
 * ------------------------------------------------------------------ */
var mkLo = 0, mkHi = 0;
function mirrorKey(kLo, kHi) {
  var v0 = kLo & 127;
  var v1 = (kLo >>> 7) & 127;
  var v2 = (kLo >>> 14) & 127;
  var v3 = (kLo >>> 21) & 127;
  var v4 = ((kLo >>> 28) & 15) | ((kHi & 7) << 4);
  var v5 = (kHi >>> 3) & 127;
  var v6 = (kHi >>> 10) & 127;
  mkLo = v6 | (v5 << 7) | (v4 << 14) | (v3 << 21) | ((v2 & 15) << 28);
  mkHi = (v2 >>> 4) | (v1 << 3) | (v0 << 10);
}

/* ------------------------------------------------------------------ *
 * search state
 * ------------------------------------------------------------------ */
var nodes = 0;
var deadline = Infinity;
var aborted = false;
var reqClass = 0;         // request maxDepth: heuristic TT values are only
                          // reused by requests of the same difficulty budget

var ORD_COL = new Int32Array(MAX_PLY * 8);
var ORD_SCORE = new Int32Array(MAX_PLY * 8);

/* Killer moves and a history table were implemented and then REMOVED after
 * measurement: on this game they fight the threat-count ordering instead of
 * helping it. Killers cost 1.64x time / 1.64x nodes at maxDepth 15 (and 1.48x
 * on exact endgame solves) even when their bonus was tuned below one threat
 * unit; the history table was worth 1% and inside the noise. See t6_ablation. */

/* root bookkeeping */
var rootOrder = new Int32Array(WIDTH);
var rootN = 0;
var rootScoreTmp = new Int32Array(WIDTH);
var rootScore = new Int32Array(WIDTH);
var rootHas = new Uint8Array(WIDTH);
var rootBest = 0, rootBestCol = -1;

/* ------------------------------------------------------------------ *
 * negamax
 * ------------------------------------------------------------------ */
function negamax(pLo, pHi, mLo, mHi, depth, alpha, beta, ply) {
  nodes++;
  if ((nodes & 1023) === 0 && Date.now() > deadline) aborted = true;
  if (aborted) return 0;

  /* playable squares: empty AND (bottom row OR the cell below is filled) */
  var psLo = (((mLo << 1) | BOTTOM_LO) & ~mLo) & BOARD_LO;
  var psHi = ((((mHi << 1) | (mLo >>> 31)) | BOTTOM_HI) & ~mHi) & BOARD_HI;

  /* 1. immediate win for the side to move */
  winningPositions(pLo, pHi, mLo, mHi);
  if (((wLo & psLo) | (wHi & psHi)) !== 0) return WIN - ply;

  /* 2. board full -> draw */
  if ((psLo | psHi) === 0) return 0;

  /* 3. opponent threats: double threat loses, single threat is forced */
  var oLo = pLo ^ mLo, oHi = pHi ^ mHi;
  winningPositions(oLo, oHi, mLo, mHi);
  var owLo = wLo, owHi = wHi;                 // all opponent winning squares
  var fLo = owLo & psLo, fHi = owHi & psHi;   // ...that are playable now
  var mvLo = psLo, mvHi = psHi;
  if ((fLo | fHi) !== 0) {
    if ((fLo & (fLo - 1)) !== 0 || (fHi & (fHi - 1)) !== 0 || (fLo !== 0 && fHi !== 0)) {
      return -(WIN - ply - 1);                // two live threats: lost next move
    }
    mvLo = fLo; mvHi = fHi;                   // forced block
  }

  /* 4. non-losing move generation: never play directly under an opponent win */
  mvLo &= ~((owLo >>> 1) | (owHi << 31));
  mvHi &= ~(owHi >>> 1);
  if ((mvLo | mvHi) === 0) return -(WIN - ply - 1);

  /* 5. horizon */
  if (depth <= 0) return evaluate(pLo, pHi, mLo, mHi);

  /* 6. transposition table (mirror-canonical key) */
  var sum = (pLo >>> 0) + (mLo >>> 0) + (BOTTOM_LO >>> 0);
  var kLo = sum | 0;
  var kHi = (pHi + mHi + BOTTOM_HI + ((sum / 4294967296) | 0)) & 0x1ffff;
  mirrorKey(kLo, kHi);
  var mirrored = (mkHi < kHi) || (mkHi === kHi && (mkLo >>> 0) < (kLo >>> 0));
  var qLo = mirrored ? mkLo : kLo;
  var qHi = mirrored ? mkHi : kHi;
  var h = Math.imul(qLo, 0x9e3779b1) ^ Math.imul(qHi, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;

  ttProbe(qLo, qHi, h);
  var hintCol = -1;
  if (ttHit) {
    if (ttMove !== 7) hintCol = mirrored ? (WIDTH - 1 - ttMove) : ttMove;
    /* Cut off only on entries produced by the same difficulty budget: a
     * depth-limited value depends on the horizon it was produced with, and
     * letting a deep "eval" search feed cutoffs into a shallow "easy" search
     * would silently make the easy level play at full strength. */
    if (ttDepth >= depth && ttClass === reqClass) {
      var v = ttValue;
      if (v > MATE_MIN) v -= ply; else if (v < -MATE_MIN) v += ply;
      if (ttFlag === TT_EXACT) return v;
      if (ttFlag === TT_LOWER && v >= beta) return v;
      if (ttFlag === TT_UPPER && v <= alpha) return v;
    }
  }

  /* 7. collect legal (non-losing) moves */
  var base = ply << 3;
  var n = 0, i, col;
  for (i = 0; i < WIDTH; i++) {
    col = COL_ORDER[i];
    if (((mvLo & COL_LO[col]) | (mvHi & COL_HI[col])) !== 0) { ORD_COL[base + n] = col; n++; }
  }

  /* staged ordering: the TT move goes first and the (expensive) threat-count
     scores for the rest are only computed if the TT move fails to cut. */
  var deferFrom = 0;
  if (hintCol >= 0) {
    for (i = 0; i < n; i++) {
      if (ORD_COL[base + i] === hintCol) {
        ORD_COL[base + i] = ORD_COL[base]; ORD_COL[base] = hintCol; deferFrom = 1; break;
      }
    }
  }
  var scored = false;

  var alphaOrig = alpha;
  var best = -INF, bestCol = -1;
  var cpLo = pLo ^ mLo, cpHi = pHi ^ mHi;   // child's side-to-move discs

  for (var k = 0; k < n; k++) {
    if (k >= deferFrom) {
      if (!scored) {
        scored = true;
        for (i = deferFrom; i < n; i++) {
          var sc = ORD_COL[base + i];
          var tbLo = mvLo & COL_LO[sc], tbHi = mvHi & COL_HI[sc];
          winningPositions(pLo | tbLo, pHi | tbHi, mLo | tbLo, mHi | tbHi);
          /* moves that create the most new winning squares first, centre-out
             as the tie-break — measured as the strongest ordering signal here */
          ORD_SCORE[base + i] = popcount2(wLo, wHi) * 1000 + CENTER_BONUS[sc];
        }
      }
      /* lazy selection sort: pick the best remaining candidate */
      var bi = k;
      for (i = k + 1; i < n; i++) if (ORD_SCORE[base + i] > ORD_SCORE[base + bi]) bi = i;
      if (bi !== k) {
        var tc = ORD_COL[base + k]; ORD_COL[base + k] = ORD_COL[base + bi]; ORD_COL[base + bi] = tc;
        var ts = ORD_SCORE[base + k]; ORD_SCORE[base + k] = ORD_SCORE[base + bi]; ORD_SCORE[base + bi] = ts;
      }
    }

    col = ORD_COL[base + k];
    var bLo = mvLo & COL_LO[col], bHi = mvHi & COL_HI[col];
    var nmLo = mLo | bLo, nmHi = mHi | bHi;

    var score;
    if (k === 0) {
      score = -negamax(cpLo, cpHi, nmLo, nmHi, depth - 1, -beta, -alpha, ply + 1);
    } else {
      /* principal-variation search: null window first, re-search on fail-high */
      score = -negamax(cpLo, cpHi, nmLo, nmHi, depth - 1, -alpha - 1, -alpha, ply + 1);
      if (!aborted && score > alpha && score < beta) {
        score = -negamax(cpLo, cpHi, nmLo, nmHi, depth - 1, -beta, -alpha, ply + 1);
      }
    }
    if (aborted) return 0;

    if (score > best) {
      best = score; bestCol = col;
      if (score > alpha) alpha = score;
    }
    if (alpha >= beta) break;
  }

  if (aborted) return 0;   // never store a value built from a truncated search

  var flag = best <= alphaOrig ? TT_UPPER : (best >= beta ? TT_LOWER : TT_EXACT);
  var stored = best;
  if (stored > MATE_MIN) stored += ply; else if (stored < -MATE_MIN) stored -= ply;
  var sm = bestCol < 0 ? 7 : (mirrored ? (WIDTH - 1 - bestCol) : bestCol);
  ttStore(qLo, qHi, h, depth, flag, stored, sm, reqClass);

  return best;
}

/* ------------------------------------------------------------------ *
 * root
 *
 * `exactRoot` controls how the per-column `results` are produced:
 *   true  — every column is searched with a window that is guaranteed to
 *           return its EXACT value (first child full window, the rest with
 *           (-INF, alpha+1) and a re-search on fail-high). Used for the
 *           budgets whose results[] the UI actually consumes.
 *   false — classic alpha-beta at the root: the chosen move and its score are
 *           still exact, the other columns are upper bounds and get clamped to
 *           the best score so they can never claim to beat the chosen move.
 * ------------------------------------------------------------------ */
function searchRoot(pLo, pHi, mLo, mHi, depth, exactRoot) {
  var psLo = (((mLo << 1) | BOTTOM_LO) & ~mLo) & BOARD_LO;
  var psHi = ((((mHi << 1) | (mLo >>> 31)) | BOTTOM_HI) & ~mHi) & BOARD_HI;

  winningPositions(pLo, pHi, mLo, mHi);
  var winLo = wLo, winHi = wHi;

  var cpLo = pLo ^ mLo, cpHi = pHi ^ mHi;
  var alpha = -INF, best = -INF, bestCol = -1;

  nodes++;                                       // the root node itself

  for (var k = 0; k < rootN; k++) {
    var col = rootOrder[k];
    var bLo = psLo & COL_LO[col], bHi = psHi & COL_HI[col];
    if ((bLo | bHi) === 0) continue;

    var s;
    if (((winLo & bLo) | (winHi & bHi)) !== 0) {
      nodes++;                                   // child resolved without a call
      s = WIN;                                   // wins on the spot (ply 0)
    } else {
      var nmLo = mLo | bLo, nmHi = mHi | bHi;
      if (best === -INF) {
        s = -negamax(cpLo, cpHi, nmLo, nmHi, depth - 1, -INF, INF, 1);
      } else if (exactRoot) {
        s = -negamax(cpLo, cpHi, nmLo, nmHi, depth - 1, -(alpha + 1), INF, 1);
        if (!aborted && s > alpha) {
          s = -negamax(cpLo, cpHi, nmLo, nmHi, depth - 1, -INF, -alpha, 1);
        }
      } else {
        s = -negamax(cpLo, cpHi, nmLo, nmHi, depth - 1, -INF, -alpha, 1);
      }
      if (aborted) return false;
    }

    rootScoreTmp[col] = s;
    if (s > best) { best = s; bestCol = col; if (s > alpha) alpha = s; }
  }

  if (bestCol < 0) return false;

  for (var c = 0; c < WIDTH; c++) {
    if (!rootHas[c]) continue;
    var v = rootScoreTmp[c];
    if (!exactRoot && v > best) v = best;      // keep bounds from lying upward
    rootScore[c] = v;
  }
  rootBest = best; rootBestCol = bestCol;

  /* order the next iteration by this one's scores (best first) */
  for (var a = 1; a < rootN; a++) {
    var cc = rootOrder[a], vv = rootScore[cc], j = a - 1;
    while (j >= 0 && rootScore[rootOrder[j]] < vv) { rootOrder[j + 1] = rootOrder[j]; j--; }
    rootOrder[j + 1] = cc;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * iterative deepening
 * ------------------------------------------------------------------ */
var EXACT_RESULTS_MAX_DEPTH = 12;   // easy(2), medium(9) and the eval bar(10)

function solve(pLo, pHi, mLo, mHi, maxDepth, timeMs) {
  nodes = 0;
  aborted = false;
  deadline = Infinity;
  ttGeneration = (ttGeneration + 1) & 255;
  reqClass = maxDepth < 0 ? 0 : (maxDepth > 63 ? 63 : maxDepth);
  rootBest = 0; rootBestCol = -1;   // never report a column from a previous call

  var filled = popcount2(mLo, mHi);
  var remaining = CELLS - filled;

  /* legal columns at the root, center-out */
  var psLo = (((mLo << 1) | BOTTOM_LO) & ~mLo) & BOARD_LO;
  var psHi = ((((mHi << 1) | (mLo >>> 31)) | BOTTOM_HI) & ~mHi) & BOARD_HI;
  rootN = 0;
  rootHas.fill(0);
  for (var i = 0; i < WIDTH; i++) {
    var c = COL_ORDER[i];
    if (((psLo & COL_LO[c]) | (psHi & COL_HI[c])) !== 0) {
      rootOrder[rootN++] = c; rootHas[c] = 1; rootScore[c] = 0;
    }
  }
  if (rootN === 0) {
    return { col: -1, score: 0, results: [], depth: 0, exact: true, nodes: nodes };
  }

  var depthCap = maxDepth < remaining ? maxDepth : remaining;
  if (depthCap < 1) depthCap = 1;
  var exactRoot = maxDepth <= EXACT_RESULTS_MAX_DEPTH;

  var reached = 0;
  var start = Date.now();
  var lastIterMs = 0, prevIterMs = 0;
  var d0 = depthCap < 2 ? depthCap : 2;

  for (var d = d0; d <= depthCap; d++) {
    /* The shallowest iteration always runs to completion so a legal move is
       guaranteed even with an absurdly small time budget. */
    deadline = (d === d0) ? Infinity : (start + timeMs);
    var t0 = Date.now();
    var ok = searchRoot(pLo, pHi, mLo, mHi, d, exactRoot);
    if (!ok || aborted) break;
    prevIterMs = lastIterMs;
    lastIterMs = Date.now() - t0;
    reached = d;

    if (rootBest > MATE_MIN || rootBest < -MATE_MIN) break;   // proven result
    if (reached >= remaining) break;                          // whole tree searched

    /* Time management: don't start an iteration that plainly cannot finish.
       The growth factor is measured from the last two iterations (clamped to a
       sane range) instead of assumed, so this only skips iterations that really
       would have been aborted. The old solver always burned its whole budget on
       a doomed iteration and then threw the work away. */
    var elapsed = Date.now() - start;
    if (elapsed >= timeMs) break;
    if (d > 3 && lastIterMs > 0) {
      var growth = prevIterMs > 0 ? lastIterMs / prevIterMs : 2.5;
      if (growth < 1.5) growth = 1.5; else if (growth > 5) growth = 5;
      if (elapsed + lastIterMs * growth > timeMs) break;
    }
  }

  var results = [];
  for (var rc = 0; rc < WIDTH; rc++) {
    if (rootHas[rc]) results.push({ col: rc, score: rootScore[rc] });
  }
  var decisive = rootBest > MATE_MIN || rootBest < -MATE_MIN;
  return {
    col: rootBestCol,
    score: rootBest,
    results: results,
    depth: reached,
    exact: reached >= remaining || decisive,
    nodes: nodes
  };
}

/* ------------------------------------------------------------------ *
 * worker protocol (identical to the original solver.js)
 * ------------------------------------------------------------------ */
function splitDecimal(str) {
  // < 2^49, so Number() is exact (doubles are exact to 2^53).
  var v = Number(str);
  return [(v % 4294967296) | 0, Math.floor(v / 4294967296) | 0];
}

function handleRequest(msg) {
  var p = splitDecimal(msg.position);
  var m = splitDecimal(msg.mask);
  var res = solve(p[0], p[1], m[0], m[1], msg.maxDepth, msg.timeMs);
  res.id = msg.id;
  return res;
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = function (e) { self.postMessage(handleRequest(e.data)); };
}

/* test hook — harmless in the browser, used by the Node test harnesses */
if (typeof globalThis !== 'undefined') {
  globalThis.__solverFast = {
    solve: solve,
    handleRequest: handleRequest,
    negamax: negamax,
    evaluate: evaluate,
    winningPositions: function (pLo, pHi, mLo, mHi) {
      winningPositions(pLo, pHi, mLo, mHi); return [wLo, wHi];
    },
    popcount2: popcount2,
    mirrorKey: function (a, b) { mirrorKey(a, b); return [mkLo, mkHi]; },
    splitDecimal: splitDecimal,
    consts: {
      BOARD_LO: BOARD_LO, BOARD_HI: BOARD_HI,
      BOTTOM_LO: BOTTOM_LO, BOTTOM_HI: BOTTOM_HI,
      COL_LO: COL_LO, COL_HI: COL_HI, TT_BITS: TT_BITS, WIN: WIN
    },
    setExactResultsMaxDepth: function (v) { EXACT_RESULTS_MAX_DEPTH = v; },
    clearTT: function () { ttArr.fill(0); ttGeneration = 0; }
  };
}
