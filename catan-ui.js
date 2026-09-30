/*
 * Catan tab UI: board rendering, heatmap, spot/pair lists, strategy lab, and
 * the photo-scan flow.
 *
 * Depends on CatanGeo + CatanData (required) and CatanModel, CatanLab,
 * CatanVision (optional — each feature degrades to a message if its module is
 * missing, so a partial deploy still renders a usable board).
 */
(function () {
  'use strict';

  var G, D, M, L, V;
  var board = null;
  var strategyId = 'balanced';
  var metric = 'model';           // 'model' | 'pips'
  var editMode = 'off';           // 'off' | 'resource' | 'number'
  var useScarcity = true;         // fold board scarcity into trade rates
  var selected = -1;
  var firstPick = -1;             // for complements mode
  var ranked = [];
  var built = false;

  var NUM_CYCLE = [null, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
  var RES_COLOR = {
    lumber: '#2f6b3a', brick: '#b4572b', wool: '#7fb85a',
    grain: '#e0b23c', ore: '#8a8f9c'
  };
  var RES_LABEL = {
    lumber: 'Lumber', brick: 'Brick', wool: 'Wool', grain: 'Grain', ore: 'Ore'
  };
  var TYPE_COLOR = {
    forest: '#2f6b3a', hills: '#b4572b', pasture: '#7fb85a',
    fields: '#e0b23c', mountains: '#8a8f9c', desert: '#d9c38f'
  };
  /* what players actually call them, kept short enough to fit inside a hex */
  var SHORT_NAME = {
    forest: 'WOOD', hills: 'BRICK', pasture: 'SHEEP',
    fields: 'WHEAT', mountains: 'ORE', desert: 'DESERT'
  };
  var RES_SHORT = {
    lumber: 'Wood', brick: 'Brick', wool: 'Sheep', grain: 'Wheat', ore: 'Ore'
  };
  var RES_ICON = {
    forest: '🌲', hills: '🧱', pasture: '🐑',
    fields: '🌾', mountains: '⛰', desert: '🏜'
  };

  function $(id) { return document.getElementById(id); }
  function svgEl(n) { return document.createElementNS('http://www.w3.org/2000/svg', n); }
  function fmt(x, d) { return (x === undefined || x === null || !isFinite(x)) ? '–' : x.toFixed(d === undefined ? 3 : d); }

  /* ------------------------------------------------------------------ *
   * board rendering
   * ------------------------------------------------------------------ */
  function renderBoard() {
    var svg = $('c-board');
    if (!svg) return;
    svg.setAttribute('viewBox', G.LAYOUT.viewBox);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var gHex = svgEl('g'), gPort = svgEl('g'), gVtx = svgEl('g');
    svg.appendChild(gPort); svg.appendChild(gHex); svg.appendChild(gVtx);

    /* ports first, so they sit under the land */
    for (var p = 0; p < G.PORT_EDGES.length; p++) {
      var port = board.ports[p];
      if (!port) continue;
      var anc = G.portAnchor(p);
      var link = svgEl('line');
      link.setAttribute('x1', anc.mx); link.setAttribute('y1', anc.my);
      link.setAttribute('x2', anc.x); link.setAttribute('y2', anc.y);
      link.setAttribute('class', 'port-link');
      gPort.appendChild(link);

      var isGeneric = port.kind === '3:1';
      var pw = isGeneric ? 8.2 : 10.4;
      var disc = svgEl('rect');
      disc.setAttribute('x', anc.x - pw / 2); disc.setAttribute('y', anc.y - 2.9);
      disc.setAttribute('width', pw); disc.setAttribute('height', 5.8);
      disc.setAttribute('rx', 2.4);
      disc.setAttribute('class', 'port-marker' + (isGeneric ? '' : ' specific'));
      disc.style.cursor = 'pointer';
      disc.setAttribute('data-port', p);
      gPort.appendChild(disc);

      /* spell the resource out — "Br2" was unreadable */
      var t = svgEl('text');
      t.setAttribute('x', anc.x); t.setAttribute('y', anc.y + 1.3);
      t.setAttribute('class', 'port-label');
      t.setAttribute('data-port', p);
      t.style.cursor = 'pointer';
      t.textContent = isGeneric ? 'ANY 3:1' : (RES_SHORT[port.resource] || '') + ' 2:1';
      gPort.appendChild(t);

      var title = svgEl('title');
      title.textContent = port.kind === '3:1'
        ? 'Generic port — trade any 3 of one resource for 1'
        : '2:1 ' + RES_LABEL[port.resource] + ' port';
      disc.appendChild(title);
    }

    /* hexes + tokens */
    for (var h = 0; h < 19; h++) {
      var hx = board.hexes[h];
      var poly = svgEl('polygon');
      poly.setAttribute('points', G.hexPolygon(h));
      poly.setAttribute('class', 'hexface ' + hx.type);
      poly.setAttribute('data-hex', h);
      gHex.appendChild(poly);

      var ht = svgEl('title');
      ht.textContent = hx.type + (hx.number ? ' — ' + hx.number + ' (' + D.PIPS[hx.number] + ' pips)' : ' — no number');
      poly.appendChild(ht);

      /* Name the resource on the hex. Colour alone is not enough: forest and
         pasture are both green, and hills and desert are both warm browns. */
      var cc = G.HEXES[h];
      var ico = svgEl('text');
      ico.setAttribute('x', cc.cx); ico.setAttribute('y', cc.cy - 4.6);
      ico.setAttribute('class', 'hex-icon');
      ico.setAttribute('data-hex', h);
      ico.textContent = RES_ICON[hx.type] || '';
      gHex.appendChild(ico);

      var nm = svgEl('text');
      nm.setAttribute('x', cc.cx); nm.setAttribute('y', cc.cy + 7.4);
      nm.setAttribute('class', 'hex-name');
      nm.setAttribute('data-hex', h);
      nm.textContent = SHORT_NAME[hx.type] || hx.type;
      gHex.appendChild(nm);

      if (hx.number) {
        var c = G.HEXES[h];
        var red = D.isRed(hx.number);
        var disc2 = svgEl('circle');
        disc2.setAttribute('cx', c.cx); disc2.setAttribute('cy', c.cy);
        disc2.setAttribute('r', 4.1);
        disc2.setAttribute('class', 'token-disc');
        disc2.setAttribute('data-hex', h);
        gHex.appendChild(disc2);

        var num = svgEl('text');
        num.setAttribute('x', c.cx); num.setAttribute('y', c.cy + 0.6);
        num.setAttribute('class', 'token-num' + (red ? ' red' : ''));
        num.setAttribute('data-hex', h);
        num.textContent = hx.number;
        gHex.appendChild(num);

        /* pips: the physical dots that encode the probability */
        var pips = D.PIPS[hx.number];
        for (var i = 0; i < pips; i++) {
          var dot = svgEl('circle');
          dot.setAttribute('cx', c.cx + (i - (pips - 1) / 2) * 0.85);
          dot.setAttribute('cy', c.cy + 2.6);
          dot.setAttribute('r', 0.3);
          dot.setAttribute('class', 'token-pip' + (red ? ' red' : ''));
          gHex.appendChild(dot);
        }
      }
    }

    /* vertices */
    var max = 0, min = Infinity;
    for (var v = 0; v < ranked.length; v++) {
      var s = metricOf(ranked[v]);
      if (s > max) max = s;
      if (s < min) min = s;
    }
    var topIds = {};
    var sortedForTop = ranked.slice().sort(function (a, b) { return metricOf(b) - metricOf(a); });
    for (var k = 0; k < 6 && k < sortedForTop.length; k++) topIds[sortedForTop[k].vertex] = k + 1;

    for (var vi = 0; vi < G.VERTICES.length; vi++) {
      var vx = G.VERTICES[vi];
      var entry = byVertex[vi];
      var val = entry ? metricOf(entry) : 0;
      var t01 = (max > min) ? (val - min) / (max - min) : 0;

      var grp = svgEl('g');
      grp.setAttribute('class', 'vtx' + (topIds[vi] ? ' top' : '') + (selected === vi ? ' sel' : ''));
      grp.setAttribute('data-vtx', vi);

      /* Colour by TIER rather than a continuous ramp: the question is which
         spots are worth taking, and a discrete grade answers that at a glance. */
      var tier = entry ? (metric === 'pips' ? entry.pipTier : entry.tier) : null;
      var isTop = tier && (tier.id === 'S+' || tier.id === 'S' || tier.id === 'A');
      var rad = isTop ? 3.1 : 1.8;

      var circ = svgEl('circle');
      circ.setAttribute('cx', vx.x); circ.setAttribute('cy', vx.y);
      circ.setAttribute('r', rad);
      circ.setAttribute('fill', tier ? tier.color : heat(t01));
      circ.setAttribute('fill-opacity', isTop ? 0.97 : 0.5);
      grp.appendChild(circ);

      var ring = svgEl('circle');
      ring.setAttribute('cx', vx.x); ring.setAttribute('cy', vx.y);
      ring.setAttribute('r', rad);
      ring.setAttribute('class', 'vtx-ring');
      grp.appendChild(ring);

      if (isTop) {
        var rk = svgEl('text');
        rk.setAttribute('x', vx.x); rk.setAttribute('y', vx.y + 1.15);
        rk.setAttribute('class', 'vtx-rank');
        rk.textContent = tier.id;
        grp.appendChild(rk);
      }

      var vt = svgEl('title');
      vt.textContent = entry
        ? 'Spot ' + vi + ' — tier ' + entry.tier.id + ', ' + fmt(entry.score) +
          ' baskets/turn, ' + entry.pipTotal + ' pips'
        : 'Spot ' + vi;
      grp.appendChild(vt);
      gVtx.appendChild(grp);
    }
  }

  /* blue -> teal -> amber ramp; readable in both directions */
  function heat(t) {
    var stops = [[40, 60, 160], [30, 150, 190], [90, 200, 140], [235, 200, 70], [240, 120, 60]];
    var x = Math.max(0, Math.min(0.999, t)) * (stops.length - 1);
    var i = Math.floor(x), f = x - i;
    var a = stops[i], b = stops[i + 1] || stops[i];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' +
                    Math.round(a[1] + (b[1] - a[1]) * f) + ',' +
                    Math.round(a[2] + (b[2] - a[2]) * f) + ')';
  }

  var byVertex = {};
  function metricOf(entry) { return metric === 'pips' ? entry.pipTotal : entry.score; }

  /* ------------------------------------------------------------------ *
   * scarcity
   *
   * The build-rate model already prices a resource by how much your plan needs
   * it and by the port rates you can trade it at. What it does NOT know is that
   * resources are not equally available ON THIS BOARD. If ore sits on three
   * low-pip hexes, everyone will be short of ore, and your ore is worth more
   * than the same number of pips of wool that half the table already produces.
   *
   * That is modelled where it belongs — in the trade rate. A surplus of a scarce
   * resource converts better than the bank rate, because opponents who cannot
   * produce it will deal. The effect is capped at the 2:1 port rate, so scarcity
   * can make a resource behave like it has a port but never better than one.
   *
   * Scarcity is applied on BOTH sides, because it cuts both ways:
   *   1. Trade rate. A surplus of a scarce resource converts better than the
   *      bank rate, since opponents who cannot produce it will deal. Capped at
   *      the 2:1 port rate, so scarcity can make a resource behave as if it has
   *      a port but never better than one.
   *   2. Basket cost. A resource that is scarce board-wide is genuinely dearer
   *      to obtain, so the amount of it your plan needs is scaled up. This is
   *      what makes a spot that PRODUCES the scarce resource pull ahead of one
   *      that has to buy it in.
   *
   * Applying only (1) was almost a no-op — it changed the best spot on 4% of
   * boards. With (2) at strength 0.8 it moves the best spot on 23%, with a
   * median rank shift of 1 in the top ten: enough to matter, not enough to
   * drown out production itself. Both strengths were picked by measuring that
   * trade-off, not by taste.
   */
  var SCARCITY_RATE_STRENGTH = 1.2;   // how much scarcity improves surplus trades
  var SCARCITY_COST_STRENGTH = 0.8;   // how much scarcity inflates what you need

  function scarcityBonuses(bd) {
    var stats = D.resourceStats(bd), out = {};
    for (var i = 0; i < D.RESOURCES.length; i++) {
      var r = D.RESOURCES[i];
      var sc = stats[r].scarcity;                       // >1 = rarer than a fair 1/5 share
      if (!isFinite(sc)) sc = 2;
      out[r] = {
        scarcity: sc,
        rate: Math.max(0, Math.min(1.5, (sc - 1) * SCARCITY_RATE_STRENGTH)),
        cost: Math.max(0.6, Math.min(2.2, 1 + (sc - 1) * SCARCITY_COST_STRENGTH))
      };
    }
    return out;
  }

  function adjustRates(rates, bon) {
    var out = {};
    for (var i = 0; i < D.RESOURCES.length; i++) {
      var r = D.RESOURCES[i];
      out[r] = Math.max(2, (rates[r] || 4) - (bon[r] ? bon[r].rate : 0));
    }
    return out;
  }

  function adjustBasket(basket, bon) {
    var out = {};
    for (var i = 0; i < D.RESOURCES.length; i++) {
      var r = D.RESOURCES[i];
      out[r] = (basket[r] || 0) * (bon[r] ? bon[r].cost : 1);
    }
    return out;
  }

  /* score one vertex set under a strategy, with scarcity folded in on both sides */
  function scoreOf(bd, verts, sid, bon) {
    var prod = M.production(bd, verts);
    var rates = M.tradeRates(bd, verts);
    var basket = D.basketCost(D.strategyById(sid).mix);
    if (bon) { rates = adjustRates(rates, bon); basket = adjustBasket(basket, bon); }
    return M.buildRate(prod, rates, basket);
  }

  /* ------------------------------------------------------------------ *
   * analysis
   * ------------------------------------------------------------------ */
  function recompute() {
    var warn = $('c-warning');
    var val = D.validateBoard(board);
    if (warn) {
      warn.hidden = val.ok;
      if (!val.ok) warn.textContent = 'Board is not legal: ' + val.errors.slice(0, 2).join('; ');
    }

    if (!M) {
      ranked = []; byVertex = {};
      renderBoard();
      var ts = $('c-topspots');
      if (ts) ts.innerHTML = '<li class="spot-sub">Valuation module not loaded.</li>';
      return;
    }

    ranked = M.rankVertices(board, strategyId);
    var bonuses = useScarcity ? scarcityBonuses(board) : null;
    if (bonuses) {
      /* re-score with scarcity-adjusted rates, then re-rank */
      for (var s = 0; s < ranked.length; s++) {
        ranked[s].score = scoreOf(board, [ranked[s].vertex], strategyId, bonuses);
      }
      ranked.sort(function (a, b) { return b.score - a.score || a.vertex - b.vertex; });
      for (var s2 = 0; s2 < ranked.length; s2++) ranked[s2].rank = s2 + 1;
    }

    /* tier every spot against the best on this board */
    var bestScore = 0, bestPip = 0;
    for (var t = 0; t < ranked.length; t++) {
      if (ranked[t].score > bestScore) bestScore = ranked[t].score;
      if (ranked[t].pipTotal > bestPip) bestPip = ranked[t].pipTotal;
    }
    for (var u = 0; u < ranked.length; u++) {
      ranked[u].tier = D.tierFor(bestScore > 0 ? ranked[u].score / bestScore : 0);
      ranked[u].pipTier = D.tierFor(bestPip > 0 ? ranked[u].pipTotal / bestPip : 0);
    }

    byVertex = {};
    for (var i = 0; i < ranked.length; i++) byVertex[ranked[i].vertex] = ranked[i];

    renderBoard();
    renderVerdict();
    renderTopSpots();
    renderPairs();
    renderResources();
    if (selected >= 0) renderDetail(selected);
  }

  /*
   * Which plan does THIS board favour?
   *
   * Compares each strategy's best opening pair against that strategy's own
   * measured distribution over 1200 random boards, as a z-score. Comparing raw
   * baskets/turn would be meaningless — a longest-road basket is far cheaper
   * than an ore-grain one, so it would "win" almost every board by construction.
   */
  function renderVerdict() {
    var el = $('c-verdict');
    if (!el || !M || !M.bestPairs) return;
    var bonuses = useScarcity ? scarcityBonuses(board) : null;

    var rows = [];
    for (var i = 0; i < D.STRATEGIES.length; i++) {
      var st = D.STRATEGIES[i];
      var pairs = M.bestPairs(board, st.id, 1) || [];
      if (!pairs.length) continue;
      var rate = bonuses
        ? scoreOf(board, [pairs[0].a, pairs[0].b], st.id, bonuses)
        : pairs[0].score;
      rows.push({ st: st, rate: rate, z: D.strategyZ(st.id, rate), pair: pairs[0] });
    }
    if (!rows.length) { el.innerHTML = ''; return; }
    rows.sort(function (a, b) { return b.z - a.z; });

    var top = rows[0];
    var gap = rows.length > 1 ? top.z - rows[1].z : 0;
    var strength = gap > 0.7 ? 'clearly' : (gap > 0.3 ? 'mildly' : 'only just');

    /* If every plan scores below its own average this is simply a poor board,
       and calling the winner "favoured" would overstate it — it is least bad. */
    var headline = (top.z < 0)
      ? 'No plan is well served by this board — <strong>' + top.st.name +
        '</strong> is the least bad'
      : 'This board ' + strength + ' favours <strong>' + top.st.name + '</strong>';

    var chips = rows.map(function (r, i) {
      return '<span class="vchip' + (i === 0 ? ' win' : '') + '">' + r.st.name +
             '<em>' + (r.z >= 0 ? '+' : '') + r.z.toFixed(1) + 'σ</em></span>';
    }).join('');

    el.innerHTML =
      '<div class="verdict-head">' + headline +
        ' <span class="verdict-sub">best pair: spots ' + top.pair.a + ' + ' + top.pair.b + '</span>' +
      '</div><div class="vchips">' + chips + '</div>' +
      '<p class="hint-text" style="margin:8px 0 0">Each plan is scored against its own ' +
      'typical board, so the numbers are comparable. σ is standard deviations above average.</p>';
  }

  function renderTopSpots() {
    var el = $('c-topspots');
    if (!el) return;
    var list = ranked.slice().sort(function (a, b) { return metricOf(b) - metricOf(a); }).slice(0, 8);
    el.innerHTML = '';
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var li = document.createElement('li');
      li.setAttribute('data-vtx', e.vertex);
      /* pipRank shows where naive pip-counting would have put this spot — the
         clearest evidence the model is doing something pips cannot */
      var delta = (e.pipRank && Math.abs(e.pipRank - (i + 1)) >= 3)
        ? ' · pips say #' + e.pipRank : '';
      li.innerHTML =
        '<span class="tier-badge tier-' + e.tier.id.replace('+', 'p') + '">' + e.tier.id + '</span>' +
        '<span class="spot-main"><strong>Spot ' + e.vertex + '</strong> ' +
        '<span class="spot-sub">' + resDetail(e.production) + delta + '</span></span>';
      li.addEventListener('click', (function (v) { return function () { select(v); }; })(e.vertex));
      li.addEventListener('mouseenter', (function (v) { return function () { highlight([v]); }; })(e.vertex));
      li.addEventListener('mouseleave', function () { highlight([]); });
      el.appendChild(li);
    }
  }

  function resSummary(prod) {
    if (!prod) return '';
    var parts = [];
    for (var i = 0; i < D.RESOURCES.length; i++) {
      var r = D.RESOURCES[i];
      if (prod[r] > 0.0001) parts.push(RES_SHORT[r]);
    }
    return parts.join(' · ') || 'nothing';
  }

  /* resources this spot produces, strongest first, so the row reads like a scouting note */
  function resDetail(prod) {
    if (!prod) return '';
    var list = [];
    for (var i = 0; i < D.RESOURCES.length; i++) {
      var r = D.RESOURCES[i];
      if (prod[r] > 0.0001) list.push({ r: r, v: prod[r] });
    }
    list.sort(function (a, b) { return b.v - a.v; });
    return list.map(function (x) {
      return '<span style="color:' + RES_COLOR[x.r] + '">' + RES_SHORT[x.r] + '</span>';
    }).join(' ') || 'nothing';
  }

  function renderPairs() {
    var el = $('c-pairs');
    if (!el || !M || !M.bestPairs) return;
    var pairs = M.bestPairs(board, strategyId, 6) || [];
    el.innerHTML = '';
    if (!pairs.length) { el.innerHTML = '<li class="spot-sub">No pairs available.</li>'; return; }
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      var li = document.createElement('li');
      li.innerHTML = '<span class="spot-rank">' + (i + 1) + '</span>' +
        '<span class="spot-main"><span class="spot-score">' + fmt(p.score) + '</span>' +
        ' <span class="spot-sub">spots ' + p.a + ' + ' + p.b + ' · ' + resSummary(p.production) + '</span></span>';
      li.addEventListener('mouseenter', (function (a, b) {
        return function () { highlight([a, b]); };
      })(p.a, p.b));
      li.addEventListener('mouseleave', function () { highlight([]); });
      li.addEventListener('click', (function (a) { return function () { select(a); }; })(p.a));
      el.appendChild(li);
    }
  }

  function highlight(vs) {
    var nodes = document.querySelectorAll('#c-board .vtx');
    for (var i = 0; i < nodes.length; i++) {
      var v = +nodes[i].getAttribute('data-vtx');
      nodes[i].classList.toggle('sel', vs.indexOf(v) >= 0 || v === selected);
    }
  }

  function renderResources() {
    var el = $('c-resources');
    if (!el) return;
    var stats = D.resourceStats(board);
    var maxPips = 0;
    for (var r in stats) if (stats[r].pips > maxPips) maxPips = stats[r].pips;
    var html = '';
    /* scarcest first — that is the ordering that matters when picking a spot */
    var order = D.RESOURCES.slice().sort(function (a, b) { return stats[a].pips - stats[b].pips; });
    for (var i = 0; i < order.length; i++) {
      var s = stats[order[i]];
      var sc = s.scarcity;
      var tag = sc >= 1.25 ? 'scarce' : (sc <= 0.85 ? 'plentiful' : 'even');
      html += '<div class="res-row res-' + s.resource + '">' +
        '<span>' + RES_SHORT[s.resource] + '</span>' +
        '<span class="res-bar"><span style="width:' + (maxPips ? (s.pips / maxPips * 100) : 0) + '%"></span></span>' +
        '<span class="res-num sc-' + tag + '">' + s.pips + 'p · ' + tag + '</span></div>';
    }
    html += '<p class="hint-text" style="margin-top:8px">Scarcest first. Scarce resources are ' +
            'worth more than their pips suggest: you can trade them well, and a plan that needs ' +
            'them pays more to get them. Brick and ore only ever get 3 hexes, so they start ' +
            'structurally short.</p>';
    el.innerHTML = html;
  }

  /* ------------------------------------------------------------------ *
   * vertex detail
   * ------------------------------------------------------------------ */
  function select(v) {
    selected = v;
    renderDetail(v);
    highlight([v]);
  }

  function renderDetail(v) {
    var card = $('c-detail'), body = $('c-detail-body'), title = $('c-detail-title');
    if (!card || !M) return;
    var info = M.scoreVertex(board, v, strategyId);
    card.hidden = false;
    title.textContent = 'Spot ' + v + ' — ' + fmt(info.score) + ' baskets/turn';

    var hexes = G.vertexHexes(v).map(function (h) {
      var hx = board.hexes[h];
      return hx.type + (hx.number ? ' ' + hx.number : ' (desert)');
    }).join(', ');

    var ports = G.vertexPorts(v).map(function (p) {
      var po = board.ports[p];
      return po.kind === '3:1' ? '3:1 any' : '2:1 ' + RES_LABEL[po.resource];
    });

    var prodHtml = '';
    for (var i = 0; i < D.RESOURCES.length; i++) {
      var r = D.RESOURCES[i];
      var per = info.production[r] || 0;
      prodHtml += '<div class="kv"><span style="color:' + RES_COLOR[r] + '">' + RES_LABEL[r] +
        '</span><span>' + fmt(per, 3) + '/turn · ' + (info.rates ? info.rates[r] : 4) + ':1</span></div>';
    }

    var best = 0;
    for (var sid in info.perStrategy) {
      if (info.perStrategy[sid] > best) best = info.perStrategy[sid];
    }
    var stratHtml = '';
    for (var j = 0; j < D.STRATEGIES.length; j++) {
      var st = D.STRATEGIES[j];
      var sc = info.perStrategy[st.id] || 0;
      stratHtml += '<div class="strat-row' + (st.id === info.bestStrategy ? ' best' : '') + '">' +
        '<span style="min-width:150px">' + st.name + '</span>' +
        '<span class="bar"><span style="width:' + (best ? sc / best * 100 : 0) + '%"></span></span>' +
        '<span style="min-width:48px;text-align:right">' + fmt(sc) + '</span></div>';
    }

    body.innerHTML =
      '<div class="detail-grid">' +
        '<div><h3>Touches</h3><p class="hint-text">' + hexes + '</p>' +
          '<div class="kv"><span>Naive pips</span><span>' + info.pipTotal + '</span></div>' +
          '<div class="kv"><span>Ports</span><span>' + (ports.length ? ports.join(', ') : 'none') + '</span></div>' +
        '</div>' +
        '<div><h3>Production</h3>' + prodHtml + '</div>' +
      '</div>' +
      '<div style="margin-top:14px"><h3>Score by strategy</h3>' + stratHtml + '</div>' +
      complementsHtml(v);
  }

  function complementsHtml(v) {
    if (!M.complements) return '';
    var comps = M.complements(board, v, strategyId, 5) || [];
    if (!comps.length) return '';
    var h = '<div style="margin-top:14px"><h3>Best second settlement with this one</h3>';
    for (var i = 0; i < comps.length; i++) {
      var c = comps[i];
      /* synergy = how much more the pair is worth than the two spots priced
         separately, which is the whole reason pairs are scored jointly */
      h += '<div class="kv"><span>Spot ' + c.vertex + '</span><span>' +
           fmt(c.pairScore) + ' combined' +
           (c.synergy > 0 ? ' (+' + fmt(c.synergy) + ' synergy)' : '') + '</span></div>';
    }
    return h + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * editing
   * ------------------------------------------------------------------ */
  function onBoardClick(e) {
    var vtxNode = e.target.closest('.vtx');
    if (vtxNode && editMode === 'off') { select(+vtxNode.getAttribute('data-vtx')); return; }

    var portAttr = e.target.getAttribute && e.target.getAttribute('data-port');
    if (portAttr !== null && portAttr !== undefined && editMode !== 'off') {
      cyclePort(+portAttr); return;
    }

    var hexAttr = e.target.getAttribute && e.target.getAttribute('data-hex');
    if (hexAttr === null || hexAttr === undefined) return;
    var h = +hexAttr;
    if (editMode === 'resource') cycleResource(h);
    else if (editMode === 'number') cycleNumber(h);
  }

  function cycleResource(h) {
    var i = D.HEX_TYPES.indexOf(board.hexes[h].type);
    var next = D.HEX_TYPES[(i + 1) % D.HEX_TYPES.length];
    board.hexes[h].type = next;
    if (next === 'desert') board.hexes[h].number = null;
    else if (!board.hexes[h].number) board.hexes[h].number = 6;
    recompute();
  }

  function cycleNumber(h) {
    if (board.hexes[h].type === 'desert') return;
    var cur = board.hexes[h].number;
    var i = NUM_CYCLE.indexOf(cur);
    var next = NUM_CYCLE[(i + 1) % NUM_CYCLE.length];
    if (next === null) next = 2;
    board.hexes[h].number = next;
    recompute();
  }

  function cyclePort(p) {
    var po = board.ports[p];
    if (po.kind === '3:1') { po.kind = '2:1'; po.resource = D.RESOURCES[0]; }
    else {
      var i = D.RESOURCES.indexOf(po.resource);
      if (i >= D.RESOURCES.length - 1) { po.kind = '3:1'; po.resource = null; }
      else po.resource = D.RESOURCES[i + 1];
    }
    recompute();
  }

  /* ------------------------------------------------------------------ *
   * strategy lab
   * ------------------------------------------------------------------ */
  function runLab() {
    var out = $('c-lab-out'), status = $('c-lab-status'), btn = $('c-lab-run');
    if (!L || !L.simulate) {
      out.innerHTML = '<p class="hint-text">Strategy lab module not loaded.</p>';
      return;
    }
    btn.disabled = true;
    status.textContent = 'running…';
    out.innerHTML = '';

    var N = 200;
    var runner = L.simulateAsync ? null : (L.createRun ? L.createRun(N, {}) : null);

    function finish(res) {
      btn.disabled = false;
      status.textContent = res.boards + ' boards in ' + res.elapsedMs + ' ms';
      renderLab(res, out);
    }
    function fail(err) {
      btn.disabled = false;
      status.textContent = '';
      out.innerHTML = '<p class="hint-text">Lab failed: ' + (err && err.message) + '</p>';
    }

    /* simulateAsync yields between batches so the page keeps painting */
    try {
      if (L.simulateAsync) {
        L.simulateAsync(N, {
          onBatch: function (p) {
            var done = (p && (p.done !== undefined ? p.done : p.boards)) || 0;
            status.textContent = 'running… ' + done + '/' + N;
          }
        }).then(finish, fail);
      } else {
        finish(L.simulate(N, {}));
      }
    } catch (err) { fail(err); }
  }

  /*
   * Two "win rate" numbers come back and they mean very different things.
   * rawWinRate counts absolute baskets/turn, which structurally favours cheap
   * baskets — a longest-road basket costs far less than an ore-grain one, so raw
   * wins land on longest-road ~96% of the time and mean nothing about strategy
   * quality. zWinRate standardises each strategy against its own distribution and
   * answers the question actually worth asking: which plan does THIS board favour?
   * Only the standardized number is presented as a result.
   */
  function renderLab(res, out) {
    if (!res || !res.strategies) {
      out.innerHTML = '<p class="hint-text">No results.</p>';
      return;
    }
    var rows = res.strategies.slice().sort(function (a, b) {
      return (b.zWinRate || 0) - (a.zWinRate || 0);
    });

    var html = '<table class="lab-table"><tr>' +
      '<th>Strategy</th><th>Mean rate</th><th>Spread</th>' +
      '<th>Board favours it</th><th>Pips disagree</th></tr>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += '<tr><td>' + (r.name || r.id) + '</td>' +
        '<td class="num">' + fmt(r.meanRate) + '</td>' +
        '<td class="num">±' + fmt(r.sd) + '</td>' +
        '<td class="num">' + pct(r.zWinRate) + '</td>' +
        '<td class="num">' + pct(r.topSpotDisagreementRate) + '</td></tr>';
    }
    html += '</table>';

    html += '<p class="hint-text" style="margin-top:12px">' +
      '<strong>Board favours it</strong> is how often a board suits that plan better than its own ' +
      'average — not raw baskets/turn, which just rewards cheap baskets and would name ' +
      'Longest Road ~96% of the time for no real reason. Near-even numbers are the honest ' +
      'answer: random boards do not favour one plan overall, but any single board does.</p>';

    if (res.pooled) {
      html += '<p class="hint-text"><strong>Naive pip-counting picks a different best spot on ' +
        pct(res.pooled.topSpotDisagreementRate) + ' of boards, and a different best pair on ' +
        pct(res.pooled.topPairDisagreementRate) + '.</strong></p>';
      var tn = res.pooled.topNumbers, tr = res.pooled.topResources;
      if (tn && tn.length) {
        html += '<p class="hint-text">Numbers showing up most in winning spots: <strong>' +
          tn.slice(0, 4).map(function (n) { return n.key; }).join(', ') + '</strong>. ' +
          'If 5 and 9 outrank 6 and 8, that is the no-adjacent-reds setup rule at work: ' +
          'two reds can never share a corner, but two 5s can.</p>';
      }
      if (tr && tr.length) {
        html += '<p class="hint-text">Resources in winning spots, most to least: ' +
          tr.map(function (r) { return RES_LABEL[r.key] || r.key; }).join(' › ') + '.</p>';
      }
    }
    out.innerHTML = html;
  }

  function pct(x) {
    return (x === undefined || x === null || !isFinite(x)) ? '–' : (x * 100).toFixed(0) + '%';
  }

  /* ------------------------------------------------------------------ *
   * photo scanner
   *
   * The handles overlay uses a viewBox equal to the image's natural size, so
   * handle coordinates ARE image coordinates and no manual scaling is needed
   * however the canvas is laid out by CSS.
   * ------------------------------------------------------------------ */
  var scanImg = null, corners = null, scanResult = null, dragIdx = -1;

  function openScan() {
    if (!V) return;
    $('c-scan-overlay').hidden = false;
  }
  function closeScan() { $('c-scan-overlay').hidden = true; }

  function loadPhoto(file) {
    var img = new Image();
    img.onload = function () {
      scanImg = img;
      var cv = $('c-photo');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      cv.getContext('2d').drawImage(img, 0, 0);
      var sv = $('c-handles');
      sv.setAttribute('viewBox', '0 0 ' + img.naturalWidth + ' ' + img.naturalHeight);

      corners = null;
      if (V.autoDetectCorners) {
        try {
          var auto = V.autoDetectCorners(cv);
          if (auto && auto.ok && auto.corners && auto.corners.length >= 4) corners = auto.corners.slice(0, 6);
        } catch (e) { /* fall through to the default hexagon */ }
      }
      if (!corners) corners = defaultCorners(img.naturalWidth, img.naturalHeight);
      drawHandles();
      $('c-parse').disabled = false;
      $('c-accept').disabled = true;
      $('c-scan-result').innerHTML = '<p class="hint-text">Drag the handles onto the six outer ' +
        'corners of the hex field, then press <strong>Read board</strong>.</p>';
      URL.revokeObjectURL(img.src);
    };
    img.onerror = function () {
      $('c-scan-result').innerHTML = '<p class="hint-text">Could not load that image.</p>';
    };
    img.src = URL.createObjectURL(file);
  }

  /* a regular hexagon inscribed in the frame, pointy-top like the board */
  function defaultCorners(w, h) {
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.45, out = [];
    for (var i = 0; i < 6; i++) {
      var a = (Math.PI / 180) * (60 * i + 90);
      out.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    }
    return out;
  }

  function drawHandles() {
    var sv = $('c-handles');
    while (sv.firstChild) sv.removeChild(sv.firstChild);
    if (!corners) return;
    var r = (scanImg ? Math.max(scanImg.naturalWidth, scanImg.naturalHeight) : 800) * 0.018;

    var poly = svgEl('polygon');
    poly.setAttribute('points', corners.map(function (c) { return c.x + ',' + c.y; }).join(' '));
    poly.setAttribute('class', 'scan-outline');
    poly.setAttribute('stroke-width', r * 0.22);
    sv.appendChild(poly);

    for (var i = 0; i < corners.length; i++) {
      var c = svgEl('circle');
      c.setAttribute('cx', corners[i].x); c.setAttribute('cy', corners[i].y);
      c.setAttribute('r', r);
      c.setAttribute('class', 'scan-handle');
      c.setAttribute('stroke-width', r * 0.22);
      c.setAttribute('data-corner', i);
      sv.appendChild(c);
    }
  }

  function svgPoint(evt) {
    var sv = $('c-handles');
    var pt = sv.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    var m = sv.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 };
  }

  function wireHandles() {
    var sv = $('c-handles');
    sv.addEventListener('pointerdown', function (e) {
      var t = e.target.getAttribute && e.target.getAttribute('data-corner');
      if (t === null || t === undefined) return;
      dragIdx = +t;
      sv.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    sv.addEventListener('pointermove', function (e) {
      if (dragIdx < 0) return;
      var p = svgPoint(e);
      corners[dragIdx] = { x: p.x, y: p.y };
      drawHandles();
      e.preventDefault();
    });
    function end(e) {
      if (dragIdx < 0) return;
      dragIdx = -1;
      try { sv.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    }
    sv.addEventListener('pointerup', end);
    sv.addEventListener('pointercancel', end);
  }

  function parsePhoto() {
    if (!scanImg || !V || !V.analyzeBoard) return;
    var res;
    try {
      res = V.analyzeBoard($('c-photo'), { corners: corners });
    } catch (err) {
      $('c-scan-result').innerHTML = '<p class="hint-text">Reading failed: ' + err.message + '</p>';
      return;
    }
    if (!res || !res.ok) {
      $('c-scan-result').innerHTML = '<p class="hint-text">Could not read the board: ' +
        ((res && res.error) || 'unknown error') + '</p>';
      return;
    }
    scanResult = res;
    $('c-accept').disabled = false;
    renderScanResult();
  }

  function renderScanResult() {
    var res = scanResult;
    var val = D.validateBoard(res.board);
    var lowCount = 0;
    var html = '';
    for (var i = 0; i < res.hexes.length; i++) {
      var h = res.hexes[i];
      var conf = Math.min(
        h.typeConfidence === undefined ? 1 : h.typeConfidence,
        h.number === null ? 1 : (h.numberConfidence === undefined ? 1 : h.numberConfidence)
      );
      var low = conf < 0.6;
      if (low) lowCount++;
      html += '<div class="scan-hex' + (low ? ' low' : '') + '" data-scanhex="' + h.id + '">' +
        '<span class="swatch" style="background:' + (TYPE_COLOR[h.type] || '#666') + '"></span>' +
        '<span style="flex:1">' + h.type + (h.number ? ' · ' + h.number : ' · —') + '</span>' +
        '<span>' + Math.round(conf * 100) + '%</span></div>';
    }

    $('c-scan-result').innerHTML =
      '<p class="hint-text">' +
        (val.ok
          ? 'Reads as a legal board.'
          : '<strong>Not a legal board yet:</strong> ' + val.errors.slice(0, 2).join('; ')) +
        ' ' + lowCount + ' of 19 hexes are low confidence. Click any row to correct it — ' +
        'click the left half to change the resource, the right half to change the number.' +
      '</p><div class="scan-grid">' + html + '</div>';

    var rows = $('c-scan-result').querySelectorAll('.scan-hex');
    for (var k = 0; k < rows.length; k++) {
      rows[k].addEventListener('click', function (e) {
        var id = +this.getAttribute('data-scanhex');
        var rect = this.getBoundingClientRect();
        var leftHalf = (e.clientX - rect.left) < rect.width / 2;
        var hx = scanResult.board.hexes[id];
        if (leftHalf) {
          var ti = D.HEX_TYPES.indexOf(hx.type);
          hx.type = D.HEX_TYPES[(ti + 1) % D.HEX_TYPES.length];
          if (hx.type === 'desert') hx.number = null;
          else if (!hx.number) hx.number = 6;
        } else if (hx.type !== 'desert') {
          var ni = NUM_CYCLE.indexOf(hx.number);
          var nx = NUM_CYCLE[(ni + 1) % NUM_CYCLE.length];
          hx.number = (nx === null) ? 2 : nx;
        }
        /* keep the displayed row in step with the corrected board */
        scanResult.hexes[id].type = hx.type;
        scanResult.hexes[id].number = hx.number;
        scanResult.hexes[id].typeConfidence = 1;
        scanResult.hexes[id].numberConfidence = 1;
        renderScanResult();
      });
    }
  }

  function acceptScan() {
    if (!scanResult) return;
    board = scanResult.board;
    selected = -1;
    $('c-detail').hidden = true;
    closeScan();
    recompute();
  }

  /* ------------------------------------------------------------------ *
   * boot
   * ------------------------------------------------------------------ */
  function fillStrategies() {
    var sel = $('c-strategy');
    if (!sel) return;
    sel.innerHTML = '';
    for (var i = 0; i < D.STRATEGIES.length; i++) {
      var o = document.createElement('option');
      o.value = D.STRATEGIES[i].id;
      o.textContent = D.STRATEGIES[i].name;
      sel.appendChild(o);
    }
    sel.value = strategyId;
    updateBlurb();
  }

  function updateBlurb() {
    var b = $('c-blurb');
    if (b) b.textContent = D.strategyById(strategyId).blurb;
  }

  function wire() {
    $('c-random').addEventListener('click', function () {
      board = D.randomBoard(); selected = -1; $('c-detail').hidden = true; recompute();
    });
    $('c-reference').addEventListener('click', function () {
      board = D.referenceBoard(); selected = -1; $('c-detail').hidden = true; recompute();
    });
    $('c-strategy').addEventListener('change', function (e) {
      strategyId = e.target.value; updateBlurb(); recompute();
    });
    $('c-heatmap').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      metric = b.getAttribute('data-metric');
      [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('active', x === b); });
      recompute();
    });
    $('c-scarcity').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      useScarcity = b.getAttribute('data-sc') === 'on';
      [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('active', x === b); });
      recompute();
    });
    $('c-editmode').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      editMode = b.getAttribute('data-edit');
      [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('active', x === b); });
      document.querySelector('.app.catan').classList.toggle('editing', editMode !== 'off');
    });
    $('c-board').addEventListener('click', onBoardClick);
    $('c-detail-close').addEventListener('click', function () {
      $('c-detail').hidden = true; selected = -1; highlight([]);
    });
    $('c-lab-run').addEventListener('click', runLab);

    $('c-scan').addEventListener('click', openScan);
    $('c-scan-close').addEventListener('click', closeScan);
    $('c-file').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) loadPhoto(e.target.files[0]);
    });
    $('c-parse').addEventListener('click', parsePhoto);
    $('c-accept').addEventListener('click', acceptScan);
    wireHandles();
  }

  function build() {
    if (built) return;
    G = window.CatanGeo; D = window.CatanData;
    M = window.CatanModel; L = window.CatanLab; V = window.CatanVision;
    if (!G || !D) return;                 // required modules missing
    built = true;
    board = D.randomBoard();
    fillStrategies();
    wire();
    /*
     * Photo scanning is DISABLED: the recogniser is overfit to its own test data.
     *
     * catan-vision.js scores ~99% resource / ~99% pip accuracy on the synthetic
     * corpus it was developed against — that result reproduces exactly, so it is
     * real. But rendered through a SECOND, independently written synthetic
     * renderer (different tile colours, different font, different pip drawing)
     * it collapses to ~26% resource and ~23% pip, against ~17% for guessing,
     * and produces 6-vs-9 confusions that its own corpus reports as zero.
     *
     * Both renderers are equally arbitrary models of a Catan board, so a drop
     * from 99% to 26% across that swap says the classifier learned one
     * generator's colour prototypes and glyphs rather than the structure of a
     * Catan board. It has never been tested against a real photograph. Real
     * boards are a third distribution, and nothing here predicts which of the
     * two numbers it would land nearer.
     *
     * The whole flow behind this flag is wired and ready — file load, draggable
     * corner handles, perspective parse, per-hex correction, accept. Flipping
     * SCAN_ENABLED is all that is needed once the recogniser is calibrated
     * against real photos and measured on held-out real photos.
     */
    var SCAN_ENABLED = false;
    var scanBtn = $('c-scan');
    if (scanBtn && (!V || !SCAN_ENABLED)) {
      scanBtn.disabled = true;
      scanBtn.title = 'Photo scanning is not accurate enough to ship yet';
      scanBtn.textContent = '📷 Scan photo (not ready)';
    }
    recompute();
  }

  document.addEventListener('tabshown', function (e) {
    if (e.detail && e.detail.tab === 'catan') build();
  });
  if (document.readyState !== 'loading') {
    if (location.hash === '#catan') build();
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      if (location.hash === '#catan') build();
    });
  }

  window.CatanUI = { build: build, recompute: recompute, getBoard: function () { return board; },
                     setBoard: function (b) { board = b; selected = -1; recompute(); } };
})();
