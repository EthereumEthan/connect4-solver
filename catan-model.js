/* =============================================================================
 * catan-model.js  --  Catan starting-placement valuation engine
 * Classic script. No modules, no dependencies. Attaches window.CatanModel.
 * Requires window.CatanData and window.CatanGeo (resolved lazily, at call time).
 * =============================================================================
 *
 * THE MODEL, IN ONE SENTENCE
 * -------------------------
 * A spot is not worth its pip sum. A spot is worth HOW FAST IT BUILDS WHAT YOU
 * WANT. We measure that in "baskets per turn".
 *
 *   1. Expected production of resource r from a set of owned vertices:
 *          P[r] = SUM over adjacent producing hexes of PIPS(number)/36
 *      (a hex touched by two of your settlements is counted twice -- you get a
 *      card per settlement).
 *
 *   2. A STRATEGY is a target build basket: a nonnegative mix over
 *      {road, settlement, city, devcard}, turned into a resource cost vector
 *      b[r] by CatanData.basketCost(mix).
 *
 *   3. SCORE = the largest k such that the income stream P can be converted
 *      into k*b using trades at the best rate the owned ports allow:
 *          surplus_r = max(0, P[r] - k*b[r])
 *          deficit_r = max(0, k*b[r] - P[r])
 *          feasible(k)  iff  SUM_r(surplus_r / rate_r)  >=  SUM_r(deficit_r)
 *      feasible() is monotone decreasing in k (surpluses shrink, deficits grow),
 *      so k is found by BINARY SEARCH. Units: baskets per turn.
 *
 * Why this single formula is enough: it prices pips, scarcity, synergy,
 * diversity and ports with no special cases. Three different resources beat
 * three of a kind because the basket needs a mix and conversion is lossy. A 2:1
 * port raises the value of a spot heavy in that resource and is worth exactly
 * nothing to a spot that produces none of it. Two settlements are scored on
 * their COMBINED production, so complementary pairs beat two copies of the same
 * good spot -- which is the whole point of an opening.
 *
 * LIMITATIONS -- READ THESE. The model is deliberately first-order.
 * ----------------------------------------------------------------
 *  * FLUID RESOURCES. Production and costs are continuous. Real Catan is
 *    integral and lumpy: you cannot spend 0.37 of a brick, and a 4:1 trade
 *    needs four actual cards in hand. Fractional k is a rate, not a plan.
 *  * NO TIMING / NO SEQUENCING. k is a steady-state throughput. It says nothing
 *    about which build comes first, about the first-two-turns burst, or about
 *    racing an opponent to a spot.
 *  * NO ROBBER BY DEFAULT. Expected income ignores the 7 and the robber
 *    entirely (see OPTIONS.robberDiscount / robberRedDiscount to switch on a
 *    crude discount; both default to 0 = robber ignored).
 *  * NO 7-CARD DISCARD, no monopoly/year-of-plenty, no dev-card variance.
 *  * NO OPPONENTS. No player-to-player trade (usually the best rate in a real
 *    game), no blocking, no placement order, no competition for the spot.
 *  * PORTS ARE FREE TO REACH. Touching a port vertex is treated as owning the
 *    rate immediately; in reality you must settle there, not merely be near it.
 *  * ALL SURPLUS IS TRADEABLE. The conversion inequality lets any surplus feed
 *    any deficit at that resource's own rate, which is generous: it assumes you
 *    always have the right 4 cards of the right colour at the right time.
 *  * BASKETS ARE NOT COMMENSURABLE ACROSS STRATEGIES. A devcard basket costs
 *    fewer resources than a city basket, so "3 devcard baskets/turn" is not
 *    better than "1 city basket/turn". Compare spots WITHIN a strategy; across
 *    strategies compare standardized scores (CatanLab does this).
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- plumbing */

  var RES = ['lumber', 'brick', 'wool', 'grain', 'ore'];
  var NR = 5;
  var IDX = { lumber: 0, brick: 1, wool: 2, grain: 3, ore: 4 };

  function D() {
    var d = global.CatanData;
    if (!d) throw new Error('CatanModel: window.CatanData is not loaded');
    return d;
  }
  function G() {
    var g = global.CatanGeo;
    if (!g) throw new Error('CatanModel: window.CatanGeo is not loaded');
    return g;
  }

  /* ---- ADAPTER / FALLBACK ---------------------------------------------------
   * Everything below is a narrow shim over the CatanData contract. It is used
   * ONLY when the corresponding CatanData member is missing or empty, so that
   * this file never hard-crashes on a load-order problem. When CatanData is
   * present its values always win. Flagged in the report as an added (soft)
   * dependency assumption.
   * ------------------------------------------------------------------------ */

  var FALLBACK_STRATEGIES = [
    { id: 'ore_grain', name: 'Ore-Grain / Cities + Dev', blurb: 'Fewer, bigger settlements: pump cities and dev cards.', mix: { road: 0.5, settlement: 0.5, city: 2, devcard: 1.5 } },
    { id: 'expansion', name: 'Expansion / Wood-Brick', blurb: 'Roads and settlements, claim the board early.', mix: { road: 3, settlement: 2, city: 0.25, devcard: 0.25 } },
    { id: 'balanced', name: 'Balanced', blurb: 'Take what the dice give you; keep every option open.', mix: { road: 1, settlement: 1, city: 1, devcard: 1 } },
    { id: 'longest_road', name: 'Longest Road', blurb: 'Wood and brick above all, roads forever.', mix: { road: 6, settlement: 1, city: 0.25, devcard: 0.5 } },
    { id: 'devcard', name: 'Dev Card / Largest Army', blurb: 'Buy knights, take the robber and the army card.', mix: { road: 0.5, settlement: 0.5, city: 0.5, devcard: 4 } }
  ];

  function strategies() {
    var d = global.CatanData;
    var s = d && d.STRATEGIES;
    if (s && s.length) return s;
    return FALLBACK_STRATEGIES;
  }

  function strategyById(id) {
    var list = strategies();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function basketCostOf(strategy) {
    var d = global.CatanData;
    if (d && typeof d.basketCost === 'function') return d.basketCost(strategy.mix);
    // fallback: mix-weighted sum of COSTS
    var costs = (d && d.COSTS) || {
      road: { lumber: 1, brick: 1 },
      settlement: { lumber: 1, brick: 1, wool: 1, grain: 1 },
      city: { ore: 3, grain: 2 },
      devcard: { ore: 1, wool: 1, grain: 1 }
    };
    var out = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
    for (var item in strategy.mix) {
      if (!Object.prototype.hasOwnProperty.call(strategy.mix, item)) continue;
      var w = strategy.mix[item] || 0;
      var c = costs[item];
      if (!c || !w) continue;
      for (var r in c) if (Object.prototype.hasOwnProperty.call(c, r)) out[r] += w * c[r];
    }
    return out;
  }

  function pipsOf(n) {
    if (n === null || n === undefined) return 0;
    var p = D().PIPS[n];
    return p ? p : 0;
  }

  function resourceOfHexType(t) {
    var m = D().HEX_RESOURCE;
    var r = m ? m[t] : null;
    return r === undefined ? null : r;
  }

  function isRed(n) {
    var red = D().RED || [6, 8];
    for (var i = 0; i < red.length; i++) if (red[i] === n) return true;
    return false;
  }

  /* ------------------------------------------------------------ vector utils */

  function zeros() { return [0, 0, 0, 0, 0]; }

  function toArr(obj, dflt) {
    if (!obj) { var z = zeros(); if (dflt !== undefined) for (var k = 0; k < NR; k++) z[k] = dflt; return z; }
    if (Object.prototype.toString.call(obj) === '[object Array]' || obj instanceof Float64Array) {
      return [+obj[0] || 0, +obj[1] || 0, +obj[2] || 0, +obj[3] || 0, +obj[4] || 0];
    }
    var a = zeros();
    for (var i = 0; i < NR; i++) {
      var v = obj[RES[i]];
      a[i] = (v === undefined || v === null || v !== v) ? (dflt === undefined ? 0 : dflt) : +v;
    }
    return a;
  }

  function toObj(arr) {
    return { lumber: arr[0], brick: arr[1], wool: arr[2], grain: arr[3], ore: arr[4] };
  }

  /* ------------------------------------------------------------------ options */

  var OPTIONS = {
    // Multiplicative discount applied to EVERY hex (robber / discards / general
    // leakage). Note: a uniform discount only rescales every score, because
    // buildRate is homogeneous of degree 1 in P -- it cannot change a ranking.
    robberDiscount: 0,
    // Extra multiplicative discount on RED numbers (6 and 8) only -- robbers
    // camp on those. This DOES change rankings. Default 0 = robber ignored.
    robberRedDiscount: 0
  };

  function normOpts(o) {
    o = o || {};
    var a = o.robberDiscount;
    var b = o.robberRedDiscount;
    return {
      robberDiscount: (a === undefined || a === null) ? OPTIONS.robberDiscount : (+a || 0),
      robberRedDiscount: (b === undefined || b === null) ? OPTIONS.robberRedDiscount : (+b || 0)
    };
  }
  function optSig(o) { return o.robberDiscount + '|' + o.robberRedDiscount; }

  /* ------------------------------------------------------- per-board caching */

  var cache = (typeof WeakMap === 'function') ? new WeakMap() : null;

  function boardEntry(board, opts) {
    var sig = optSig(opts);
    var e = cache ? cache.get(board) : null;
    if (e && e.sig === sig) return e;
    e = buildEntry(board, opts);
    e.sig = sig;
    if (cache) cache.set(board, e);
    return e;
  }

  // prod: Float64Array(54*5) of per-vertex expected income
  // sums: Float64Array(54)   of total expected cards/turn per vertex
  // pips: Float64Array(54)   naive pip sum per vertex
  // three: Uint8Array(54)    vertex touches a 3:1 port
  // two:   Uint8Array(54*5)  vertex touches a 2:1 port for that resource
  function buildEntry(board, opts) {
    var geo = G();
    var nv = geo.VERTICES.length;
    var prod = new Float64Array(nv * NR);
    var sums = new Float64Array(nv);
    var pips = new Float64Array(nv);
    var three = new Uint8Array(nv);
    var two = new Uint8Array(nv * NR);
    var kUniform = 1 - opts.robberDiscount;
    var kRed = kUniform * (1 - opts.robberRedDiscount);
    var hexes = board.hexes || [];
    var ports = board.ports || [];
    var v, i;

    for (v = 0; v < nv; v++) {
      var hs = geo.vertexHexes(v) || [];
      var tot = 0, pipSum = 0;
      for (i = 0; i < hs.length; i++) {
        var h = hexes[hs[i]];
        if (!h) continue;
        var p = pipsOf(h.number);
        if (!p) continue;
        pipSum += p;
        var res = resourceOfHexType(h.type);
        if (!res) continue;                       // desert, or unknown type
        var rate = (isRed(h.number) ? kRed : kUniform) * (p / 36);
        if (rate < 0) rate = 0;
        prod[v * NR + IDX[res]] += rate;
        tot += rate;
      }
      sums[v] = tot;
      pips[v] = pipSum;

      var pl = (typeof geo.vertexPorts === 'function') ? (geo.vertexPorts(v) || []) : [];
      for (i = 0; i < pl.length; i++) {
        var port = ports[pl[i]];
        if (!port) continue;
        if (port.kind === '2:1' && port.resource && IDX[port.resource] !== undefined) {
          two[v * NR + IDX[port.resource]] = 1;
        } else if (port.kind === '3:1') {
          three[v] = 1;
        }
      }
    }
    return { prod: prod, sums: sums, pips: pips, three: three, two: two, nv: nv };
  }

  /* -------------------------------------------------------------- core maths */

  function asVertexList(vertexIds) {
    if (vertexIds === null || vertexIds === undefined) return [];
    if (typeof vertexIds === 'number') return [vertexIds];
    return vertexIds;
  }

  function prodArr(board, vertexIds, opts) {
    var e = boardEntry(board, opts);
    var list = asVertexList(vertexIds);
    var out = zeros();
    for (var i = 0; i < list.length; i++) {
      var v = list[i] | 0;
      if (v < 0 || v >= e.nv) continue;
      var base = v * NR;
      for (var r = 0; r < NR; r++) out[r] += e.prod[base + r];
    }
    return out;
  }

  function ratesArr(board, vertexIds, opts) {
    var e = boardEntry(board, opts);
    var list = asVertexList(vertexIds);
    var out = [4, 4, 4, 4, 4];
    var has3 = false, r;
    var has2 = [0, 0, 0, 0, 0];
    for (var i = 0; i < list.length; i++) {
      var v = list[i] | 0;
      if (v < 0 || v >= e.nv) continue;
      if (e.three[v]) has3 = true;
      for (r = 0; r < NR; r++) if (e.two[v * NR + r]) has2[r] = 1;
    }
    for (r = 0; r < NR; r++) {
      if (has2[r]) out[r] = 2;
      else if (has3) out[r] = 3;
    }
    return out;
  }

  /**
   * feasible(k): can production P be converted into k baskets of b?
   * surplus of r trades away at rate_r to 1 of anything; deficits must be
   * covered by the total so obtained.
   */
  function feasible(k, P, rate, b) {
    var supply = 0, need = 0;
    for (var r = 0; r < NR; r++) {
      var want = k * b[r];
      var d = want - P[r];
      if (d > 0) need += d;
      else if (d < 0) supply += (-d) / rate[r];
    }
    return supply >= need;
  }

  var BISECT_ITERS = 40;

  /* Scores come out of a binary search, so two spots that are mathematically
   * identical can differ in the last ulp. Compare with a relative epsilon so
   * genuine ties fall through to a stable tiebreak (pips, then vertex id) and a
   * spot never changes rank just because the whole board was rescaled. */
  var TIE_EPS = 1e-12;
  function scoreCmp(x, y) {
    var d = y - x;
    var scale = Math.max(Math.abs(x), Math.abs(y), 1e-300);
    return Math.abs(d) <= TIE_EPS * scale ? 0 : d;
  }

  /**
   * buildRateArr -- the engine. Max k with feasible(k). Binary search.
   *
   * Upper bound derivation (used to bracket the search):
   *   every rate_r >= 2, so  SUM surplus/rate <= (SUM P)/2, and
   *   SUM deficit >= k*(SUM b) - (SUM P).  feasible(k) therefore requires
   *   (SUM P)/2 >= k*(SUM b) - (SUM P), i.e.  k <= 1.5 * SUM P / SUM b.
   * k=0 is always feasible (all surplus, no deficit), so the bracket is sound.
   */
  function buildRateArr(P, rate, b) {
    var sumP = 0, sumB = 0, r;
    for (r = 0; r < NR; r++) {
      if (P[r] > 0) sumP += P[r];
      if (b[r] > 0) sumB += b[r];
    }
    // Degenerate guards -- these are the only division-by-zero paths.
    if (!(sumB > 0)) return 0;   // empty / invalid basket: no meaningful rate
    if (!(sumP > 0)) return 0;   // no production at all: nothing to convert
    var lo = 0, hi = 1.5 * sumP / sumB;
    if (feasible(hi, P, rate, b)) return hi;   // only at exact equality
    for (var i = 0; i < BISECT_ITERS; i++) {
      var mid = (lo + hi) / 2;
      if (feasible(mid, P, rate, b)) lo = mid; else hi = mid;
    }
    return lo;
  }

  /* --------------------------------------------------------- strategy tables */

  function basketArrFor(strategyId) {
    var s = (strategyId && typeof strategyId === 'object') ? strategyId : strategyById(strategyId);
    if (!s) {
      var list = strategies();
      s = list[0];
    }
    return toArr(basketCostOf(s));
  }

  function baskets() {
    var list = strategies();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      out.push({ id: list[i].id, name: list[i].name, strategy: list[i], b: toArr(basketCostOf(list[i])) });
    }
    return out;
  }

  /* --------------------------------------------------------- pair enumeration
   * Exact top-n search over all legal (non-adjacent) pairs.
   *
   * 1431 pairs is small, so a plain double loop is fine for one call. But the
   * Monte Carlo lab runs this thousands of times, so we prune with the SAME
   * upper bound that brackets the binary search:
   *        score(a,b) <= 1.5 * (sumP_a + sumP_b) / sumB
   * Vertices are visited in decreasing sumP, so once that bound drops below the
   * current n-th best score we can stop. The prune is exact (it discards only
   * pairs that provably cannot enter the top n); tests assert pruned == brute.
   */

  function adjacencyMatrix() {
    var geo = G();
    if (geo.__cm_adj) return geo.__cm_adj;
    var nv = geo.VERTICES.length;
    var m = new Uint8Array(nv * nv);
    for (var v = 0; v < nv; v++) {
      var ns = geo.vertexNeighbors(v) || [];
      for (var i = 0; i < ns.length; i++) {
        m[v * nv + ns[i]] = 1;
        m[ns[i] * nv + v] = 1;
      }
    }
    try { Object.defineProperty(geo, '__cm_adj', { value: m, enumerable: false }); } catch (e) { geo.__cm_adj = m; }
    return m;
  }

  function searchPairs(board, bArr, n, opts) {
    var e = boardEntry(board, opts);
    var nv = e.nv;
    var adj = adjacencyMatrix();
    var sumB = 0, r;
    for (r = 0; r < NR; r++) if (bArr[r] > 0) sumB += bArr[r];
    if (n === undefined || n === null || n < 1) n = 1;

    var order = [];
    for (var v = 0; v < nv; v++) order.push(v);
    order.sort(function (a, b2) { return e.sums[b2] - e.sums[a]; });
    var maxSum = nv ? e.sums[order[0]] : 0;

    var top = [];          // ascending by score, length <= n
    var threshold = -Infinity;
    var C = sumB > 0 ? 1.5 / sumB : Infinity;

    var P = zeros(), rate = [4, 4, 4, 4, 4];

    for (var ii = 0; ii < nv; ii++) {
      var a = order[ii];
      if (top.length >= n && C * (e.sums[a] + maxSum) <= threshold) break;
      var ba = a * NR;
      for (var jj = ii + 1; jj < nv; jj++) {
        var b = order[jj];
        if (top.length >= n && C * (e.sums[a] + e.sums[b]) <= threshold) break;
        if (adj[a * nv + b]) continue;          // DISTANCE RULE: never adjacent
        var bb = b * NR;
        var has3 = (e.three[a] || e.three[b]);
        for (r = 0; r < NR; r++) {
          P[r] = e.prod[ba + r] + e.prod[bb + r];
          rate[r] = (e.two[ba + r] || e.two[bb + r]) ? 2 : (has3 ? 3 : 4);
        }
        var sc = buildRateArr(P, rate, bArr);
        if (top.length < n || sc > threshold) {
          top.push({ a: a, b: b, score: sc, production: toObj(P), rates: toObj(rate.slice()) });
          top.sort(function (x, y) { return scoreCmp(x.score, y.score) || (x.a - y.a) || (x.b - y.b); });
          if (top.length > n) top.length = n;
          threshold = top[top.length - 1].score;
        }
      }
    }
    return top;
  }

  /* --------------------------------------------------------------- public API */

  function production(board, vertexIds, options) {
    return toObj(prodArr(board, vertexIds, normOpts(options)));
  }

  function tradeRates(board, vertexIds, options) {
    return toObj(ratesArr(board, vertexIds, normOpts(options)));
  }

  function buildRate(productionIn, ratesIn, basketCostIn) {
    return buildRateArr(toArr(productionIn), toArr(ratesIn, 4), toArr(basketCostIn));
  }

  function pipTotal(board, vertexId) {
    var e = boardEntry(board, normOpts(null));
    if (vertexId < 0 || vertexId >= e.nv) return 0;
    return e.pips[vertexId];
  }

  function scoreVertex(board, v, strategyId, options) {
    var opts = normOpts(options);
    var P = prodArr(board, v, opts);
    var rate = ratesArr(board, v, opts);
    var bs = baskets();
    var per = {}, best = null, bestScore = -Infinity, i;
    for (i = 0; i < bs.length; i++) {
      var sc = buildRateArr(P, rate, bs[i].b);
      per[bs[i].id] = sc;
      if (sc > bestScore) { bestScore = sc; best = bs[i].id; }
    }
    var score = (strategyId && per[strategyId] !== undefined) ? per[strategyId] : bestScore;
    if (strategyId && per[strategyId] === undefined) {
      // unknown strategy id: fall back to a fresh basket lookup (may be a
      // strategy object passed straight in)
      score = buildRateArr(P, rate, basketArrFor(strategyId));
    }
    return {
      vertex: v,
      strategyId: strategyId || best,
      score: score,
      production: toObj(P),
      rates: toObj(rate),
      pipTotal: pipTotal(board, v),
      bestStrategy: best,
      perStrategy: per
    };
  }

  function rankVertices(board, strategyId, options) {
    var opts = normOpts(options);
    var e = boardEntry(board, opts);
    var bArr = basketArrFor(strategyId);
    var out = [];
    for (var v = 0; v < e.nv; v++) {
      var P = prodArr(board, v, opts);
      var rate = ratesArr(board, v, opts);
      out.push({
        vertex: v,
        score: buildRateArr(P, rate, bArr),
        pipTotal: e.pips[v],
        production: toObj(P),
        rates: toObj(rate),
        totalCards: e.sums[v]
      });
    }
    out.sort(function (x, y) { return scoreCmp(x.score, y.score) || y.pipTotal - x.pipTotal || x.vertex - y.vertex; });
    for (var i = 0; i < out.length; i++) out[i].rank = i + 1;
    // naive pip ranking alongside, so the UI can show model-vs-pips movement
    var byPips = out.slice().sort(function (x, y) { return y.pipTotal - x.pipTotal || x.vertex - y.vertex; });
    for (i = 0; i < byPips.length; i++) byPips[i].pipRank = i + 1;
    for (i = 0; i < out.length; i++) out[i].rankDelta = out[i].pipRank - out[i].rank;
    return out;
  }

  function pairScore(board, a, b, strategyId, options) {
    var opts = normOpts(options);
    var P = prodArr(board, [a, b], opts);
    var rate = ratesArr(board, [a, b], opts);
    var bArr = basketArrFor(strategyId);
    return {
      a: a, b: b,
      legal: !areAdjacent(a, b),
      score: buildRateArr(P, rate, bArr),
      production: toObj(P),
      rates: toObj(rate),
      pipTotal: pipTotal(board, a) + pipTotal(board, b)
    };
  }

  function areAdjacent(a, b) {
    var geo = G();
    var nv = geo.VERTICES.length;
    return !!adjacencyMatrix()[a * nv + b];
  }

  function bestPairs(board, strategyId, n, options) {
    var opts = normOpts(options);
    var bArr = basketArrFor(strategyId);
    var top = searchPairs(board, bArr, n || 10, opts);
    var e = boardEntry(board, opts);
    for (var i = 0; i < top.length; i++) {
      var t = top[i];
      var sa = buildRateArr(prodArr(board, t.a, opts), ratesArr(board, t.a, opts), bArr);
      var sb = buildRateArr(prodArr(board, t.b, opts), ratesArr(board, t.b, opts), bArr);
      t.rank = i + 1;
      t.pipTotal = e.pips[t.a] + e.pips[t.b];
      t.soloScores = [sa, sb];
      t.sumOfSolo = sa + sb;
      t.synergy = t.score - (sa + sb);   // >0: the pair covers each other's gaps
    }
    return top;
  }

  function complements(board, v, strategyId, n, options) {
    var opts = normOpts(options);
    var e = boardEntry(board, opts);
    var bArr = basketArrFor(strategyId);
    var solo = buildRateArr(prodArr(board, v, opts), ratesArr(board, v, opts), bArr);
    var out = [];
    for (var u = 0; u < e.nv; u++) {
      if (u === v || areAdjacent(u, v)) continue;
      var P = prodArr(board, [v, u], opts);
      var rate = ratesArr(board, [v, u], opts);
      var sc = buildRateArr(P, rate, bArr);
      var soloU = buildRateArr(prodArr(board, u, opts), ratesArr(board, u, opts), bArr);
      out.push({
        vertex: u,
        pairScore: sc,
        firstPickSolo: solo,
        partnerSolo: soloU,
        gain: sc - solo,                 // marginal value of adding u
        synergy: sc - (solo + soloU),
        production: toObj(P),
        rates: toObj(rate),
        pipTotal: e.pips[u]
      });
    }
    out.sort(function (x, y) { return scoreCmp(x.pairScore, y.pairScore) || y.pipTotal - x.pipTotal || x.vertex - y.vertex; });
    if (n) out.length = Math.min(out.length, n);
    for (var i = 0; i < out.length; i++) out[i].rank = i + 1;
    return out;
  }

  function resourceRanking(board) {
    var d = D();
    var hexes = board.hexes || [];
    var acc = {};
    var i, r;
    for (i = 0; i < RES.length; i++) {
      acc[RES[i]] = { resource: RES[i], hexType: null, hexCount: 0, producingHexCount: 0, totalPips: 0, numbers: [] };
    }
    for (i = 0; i < hexes.length; i++) {
      var h = hexes[i];
      if (!h) continue;
      var res = resourceOfHexType(h.type);
      if (!res || !acc[res]) continue;
      acc[res].hexType = h.type;
      acc[res].hexCount++;
      var p = pipsOf(h.number);
      if (p > 0) { acc[res].producingHexCount++; acc[res].totalPips += p; acc[res].numbers.push(h.number); }
    }
    var allPips = 0;
    for (i = 0; i < RES.length; i++) allPips += acc[RES[i]].totalPips;
    var out = [];
    for (i = 0; i < RES.length; i++) {
      var a = acc[RES[i]];
      var share = allPips > 0 ? a.totalPips / allPips : 0;
      a.pipShare = share;
      // scarcity: 1.0 == this resource has its "fair" 1/5 share of all pips.
      // >1 means scarcer than average, so one of its pips is worth more.
      a.scarcity = share > 0 ? (1 / RES.length) / share : Infinity;
      a.pipsPerHex = a.hexCount > 0 ? a.totalPips / a.hexCount : 0;
      a.expectedCardsPerTurn = a.totalPips / 36;   // per settlement-equivalent
      a.numbers.sort(function (x, y) { return x - y; });
      out.push(a);
    }
    out.sort(function (x, y) { return y.scarcity - x.scarcity || x.totalPips - y.totalPips; });
    for (i = 0; i < out.length; i++) out[i].scarcityRank = i + 1;
    return out;
  }

  /* --------------------------------------------------------------- internals
   * Exposed for CatanLab's hot loop and for tests. Not part of the UI contract.
   */
  var internal = {
    RES: RES, IDX: IDX,
    toArr: toArr, toObj: toObj,
    boardEntry: function (board, options) { return boardEntry(board, normOpts(options)); },
    buildRateArr: buildRateArr,
    feasible: feasible,
    searchPairs: function (board, bArr, n, options) { return searchPairs(board, bArr, n, normOpts(options)); },
    adjacencyMatrix: adjacencyMatrix,
    baskets: baskets,
    basketArrFor: basketArrFor,
    normOpts: normOpts,
    FALLBACK_STRATEGIES: FALLBACK_STRATEGIES
  };

  global.CatanModel = {
    VERSION: '1.0.0',
    OPTIONS: OPTIONS,
    RESOURCES: RES,
    // core
    production: production,
    tradeRates: tradeRates,
    buildRate: buildRate,
    pipTotal: pipTotal,
    // valuation
    scoreVertex: scoreVertex,
    rankVertices: rankVertices,
    bestPairs: bestPairs,
    complements: complements,
    resourceRanking: resourceRanking,
    // extras
    pairScore: pairScore,
    areAdjacent: areAdjacent,
    strategies: strategies,
    strategyById: strategyById,
    basketCostOf: basketCostOf,
    _internal: internal
  };
})(typeof window !== 'undefined' ? window : globalThis);
