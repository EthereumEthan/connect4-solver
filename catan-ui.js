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

      var disc = svgEl('circle');
      disc.setAttribute('cx', anc.x); disc.setAttribute('cy', anc.y);
      disc.setAttribute('r', 3.6);
      disc.setAttribute('class', 'port-marker');
      disc.style.cursor = 'pointer';
      disc.setAttribute('data-port', p);
      gPort.appendChild(disc);

      var t = svgEl('text');
      t.setAttribute('x', anc.x); t.setAttribute('y', anc.y + 0.6);
      t.setAttribute('class', 'port-label');
      t.setAttribute('data-port', p);
      t.style.cursor = 'pointer';
      t.textContent = port.kind === '3:1' ? '3:1' : (RES_LABEL[port.resource] || '').slice(0, 2) + '2';
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

      var circ = svgEl('circle');
      circ.setAttribute('cx', vx.x); circ.setAttribute('cy', vx.y);
      circ.setAttribute('r', topIds[vi] ? 2.5 : 1.7);
      circ.setAttribute('fill', heat(t01));
      circ.setAttribute('fill-opacity', 0.35 + 0.6 * t01);
      grp.appendChild(circ);

      var ring = svgEl('circle');
      ring.setAttribute('cx', vx.x); ring.setAttribute('cy', vx.y);
      ring.setAttribute('r', topIds[vi] ? 2.5 : 1.7);
      ring.setAttribute('class', 'vtx-ring');
      grp.appendChild(ring);

      if (topIds[vi]) {
        var rk = svgEl('text');
        rk.setAttribute('x', vx.x); rk.setAttribute('y', vx.y + 1.1);
        rk.setAttribute('class', 'vtx-rank');
        rk.textContent = topIds[vi];
        grp.appendChild(rk);
      }

      var vt = svgEl('title');
      vt.textContent = entry
        ? 'Spot ' + vi + ' — ' + fmt(entry.score) + ' baskets/turn, ' + entry.pipTotal + ' pips'
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
    byVertex = {};
    for (var i = 0; i < ranked.length; i++) byVertex[ranked[i].vertex] = ranked[i];

    renderBoard();
    renderTopSpots();
    renderPairs();
    renderResources();
    if (selected >= 0) renderDetail(selected);
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
      /* rankDelta is how many places naive pip-counting would have misplaced this
         spot; surfacing it is the clearest way to show the model earning its keep */
      var delta = (e.rankDelta && Math.abs(e.rankDelta) >= 3)
        ? ' · pips rank it #' + e.pipRank : '';
      li.innerHTML = '<span class="spot-rank">' + (i + 1) + '</span>' +
        '<span class="spot-main"><span class="spot-score">' + fmt(e.score) + '</span>' +
        ' <span class="spot-sub">baskets/turn · ' + e.pipTotal + ' pips · ' +
        resSummary(e.production) + delta + '</span></span>';
      li.addEventListener('click', (function (v) { return function () { select(v); }; })(e.vertex));
      li.addEventListener('mouseenter', (function (v) { return function () { highlight([v]); }; })(e.vertex));
      li.addEventListener('mouseleave', function () { highlight([]); });
      el.appendChild(li);
    }
  }

  function resSummary(prod) {
    if (!prod) return '';
    var parts = [];
    for (var r in prod) {
      if (Object.prototype.hasOwnProperty.call(prod, r) && prod[r] > 0.0001) {
        parts.push(RES_LABEL[r].slice(0, 2));
      }
    }
    return parts.join('/') || 'nothing';
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
    var order = D.RESOURCES.slice().sort(function (a, b) { return stats[b].pips - stats[a].pips; });
    for (var i = 0; i < order.length; i++) {
      var s = stats[order[i]];
      html += '<div class="res-row res-' + s.resource + '">' +
        '<span>' + RES_LABEL[s.resource] + '</span>' +
        '<span class="res-bar"><span style="width:' + (maxPips ? (s.pips / maxPips * 100) : 0) + '%"></span></span>' +
        '<span class="res-num">' + s.pips + 'p/' + s.hexes + 'h</span></div>';
    }
    html += '<p class="hint-text" style="margin-top:8px">Pips and hex count per resource. ' +
            'Brick and ore only ever get 3 hexes, so they are structurally scarce.</p>';
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
     * Photo scanning is DISABLED pending accuracy work.
     *
     * catan-vision.js loads and runs end to end without errors, but measured
     * against synthetic boards with known ground truth it reads only ~39% of
     * hex resources and ~25% of pip values correctly — barely above the ~17%
     * you would get by guessing. That was on flat, evenly lit, undistorted
     * renders, i.e. the easiest possible input; a working pipeline should be
     * near perfect there. Every corner ordering and winding direction was
     * tried (12 variants) and none rescued it, so this is not a calibration
     * convention mismatch.
     *
     * The whole flow behind this flag is wired and ready — file load, draggable
     * corner handles, parse, per-hex correction, accept — so flipping
     * SCAN_ENABLED to true is all that is needed once the recognition itself
     * clears a sensible accuracy bar.
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
