/* =============================================================================
 * catan-lab.js  --  Monte Carlo strategy lab for the placement model
 * Classic script. No modules, no dependencies. Attaches window.CatanLab.
 * Requires window.CatanData, window.CatanGeo, window.CatanModel.
 * =============================================================================
 *
 * WHAT IT MEASURES
 * ----------------
 * Generate n random legal boards. On each board, for every strategy, find the
 * best LEGAL opening pair (two non-adjacent settlements, scored on combined
 * production) with CatanModel. Then report per strategy:
 *   - mean / sd / variance / min / max / p10 / p50 / p90 of the best achievable
 *     build rate (baskets per turn),
 *   - how often it is the single best strategy on a board, two ways:
 *       rawWins  -- highest absolute baskets/turn. Biased, because a devcard
 *                   basket is cheaper than a city basket, so cheap baskets win
 *                   by construction. Reported for completeness only.
 *       zWins    -- highest STANDARDIZED score (rate - mean_s)/sd_s, computed in
 *                   a second pass. This is the meaningful one: it answers "which
 *                   strategy does THIS board favour relative to its own norm".
 *   - which resources and which numbers show up in the winning spots,
 *   - HOW OFTEN NAIVE PIP RANKING PICKS A DIFFERENT TOP SPOT (and a different
 *     top pair) than the build-rate model. That contrast is the headline.
 *
 * NOT FREEZING THE BROWSER
 * ------------------------
 * simulate() is synchronous and does the whole run, but it is internally batched
 * and invokes options.onBatch(progress) after every batch so a caller can show
 * progress. To actually yield to the event loop you want one of:
 *   CatanLab.createRun(n, options) -> { step(), done, progress(), result() }
 *       Pull-driven: the UI calls step() once per requestAnimationFrame /
 *       setTimeout(0) tick. One step == one batch of boards. Nothing blocks.
 *   CatanLab.simulateAsync(n, options) -> Promise<report>
 *       Same thing, driven for you, awaiting a macrotask yield between batches
 *       so paint and input still happen. This is the recommended UI entry point.
 * Default batchSize is 10 boards (~20ms measured in Node), tune via options.batchSize.
 *
 * All the limitations of catan-model.js apply here unchanged: fluid resources,
 * no timing, no robber by default, no opponents, no player trade.
 * ========================================================================== */

(function (global) {
  'use strict';

  function M() {
    var m = global.CatanModel;
    if (!m) throw new Error('CatanLab: window.CatanModel is not loaded');
    return m;
  }
  function D() {
    var d = global.CatanData;
    if (!d) throw new Error('CatanLab: window.CatanData is not loaded');
    return d;
  }
  function G() {
    var g = global.CatanGeo;
    if (!g) throw new Error('CatanLab: window.CatanGeo is not loaded');
    return g;
  }

  /* --------------------------------------------------------------------- rng */
  // mulberry32: tiny, deterministic, good enough for board shuffling.
  function makeRng(seed) {
    var a = (seed === undefined || seed === null) ? 0x9e3779b9 : (seed | 0);
    if (a === 0) a = 0x6d2b79f5;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------- stats */
  function stats(arr) {
    var n = arr.length;
    if (!n) return { n: 0, mean: 0, sd: 0, variance: 0, min: 0, max: 0, p10: 0, p50: 0, p90: 0 };
    var i, s = 0;
    for (i = 0; i < n; i++) s += arr[i];
    var mean = s / n;
    var v = 0;
    for (i = 0; i < n; i++) { var d = arr[i] - mean; v += d * d; }
    v /= n;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    function q(p) {
      var idx = (n - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    }
    return {
      n: n, mean: mean, sd: Math.sqrt(v), variance: v,
      min: sorted[0], max: sorted[n - 1],
      p10: q(0.10), p50: q(0.50), p90: q(0.90)
    };
  }

  function bump(obj, key, by) { obj[key] = (obj[key] || 0) + (by === undefined ? 1 : by); }

  function topKeys(counts, k) {
    var out = [];
    for (var key in counts) if (Object.prototype.hasOwnProperty.call(counts, key)) out.push({ key: key, count: counts[key] });
    out.sort(function (a, b) { return b.count - a.count || (a.key < b.key ? -1 : 1); });
    if (k) out.length = Math.min(out.length, k);
    return out;
  }

  /* ------------------------------------------------------------ board source */
  function makeBoardFactory(options) {
    if (typeof options.boardFactory === 'function') return options.boardFactory;
    var d = D();
    var mode = null;   // 'fn' -> randomBoard(rng), 'seed' -> randomBoard(int)
    return function (rng, i) {
      if (mode === 'fn') return d.randomBoard(rng);
      if (mode === 'seed') return d.randomBoard((rng() * 0x7fffffff) | 0);
      try {
        var b = d.randomBoard(rng);
        if (b && b.hexes && b.hexes.length) { mode = 'fn'; return b; }
      } catch (e) { /* fall through */ }
      mode = 'seed';
      return d.randomBoard((rng() * 0x7fffffff) | 0);
    };
  }

  /* ------------------------------------------------------ best legal pip pair */
  function bestPipPair(entry, adj, nv) {
    var best = -Infinity, bp = null;
    for (var a = 0; a < nv; a++) {
      for (var b = a + 1; b < nv; b++) {
        if (adj[a * nv + b]) continue;
        var s = entry.pips[a] + entry.pips[b];
        if (s > best) { best = s; bp = [a, b]; }
      }
    }
    return { pair: bp, pips: best };
  }

  function argMaxSet(values, nv, eps) {
    var best = -Infinity, i;
    for (i = 0; i < nv; i++) if (values[i] > best) best = values[i];
    var set = [];
    for (i = 0; i < nv; i++) if (values[i] >= best - eps) set.push(i);
    return { best: best, set: set };
  }

  function setsIntersect(a, b) {
    for (var i = 0; i < a.length; i++) for (var j = 0; j < b.length; j++) if (a[i] === b[j]) return true;
    return false;
  }

  /* ============================================================= the run loop */

  /**
   * createRun(n, options) -> pull-driven runner.
   *   options:
   *     seed        : int, default 12345 (deterministic)
   *     batchSize   : boards per step(), default 10
   *     strategies  : array of strategy ids to include (default: all)
   *     modelOptions: passed through to CatanModel (robberDiscount, ...)
   *     boardFactory: function(rng, i) -> board  (default CatanData.randomBoard)
   *     validate    : bool, default true -- count boards CatanData rejects
   *     onBatch     : function(progress) called by simulate()/simulateAsync()
   */
  function createRun(n, options) {
    options = options || {};
    var model = M();
    var geo = G();
    var data = D();
    var nv = geo.VERTICES.length;
    var adj = model._internal.adjacencyMatrix();
    var modelOptions = options.modelOptions || options.options || null;

    var allBaskets = model._internal.baskets();
    if (options.strategies && options.strategies.length) {
      var want = {};
      for (var w = 0; w < options.strategies.length; w++) want[options.strategies[w]] = 1;
      allBaskets = allBaskets.filter(function (b) { return want[b.id]; });
    }
    var ns = allBaskets.length;
    var batchSize = Math.max(1, options.batchSize || 10);
    var validate = options.validate !== false;
    var rng = makeRng(options.seed === undefined ? 12345 : options.seed);
    var factory = makeBoardFactory(options);
    var t0 = (typeof Date.now === 'function') ? Date.now() : 0;

    // accumulators
    var pairRates = [];          // [strategy][board]
    var soloRates = [];
    var spotDisagree = [];       // counts
    var pairDisagree = [];
    var resourceCounts = [];
    var numberCounts = [];
    var hexTypeCounts = [];
    var portCounts = [];
    var synergySum = [];
    for (var s = 0; s < ns; s++) {
      pairRates.push([]); soloRates.push([]);
      spotDisagree.push(0); pairDisagree.push(0);
      resourceCounts.push({}); numberCounts.push({}); hexTypeCounts.push({}); portCounts.push(0);
      synergySum.push(0);
    }
    var invalidBoards = 0, boardsDone = 0;
    var EPS = 1e-12;

    function oneBoard(board) {
      if (validate && typeof data.validateBoard === 'function') {
        var vr = data.validateBoard(board);
        if (vr && vr.ok === false) invalidBoards++;
      }
      var entry = model._internal.boardEntry(board, modelOptions);
      var pipPair = bestPipPair(entry, adj, nv);
      var pipSpot = argMaxSet(entry.pips, nv, EPS);

      for (var si = 0; si < ns; si++) {
        var bArr = allBaskets[si].b;

        // --- best single spot under the model, plus pip disagreement
        var scores = new Float64Array(nv);
        for (var v = 0; v < nv; v++) {
          scores[v] = model._internal.buildRateArr(
            arrProd(entry, v), arrRates(entry, v), bArr);
        }
        var modelSpot = argMaxSet(scores, nv, 1e-12);
        soloRates[si].push(modelSpot.best);
        if (!setsIntersect(modelSpot.set, pipSpot.set)) spotDisagree[si]++;

        // --- best legal pair under the model (exhaustive, exact)
        var top = model._internal.searchPairs(board, bArr, 1, modelOptions);
        var best = top[0];
        pairRates[si].push(best ? best.score : 0);

        if (best) {
          // pip-vs-model on PAIRS: is the model's best pair also a pip-best pair?
          var modelPairPips = entry.pips[best.a] + entry.pips[best.b];
          if (modelPairPips < pipPair.pips - EPS) pairDisagree[si]++;

          var solo = model._internal.buildRateArr(arrProd(entry, best.a), arrRates(entry, best.a), bArr)
                   + model._internal.buildRateArr(arrProd(entry, best.b), arrRates(entry, best.b), bArr);
          synergySum[si] += best.score - solo;

          // what the winning spots are made of
          var vs = [best.a, best.b];
          var seenPort = false;
          for (var k = 0; k < 2; k++) {
            var hs = geo.vertexHexes(vs[k]) || [];
            for (var hi = 0; hi < hs.length; hi++) {
              var h = board.hexes[hs[hi]];
              if (!h) continue;
              bump(hexTypeCounts[si], h.type);
              var res = data.HEX_RESOURCE[h.type];
              if (res) bump(resourceCounts[si], res);
              if (h.number !== null && h.number !== undefined) bump(numberCounts[si], String(h.number));
            }
            if (entry.three[vs[k]]) seenPort = true;
            for (var r = 0; r < 5; r++) if (entry.two[vs[k] * 5 + r]) seenPort = true;
          }
          if (seenPort) portCounts[si]++;
        }
      }
      boardsDone++;
    }

    function arrProd(entry, v) {
      var base = v * 5;
      return [entry.prod[base], entry.prod[base + 1], entry.prod[base + 2], entry.prod[base + 3], entry.prod[base + 4]];
    }
    function arrRates(entry, v) {
      var out = [4, 4, 4, 4, 4], base = v * 5;
      for (var r = 0; r < 5; r++) {
        if (entry.two[base + r]) out[r] = 2;
        else if (entry.three[v]) out[r] = 3;
      }
      return out;
    }

    function step() {
      if (boardsDone >= n) return null;
      var end = Math.min(n, boardsDone + batchSize);
      while (boardsDone < end) oneBoard(factory(rng, boardsDone));
      return progress();
    }

    function progress() {
      return { done: boardsDone, total: n, fraction: n ? boardsDone / n : 1 };
    }

    function result() {
      var elapsed = ((typeof Date.now === 'function') ? Date.now() : 0) - t0;
      var si, i;

      var st = [];
      for (si = 0; si < ns; si++) st.push(stats(pairRates[si]));

      // raw wins: highest absolute baskets/turn (biased by basket size)
      // z wins  : highest standardized score -- which strategy this board favours
      var rawWins = new Array(ns), zWins = new Array(ns);
      for (si = 0; si < ns; si++) { rawWins[si] = 0; zWins[si] = 0; }
      for (i = 0; i < boardsDone; i++) {
        var bestRaw = -Infinity, bestRawI = -1, bestZ = -Infinity, bestZI = -1;
        for (si = 0; si < ns; si++) {
          var x = pairRates[si][i];
          if (x > bestRaw) { bestRaw = x; bestRawI = si; }
          var sd = st[si].sd;
          var z = sd > 0 ? (x - st[si].mean) / sd : 0;
          if (z > bestZ) { bestZ = z; bestZI = si; }
        }
        if (bestRawI >= 0) rawWins[bestRawI]++;
        if (bestZI >= 0) zWins[bestZI]++;
      }

      var pooledRes = {}, pooledNum = {}, pooledHex = {};
      var out = [];
      for (si = 0; si < ns; si++) {
        var key;
        for (key in resourceCounts[si]) bump(pooledRes, key, resourceCounts[si][key]);
        for (key in numberCounts[si]) bump(pooledNum, key, numberCounts[si][key]);
        for (key in hexTypeCounts[si]) bump(pooledHex, key, hexTypeCounts[si][key]);
        out.push({
          id: allBaskets[si].id,
          name: allBaskets[si].name,
          basketCost: M().basketCostOf(allBaskets[si].strategy),
          bestPairRate: st[si],
          meanRate: st[si].mean,
          sd: st[si].sd,
          variance: st[si].variance,
          bestSoloRate: stats(soloRates[si]),
          rawWins: rawWins[si],
          rawWinRate: boardsDone ? rawWins[si] / boardsDone : 0,
          zWins: zWins[si],
          zWinRate: boardsDone ? zWins[si] / boardsDone : 0,
          meanSynergy: boardsDone ? synergySum[si] / boardsDone : 0,
          topSpotDisagreements: spotDisagree[si],
          topSpotDisagreementRate: boardsDone ? spotDisagree[si] / boardsDone : 0,
          topPairDisagreements: pairDisagree[si],
          topPairDisagreementRate: boardsDone ? pairDisagree[si] / boardsDone : 0,
          portPairRate: boardsDone ? portCounts[si] / boardsDone : 0,
          resourceCounts: resourceCounts[si],
          numberCounts: numberCounts[si],
          hexTypeCounts: hexTypeCounts[si],
          topResources: topKeys(resourceCounts[si], 5),
          topNumbers: topKeys(numberCounts[si], 6)
        });
      }

      // per-strategy rates are the meaningful disagreement numbers; pool them
      var spotSum = 0, pairSum = 0;
      for (si = 0; si < ns; si++) { spotSum += spotDisagree[si]; pairSum += pairDisagree[si]; }

      return {
        boards: boardsDone,
        requested: n,
        seed: options.seed === undefined ? 12345 : options.seed,
        elapsedMs: elapsed,
        invalidBoards: invalidBoards,
        strategies: out,
        pooled: {
          topSpotDisagreementRate: (boardsDone * ns) ? spotSum / (boardsDone * ns) : 0,
          topPairDisagreementRate: (boardsDone * ns) ? pairSum / (boardsDone * ns) : 0,
          resourceCounts: pooledRes,
          numberCounts: pooledNum,
          hexTypeCounts: pooledHex,
          topResources: topKeys(pooledRes, 5),
          topNumbers: topKeys(pooledNum, 8),
          topHexTypes: topKeys(pooledHex, 6)
        },
        notes: [
          'rawWins compares absolute baskets/turn and is biased toward cheap baskets; use zWins.',
          'Robber ignored unless modelOptions.robberDiscount / robberRedDiscount are set.',
          'Resources are treated as fluid; k is a throughput rate, not a build plan.'
        ]
      };
    }

    return {
      step: step,
      progress: progress,
      result: result,
      get done() { return boardsDone >= n; },
      isDone: function () { return boardsDone >= n; }
    };
  }

  /** Synchronous full run. Batched; calls options.onBatch(progress) per batch. */
  function simulate(n, options) {
    options = options || {};
    var run = createRun(n, options);
    var p;
    while ((p = run.step()) !== null) {
      if (typeof options.onBatch === 'function') options.onBatch(p);
    }
    return run.result();
  }

  /** Browser-friendly run: yields a macrotask between batches so the UI paints. */
  function simulateAsync(n, options) {
    options = options || {};
    var run = createRun(n, options);
    var yieldTo = (typeof setTimeout === 'function')
      ? function (fn) { setTimeout(fn, 0); }
      : function (fn) { Promise.resolve().then(fn); };
    return new Promise(function (resolve, reject) {
      function tick() {
        try {
          var p = run.step();
          if (p === null) { resolve(run.result()); return; }
          if (typeof options.onBatch === 'function') options.onBatch(p);
          yieldTo(tick);
        } catch (e) { reject(e); }
      }
      yieldTo(tick);
    });
  }

  global.CatanLab = {
    VERSION: '1.0.0',
    simulate: simulate,
    simulateAsync: simulateAsync,
    createRun: createRun,
    makeRng: makeRng,
    stats: stats
  };
})(typeof window !== 'undefined' ? window : globalThis);
