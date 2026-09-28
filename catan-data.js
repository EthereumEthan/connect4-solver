/*
 * Catan rules data: hexes, number tokens, pip values, build costs, strategies,
 * and board generation/validation.
 *
 * The pip table is not taken on faith — PIP_CHECK below re-derives it by
 * enumerating all 36 two-dice outcomes, and the self-check compares the two.
 *
 * Depends on window.CatanGeo for hex adjacency (used by the red-number rule).
 * Exposes window.CatanData.
 */
(function (global) {
  'use strict';

  var RESOURCES = ['lumber', 'brick', 'wool', 'grain', 'ore'];

  var HEX_TYPES = ['forest', 'hills', 'pasture', 'fields', 'mountains', 'desert'];

  var HEX_RESOURCE = {
    forest: 'lumber', hills: 'brick', pasture: 'wool',
    fields: 'grain', mountains: 'ore', desert: null
  };

  var RESOURCE_HEX = {
    lumber: 'forest', brick: 'hills', wool: 'pasture',
    grain: 'fields', ore: 'mountains'
  };

  /* 19 land hexes. Brick and ore get only 3 each, which is why they are the
     scarce resources and why a brick pip is typically worth more than a wool pip. */
  var HEX_COUNTS = { forest: 4, hills: 3, pasture: 4, fields: 4, mountains: 3, desert: 1 };

  /* 18 tokens for the 18 non-desert hexes */
  var TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

  var PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

  /* 6 and 8 are printed in red, and standard setup forbids two reds adjacent */
  var RED = [6, 8];

  /* derive the 2d6 distribution from first principles, to check PIPS */
  var PIP_CHECK = (function () {
    var w = {};
    for (var a = 1; a <= 6; a++) {
      for (var b = 1; b <= 6; b++) {
        var s = a + b;
        w[s] = (w[s] || 0) + 1;
      }
    }
    return w;                            // {2:1,3:2,...,7:6,...,12:1}
  })();

  var COSTS = {
    road:       { lumber: 1, brick: 1 },
    settlement: { lumber: 1, brick: 1, wool: 1, grain: 1 },
    city:       { ore: 3, grain: 2 },
    devcard:    { ore: 1, wool: 1, grain: 1 }
  };

  var BUILDINGS = ['road', 'settlement', 'city', 'devcard'];

  /* A strategy is a target build basket: a weighted mix of the four things you
     can buy. Scoring a spot means asking how fast it can produce this mix. */
  var STRATEGIES = [
    { id: 'oregrain', name: 'Ore-Grain (Cities + Dev)',
      blurb: 'Pump cities and development cards. Wants ore and grain, plus wool for cards.',
      mix: { road: 0.2, settlement: 0.3, city: 1.0, devcard: 0.8 } },
    { id: 'expansion', name: 'Expansion (Wood-Brick)',
      blurb: 'Grab land fast with roads and settlements. Wants lumber and brick.',
      mix: { road: 2.0, settlement: 1.0, city: 0.2, devcard: 0.1 } },
    { id: 'balanced', name: 'Balanced',
      blurb: 'A bit of everything. Rewards spots that touch many resources.',
      mix: { road: 1.0, settlement: 0.8, city: 0.6, devcard: 0.5 } },
    { id: 'longestroad', name: 'Longest Road',
      blurb: 'Road spam for the 2 victory points. Almost pure lumber and brick.',
      mix: { road: 4.0, settlement: 0.6, city: 0.1, devcard: 0.1 } },
    { id: 'devcard', name: 'Dev Cards (Largest Army)',
      blurb: 'Buy cards for knights and points. Wants ore, wool and grain evenly.',
      mix: { road: 0.2, settlement: 0.2, city: 0.3, devcard: 2.0 } }
  ];

  /* mix over buildings -> normalised resource cost vector for one "basket" */
  function basketCost(mix) {
    var out = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
    var total = 0;
    for (var i = 0; i < BUILDINGS.length; i++) {
      var b = BUILDINGS[i];
      var w = mix[b] || 0;
      total += w;
      var cost = COSTS[b];
      for (var r in cost) {
        if (Object.prototype.hasOwnProperty.call(cost, r)) out[r] += cost[r] * w;
      }
    }
    /* normalise so baskets across strategies are comparable in size: one basket
       is one average purchase, not one of each thing */
    if (total > 0) {
      for (var j = 0; j < RESOURCES.length; j++) out[RESOURCES[j]] /= total;
    }
    return out;
  }

  function strategyById(id) {
    for (var i = 0; i < STRATEGIES.length; i++) if (STRATEGIES[i].id === id) return STRATEGIES[i];
    return STRATEGIES[0];
  }

  /* ---------------- ports ---------------- */
  /* 4 generic 3:1 plus one 2:1 for each of the five resources */
  function defaultPorts() {
    var ports = [];
    for (var i = 0; i < RESOURCES.length; i++) {
      ports.push({ id: ports.length, kind: '2:1', resource: RESOURCES[i] });
    }
    while (ports.length < 9) ports.push({ id: ports.length, kind: '3:1', resource: null });
    return ports;
  }

  /* ---------------- rng ---------------- */
  /*
   * Deterministic PRNG so the Monte Carlo lab is reproducible.
   *
   * This is splitmix32, NOT xorshift, and the choice matters. The lab seeds
   * thousands of boards with consecutive integers, and xorshift32 emits strongly
   * correlated first outputs for nearby seeds — which showed up as a measurable
   * bias in where the desert and the red tokens landed. splitmix32 adds the
   * golden-ratio gamma and avalanches every call, so consecutive seeds give
   * independent streams from the first draw.
   */
  function makeRng(seed) {
    if (typeof seed === 'function') return seed;
    var s = (seed === undefined || seed === null)
      ? ((Math.random() * 4294967296) >>> 0) : (seed | 0);
    return function () {
      s = (s + 0x9e3779b9) | 0;
      var t = s ^ (s >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      t = t ^ (t >>> 15);
      return (t >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function hexTypeBag() {
    var bag = [];
    for (var t in HEX_COUNTS) {
      if (!Object.prototype.hasOwnProperty.call(HEX_COUNTS, t)) continue;
      for (var i = 0; i < HEX_COUNTS[t]; i++) bag.push(t);
    }
    return bag;                          // 19 entries
  }

  function isRed(n) { return n === 6 || n === 8; }

  /* ---------------- board generation ---------------- */
  /*
   * Produces a legal board: exact hex multiset, exact token multiset, desert has
   * no token, and (by default) no two red 6/8 tokens on adjacent hexes.
   * The red rule is enforced by rejection sampling on the token placement only,
   * which keeps the hex-type distribution uniform.
   */
  function randomBoard(seedOrRng, options) {
    var opts = options || {};
    var rng = makeRng(seedOrRng);
    var noAdjacentRed = opts.noAdjacentRed !== false;
    var geo = global.CatanGeo;

    var types = shuffle(hexTypeBag(), rng);
    var hexes = [];
    for (var i = 0; i < types.length; i++) {
      hexes.push({ id: i, type: types[i], number: null });
    }

    var landIdx = [];
    for (var j = 0; j < hexes.length; j++) if (hexes[j].type !== 'desert') landIdx.push(j);

    var placed = false;
    for (var attempt = 0; attempt < 400 && !placed; attempt++) {
      var toks = shuffle(TOKENS.slice(), rng);
      for (var k = 0; k < landIdx.length; k++) hexes[landIdx[k]].number = toks[k];
      if (!noAdjacentRed || !geo) { placed = true; break; }
      var bad = false;
      for (var h = 0; h < hexes.length && !bad; h++) {
        if (!isRed(hexes[h].number)) continue;
        var nb = geo.hexNeighbors(h);
        for (var n = 0; n < nb.length; n++) {
          if (isRed(hexes[nb[n]].number)) { bad = true; break; }
        }
      }
      if (!bad) placed = true;
    }

    var ports = defaultPorts();
    shuffle(ports, rng);
    for (var p = 0; p < ports.length; p++) ports[p].id = p;

    return { hexes: hexes, ports: ports };
  }

  /*
   * A fixed, legal, well-spread layout for repeatable analysis and demos.
   * NOTE: this is our own balanced reference arrangement, NOT the licensed
   * official beginner setup — we do not assert an arrangement we cannot verify.
   * Rows are 3,4,5,4,3 read left to right, top to bottom.
   */
  var REFERENCE_TYPES = [
    'mountains', 'pasture', 'forest',
    'fields', 'hills', 'pasture', 'hills',
    'fields', 'forest', 'desert', 'forest', 'mountains',
    'forest', 'mountains', 'fields', 'pasture',
    'hills', 'fields', 'pasture'
  ];
  /* tokens in the same order, desert skipped */
  var REFERENCE_NUMBERS = [
    10, 2, 9,
    12, 6, 4, 10,
    9, 11, null, 3, 8,
    8, 3, 4, 5,
    5, 6, 11
  ];

  function referenceBoard() {
    var hexes = [];
    for (var i = 0; i < 19; i++) {
      hexes.push({ id: i, type: REFERENCE_TYPES[i], number: REFERENCE_NUMBERS[i] });
    }
    var ports = [
      { id: 0, kind: '3:1', resource: null },
      { id: 1, kind: '2:1', resource: 'grain' },
      { id: 2, kind: '2:1', resource: 'ore' },
      { id: 3, kind: '3:1', resource: null },
      { id: 4, kind: '2:1', resource: 'wool' },
      { id: 5, kind: '3:1', resource: null },
      { id: 6, kind: '2:1', resource: 'brick' },
      { id: 7, kind: '3:1', resource: null },
      { id: 8, kind: '2:1', resource: 'lumber' }
    ];
    return { hexes: hexes, ports: ports };
  }

  /* ---------------- validation ---------------- */
  function multiset(list) {
    var m = {};
    for (var i = 0; i < list.length; i++) m[list[i]] = (m[list[i]] || 0) + 1;
    return m;
  }

  function sameMultiset(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) if (a[ka[i]] !== b[ka[i]]) return false;
    return true;
  }

  function validateBoard(board) {
    var errors = [];
    var geo = global.CatanGeo;

    if (!board || !board.hexes) return { ok: false, errors: ['no board'] };
    if (board.hexes.length !== 19) errors.push('expected 19 hexes, got ' + board.hexes.length);

    var types = [], nums = [];
    for (var i = 0; i < board.hexes.length; i++) {
      var h = board.hexes[i];
      types.push(h.type);
      if (HEX_TYPES.indexOf(h.type) < 0) errors.push('hex ' + i + ' has unknown type ' + h.type);
      if (h.type === 'desert') {
        if (h.number !== null && h.number !== undefined) {
          errors.push('desert hex ' + i + ' must not have a number');
        }
      } else {
        if (h.number === null || h.number === undefined) {
          errors.push('hex ' + i + ' is missing a number');
        } else if (PIPS[h.number] === undefined) {
          errors.push('hex ' + i + ' has an illegal number ' + h.number);
        } else {
          nums.push(h.number);
        }
      }
    }

    if (!sameMultiset(multiset(types), HEX_COUNTS)) {
      errors.push('hex types are not the legal set (need 4 forest, 3 hills, 4 pasture, ' +
                  '4 fields, 3 mountains, 1 desert)');
    }
    if (nums.length === 18 && !sameMultiset(multiset(nums), multiset(TOKENS))) {
      errors.push('number tokens are not the legal set');
    }

    if (geo) {
      for (var h2 = 0; h2 < board.hexes.length; h2++) {
        if (!isRed(board.hexes[h2].number)) continue;
        var nb = geo.hexNeighbors(h2);
        for (var n = 0; n < nb.length; n++) {
          if (isRed(board.hexes[nb[n]].number) && nb[n] > h2) {
            errors.push('red numbers adjacent: hexes ' + h2 + ' and ' + nb[n]);
          }
        }
      }
    }

    if (board.ports) {
      if (board.ports.length !== 9) errors.push('expected 9 ports, got ' + board.ports.length);
      var generic = 0, specific = {};
      for (var p = 0; p < board.ports.length; p++) {
        if (board.ports[p].kind === '3:1') generic++;
        else if (board.ports[p].kind === '2:1') {
          specific[board.ports[p].resource] = (specific[board.ports[p].resource] || 0) + 1;
        }
      }
      if (generic !== 4) errors.push('expected 4 generic 3:1 ports, got ' + generic);
      for (var r = 0; r < RESOURCES.length; r++) {
        if (specific[RESOURCES[r]] !== 1) {
          errors.push('expected exactly one 2:1 port for ' + RESOURCES[r]);
        }
      }
    }

    return { ok: errors.length === 0, errors: errors };
  }

  /* ---------------- board-level resource stats ---------------- */
  /*
   * Static scarcity comes from the hex counts (brick and ore have 3 hexes, the
   * rest have 4). Board scarcity comes from where the numbers actually landed:
   * three ore hexes on 2, 12 and 3 is a very different board from three on 6, 8 and 5.
   */
  function resourceStats(board) {
    var out = {};
    for (var i = 0; i < RESOURCES.length; i++) {
      out[RESOURCES[i]] = { resource: RESOURCES[i], hexes: 0, pips: 0, expected: 0 };
    }
    for (var h = 0; h < board.hexes.length; h++) {
      var res = HEX_RESOURCE[board.hexes[h].type];
      if (!res) continue;
      var p = PIPS[board.hexes[h].number] || 0;
      out[res].hexes++;
      out[res].pips += p;
      out[res].expected += p / 36;
    }
    var totalPips = 0;
    for (var j = 0; j < RESOURCES.length; j++) totalPips += out[RESOURCES[j]].pips;
    for (var k = 0; k < RESOURCES.length; k++) {
      var e = out[RESOURCES[k]];
      e.shareOfPips = totalPips > 0 ? e.pips / totalPips : 0;
      /* scarcity > 1 means this resource is rarer than an even split would give */
      e.scarcity = e.shareOfPips > 0 ? (1 / RESOURCES.length) / e.shareOfPips : Infinity;
    }
    return out;
  }

  /* ---------------- self-check ---------------- */
  var SELFCHECK = (function () {
    var errs = [];
    function need(c, m) { if (!c) errs.push(m); }

    /* the pip table must match the enumerated 2d6 distribution */
    for (var n in PIPS) {
      if (!Object.prototype.hasOwnProperty.call(PIPS, n)) continue;
      need(PIPS[n] === PIP_CHECK[n],
        'pip table wrong for ' + n + ': table says ' + PIPS[n] + ', dice say ' + PIP_CHECK[n]);
    }
    need(PIPS[7] === undefined, '7 must not be a token (it is the robber)');

    var bagLen = hexTypeBag().length;
    need(bagLen === 19, 'hex bag has ' + bagLen + ' entries, expected 19');
    need(TOKENS.length === 18, 'token bag has ' + TOKENS.length + ' entries, expected 18');

    /* 18 land hexes need 18 tokens */
    need(bagLen - HEX_COUNTS.desert === TOKENS.length, 'land hex count does not match token count');

    var ref = validateBoard(referenceBoard());
    need(ref.ok, 'reference board is illegal: ' + ref.errors.join('; '));

    if (errs.length && typeof console !== 'undefined') {
      console.error('CatanData self-check FAILED:', errs);
    }
    return errs;
  })();

  global.CatanData = {
    RESOURCES: RESOURCES, HEX_TYPES: HEX_TYPES, HEX_RESOURCE: HEX_RESOURCE,
    RESOURCE_HEX: RESOURCE_HEX, HEX_COUNTS: HEX_COUNTS,
    TOKENS: TOKENS, PIPS: PIPS, PIP_CHECK: PIP_CHECK, RED: RED, isRed: isRed,
    COSTS: COSTS, BUILDINGS: BUILDINGS,
    STRATEGIES: STRATEGIES, strategyById: strategyById, basketCost: basketCost,
    defaultPorts: defaultPorts,
    makeRng: makeRng, shuffle: shuffle,
    randomBoard: randomBoard,
    referenceBoard: referenceBoard,
    beginnerBoard: referenceBoard,        // alias; see the note on referenceBoard
    validateBoard: validateBoard,
    resourceStats: resourceStats,
    SELFCHECK: SELFCHECK
  };
})(typeof window !== 'undefined' ? window : globalThis);
