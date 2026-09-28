/*
 * Catan board topology and pixel layout.
 *
 * The board is 19 land hexes in rows of 3,4,5,4,3. Hexes are POINTY-TOP, which
 * is what gives a Catan board its vertical shared edges between horizontal
 * neighbours and its zigzag coastline.
 *
 * Nothing here is hardcoded beyond the row sizes: the 54 vertices and 72 edges
 * are DERIVED by generating all 19*6 hex corners in pixel space and then
 * deduplicating them on a tolerance. That way the topology cannot drift out of
 * sync with the rendering, and the counts become assertions, not assumptions.
 *
 * Counts that fall out of the construction (all asserted at load time):
 *   19 hexes, 54 vertices, 72 edges   (Euler: 54 - 72 + (19 + 1) = 2)
 *   42 interior edges + 30 coastline edges, and the coastline is one 30-cycle
 *
 * Exposes window.CatanGeo.
 */
(function (global) {
  'use strict';

  var ROW_SIZES = [3, 4, 5, 4, 3];
  var SIZE = 10;                        // hex circumradius, in layout units
  var SQ3 = Math.sqrt(3);
  var HEX_W = SQ3 * SIZE;               // width of a pointy-top hex
  var ROW_DY = 1.5 * SIZE;              // vertical distance between hex rows
  var EPS = 0.01;                       // dedup tolerance (coords are order 10)

  /* ---------------- hexes ---------------- */
  var HEXES = [];
  (function buildHexes() {
    var id = 0;
    for (var row = 0; row < ROW_SIZES.length; row++) {
      var n = ROW_SIZES[row];
      for (var col = 0; col < n; col++) {
        HEXES.push({
          id: id++,
          row: row,
          col: col,
          q: col - ((n - 1) / 2),
          r: row - 2,
          cx: (col - (n - 1) / 2) * HEX_W,
          cy: (row - 2) * ROW_DY
        });
      }
    }
  })();

  /* corner i of a pointy-top hex: angles 90,150,210,270,330,30 degrees */
  function hexCorner(h, i) {
    var a = (Math.PI / 180) * (60 * i + 90);
    return { x: h.cx + SIZE * Math.cos(a), y: h.cy + SIZE * Math.sin(a) };
  }

  /* ---------------- vertices (derived) ---------------- */
  var VERTICES = [];
  var vkey = {};
  function vertexIdAt(x, y) {
    var k = Math.round(x / EPS) + '|' + Math.round(y / EPS);
    if (vkey[k] === undefined) {
      vkey[k] = VERTICES.length;
      VERTICES.push({ id: VERTICES.length, x: x, y: y });
    }
    return vkey[k];
  }

  var HEX_VERTS = [];            // hexId -> [6 vertex ids]
  var VERT_HEXES = [];           // vertexId -> [hex ids]
  (function buildVertices() {
    for (var h = 0; h < HEXES.length; h++) {
      var vs = [];
      for (var i = 0; i < 6; i++) {
        var c = hexCorner(HEXES[h], i);
        var vid = vertexIdAt(c.x, c.y);
        vs.push(vid);
        if (!VERT_HEXES[vid]) VERT_HEXES[vid] = [];
        if (VERT_HEXES[vid].indexOf(h) < 0) VERT_HEXES[vid].push(h);
      }
      HEX_VERTS.push(vs);
    }
    for (var v = 0; v < VERTICES.length; v++) {
      if (!VERT_HEXES[v]) VERT_HEXES[v] = [];
    }
  })();

  /* ---------------- edges (derived) ---------------- */
  var EDGES = [];
  var ekey = {};
  var VERT_NEIGHBORS = [];       // vertexId -> [vertex ids]
  var EDGE_HEXES = [];           // edgeId -> [hex ids]; 1 = coastline, 2 = interior
  (function buildEdges() {
    for (var h = 0; h < HEXES.length; h++) {
      var vs = HEX_VERTS[h];
      for (var i = 0; i < 6; i++) {
        var a = vs[i], b = vs[(i + 1) % 6];
        var lo = Math.min(a, b), hi = Math.max(a, b);
        var k = lo + '-' + hi;
        var eid = ekey[k];
        if (eid === undefined) {
          eid = EDGES.length;
          ekey[k] = eid;
          EDGES.push({ id: eid, a: lo, b: hi });
          EDGE_HEXES[eid] = [];
        }
        if (EDGE_HEXES[eid].indexOf(h) < 0) EDGE_HEXES[eid].push(h);
      }
    }
    for (var v = 0; v < VERTICES.length; v++) VERT_NEIGHBORS[v] = [];
    for (var e = 0; e < EDGES.length; e++) {
      VERT_NEIGHBORS[EDGES[e].a].push(EDGES[e].b);
      VERT_NEIGHBORS[EDGES[e].b].push(EDGES[e].a);
    }
  })();

  /* hex neighbours share an edge */
  var HEX_NEIGHBORS = [];
  (function buildHexNeighbors() {
    for (var h = 0; h < HEXES.length; h++) HEX_NEIGHBORS[h] = [];
    for (var e = 0; e < EDGES.length; e++) {
      var hs = EDGE_HEXES[e];
      if (hs.length === 2) {
        HEX_NEIGHBORS[hs[0]].push(hs[1]);
        HEX_NEIGHBORS[hs[1]].push(hs[0]);
      }
    }
  })();

  /* ---------------- coastline ---------------- */
  /* Coastline edges touch exactly one hex. They form a single closed cycle, which
     we WALK to get a genuine ordering rather than assuming one. */
  var COAST_EDGES = [];
  for (var ce = 0; ce < EDGES.length; ce++) {
    if (EDGE_HEXES[ce].length === 1) COAST_EDGES.push(ce);
  }

  var PERIMETER_VERTICES = [];
  var PERIMETER_EDGES = [];      // PERIMETER_EDGES[i] joins PERIMETER_VERTICES[i] and [i+1]
  (function walkCoast() {
    var adj = {};
    for (var i = 0; i < COAST_EDGES.length; i++) {
      var e = EDGES[COAST_EDGES[i]];
      if (!adj[e.a]) adj[e.a] = [];
      if (!adj[e.b]) adj[e.b] = [];
      adj[e.a].push({ v: e.b, e: COAST_EDGES[i] });
      adj[e.b].push({ v: e.a, e: COAST_EDGES[i] });
    }
    var startV = EDGES[COAST_EDGES[0]].a;
    var cur = startV, prevEdge = -1, guard = 0;
    do {
      PERIMETER_VERTICES.push(cur);
      var opts = adj[cur], nxt = null;
      for (var j = 0; j < opts.length; j++) {
        if (opts[j].e !== prevEdge) { nxt = opts[j]; break; }
      }
      if (!nxt) break;
      PERIMETER_EDGES.push(nxt.e);
      prevEdge = nxt.e;
      cur = nxt.v;
    } while (cur !== startV && ++guard < 200);
  })();

  /* ---------------- ports ---------------- */
  /* 9 ports sit on coastline edges. The physical board spaces them with gaps of
     3 and 4 edges; 3+3+4+3+3+4+3+4+3 = 30 walks the whole cycle and never puts
     two ports on adjacent edges. Change this constant to rearrange them. */
  var PORT_GAPS = [3, 3, 4, 3, 3, 4, 3, 4, 3];
  var PORT_EDGES = [];           // port id -> {edge, a, b, perimIndex}
  (function buildPorts() {
    var idx = 0;
    for (var p = 0; p < PORT_GAPS.length; p++) {
      var pi = idx % PERIMETER_EDGES.length;
      var eid = PERIMETER_EDGES[pi];
      PORT_EDGES.push({ edge: eid, a: EDGES[eid].a, b: EDGES[eid].b, perimIndex: pi });
      idx += PORT_GAPS[p];
    }
  })();

  var VERT_PORTS = [];
  (function buildVertPorts() {
    for (var v = 0; v < VERTICES.length; v++) VERT_PORTS[v] = [];
    for (var p = 0; p < PORT_EDGES.length; p++) {
      VERT_PORTS[PORT_EDGES[p].a].push(p);
      VERT_PORTS[PORT_EDGES[p].b].push(p);
    }
  })();

  /* ---------------- SVG layout ---------------- */
  var xs = [], ys = [];
  for (var xi = 0; xi < VERTICES.length; xi++) { xs.push(VERTICES[xi].x); ys.push(VERTICES[xi].y); }
  var PAD = SIZE * 2.2;          // sea ring, where port markers are drawn
  var minX = Math.min.apply(null, xs) - PAD, maxX = Math.max.apply(null, xs) + PAD;
  var minY = Math.min.apply(null, ys) - PAD, maxY = Math.max.apply(null, ys) + PAD;

  function hexPolygon(h) {
    var pts = [];
    for (var i = 0; i < 6; i++) {
      var c = hexCorner(HEXES[h], i);
      pts.push(c.x.toFixed(3) + ',' + c.y.toFixed(3));
    }
    return pts.join(' ');
  }

  /* place a port marker out in the sea, along the outward normal of its edge */
  function portAnchor(portId, dist) {
    var pe = PORT_EDGES[portId];
    var va = VERTICES[pe.a], vb = VERTICES[pe.b];
    var mx = (va.x + vb.x) / 2, my = (va.y + vb.y) / 2;
    var h = HEXES[EDGE_HEXES[pe.edge][0]];
    var dx = mx - h.cx, dy = my - h.cy;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var d = (dist === undefined) ? SIZE * 1.2 : dist;
    return {
      x: mx + (dx / len) * d, y: my + (dy / len) * d,
      mx: mx, my: my,
      angle: Math.atan2(dy, dx) * 180 / Math.PI
    };
  }

  /* ---------------- load-time self-check ---------------- */
  var SELFCHECK = (function () {
    var errs = [];
    function need(cond, msg) { if (!cond) errs.push(msg); }

    need(HEXES.length === 19, 'expected 19 hexes, got ' + HEXES.length);
    need(VERTICES.length === 54, 'expected 54 vertices, got ' + VERTICES.length);
    need(EDGES.length === 72, 'expected 72 edges, got ' + EDGES.length);
    need(VERTICES.length - EDGES.length + (HEXES.length + 1) === 2, 'Euler check failed');
    need(COAST_EDGES.length === 30, 'expected 30 coastline edges, got ' + COAST_EDGES.length);
    need(PERIMETER_VERTICES.length === 30,
      'expected a 30-vertex coastline cycle, got ' + PERIMETER_VERTICES.length);

    for (var h = 0; h < HEXES.length; h++) {
      var seenV = {}, cnt = 0;
      for (var i = 0; i < HEX_VERTS[h].length; i++) {
        if (!seenV[HEX_VERTS[h][i]]) { seenV[HEX_VERTS[h][i]] = 1; cnt++; }
      }
      need(cnt === 6, 'hex ' + h + ' does not have 6 distinct vertices');
    }
    for (var v = 0; v < VERTICES.length; v++) {
      need(VERT_HEXES[v].length >= 1 && VERT_HEXES[v].length <= 3,
        'vertex ' + v + ' touches ' + VERT_HEXES[v].length + ' hexes');
      need(VERT_NEIGHBORS[v].length >= 2 && VERT_NEIGHBORS[v].length <= 3,
        'vertex ' + v + ' has ' + VERT_NEIGHBORS[v].length + ' neighbours');
      for (var j = 0; j < VERT_NEIGHBORS[v].length; j++) {
        need(VERT_NEIGHBORS[VERT_NEIGHBORS[v][j]].indexOf(v) >= 0,
          'asymmetric vertex adjacency at ' + v);
      }
    }
    /* sum of hexes-per-vertex must equal 19 * 6 */
    var totalInc = 0;
    for (var v2 = 0; v2 < VERTICES.length; v2++) totalInc += VERT_HEXES[v2].length;
    need(totalInc === 19 * 6, 'vertex/hex incidence sum is ' + totalInc + ', expected 114');

    need(PORT_EDGES.length === 9, 'expected 9 ports, got ' + PORT_EDGES.length);
    var seenE = {};
    for (var p = 0; p < PORT_EDGES.length; p++) {
      need(!seenE[PORT_EDGES[p].edge], 'two ports on the same edge');
      seenE[PORT_EDGES[p].edge] = 1;
    }
    for (var p2 = 0; p2 < PORT_EDGES.length; p2++) {
      var nx = PORT_EDGES[(p2 + 1) % PORT_EDGES.length];
      var gap = (nx.perimIndex - PORT_EDGES[p2].perimIndex + 30) % 30;
      need(gap >= 2, 'ports ' + p2 + ' and ' + ((p2 + 1) % 9) + ' are adjacent on the coast');
    }

    if (errs.length && typeof console !== 'undefined') {
      console.error('CatanGeo self-check FAILED:', errs);
    }
    return errs;
  })();

  global.CatanGeo = {
    ROW_SIZES: ROW_SIZES, SIZE: SIZE, HEX_W: HEX_W, ROW_DY: ROW_DY,
    HEXES: HEXES, VERTICES: VERTICES, EDGES: EDGES,
    vertexHexes: function (v) { return VERT_HEXES[v]; },
    vertexNeighbors: function (v) { return VERT_NEIGHBORS[v]; },
    hexVertices: function (h) { return HEX_VERTS[h]; },
    hexNeighbors: function (h) { return HEX_NEIGHBORS[h]; },
    edgeHexes: function (e) { return EDGE_HEXES[e]; },
    areAdjacent: function (a, b) { return VERT_NEIGHBORS[a].indexOf(b) >= 0; },
    COAST_EDGES: COAST_EDGES,
    PERIMETER_VERTICES: PERIMETER_VERTICES,
    PERIMETER_EDGES: PERIMETER_EDGES,
    PORT_EDGES: PORT_EDGES,
    portVertices: function (p) { return [PORT_EDGES[p].a, PORT_EDGES[p].b]; },
    vertexPorts: function (v) { return VERT_PORTS[v]; },
    hexCorner: hexCorner,
    hexPolygon: hexPolygon,
    portAnchor: portAnchor,
    LAYOUT: {
      viewBox: [minX.toFixed(2), minY.toFixed(2),
                (maxX - minX).toFixed(2), (maxY - minY).toFixed(2)].join(' '),
      minX: minX, minY: minY, maxX: maxX, maxY: maxY
    },
    SELFCHECK: SELFCHECK
  };
})(typeof window !== 'undefined' ? window : globalThis);
