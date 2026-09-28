/* ==========================================================================
 * catan-vision.js  --  hand-rolled computer vision for photos of a Catan board
 *
 * Classic script (no modules, no imports, no dependencies, no CDN).
 * Attaches its public API to window.CatanVision.
 *
 * Design in one paragraph: fully automatic board finding in an arbitrary phone
 * photo is not reliably solvable, so this module is CALIBRATED, not blind. The
 * user taps the 6 outer corners of the hex field (or 4, and we infer 2); from
 * those we solve a perspective homography board-space -> image-space by hand
 * (8x8 linear system, Gauss-Jordan with partial pivoting). Every hex centre is
 * then known exactly. Resources come from a robust (median) HSV statistic over
 * a ring of pixels between the number token and the hex border, after a global
 * white-balance / exposure normalisation computed from the board itself. Number
 * tokens are read PIP FIRST: connected-component labelling on a thresholded,
 * rectified token crop finds the dot row, and the pip count is rotation
 * invariant and is exactly what the downstream valuation model needs. Pip count
 * narrows the numeral to two candidates; those are separated by rotation
 * invariant topology (component count, hole count) with a derotated template
 * correlation as cross-check, plus red/black ink as an independent check.
 * Everything intermediate is exposed so a UI can show the user what was seen.
 * ========================================================================== */

(function (root) {
'use strict';

var VERSION = '1.0.0';
var SQ3 = Math.sqrt(3);

/* ---------------------------------------------------------------- canonical */

var ROW_SIZES        = [3, 4, 5, 4, 3];
var TYPES            = ['forest', 'hills', 'pasture', 'fields', 'mountains', 'desert'];
var RESOURCE_COUNTS  = { forest: 4, hills: 3, pasture: 4, fields: 4, mountains: 3, desert: 1 };
var RESOURCE_OF      = { forest: 'lumber', hills: 'brick', pasture: 'wool',
                         fields: 'grain', mountains: 'ore', desert: null };
var TOKEN_MULTISET   = [2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12];
var PIP_VALUE        = { 2:1, 3:2, 4:3, 5:4, 6:5, 8:5, 9:4, 10:3, 11:2, 12:1 };
var RED_NUMBERS      = { 6: true, 8: true };
var PIP_CANDIDATES   = { 1:[2,12], 2:[3,11], 3:[4,10], 4:[5,9], 5:[6,8] };
var PORT_MULTISET    = [ { kind: '3:1', resource: null }, { kind: '3:1', resource: null },
                         { kind: '3:1', resource: null }, { kind: '3:1', resource: null },
                         { kind: '2:1', resource: 'lumber' }, { kind: '2:1', resource: 'brick' },
                         { kind: '2:1', resource: 'wool' },   { kind: '2:1', resource: 'grain' },
                         { kind: '2:1', resource: 'ore' } ];

/* ------------------------------------------------------------- board space
 *
 * Board space uses pointy-top hexes of circumradius 1, board centre at the
 * origin, +x right and +y DOWN (image convention).  Hex width  = sqrt(3),
 * hex height = 2, row pitch = 1.5.
 *
 * Hex ids run rows top->bottom, left->right within a row: 3,4,5,4,3.
 *
 * The union of the 19 hexes is NOT a hexagon, it is a 12-gon: six long sides
 * (length 2*sqrt(3), at distance 4 from the centre) and six short chamfers
 * (the outer edge of each corner hex, length 1, at distance 2.5*sqrt(3)).
 * "The 6 outer corners of the hex field" is therefore defined here as the
 * MIDPOINT OF THE OUTER EDGE OF EACH CORNER HEX -- the outermost point of the
 * coastline in each of the six corner directions.  Radius 2.5*sqrt(3), at
 * angles 240/300/0/60/120/180 degrees.  Order: top-left, then CLOCKWISE.
 */

var HEX_R      = 1.0;      /* hex circumradius, board units                   */
var TOKEN_R    = 0.45;     /* number-token radius, board units                */
var RING_IN    = 0.60;     /* resource ring: inner radius (outside token)     */
var RING_OUT   = 0.80;     /* resource ring: outer radius (inside hex border) */
var CROP_HALF  = 0.585;    /* token crop half-width in board units            */
var CROP_PX    = 128;      /* token crop raster size in pixels                */
var CORNER_RAD = 2.5 * SQ3;

var LAYOUT_HEXES = (function () {
  var out = [], id = 0, r, i, n;
  for (r = 0; r < 5; r++) {
    n = ROW_SIZES[r];
    for (i = 0; i < n; i++) {
      out.push({ id: id++, row: r, col: i,
                 x: (i - (n - 1) / 2) * SQ3,
                 y: (r - 2) * 1.5 });
    }
  }
  return out;
})();

var BOARD_CORNERS = (function () {
  var out = [], k, a;
  var angs = [240, 300, 0, 60, 120, 180];
  for (k = 0; k < 6; k++) {
    a = angs[k] * Math.PI / 180;
    out.push([CORNER_RAD * Math.cos(a), CORNER_RAD * Math.sin(a)]);
  }
  return out;
})();

/* 9 harbour slots.  If catan-geometry.js is present we use its real coastline
 * port anchors (its layout is exactly this board space scaled by SIZE=10);
 * otherwise we fall back to 9 evenly spaced positions on the sea frame.
 * Either way port reading is by far the weakest stage of this pipeline and it
 * always reports low confidence. */
var PORT_RADIUS = 5.35;
var _portSlots = null, _portSlotSource = null;

/* resolved lazily, because catan-geometry.js may load after this file */
function getPortSlots() {
  if (_portSlots) return _portSlots;
  var out = [], k, a;
  var geo = root && root.CatanGeo;
  if (geo && geo.portAnchor && geo.SIZE) {
    try {
      for (k = 0; k < 9; k++) {
        var pa = geo.portAnchor(k, geo.SIZE * 0.85);
        out.push([pa.x / geo.SIZE, pa.y / geo.SIZE]);
      }
      if (out.length === 9) {
        _portSlots = out; _portSlotSource = 'CatanGeo.portAnchor';
        return _portSlots;
      }
    } catch (e) { out = []; }
  }
  out = [];
  for (k = 0; k < 9; k++) {
    a = (240 + k * 40) * Math.PI / 180;
    out.push([PORT_RADIUS * Math.cos(a), PORT_RADIUS * Math.sin(a)]);
  }
  _portSlots = out; _portSlotSource = 'evenly-spaced-fallback';
  return _portSlots;
}

/* ----------------------------------------------------------- linear algebra */

/* Gauss-Jordan elimination with partial pivoting.
 * A is n*n row-major, b is length n.  Both are copied, neither is mutated.
 * Returns Float64Array(n) solution, or null if the system is singular. */
function solveLinearSystem(A, b, n) {
  if (n == null) n = b.length;
  var m = new Float64Array(n * n), v = new Float64Array(n), i, j, k;
  for (i = 0; i < n * n; i++) m[i] = A[i];
  for (i = 0; i < n; i++) v[i] = b[i];

  for (k = 0; k < n; k++) {
    var piv = k, best = Math.abs(m[k * n + k]);
    for (i = k + 1; i < n; i++) {
      var av = Math.abs(m[i * n + k]);
      if (av > best) { best = av; piv = i; }
    }
    if (best < 1e-14) return null;
    if (piv !== k) {
      for (j = 0; j < n; j++) {
        var t = m[k * n + j]; m[k * n + j] = m[piv * n + j]; m[piv * n + j] = t;
      }
      var tb = v[k]; v[k] = v[piv]; v[piv] = tb;
    }
    var d = m[k * n + k];
    for (j = k; j < n; j++) m[k * n + j] /= d;
    v[k] /= d;
    for (i = 0; i < n; i++) {
      if (i === k) continue;
      var f = m[i * n + k];
      if (f === 0) continue;
      for (j = k; j < n; j++) m[i * n + j] -= f * m[k * n + j];
      v[i] -= f * v[k];
    }
  }
  return v;
}

function mat3mul(a, b) {
  var o = new Float64Array(9), i, j, k, s;
  for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) {
    s = 0; for (k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
    o[i * 3 + j] = s;
  }
  return o;
}

function mat3inv(m) {
  var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5],
      g = m[6], h = m[7], i = m[8];
  var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  var det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-300) return null;
  var o = new Float64Array(9);
  o[0] = A / det; o[1] = -(b * i - c * h) / det; o[2] = (b * f - c * e) / det;
  o[3] = B / det; o[4] = (a * i - c * g) / det;  o[5] = -(a * f - c * d) / det;
  o[6] = C / det; o[7] = -(a * h - b * g) / det; o[8] = (a * e - b * d) / det;
  return o;
}

/* Hartley-style isotropic normalisation, for conditioning. */
function normaliseTransform(pts) {
  var n = pts.length, i, mx = 0, my = 0, s = 0;
  for (i = 0; i < n; i++) { mx += pts[i][0]; my += pts[i][1]; }
  mx /= n; my /= n;
  for (i = 0; i < n; i++) {
    var dx = pts[i][0] - mx, dy = pts[i][1] - my;
    s += Math.sqrt(dx * dx + dy * dy);
  }
  s /= n;
  var k = (s > 1e-12) ? (Math.SQRT2 / s) : 1;
  var T = new Float64Array([k, 0, -k * mx, 0, k, -k * my, 0, 0, 1]);
  var out = [];
  for (i = 0; i < n; i++) out.push([k * (pts[i][0] - mx), k * (pts[i][1] - my)]);
  return { T: T, pts: out };
}

/* Homography src -> dst from >= 4 correspondences.
 * 4 points  -> exact 8x8 system.  >4 -> least squares via 8x8 normal
 * equations.  Both solved with the same Gauss-Jordan routine. */
function solveHomography(src, dst) {
  if (!src || !dst || src.length < 4 || src.length !== dst.length) return null;
  var ns = normaliseTransform(src), nd = normaliseTransform(dst);
  var n = src.length, rows = [], rhs = [], i, j;

  for (i = 0; i < n; i++) {
    var X = ns.pts[i][0], Y = ns.pts[i][1];
    var u = nd.pts[i][0], v = nd.pts[i][1];
    rows.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); rhs.push(u);
    rows.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]); rhs.push(v);
  }

  var A8 = new Float64Array(64), b8 = new Float64Array(8), r, c;
  if (n === 4) {
    for (r = 0; r < 8; r++) {
      for (c = 0; c < 8; c++) A8[r * 8 + c] = rows[r][c];
      b8[r] = rhs[r];
    }
  } else {
    for (r = 0; r < 8; r++) {
      for (c = 0; c < 8; c++) {
        var s = 0;
        for (j = 0; j < rows.length; j++) s += rows[j][r] * rows[j][c];
        A8[r * 8 + c] = s;
      }
      var sb = 0;
      for (j = 0; j < rows.length; j++) sb += rows[j][r] * rhs[j];
      b8[r] = sb;
    }
  }

  var h = solveLinearSystem(A8, b8, 8);
  if (!h) return null;
  var Hn = new Float64Array([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]);
  var Tdi = mat3inv(nd.T);
  if (!Tdi) return null;
  var H = mat3mul(Tdi, mat3mul(Hn, ns.T));
  if (Math.abs(H[8]) > 1e-300) { for (i = 0; i < 9; i++) H[i] /= H[8]; }
  return makeHomography(H);
}

function makeHomography(H) {
  var Hi = mat3inv(H);
  var obj = {
    m: H,
    mInv: Hi,
    apply: function (x, y) {
      var w = H[6] * x + H[7] * y + H[8];
      if (Math.abs(w) < 1e-12) w = 1e-12;
      return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
    },
    applyInv: function (u, v) {
      if (!Hi) return [0, 0];
      var w = Hi[6] * u + Hi[7] * v + Hi[8];
      if (Math.abs(w) < 1e-12) w = 1e-12;
      return [(Hi[0] * u + Hi[1] * v + Hi[2]) / w, (Hi[3] * u + Hi[4] * v + Hi[5]) / w];
    },
    /* local linear magnification (px per board unit) at a board point */
    scaleAt: function (x, y) {
      var e = 1e-3;
      var p0 = obj.apply(x, y), px = obj.apply(x + e, y), py = obj.apply(x, y + e);
      var a = (px[0] - p0[0]) / e, b = (py[0] - p0[0]) / e;
      var c = (px[1] - p0[1]) / e, d = (py[1] - p0[1]) / e;
      return Math.sqrt(Math.abs(a * d - b * c));
    }
  };
  return obj;
}

/* ------------------------------------------------------- corner bookkeeping */

function polyArea(pts) {
  var s = 0, i, n = pts.length;
  for (i = 0; i < n; i++) {
    var a = pts[i], b = pts[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

var CANON_WINDING = polyArea(BOARD_CORNERS) > 0 ? 1 : -1;

/* Given 4 taps (top-left, top-right, bottom-right, bottom-left of the hex
 * field) infer the missing left/right corners by fitting the homography to
 * those 4 and pushing the 2 unknown board-space corners through it. */
function inferSixCorners(four) {
  if (!four || four.length !== 4) return null;
  var srcIdx = [0, 1, 3, 4], src = [], i;
  for (i = 0; i < 4; i++) src.push(BOARD_CORNERS[srcIdx[i]]);
  var H = solveHomography(src, four);
  if (!H) return null;
  var six = new Array(6);
  six[0] = four[0].slice(); six[1] = four[1].slice();
  six[3] = four[2].slice(); six[4] = four[3].slice();
  six[2] = H.apply(BOARD_CORNERS[2][0], BOARD_CORNERS[2][1]);
  six[5] = H.apply(BOARD_CORNERS[5][0], BOARD_CORNERS[5][1]);
  return six;
}

function rotateCorners(corners, steps) {
  var n = corners.length, out = [], i;
  steps = ((steps % n) + n) % n;
  for (i = 0; i < n; i++) out.push(corners[(i + steps) % n].slice());
  return out;
}

/* Build the calibration from 4 or 6 tapped image points. */
function buildCalibration(points, opts) {
  opts = opts || {};
  var warnings = [], i;
  if (!points || (points.length !== 4 && points.length !== 6)) {
    return { ok: false, error: 'need 4 or 6 corner points, got ' +
             (points ? points.length : 0) };
  }
  var pts = [];
  for (i = 0; i < points.length; i++) {
    var p = points[i];
    var x = (p && p.length >= 2) ? +p[0] : (p ? +p.x : NaN);
    var y = (p && p.length >= 2) ? +p[1] : (p ? +p.y : NaN);
    if (!isFinite(x) || !isFinite(y)) {
      return { ok: false, error: 'corner ' + i + ' is not a finite point' };
    }
    pts.push([x, y]);
  }

  var mode = pts.length === 6 ? '6-corner' : '4-corner';
  if (pts.length === 4) {
    pts = inferSixCorners(pts);
    if (!pts) return { ok: false, error: 'could not infer corners from 4 taps' };
    warnings.push('two corners were inferred from 4 taps; accuracy is lower than a 6-tap calibration');
  }

  var mirrored = false;
  if ((polyArea(pts) > 0 ? 1 : -1) !== CANON_WINDING) {
    pts = [pts[0], pts[5], pts[4], pts[3], pts[2], pts[1]];
    mirrored = true;
    warnings.push('corners were given anticlockwise; order was reversed so the board is not mirrored');
  }

  var H = solveHomography(BOARD_CORNERS, pts);
  if (!H) return { ok: false, error: 'degenerate corner configuration (homography is singular)' };

  var resid = 0;
  for (i = 0; i < 6; i++) {
    var q = H.apply(BOARD_CORNERS[i][0], BOARD_CORNERS[i][1]);
    resid += Math.sqrt((q[0] - pts[i][0]) * (q[0] - pts[i][0]) +
                       (q[1] - pts[i][1]) * (q[1] - pts[i][1]));
  }
  resid /= 6;

  var centres = [], scales = [], meanScale = 0;
  for (i = 0; i < 19; i++) {
    var hx = LAYOUT_HEXES[i];
    centres.push(H.apply(hx.x, hx.y));
    scales.push(H.scaleAt(hx.x, hx.y));
    meanScale += scales[i];
  }
  meanScale /= 19;

  if (resid > 0.10 * meanScale) {
    warnings.push('tapped corners are not consistent with a planar hex field (mean reprojection residual ' +
                  resid.toFixed(1) + ' px)');
  }

  return {
    ok: true,
    mode: mode,
    corners: pts,
    mirroredFix: mirrored,
    homography: H,
    residualPx: resid,
    hexCentres: centres,
    hexScalePx: scales,
    meanScalePx: meanScale,
    warnings: warnings
  };
}

/* ------------------------------------------------------------ image access */

/* Accepts ImageData, {width,height,data}, HTMLCanvasElement, HTMLImageElement. */
function toImageData(src) {
  if (!src) return null;
  if (src.data && src.width && src.height) return src;
  if (typeof document !== 'undefined') {
    var w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    if (!w || !h) return null;
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var cx = cv.getContext('2d');
    cx.drawImage(src, 0, 0);
    return cx.getImageData(0, 0, w, h);
  }
  return null;
}

function imageDataToCanvas(img) {
  if (typeof document === 'undefined') return null;
  var cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  var cx = cv.getContext('2d');
  var id = cx.createImageData(img.width, img.height);
  id.data.set(img.data);
  cx.putImageData(id, 0, 0);
  return cv;
}

var _s = [0, 0, 0];

/* Bilinear RGB sample; writes into out[0..2] (0..255). Returns false if the
 * point is outside the image. */
function sampleBilinear(img, x, y, out) {
  var w = img.width, h = img.height, d = img.data;
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) {
    /* clamp but report out-of-frame */
    if (x < -2 || y < -2 || x > w + 1 || y > h + 1) { out[0] = out[1] = out[2] = 0; return false; }
    x = Math.min(w - 1, Math.max(0, x));
    y = Math.min(h - 1, Math.max(0, y));
  }
  var x0 = Math.floor(x), y0 = Math.floor(y);
  var x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  var fx = x - x0, fy = y - y0;
  var i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
  var i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy),
      w01 = (1 - fx) * fy,       w11 = fx * fy;
  out[0] = d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11;
  out[1] = d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11;
  out[2] = d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11;
  return true;
}

/* ----------------------------------------------------------- colour helpers */

function rgb2hsv(r, g, b, out) {
  r /= 255; g /= 255; b /= 255;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn, hh = 0;
  if (c > 1e-9) {
    if (mx === r)      hh = ((g - b) / c) % 6;
    else if (mx === g) hh = (b - r) / c + 2;
    else               hh = (r - g) / c + 4;
    hh *= 60;
    if (hh < 0) hh += 360;
  }
  out[0] = hh;
  out[1] = mx > 1e-9 ? c / mx : 0;
  out[2] = mx;
  return out;
}

function hueDiff(a, b) {
  var d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function median(arr) {
  if (!arr.length) return 0;
  var a = Array.prototype.slice.call(arr);
  a.sort(function (p, q) { return p - q; });
  var n = a.length;
  return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

function madOf(arr, med) {
  var i, d = [];
  for (i = 0; i < arr.length; i++) d.push(Math.abs(arr[i] - med));
  return median(d);
}

/* Circular median of hues (degrees). */
function circularMedian(hues) {
  if (!hues.length) return 0;
  var i, sx = 0, sy = 0;
  for (i = 0; i < hues.length; i++) {
    var a = hues[i] * Math.PI / 180;
    sx += Math.cos(a); sy += Math.sin(a);
  }
  var mean = Math.atan2(sy, sx) * 180 / Math.PI;
  if (mean < 0) mean += 360;
  var rel = [];
  for (i = 0; i < hues.length; i++) {
    var d = hues[i] - mean;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    rel.push(d);
  }
  var m = mean + median(rel);
  m %= 360; if (m < 0) m += 360;
  return m;
}

function circularSpread(hues, med) {
  var i, d = [];
  for (i = 0; i < hues.length; i++) d.push(hueDiff(hues[i], med));
  return median(d);
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* ===========================================================================
 * Stage 1 -- global white balance / exposure, computed from the board itself
 * ========================================================================= */

function computeWhiteBalance(img, cal, opts) {
  opts = opts || {};
  var rgb = [0, 0, 0], hsv = [0, 0, 0];
  var sumR = 0, sumG = 0, sumB = 0, n = 0, lums = [], i, ri, ai;
  /* dense-ish sample over every hex, out to 0.82R, plus the token discs */
  for (i = 0; i < 19; i++) {
    var hx = LAYOUT_HEXES[i];
    for (ri = 0; ri < 6; ri++) {
      var rad = 0.10 + ri * 0.145;
      for (ai = 0; ai < 24; ai++) {
        var a = ai / 24 * 2 * Math.PI + ri * 0.13;
        var bx = hx.x + rad * Math.cos(a), by = hx.y + rad * Math.sin(a);
        var p = cal.homography.apply(bx, by);
        if (!sampleBilinear(img, p[0], p[1], rgb)) continue;
        sumR += rgb[0]; sumG += rgb[1]; sumB += rgb[2]; n++;
        lums.push(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]);
      }
    }
  }
  if (!n) return { gain: [1, 1, 1], exposure: 1, samples: 0, ok: false };

  var mr = sumR / n, mg = sumG / n, mb = sumB / n;
  var grey = (mr + mg + mb) / 3;
  /* grey-world: the whole board averaged over 19 tiles of six different hues
   * plus 18 pale tokens is a reasonable neutral reference. */
  var gr = clamp(grey / Math.max(1, mr), 0.55, 1.85);
  var gg = clamp(grey / Math.max(1, mg), 0.55, 1.85);
  var gb = clamp(grey / Math.max(1, mb), 0.55, 1.85);

  /* exposure: put the 92nd percentile luminance (token discs, the brightest
   * large feature on the board) at a fixed target. */
  lums.sort(function (a, b) { return a - b; });
  var p92 = lums[Math.min(lums.length - 1, Math.floor(lums.length * 0.92))];
  var target = opts.exposureTarget == null ? 218 : opts.exposureTarget;
  var expo = clamp(target / Math.max(8, p92 * (gr + gg + gb) / 3), 0.45, 2.6);

  return { gain: [gr * expo, gg * expo, gb * expo], rawGain: [gr, gg, gb],
           exposure: expo, p92: p92, samples: n, ok: true };
}

function applyWB(wb, rgb, out) {
  out[0] = clamp(rgb[0] * wb.gain[0], 0, 255);
  out[1] = clamp(rgb[1] * wb.gain[1], 0, 255);
  out[2] = clamp(rgb[2] * wb.gain[2], 0, 255);
  return out;
}

/* ===========================================================================
 * Stage 2 -- resource classification from a robust ring statistic
 * ========================================================================= */

/* Reference prototypes.  Hue in degrees, s/v in 0..1.  The per-axis weights
 * encode which axis actually separates each class: mountains are defined by
 * near-zero saturation (hue is meaningless there), desert by high value with
 * low saturation, forest by being dark.  pasture-vs-fields and hills-vs-desert
 * are the genuinely confusable pairs and are handled by extra explicit terms
 * in classifyHex() below, not by hue alone. */
var PROTOS = [
  { type: 'forest',    h: 127, s: 0.46, v: 0.38, wh: 1.00, ws: 0.60, wv: 1.35 },
  { type: 'hills',     h: 20,  s: 0.67, v: 0.64, wh: 1.45, ws: 0.95, wv: 0.95 },
  { type: 'pasture',   h: 76,  s: 0.56, v: 0.69, wh: 1.70, ws: 0.95, wv: 0.85 },
  { type: 'fields',    h: 46,  s: 0.73, v: 0.86, wh: 1.70, ws: 1.05, wv: 1.00 },
  { type: 'mountains', h: 0,   s: 0.06, v: 0.57, wh: 0.10, ws: 3.20, wv: 0.65 },
  { type: 'desert',    h: 42,  s: 0.26, v: 0.86, wh: 0.75, ws: 2.40, wv: 1.70 }
];

/* Sample the ring between the token edge and the hex border and return a
 * robust HSV statistic plus a quality measure. */
function sampleHexRing(img, cal, wb, hexIdx) {
  var hx = LAYOUT_HEXES[hexIdx];
  var rgb = [0, 0, 0], wbc = [0, 0, 0], hsv = [0, 0, 0];
  var hs = [], ss = [], vs = [], nOut = 0, total = 0;
  var nR = 5, nA = 72, ri, ai;
  for (ri = 0; ri < nR; ri++) {
    var rad = RING_IN + (RING_OUT - RING_IN) * (nR === 1 ? 0.5 : ri / (nR - 1));
    for (ai = 0; ai < nA; ai++) {
      var a = (ai / nA) * 2 * Math.PI + ri * 0.21;
      /* stay inside the hexagon: shrink radius near the vertices */
      var bx = hx.x + rad * Math.cos(a), by = hx.y + rad * Math.sin(a);
      var p = cal.homography.apply(bx, by);
      total++;
      if (!sampleBilinear(img, p[0], p[1], rgb)) { nOut++; continue; }
      applyWB(wb, rgb, wbc);
      rgb2hsv(wbc[0], wbc[1], wbc[2], hsv);
      hs.push(hsv[0]); ss.push(hsv[1]); vs.push(hsv[2]);
    }
  }
  if (!hs.length) {
    return { ok: false, h: 0, s: 0, v: 0, hSpread: 180, sMad: 1, vMad: 1,
             offFrame: 1, n: 0 };
  }
  var mh = circularMedian(hs), ms = median(ss), mv = median(vs);
  return {
    ok: true, h: mh, s: ms, v: mv,
    hSpread: circularSpread(hs, mh),
    sMad: madOf(ss, ms), vMad: madOf(vs, mv),
    offFrame: nOut / total, n: hs.length
  };
}

/* Distance of a sample to each prototype, lower is better. */
function typeCosts(st) {
  var out = {}, i, best = Infinity, second = Infinity;
  for (i = 0; i < PROTOS.length; i++) {
    var p = PROTOS[i];
    /* hue is only meaningful when BOTH sample and prototype are saturated */
    var hueTrust = Math.min(1, Math.min(st.s, p.s) / 0.22);
    var dh = hueDiff(st.h, p.h) / 45;
    var ds = (st.s - p.s) / 0.26;
    var dv = (st.v - p.v) / 0.26;
    var d = p.wh * hueTrust * dh * dh + p.ws * ds * ds + p.wv * dv * dv;

    /* --- deliberate handling of the two confusable pairs --------------- */
    if (p.type === 'pasture' || p.type === 'fields') {
      /* pasture vs fields is a hue question but a narrow one (76 vs 46);
       * amplify the hue axis inside this band and use saturation as a
       * secondary vote (fields are more saturated). */
      if (st.s > 0.25) {
        var dhp = hueDiff(st.h, p.h) / 14;
        d += 0.55 * dhp * dhp;
      }
    }
    if (p.type === 'desert') {
      /* desert must be pale: penalise saturated or dark samples hard */
      if (st.s > 0.40) d += 7 * (st.s - 0.40) * (st.s - 0.40) / 0.02;
      if (st.v < 0.66) d += 7 * (0.66 - st.v) * (0.66 - st.v) / 0.02;
    }
    if (p.type === 'hills') {
      /* hills must be reasonably saturated and not pale */
      if (st.s < 0.36) d += 5 * (0.36 - st.s) * (0.36 - st.s) / 0.02;
    }
    if (p.type === 'mountains') {
      if (st.s > 0.22) d += 9 * (st.s - 0.22) * (st.s - 0.22) / 0.02;
    }
    if (p.type === 'forest') {
      if (st.v > 0.62) d += 3 * (st.v - 0.62) * (st.v - 0.62) / 0.02;
    }
    out[p.type] = d;
    if (d < best) { second = best; best = d; }
    else if (d < second) second = d;
  }
  out._best = best; out._second = second;
  return out;
}

function costsToConfidence(costs, st) {
  var margin = (costs._second - costs._best) / (costs._second + costs._best + 0.6);
  var q = 1;
  if (st.hSpread > 30) q *= clamp(1 - (st.hSpread - 30) / 60, 0.25, 1);
  if (st.offFrame > 0.02) q *= clamp(1 - st.offFrame * 2, 0.1, 1);
  if (costs._best > 3.0) q *= clamp(1 - (costs._best - 3.0) / 6, 0.2, 1);
  return clamp(margin * 1.8 * q, 0.02, 0.99);
}

/* ===========================================================================
 * Stage 3 -- rectified crops, connected components, pips and numerals
 * ========================================================================= */

/* Warp a square board-space patch centred at (cx,cy) into an n x n RGBA
 * raster.  White balance is applied while sampling. */
function warpPatch(img, H, wb, cx, cy, half, n) {
  var out = { width: n, height: n, data: new Uint8ClampedArray(n * n * 4) };
  var rgb = [0, 0, 0], wbc = [0, 0, 0], i, j;
  for (j = 0; j < n; j++) {
    var by = cy + (2 * (j + 0.5) / n - 1) * half;
    for (i = 0; i < n; i++) {
      var bx = cx + (2 * (i + 0.5) / n - 1) * half;
      var p = H.apply(bx, by);
      var ok = sampleBilinear(img, p[0], p[1], rgb);
      if (wb) applyWB(wb, rgb, wbc); else { wbc[0] = rgb[0]; wbc[1] = rgb[1]; wbc[2] = rgb[2]; }
      var o = (j * n + i) * 4;
      out.data[o] = wbc[0]; out.data[o + 1] = wbc[1]; out.data[o + 2] = wbc[2];
      out.data[o + 3] = ok ? 255 : 0;
    }
  }
  return out;
}

/* Rectangular warp for the whole-board transparency image. */
function rectify(img, cal, wOut, hOut, wb) {
  wOut = wOut || 600;
  var xr = 5.3, yr = 4.8;
  hOut = hOut || Math.round(wOut * yr / xr);
  var out = { width: wOut, height: hOut, data: new Uint8ClampedArray(wOut * hOut * 4) };
  var rgb = [0, 0, 0], wbc = [0, 0, 0], i, j;
  for (j = 0; j < hOut; j++) {
    var by = (2 * (j + 0.5) / hOut - 1) * yr;
    for (i = 0; i < wOut; i++) {
      var bx = (2 * (i + 0.5) / wOut - 1) * xr;
      var p = cal.homography.apply(bx, by);
      var ok = sampleBilinear(img, p[0], p[1], rgb);
      if (wb) applyWB(wb, rgb, wbc); else { wbc[0] = rgb[0]; wbc[1] = rgb[1]; wbc[2] = rgb[2]; }
      var o = (j * wOut + i) * 4;
      out.data[o] = wbc[0]; out.data[o + 1] = wbc[1]; out.data[o + 2] = wbc[2];
      out.data[o + 3] = ok ? 255 : 0;
    }
  }
  return out;
}

/* Otsu threshold over a masked set of luminance values (0..255). */
function otsu(vals) {
  var hist = new Float64Array(256), i, n = vals.length;
  for (i = 0; i < n; i++) hist[vals[i] | 0]++;
  var total = n, sum = 0;
  for (i = 0; i < 256; i++) sum += i * hist[i];
  var sumB = 0, wB = 0, best = -1, thr = 128;
  for (i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    var wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    var mB = sumB / wB, mF = (sum - sumB) / wF;
    var between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = i; }
  }
  return thr;
}

/* 8-connected component labelling over a Uint8Array mask. */
function connectedComponents(mask, w, h) {
  var labels = new Int32Array(w * h).fill(-1);
  var comps = [], stack = new Int32Array(w * h), i, j;
  var dx = [1, -1, 0, 0, 1, 1, -1, -1], dy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
    var idx = j * w + i;
    if (!mask[idx] || labels[idx] >= 0) continue;
    var id = comps.length, sp = 0;
    stack[sp++] = idx; labels[idx] = id;
    var area = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    var minx = i, maxx = i, miny = j, maxy = j, perim = 0;
    while (sp > 0) {
      var cur = stack[--sp];
      var cx = cur % w, cy = (cur / w) | 0;
      area++; sx += cx; sy += cy; sxx += cx * cx; syy += cy * cy; sxy += cx * cy;
      if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
      if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
      var k, edge = 0;
      for (k = 0; k < 4; k++) {
        var nx = cx + dx[k], ny = cy + dy[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) edge = 1;
      }
      perim += edge;
      for (k = 0; k < 8; k++) {
        var mx = cx + dx[k], my = cy + dy[k];
        if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
        var ni = my * w + mx;
        if (mask[ni] && labels[ni] < 0) { labels[ni] = id; stack[sp++] = ni; }
      }
    }
    var cxm = sx / area, cym = sy / area;
    var mu20 = sxx / area - cxm * cxm, mu02 = syy / area - cym * cym,
        mu11 = sxy / area - cxm * cym;
    var tr = mu20 + mu02, det = mu20 * mu02 - mu11 * mu11;
    var disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    var l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    comps.push({
      id: id, area: area, cx: cxm, cy: cym,
      minx: minx, maxx: maxx, miny: miny, maxy: maxy,
      w: maxx - minx + 1, h: maxy - miny + 1,
      perim: Math.max(1, perim),
      circularity: clamp(4 * Math.PI * area / (Math.max(1, perim) * Math.max(1, perim)), 0, 1.4),
      elong: l2 > 1e-6 ? Math.sqrt(l1 / l2) : 99,
      axis: 0.5 * Math.atan2(2 * mu11, mu20 - mu02),
      extent: area / ((maxx - minx + 1) * (maxy - miny + 1))
    });
  }
  return { labels: labels, comps: comps, width: w, height: h };
}

/* Count holes (enclosed background regions) of one component. */
function countHoles(cc, comp, minHoleArea) {
  var pad = 2;
  var x0 = comp.minx - pad, y0 = comp.miny - pad;
  var bw = comp.w + 2 * pad, bh = comp.h + 2 * pad;
  var sub = new Uint8Array(bw * bh), i, j;
  for (j = 0; j < bh; j++) for (i = 0; i < bw; i++) {
    var gx = x0 + i, gy = y0 + j;
    var inside = (gx >= 0 && gy >= 0 && gx < cc.width && gy < cc.height &&
                  cc.labels[gy * cc.width + gx] === comp.id);
    sub[j * bw + i] = inside ? 0 : 1;   /* 1 = background */
  }
  /* flood the outer background */
  var seen = new Uint8Array(bw * bh), stack = [], sp;
  for (i = 0; i < bw; i++) { stack.push(i); stack.push((bh - 1) * bw + i); }
  for (j = 0; j < bh; j++) { stack.push(j * bw); stack.push(j * bw + bw - 1); }
  while (stack.length) {
    var cur = stack.pop();
    if (seen[cur] || !sub[cur]) continue;
    seen[cur] = 1;
    var cx = cur % bw, cy = (cur / bw) | 0;
    if (cx > 0) stack.push(cur - 1);
    if (cx < bw - 1) stack.push(cur + 1);
    if (cy > 0) stack.push(cur - bw);
    if (cy < bh - 1) stack.push(cur + bw);
  }
  var holeMask = new Uint8Array(bw * bh);
  for (i = 0; i < bw * bh; i++) holeMask[i] = (sub[i] && !seen[i]) ? 1 : 0;
  var hc = connectedComponents(holeMask, bw, bh);
  var n = 0, areas = [];
  for (i = 0; i < hc.comps.length; i++) {
    if (hc.comps[i].area >= minHoleArea) { n++; areas.push(hc.comps[i].area); }
  }
  areas.sort(function (a, b) { return b - a; });
  return { count: n, areas: areas };
}

/* ------------------------------------------- self-rendered digit templates */

/* Glyph primitives, drawn in a box where the cap height spans y in [-0.5,0.5]
 * and the advance width is 0.62.  'seg' = thick line with round caps,
 * 'arc'  = thick elliptical arc (a0/a1 in degrees, +x right, +y DOWN, so 270
 * is straight up).  A full ring is an arc of 360 degrees. */
var STROKE = 0.155;
var GLYPHS = {
  '0': [ { t: 'arc', cx: 0, cy: 0, rx: 0.215, ry: 0.415, a0: 0, a1: 360 } ],
  '1': [ { t: 'seg', x0: 0.02, y0: -0.5, x1: 0.02, y1: 0.5 },
         { t: 'seg', x0: -0.15, y0: -0.34, x1: 0.02, y1: -0.5 } ],
  '2': [ { t: 'arc', cx: 0, cy: -0.26, rx: 0.22, ry: 0.20, a0: 170, a1: 390 },
         { t: 'seg', x0: 0.19, y0: -0.16, x1: -0.22, y1: 0.40 },
         { t: 'seg', x0: -0.24, y0: 0.42, x1: 0.24, y1: 0.42 } ],
  '3': [ { t: 'arc', cx: 0, cy: -0.24, rx: 0.21, ry: 0.20, a0: 200, a1: 430 },
         { t: 'arc', cx: 0, cy: 0.24, rx: 0.23, ry: 0.22, a0: -70, a1: 160 } ],
  '4': [ { t: 'seg', x0: 0.10, y0: -0.5, x1: -0.25, y1: 0.16 },
         { t: 'seg', x0: -0.27, y0: 0.16, x1: 0.25, y1: 0.16 },
         { t: 'seg', x0: 0.10, y0: -0.5, x1: 0.10, y1: 0.5 } ],
  '5': [ { t: 'seg', x0: -0.20, y0: -0.42, x1: 0.22, y1: -0.42 },
         { t: 'seg', x0: -0.20, y0: -0.42, x1: -0.20, y1: -0.06 },
         { t: 'seg', x0: -0.20, y0: -0.06, x1: 0.0, y1: -0.075 },
         { t: 'arc', cx: 0, cy: 0.18, rx: 0.23, ry: 0.245, a0: 270, a1: 500 } ],
  '6': [ { t: 'arc', cx: 0, cy: 0.16, rx: 0.225, ry: 0.245, a0: 0, a1: 360 },
         { t: 'arc', cx: 0.17, cy: 0.16, rx: 0.40, ry: 0.58, a0: 270, a1: 180 } ],
  '8': [ { t: 'arc', cx: 0, cy: -0.235, rx: 0.195, ry: 0.215, a0: 0, a1: 360 },
         { t: 'arc', cx: 0, cy: 0.19, rx: 0.225, ry: 0.24, a0: 0, a1: 360 } ],
  '9': [ { t: 'arc', cx: 0, cy: -0.16, rx: 0.225, ry: 0.245, a0: 0, a1: 360 },
         { t: 'arc', cx: -0.17, cy: -0.16, rx: 0.40, ry: 0.58, a0: 90, a1: 0 } ]
};

function distToPrimitive(p, x, y) {
  if (p.t === 'seg') {
    var vx = p.x1 - p.x0, vy = p.y1 - p.y0;
    var L2 = vx * vx + vy * vy;
    var t = L2 > 1e-12 ? ((x - p.x0) * vx + (y - p.y0) * vy) / L2 : 0;
    t = clamp(t, 0, 1);
    var qx = p.x0 + t * vx, qy = p.y0 + t * vy;
    return Math.sqrt((x - qx) * (x - qx) + (y - qy) * (y - qy));
  }
  /* arc: approximate distance by clamping the parametric angle */
  var a0 = p.a0, a1 = p.a1;
  var ang = Math.atan2((y - p.cy) / p.ry, (x - p.cx) / p.rx) * 180 / Math.PI;
  var lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  var full = (hi - lo) >= 359.9;
  var best = Infinity, cand = [], k;
  if (full) cand.push(ang);
  else {
    var a = ang;
    while (a < lo) a += 360;
    while (a > hi + 360) a -= 360;
    if (a >= lo && a <= hi) cand.push(a);
    cand.push(lo); cand.push(hi);
  }
  for (k = 0; k < cand.length; k++) {
    var r = cand[k] * Math.PI / 180;
    var px = p.cx + p.rx * Math.cos(r), py = p.cy + p.ry * Math.sin(r);
    var d = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
    if (d < best) best = d;
  }
  return best;
}

/* Rasterise a number string into an n x n binary mask (bbox-normalised). */
function renderNumberMask(numStr, n) {
  var chars = String(numStr).split(''), adv = 0.56, i;
  var prims = [], xoff = -(chars.length - 1) * adv / 2;
  for (i = 0; i < chars.length; i++) {
    var g = GLYPHS[chars[i]];
    if (!g) continue;
    var ox = xoff + i * adv, j;
    for (j = 0; j < g.length; j++) {
      var p = g[j], q = {};
      var key;
      for (key in p) q[key] = p[key];
      if (q.t === 'seg') { q.x0 += ox; q.x1 += ox; }
      else { q.cx += ox; }
      prims.push(q);
    }
  }
  /* find the glyph bbox by coarse sampling, then rasterise normalised */
  var sn = 96, buf = new Uint8Array(sn * sn);
  var spanX = chars.length * adv / 2 + 0.3, spanY = 0.75;
  var minx = sn, maxx = -1, miny = sn, maxy = -1, ix, iy;
  for (iy = 0; iy < sn; iy++) {
    var gy = (2 * (iy + 0.5) / sn - 1) * spanY;
    for (ix = 0; ix < sn; ix++) {
      var gx = (2 * (ix + 0.5) / sn - 1) * spanX;
      var d = Infinity, k;
      for (k = 0; k < prims.length; k++) {
        var dd = distToPrimitive(prims[k], gx, gy);
        if (dd < d) d = dd;
      }
      if (d <= STROKE / 2) {
        buf[iy * sn + ix] = 1;
        if (ix < minx) minx = ix; if (ix > maxx) maxx = ix;
        if (iy < miny) miny = iy; if (iy > maxy) maxy = iy;
      }
    }
  }
  var out = new Uint8Array(n * n);
  if (maxx < 0) return { mask: out, aspect: 1 };
  var bw = maxx - minx + 1, bh = maxy - miny + 1;
  /* the sampling grid is sn x sn but covers spanX x spanY GLYPH units, so the
   * true aspect ratio has to be converted back out of pixel space */
  var trueAspect = (bw * spanX) / (bh * spanY);
  for (iy = 0; iy < n; iy++) for (ix = 0; ix < n; ix++) {
    var sx = minx + Math.floor((ix + 0.5) / n * bw);
    var sy = miny + Math.floor((iy + 0.5) / n * bh);
    out[iy * n + ix] = buf[sy * sn + sx];
  }
  return { mask: out, aspect: trueAspect };
}

var TPL_N = 28;
var TEMPLATES = (function () {
  var out = {}, nums = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12], i;
  for (i = 0; i < nums.length; i++) out[nums[i]] = renderNumberMask(nums[i], TPL_N);
  return out;
})();

/* Reference topology of each numeral, used as the primary rotation-invariant
 * discriminator.  Derived from the glyph definitions above and true of real
 * Catan tokens: 5 has no counter, 9 has one, 6 has one, 8 has two. */
var NUM_TOPOLOGY = {
  2:  { comps: 1, holes: 0 }, 3:  { comps: 1, holes: 0 },
  4:  { comps: 1, holes: 1 }, 5:  { comps: 1, holes: 0 },
  6:  { comps: 1, holes: 1 }, 8:  { comps: 1, holes: 2 },
  9:  { comps: 1, holes: 1 },
  10: { comps: 2, holes: 1 }, 11: { comps: 2, holes: 0 },
  12: { comps: 2, holes: 0 }
};

/* Expected geometry inside a CROP_PX crop */
function tokenGeom() {
  var rt = CROP_PX * TOKEN_R / (2 * CROP_HALF);        /* token radius, px */
  return {
    tokenR: rt,
    pipR: 0.070 * rt,
    pipArea: Math.PI * Math.pow(0.070 * rt, 2),
    pipSpacing: 0.24 * rt,
    digitH: 0.85 * rt,
    strokeW: 0.15 * rt
  };
}

/* --------------------------------------------------------- token analysis */

function analyseToken(crop, geom) {
  var n = crop.width, d = crop.data, i, j;
  var cx = n / 2, cy = n / 2;
  var rt = geom.tokenR;

  /* ---- disc statistics (inside 0.88 * token radius) --------------------- */
  var lum = new Float64Array(n * n);
  var hsv = [0, 0, 0];
  var discIdx = [], discLum = [], discS = [], discV = [];
  for (j = 0; j < n; j++) for (i = 0; i < n; i++) {
    var o = (j * n + i) * 4;
    var L = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
    lum[j * n + i] = L;
    var dx = i + 0.5 - cx, dy = j + 0.5 - cy;
    if (dx * dx + dy * dy <= (0.88 * rt) * (0.88 * rt)) {
      discIdx.push(j * n + i);
      discLum.push(L);
      rgb2hsv(d[o], d[o + 1], d[o + 2], hsv);
      discS.push(hsv[1]); discV.push(hsv[2]);
    }
  }
  var medL = median(discLum), medS = median(discS), medV = median(discV);

  /* ---- ink threshold: Otsu inside the disc, dark class ------------------ */
  var thr = otsu(discLum.map(function (v) { return clamp(v, 0, 255); }));
  /* guard: if the disc is uniform there is nothing to read */
  var hiL = median(discLum.filter(function (v) { return v >= medL; }));
  var loL = median(discLum.filter(function (v) { return v < medL; }));
  var contrast = hiL - loL;
  thr = Math.min(thr, medL - 0.12 * Math.max(20, contrast));

  var mask = new Uint8Array(n * n), inkCount = 0;
  for (i = 0; i < discIdx.length; i++) {
    var ix = discIdx[i];
    if (lum[ix] <= thr) { mask[ix] = 1; inkCount++; }
  }

  var cc = connectedComponents(mask, n, n);
  var comps = cc.comps.filter(function (c) {
    if (c.area < Math.max(4, geom.pipArea * 0.18)) return false;
    /* drop anything hugging the disc rim (shadow / border artefacts) */
    var dx = c.cx - cx, dy = c.cy - cy;
    return Math.sqrt(dx * dx + dy * dy) < 0.90 * rt;
  });

  /* ---- presence: a token needs a pale disc AND ink inside it ------------ */
  var discArea = Math.PI * Math.pow(0.88 * rt, 2);
  var inkFrac = inkCount / discArea;
  var present = (comps.length >= 1) && (inkFrac > 0.012) && (inkFrac < 0.42) &&
                (medV > 0.45) && (contrast > 22);

  var res = {
    present: present, presenceScore: 0,
    discLum: medL, discS: medS, discV: medV, contrast: contrast,
    inkFrac: inkFrac, threshold: thr,
    comps: comps.length, blobs: [], pips: null, pipConfidence: 0,
    number: null, numberConfidence: 0, candidates: null,
    ink: 'none', inkConflict: false, rotationDeg: null,
    holes: null, numeralComps: 0, numeralAspect: null,
    notes: []
  };
  res.presenceScore = clamp((inkFrac - 0.004) * 30, 0, 1) *
                      clamp((contrast - 14) / 45, 0, 1) *
                      clamp((medV - 0.38) / 0.25, 0, 1);
  if (!present) { res.mask = mask; res.cc = cc; return res; }

  /* ---- separate pip candidates from numeral strokes --------------------- */
  var pipLo = geom.pipArea * 0.30, pipHi = geom.pipArea * 3.2;
  var pipCand = [], numComps = [];
  for (i = 0; i < comps.length; i++) {
    var c = comps[i];
    var roundish = c.circularity > 0.52 && c.elong < 2.4 && c.extent > 0.45;
    if (c.area >= pipLo && c.area <= pipHi && roundish) pipCand.push(c);
    else numComps.push(c);
  }
  /* merged pips: an elongated blob of k pip-areas sitting away from centre */
  var merged = [];
  for (i = 0; i < numComps.length; i++) {
    var c2 = numComps[i];
    var k = c2.area / geom.pipArea;
    if (k > 1.4 && k < 6.5 && c2.elong > 2.0 && c2.circularity < 0.6) {
      merged.push({ comp: c2, k: Math.max(1, Math.min(5, Math.round(k))) });
    }
  }

  res.blobs = comps.map(function (c) {
    return { cx: c.cx, cy: c.cy, area: c.area, circularity: c.circularity,
             elong: c.elong, isPip: pipCand.indexOf(c) >= 0 };
  });

  /* ---- best collinear subset of pip candidates -------------------------- */
  var pipSet = bestCollinearSet(pipCand, geom);
  var pipsFromBlobs = pipSet.pts.length;
  var pipsFromMerged = 0;
  for (i = 0; i < merged.length; i++) pipsFromMerged += merged[i].k;

  /* three independent estimates of the pip count */
  var estBlobs = pipsFromBlobs + (pipsFromBlobs > 0 ? 0 : pipsFromMerged);
  if (pipsFromBlobs > 0 && merged.length && pipSet.line) {
    /* only fold merged blobs in if they lie on the same line */
    for (i = 0; i < merged.length; i++) {
      if (pointLineDist(pipSet.line, merged[i].comp.cx, merged[i].comp.cy) <
          geom.pipR * 1.6) estBlobs += merged[i].k;
    }
  }
  var totalPipArea = 0;
  for (i = 0; i < pipSet.pts.length; i++) totalPipArea += pipSet.pts[i].area;
  var estArea = Math.round(totalPipArea / geom.pipArea);
  var estSpan = pipSet.pts.length >= 2
    ? Math.round(pipSet.span / geom.pipSpacing) + 1 : pipSet.pts.length;

  var votes = {};
  [estBlobs, estArea, estSpan].forEach(function (v) {
    if (v >= 1 && v <= 5) votes[v] = (votes[v] || 0) + 1;
  });
  var pips = estBlobs, bestVotes = -1, key;
  for (key in votes) {
    if (votes[key] > bestVotes || (votes[key] === bestVotes && +key === estBlobs)) {
      bestVotes = votes[key]; pips = +key;
    }
  }
  pips = clamp(pips, 1, 5);
  res.pips = pips;
  res.pipEstimates = { blobs: estBlobs, area: estArea, span: estSpan };
  res.pipConfidence = clamp(0.30 + 0.24 * bestVotes +
                            (pipsFromBlobs === pips ? 0.15 : -0.05) -
                            (merged.length ? 0.08 : 0), 0.05, 0.97);

  /* ---- rotation ---------------------------------------------------------- */
  var numeralMask = new Uint8Array(n * n), nComps = 0, numeralArea = 0;
  var pipIds = {};
  for (i = 0; i < pipSet.pts.length; i++) pipIds[pipSet.pts[i].id] = 1;
  var numeralComps = [];
  for (i = 0; i < comps.length; i++) {
    if (pipIds[comps[i].id]) continue;
    if (merged.some(function (m) { return m.comp.id === comps[i].id; }) &&
        pipSet.line &&
        pointLineDist(pipSet.line, comps[i].cx, comps[i].cy) < geom.pipR * 1.6) continue;
    if (comps[i].area < geom.pipArea * 1.2) continue;
    numeralComps.push(comps[i]);
  }
  var ncx = 0, ncy = 0;
  for (i = 0; i < numeralComps.length; i++) {
    ncx += numeralComps[i].cx * numeralComps[i].area;
    ncy += numeralComps[i].cy * numeralComps[i].area;
    numeralArea += numeralComps[i].area;
  }
  if (numeralArea > 0) { ncx /= numeralArea; ncy /= numeralArea; }
  res.numeralComps = numeralComps.length;

  var pcx = 0, pcy = 0;
  if (pipSet.pts.length) {
    for (i = 0; i < pipSet.pts.length; i++) { pcx += pipSet.pts[i].cx; pcy += pipSet.pts[i].cy; }
    pcx /= pipSet.pts.length; pcy /= pipSet.pts.length;
  }

  /* "down" in token space = numeral centroid -> pip centroid */
  var downAng = null;
  if (pipSet.pts.length && numeralArea > 0) {
    downAng = Math.atan2(pcy - ncy, pcx - ncx);
  }
  var rot;
  if (pipSet.pts.length >= 2 && pipSet.line) {
    /* the pip row is horizontal in token space; its direction gives rotation */
    var la = Math.atan2(pipSet.line.dy, pipSet.line.dx);
    /* pick the +-pi representative whose perpendicular points the same way as
     * downAng (this resolves the 180 degree ambiguity) */
    var cand = [la, la + Math.PI], bestA = la;
    if (downAng != null) {
      var bd = Infinity;
      for (i = 0; i < 2; i++) {
        var perp = cand[i] + Math.PI / 2;
        var dd = Math.abs(angDiff(perp, downAng));
        if (dd < bd) { bd = dd; bestA = cand[i]; }
      }
    }
    rot = bestA;
  } else if (downAng != null) {
    rot = downAng - Math.PI / 2;
  } else {
    rot = 0;
    res.notes.push('rotation could not be determined');
  }
  res.rotationDeg = ((rot * 180 / Math.PI) % 360 + 360) % 360;

  /* ---- ink colour -------------------------------------------------------- */
  var inkH = [], inkS = [], inkV = [];
  for (i = 0; i < numeralComps.length; i++) {
    var c3 = numeralComps[i];
    for (j = c3.miny; j <= c3.maxy; j++) {
      for (var ii = c3.minx; ii <= c3.maxx; ii++) {
        if (cc.labels[j * n + ii] !== c3.id) continue;
        var oo = (j * n + ii) * 4;
        rgb2hsv(d[oo], d[oo + 1], d[oo + 2], hsv);
        inkH.push(hsv[0]); inkS.push(hsv[1]); inkV.push(hsv[2]);
      }
    }
  }
  if (inkS.length) {
    var mS = median(inkS), mH = circularMedian(inkH);
    var isRedInk = mS > 0.33 && (mH < 28 || mH > 335);
    res.ink = isRedInk ? 'red' : 'black';
    res.inkStat = { h: mH, s: mS, v: median(inkV) };
  }

  /* ---- topology of the numeral ------------------------------------------ */
  var minHole = Math.max(6, geom.pipArea * 0.28);
  var holesTotal = 0, holeAreas = [];
  for (i = 0; i < numeralComps.length; i++) {
    var hh = countHoles(cc, numeralComps[i], minHole);
    holesTotal += hh.count;
    holeAreas = holeAreas.concat(hh.areas);
  }
  res.holes = holesTotal;
  res.holeAreas = holeAreas;

  /* ---- derotated, size-normalised numeral crop -------------------------- */
  var norm = normaliseNumeral(cc, numeralComps, n, rot);
  res.numeralAspect = norm.aspect;
  res.normMask = norm.mask;

  /* ---- decide between the two candidates -------------------------------- */
  var cands = PIP_CANDIDATES[pips] || [null, null];
  res.candidates = cands.slice();
  var decision = decideNumber(cands, res, geom, norm);
  res.number = decision.number;
  res.numberConfidence = decision.confidence;
  res.decision = decision;

  /* ---- red/black cross-check -------------------------------------------- */
  if (res.ink !== 'none' && res.number != null) {
    var shouldBeRed = !!RED_NUMBERS[res.number];
    var isRed = res.ink === 'red';
    if (shouldBeRed !== isRed) {
      res.inkConflict = true;
      res.notes.push('ink colour (' + res.ink + ') disagrees with the number ' + res.number);
      res.numberConfidence *= 0.45;
      res.pipConfidence *= 0.7;
    }
    /* red ink is strong evidence for 5 pips */
    if (isRed && pips !== 5) {
      res.inkConflict = true;
      res.notes.push('red ink implies 6 or 8 (5 pips) but ' + pips + ' pips were counted');
      res.pipConfidence *= 0.5;
    }
    if (!isRed && pips === 5) {
      res.inkConflict = true;
      res.notes.push('5 pips implies 6 or 8 (red) but the ink looks black');
      res.pipConfidence *= 0.5;
    }
  }

  res.mask = mask;
  res.cc = cc;
  return res;
}

function angDiff(a, b) {
  var d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function pointLineDist(line, x, y) {
  return Math.abs((x - line.x) * line.dy - (y - line.y) * line.dx);
}

/* Largest collinear, evenly spaced subset of pip candidates. */
function bestCollinearSet(cands, geom) {
  var n = cands.length, i, j, k;
  if (n === 0) return { pts: [], line: null, span: 0 };
  if (n === 1) return { pts: [cands[0]], line: null, span: 0 };

  var tol = Math.max(1.6, geom.pipR * 1.1);
  var best = null;
  for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
    var dx = cands[j].cx - cands[i].cx, dy = cands[j].cy - cands[i].cy;
    var L = Math.sqrt(dx * dx + dy * dy);
    if (L < 1e-6 || L > geom.pipSpacing * 5.2) continue;
    dx /= L; dy /= L;
    var line = { x: cands[i].cx, y: cands[i].cy, dx: dx, dy: dy };
    var inl = [], areas = [];
    for (k = 0; k < n; k++) {
      if (pointLineDist(line, cands[k].cx, cands[k].cy) <= tol) {
        inl.push(cands[k]); areas.push(cands[k].area);
      }
    }
    if (inl.length < 2) continue;
    /* projections along the line, check even spacing */
    var proj = inl.map(function (c) {
      return (c.cx - line.x) * dx + (c.cy - line.y) * dy;
    }).sort(function (a, b) { return a - b; });
    var span = proj[proj.length - 1] - proj[0];
    if (span > geom.pipSpacing * 5.2) continue;
    var gaps = [], ok = true;
    for (k = 1; k < proj.length; k++) gaps.push(proj[k] - proj[k - 1]);
    var mg = median(gaps);
    for (k = 0; k < gaps.length; k++) {
      if (mg > 1e-6 && (gaps[k] < mg * 0.45 || gaps[k] > mg * 2.4)) ok = false;
    }
    var medArea = median(areas), areaOk = true;
    for (k = 0; k < areas.length; k++) {
      if (areas[k] < medArea * 0.35 || areas[k] > medArea * 3.0) areaOk = false;
    }
    var score = inl.length * 10 + (ok ? 3 : 0) + (areaOk ? 2 : 0) - span / geom.pipSpacing * 0.1;
    if (!best || score > best.score) {
      best = { pts: inl, line: line, span: span, score: score };
    }
  }
  if (!best) {
    /* fall back to the single largest candidate */
    var pick = cands.slice().sort(function (a, b) { return b.area - a.area; })[0];
    return { pts: [pick], line: null, span: 0 };
  }
  return best;
}

/* Derotate the numeral mask and normalise it into a TPL_N x TPL_N bitmap. */
function normaliseNumeral(cc, numeralComps, n, rot) {
  var i, j;
  if (!numeralComps.length) return { mask: new Uint8Array(TPL_N * TPL_N), aspect: 1, ok: false };
  var ca = Math.cos(-rot), sa = Math.sin(-rot);
  var cx = n / 2, cy = n / 2;
  var pts = [];
  var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (i = 0; i < numeralComps.length; i++) {
    var c = numeralComps[i];
    for (j = c.miny; j <= c.maxy; j++) {
      for (var ii = c.minx; ii <= c.maxx; ii++) {
        if (cc.labels[j * n + ii] !== c.id) continue;
        var dx = ii + 0.5 - cx, dy = j + 0.5 - cy;
        var rx = dx * ca - dy * sa, ry = dx * sa + dy * ca;
        pts.push(rx); pts.push(ry);
        if (rx < minx) minx = rx; if (rx > maxx) maxx = rx;
        if (ry < miny) miny = ry; if (ry > maxy) maxy = ry;
      }
    }
  }
  var bw = Math.max(1e-6, maxx - minx), bh = Math.max(1e-6, maxy - miny);
  var mask = new Uint8Array(TPL_N * TPL_N);
  for (i = 0; i < pts.length; i += 2) {
    var u = Math.floor((pts[i] - minx) / bw * (TPL_N - 1e-6));
    var v = Math.floor((pts[i + 1] - miny) / bh * (TPL_N - 1e-6));
    mask[clamp(v, 0, TPL_N - 1) * TPL_N + clamp(u, 0, TPL_N - 1)] = 1;
  }
  return { mask: mask, aspect: bw / bh, ok: true, bw: bw, bh: bh };
}

function maskIoU(a, b) {
  var i, inter = 0, uni = 0;
  for (i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) uni++;
  }
  return uni ? inter / uni : 0;
}

/* 4x4 zoning density distance. */
function zoningDist(a, b) {
  var za = new Float64Array(16), zb = new Float64Array(16), i, j;
  for (j = 0; j < TPL_N; j++) for (i = 0; i < TPL_N; i++) {
    var z = (Math.floor(j * 4 / TPL_N)) * 4 + Math.floor(i * 4 / TPL_N);
    za[z] += a[j * TPL_N + i]; zb[z] += b[j * TPL_N + i];
  }
  var cell = (TPL_N / 4) * (TPL_N / 4), s = 0;
  for (i = 0; i < 16; i++) {
    var d = (za[i] - zb[i]) / cell;
    s += d * d;
  }
  return Math.sqrt(s / 16);
}

/* Binary choice between the two candidates allowed by the pip count. */
function decideNumber(cands, res, geom, norm) {
  if (!cands || cands[0] == null) {
    return { number: null, confidence: 0, reasons: ['no candidates'] };
  }
  var a = cands[0], b = cands[1], reasons = [];
  var scoreA = 0, scoreB = 0;

  /* --- 1. digit-count test (solves 2v12, 3v11, 4v10 without any rotation) */
  var ta = NUM_TOPOLOGY[a], tb = NUM_TOPOLOGY[b];
  if (ta.comps !== tb.comps) {
    var obs = res.numeralComps;
    var wComp = 2.4;
    scoreA += (obs === ta.comps ? wComp : 0);
    scoreB += (obs === tb.comps ? wComp : 0);
    reasons.push('numeral component count = ' + obs);
    /* width backs it up: two-digit numbers are far wider than one digit */
    if (norm.ok && res.numeralAspect != null) {
      var asp = res.numeralAspect;
      var expA = TEMPLATES[a] ? TEMPLATES[a].aspect : 1;
      var expB = TEMPLATES[b] ? TEMPLATES[b].aspect : 1;
      var dA = Math.abs(asp - expA), dB = Math.abs(asp - expB);
      var wA = 1.6 * clamp(1 - dA / 0.5, 0, 1), wB = 1.6 * clamp(1 - dB / 0.5, 0, 1);
      scoreA += wA; scoreB += wB;
      reasons.push('numeral aspect ' + asp.toFixed(2) +
                   ' (expect ' + expA.toFixed(2) + ' / ' + expB.toFixed(2) + ')');
    }
  }

  /* --- 2. hole count: rotation invariant, and it is exactly what separates
   *        5 (0 holes) from 9 (1 hole) and 6 (1 hole) from 8 (2 holes).    */
  if (ta.holes !== tb.holes) {
    var h = res.holes;
    var wHole = 2.6;
    if (h === ta.holes) scoreA += wHole;
    else if (h === tb.holes) scoreB += wHole;
    else {
      /* neither matched: partial credit to the nearer one */
      scoreA += wHole * 0.4 * clamp(1 - Math.abs(h - ta.holes), 0, 1);
      scoreB += wHole * 0.4 * clamp(1 - Math.abs(h - tb.holes), 0, 1);
    }
    reasons.push('hole count = ' + h + ' (expect ' + ta.holes + ' / ' + tb.holes + ')');
  }

  /* --- 3. derotated template correlation (cross-check) ------------------- */
  if (norm.ok) {
    var iouA = TEMPLATES[a] ? maskIoU(norm.mask, TEMPLATES[a].mask) : 0;
    var iouB = TEMPLATES[b] ? maskIoU(norm.mask, TEMPLATES[b].mask) : 0;
    var znA = TEMPLATES[a] ? zoningDist(norm.mask, TEMPLATES[a].mask) : 1;
    var znB = TEMPLATES[b] ? zoningDist(norm.mask, TEMPLATES[b].mask) : 1;
    var tA = 2.0 * iouA + 1.0 * (1 - clamp(znA, 0, 1));
    var tB = 2.0 * iouB + 1.0 * (1 - clamp(znB, 0, 1));
    scoreA += tA; scoreB += tB;
    reasons.push('template IoU ' + iouA.toFixed(2) + ' / ' + iouB.toFixed(2));
  }

  /* --- 4. ink colour, when it discriminates (6/8 are red, nothing else) -- */
  if (res.ink !== 'none') {
    var ra = !!RED_NUMBERS[a], rb = !!RED_NUMBERS[b];
    if (ra !== rb) {
      var obsRed = res.ink === 'red';
      scoreA += (obsRed === ra) ? 1.5 : 0;
      scoreB += (obsRed === rb) ? 1.5 : 0;
      reasons.push('ink is ' + res.ink);
    }
  }

  var num = scoreA >= scoreB ? a : b;
  var hi = Math.max(scoreA, scoreB), lo = Math.min(scoreA, scoreB);
  var conf = clamp((hi - lo) / (hi + lo + 0.9) * 1.7, 0.03, 0.97);
  return { number: num, confidence: conf, scoreA: scoreA, scoreB: scoreB,
           reasons: reasons };
}

/* ===========================================================================
 * Stage 4 -- constrained assignment against the canonical multisets
 * ========================================================================= */

/* Greedy + 2-opt minimum-cost assignment of n items to n slots.
 * cost[i * n + s].  Returns Int32Array of slot index per item. */
function assign(cost, n) {
  var order = [], i, s;
  for (i = 0; i < n; i++) {
    var bestC = Infinity, secC = Infinity;
    for (s = 0; s < n; s++) {
      var c = cost[i * n + s];
      if (c < bestC) { secC = bestC; bestC = c; }
      else if (c < secC) secC = c;
    }
    order.push({ i: i, regret: secC - bestC });
  }
  order.sort(function (a, b) { return b.regret - a.regret; });

  var used = new Uint8Array(n), out = new Int32Array(n).fill(-1);
  for (var k = 0; k < order.length; k++) {
    var it = order[k].i, bs = -1, bc = Infinity;
    for (s = 0; s < n; s++) {
      if (used[s]) continue;
      if (cost[it * n + s] < bc) { bc = cost[it * n + s]; bs = s; }
    }
    out[it] = bs; used[bs] = 1;
  }
  /* 2-opt improvement until stable */
  var improved = true, guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
      var si = out[i], sj = out[j];
      var before = cost[i * n + si] + cost[j * n + sj];
      var after = cost[i * n + sj] + cost[j * n + si];
      if (after < before - 1e-9) { out[i] = sj; out[j] = si; improved = true; }
    }
  }
  return out;
}

/* ===========================================================================
 * Stage 5 -- validation
 * ========================================================================= */

function validateBoard(board) {
  var problems = [], i;
  if (!board || !board.hexes || board.hexes.length !== 19) {
    return { ok: false, problems: [{ code: 'hex-count',
      message: 'expected 19 hexes, got ' + (board && board.hexes ? board.hexes.length : 0),
      hexIds: [] }] };
  }
  var counts = {}, byType = {};
  for (i = 0; i < 19; i++) {
    var t = board.hexes[i].type;
    counts[t] = (counts[t] || 0) + 1;
    (byType[t] = byType[t] || []).push(i);
  }
  for (var t2 in RESOURCE_COUNTS) {
    var want = RESOURCE_COUNTS[t2], got = counts[t2] || 0;
    if (got !== want) {
      problems.push({ code: 'resource-count',
        message: 'expected ' + want + ' ' + t2 + ' hex(es), detected ' + got,
        hexIds: byType[t2] || [] });
    }
  }
  for (var t3 in counts) {
    if (!(t3 in RESOURCE_COUNTS)) {
      problems.push({ code: 'unknown-type', message: 'unknown hex type "' + t3 + '"',
        hexIds: byType[t3] });
    }
  }

  var tokens = [], tokenHexes = {};
  for (i = 0; i < 19; i++) {
    var hx = board.hexes[i];
    if (hx.type === 'desert') {
      if (hx.number != null) {
        problems.push({ code: 'desert-token',
          message: 'the desert (hex ' + i + ') must not carry a number token',
          hexIds: [i] });
      }
    } else if (hx.number == null) {
      problems.push({ code: 'missing-token',
        message: 'hex ' + i + ' is ' + hx.type + ' but no number token was read',
        hexIds: [i] });
    } else {
      tokens.push(hx.number);
      (tokenHexes[hx.number] = tokenHexes[hx.number] || []).push(i);
    }
  }
  var want = {}, gotc = {}, k;
  for (i = 0; i < TOKEN_MULTISET.length; i++) want[TOKEN_MULTISET[i]] = (want[TOKEN_MULTISET[i]] || 0) + 1;
  for (i = 0; i < tokens.length; i++) gotc[tokens[i]] = (gotc[tokens[i]] || 0) + 1;
  for (k in want) {
    var g = gotc[k] || 0;
    if (g !== want[k]) {
      problems.push({ code: 'token-count',
        message: 'expected ' + want[k] + ' x "' + k + '" token(s), detected ' + g,
        hexIds: tokenHexes[k] || [] });
    }
  }
  for (k in gotc) {
    if (!(k in want)) {
      problems.push({ code: 'illegal-token',
        message: '"' + k + '" is not a legal Catan number token',
        hexIds: tokenHexes[k] });
    }
  }

  if (board.ports) {
    if (board.ports.length !== 9) {
      problems.push({ code: 'port-count',
        message: 'expected 9 ports, got ' + board.ports.length, hexIds: [] });
    } else {
      var generic = 0, spec = {};
      for (i = 0; i < 9; i++) {
        if (board.ports[i].kind === '3:1') generic++;
        else spec[board.ports[i].resource] = (spec[board.ports[i].resource] || 0) + 1;
      }
      if (generic !== 4) {
        problems.push({ code: 'port-generic-count',
          message: 'expected 4 generic 3:1 ports, got ' + generic, hexIds: [] });
      }
      ['lumber', 'brick', 'wool', 'grain', 'ore'].forEach(function (r) {
        if ((spec[r] || 0) !== 1) {
          problems.push({ code: 'port-resource-count',
            message: 'expected exactly one 2:1 ' + r + ' port, got ' + (spec[r] || 0),
            hexIds: [] });
        }
      });
    }
  }

  return { ok: problems.length === 0, problems: problems };
}

/* ===========================================================================
 * Stage 6 -- ports (best effort, always low confidence)
 * ========================================================================= */

var PORT_HUES = { lumber: 127, brick: 20, wool: 76, grain: 46, ore: 0 };

function readPorts(img, cal, wb, opts) {
  var rgb = [0, 0, 0], wbc = [0, 0, 0], hsv = [0, 0, 0];
  var slotPos = getPortSlots();
  var slots = [], i, ri, ai;
  for (i = 0; i < 9; i++) {
    var px = slotPos[i][0], py = slotPos[i][1];
    var hs = [], ss = [], vs = [], off = 0, tot = 0;
    for (ri = 0; ri < 4; ri++) {
      var rad = 0.08 + ri * 0.085;
      for (ai = 0; ai < 20; ai++) {
        var a = ai / 20 * 2 * Math.PI + ri * 0.17;
        var p = cal.homography.apply(px + rad * Math.cos(a), py + rad * Math.sin(a));
        tot++;
        if (!sampleBilinear(img, p[0], p[1], rgb)) { off++; continue; }
        applyWB(wb, rgb, wbc);
        rgb2hsv(wbc[0], wbc[1], wbc[2], hsv);
        hs.push(hsv[0]); ss.push(hsv[1]); vs.push(hsv[2]);
      }
    }
    if (!hs.length) { slots.push(null); continue; }
    slots.push({ h: circularMedian(hs), s: median(ss), v: median(vs),
                 offFrame: off / tot });
  }

  /* cost of assigning each slot to each of the 9 canonical port entries */
  var n = 9, cost = new Float64Array(n * n);
  for (i = 0; i < n; i++) {
    for (var s = 0; s < n; s++) {
      var entry = PORT_MULTISET[s], st = slots[i], c;
      if (!st) { cost[i * n + s] = 1; continue; }
      if (entry.kind === '3:1') {
        /* generic harbours carry no single dominant resource colour */
        c = 1.2 * clamp(st.s, 0, 1);
      } else {
        var dh = hueDiff(st.h, PORT_HUES[entry.resource]) / 45;
        var trust = clamp(st.s / 0.25, 0, 1);
        c = trust * dh * dh + 0.8 * (1 - trust);
      }
      cost[i * n + s] = c + (st.offFrame > 0.3 ? 0.5 : 0);
    }
  }
  var asg = assign(cost, n);
  var ports = [], totalCost = 0;
  for (i = 0; i < n; i++) {
    var e = PORT_MULTISET[asg[i]];
    totalCost += cost[i * n + asg[i]];
    ports.push({ id: i, kind: e.kind, resource: e.resource });
  }
  return {
    ports: ports,
    samples: slots,
    confidence: 'low',
    meanCost: totalCost / n,
    slotSource: _portSlotSource,
    note: 'Port slots are located from catan-geometry.js when it is loaded (else 9 ' +
          'evenly spaced sea-frame positions) and are classified by dominant hue ' +
          'only. Treat EVERY port as needing user confirmation.'
  };
}

/* ===========================================================================
 * Stage 7 -- the whole pipeline
 * ========================================================================= */

function analyzeBoard(image, opts) {
  opts = opts || {};
  var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  var img = toImageData(image);
  if (!img) return { ok: false, error: 'could not read the image (expected ImageData, canvas or image)' };

  var cal = opts.calibration;
  if (!cal) {
    if (!opts.corners) return { ok: false, error: 'opts.corners (4 or 6 image points) is required' };
    cal = buildCalibration(opts.corners, opts);
  }
  if (!cal.ok) return { ok: false, error: cal.error, calibration: cal };

  var wb = (opts.whiteBalance === false)
    ? { gain: [1, 1, 1], exposure: 1, samples: 0, ok: false, disabled: true }
    : computeWhiteBalance(img, cal, opts);

  var geom = tokenGeom();
  var debug = !!opts.debug;
  var enforce = opts.enforceCounts !== false;

  var hexes = [], i, s;

  /* --- per hex: ring colour + token ------------------------------------- */
  for (i = 0; i < 19; i++) {
    var st = sampleHexRing(img, cal, wb, i);
    var costs = typeCosts(st);
    var rawType = null, bestC = Infinity;
    for (var ti = 0; ti < TYPES.length; ti++) {
      if (costs[TYPES[ti]] < bestC) { bestC = costs[TYPES[ti]]; rawType = TYPES[ti]; }
    }
    var hx = LAYOUT_HEXES[i];
    var crop = warpPatch(img, cal.homography, wb, hx.x, hx.y, CROP_HALF, CROP_PX);
    var tok = analyseToken(crop, geom);

    hexes.push({
      id: i, row: hx.row, col: hx.col,
      centre: cal.hexCentres[i],
      hsv: { h: st.h, s: st.s, v: st.v },
      hsvSpread: { hue: st.hSpread, s: st.sMad, v: st.vMad, offFrame: st.offFrame },
      typeCosts: costs,
      rawType: rawType,
      rawTypeConfidence: costsToConfidence(costs, st),
      token: tok,
      _crop: crop
    });
  }

  /* --- resource assignment under the exact 4/3/4/4/3/1 constraint -------- */
  var slotTypes = [];
  for (var t in RESOURCE_COUNTS) {
    for (s = 0; s < RESOURCE_COUNTS[t]; s++) slotTypes.push(t);
  }
  var n = 19, cost = new Float64Array(n * n);
  for (i = 0; i < n; i++) {
    for (s = 0; s < n; s++) {
      var ty = slotTypes[s];
      var c = hexes[i].typeCosts[ty];
      if (ty === 'desert') {
        /* absence of a token is independent, strong evidence for the desert */
        c += hexes[i].token.present ? 2.2 : -1.6;
      } else {
        c += hexes[i].token.present ? -0.25 : 0.9;
      }
      cost[i * n + s] = c;
    }
  }
  var asg = assign(cost, n);
  for (i = 0; i < n; i++) {
    hexes[i].type = enforce ? slotTypes[asg[i]] : hexes[i].rawType;
    hexes[i].typeConfidence = hexes[i].rawTypeConfidence;
    if (enforce && hexes[i].type !== hexes[i].rawType) {
      hexes[i].typeConfidence *= 0.55;
      hexes[i].typeCorrected = true;
    }
  }

  /* --- number assignment under the exact 18-token multiset --------------- */
  var live = [];
  for (i = 0; i < 19; i++) if (hexes[i].type !== 'desert') live.push(i);

  if (enforce && live.length === 18) {
    var m = 18, ncost = new Float64Array(m * m);
    for (var a = 0; a < m; a++) {
      var hxi = live[a], tk = hexes[hxi].token;
      for (var b = 0; b < m; b++) {
        var num = TOKEN_MULTISET[b];
        var wantPips = PIP_VALUE[num], c2 = 0;
        if (!tk.present || tk.pips == null) {
          c2 = 1.4;                                   /* no evidence at all */
        } else {
          var dp = Math.abs(tk.pips - wantPips);
          c2 += (dp === 0 ? 0 : (1.2 + 0.7 * dp)) * (0.35 + 0.65 * tk.pipConfidence);
          /* which of the two same-pip candidates */
          if (tk.number != null) {
            if (tk.number === num) c2 -= 0.55 * tk.numberConfidence;
            else if (PIP_VALUE[num] === tk.pips) c2 += 0.55 * tk.numberConfidence;
          }
          /* ink colour is an independent vote on redness */
          if (tk.ink !== 'none') {
            var wantRed = !!RED_NUMBERS[num], isRed = tk.ink === 'red';
            if (wantRed !== isRed) c2 += 0.45;
          }
        }
        ncost[a * m + b] = c2;
      }
    }
    var nasg = assign(ncost, m);
    for (a = 0; a < m; a++) {
      var hh = hexes[live[a]];
      var chosen = TOKEN_MULTISET[nasg[a]];
      hh.rawNumber = hh.token.present ? hh.token.number : null;
      hh.number = chosen;
      hh.numberConfidence = hh.token.present ? hh.token.numberConfidence : 0.05;
      if (hh.rawNumber != null && hh.rawNumber !== chosen) {
        hh.numberCorrected = true;
        hh.numberConfidence *= 0.5;
      }
      if (!hh.token.present) {
        hh.numberCorrected = true;
        hh.numberConfidence = 0.05;
      }
      hh.pips = PIP_VALUE[chosen];
      hh.rawPips = hh.token.present ? hh.token.pips : null;
      hh.pipConfidence = hh.token.present ? hh.token.pipConfidence : 0.05;
    }
  } else {
    for (i = 0; i < 19; i++) {
      var h2 = hexes[i];
      if (h2.type === 'desert') { h2.number = null; h2.pips = 0; }
      else {
        h2.rawNumber = h2.token.present ? h2.token.number : null;
        h2.number = h2.rawNumber;
        h2.pips = h2.token.pips;
        h2.rawPips = h2.token.pips;
        h2.numberConfidence = h2.token.numberConfidence;
        h2.pipConfidence = h2.token.pipConfidence;
      }
    }
  }
  for (i = 0; i < 19; i++) {
    if (hexes[i].type === 'desert') {
      hexes[i].number = null; hexes[i].pips = 0;
      hexes[i].numberConfidence = hexes[i].token.present ? 0.2 : 0.9;
      hexes[i].pipConfidence = hexes[i].numberConfidence;
    }
  }

  /* --- ports ------------------------------------------------------------ */
  var portRes = opts.ports === false ? null : readPorts(img, cal, wb, opts);

  /* --- output board ----------------------------------------------------- */
  var board = { hexes: [], ports: portRes ? portRes.ports : PORT_MULTISET.map(function (p, k) {
    return { id: k, kind: p.kind, resource: p.resource };
  }) };
  for (i = 0; i < 19; i++) {
    board.hexes.push({ id: i, type: hexes[i].type, number: hexes[i].number });
  }

  var rawBoard = { hexes: [], ports: board.ports };
  for (i = 0; i < 19; i++) {
    rawBoard.hexes.push({ id: i, type: hexes[i].rawType,
      number: hexes[i].rawType === 'desert' ? null
              : (hexes[i].token.present ? hexes[i].token.number : null) });
  }

  /* --- confidences and review list -------------------------------------- */
  var review = [];
  for (i = 0; i < 19; i++) {
    var hh2 = hexes[i];
    var conf = Math.min(hh2.typeConfidence,
      hh2.type === 'desert' ? hh2.numberConfidence : Math.min(hh2.pipConfidence, hh2.numberConfidence));
    hh2.confidence = conf;
    var reasons = [];
    if (hh2.typeConfidence < 0.35) reasons.push('resource colour is ambiguous');
    if (hh2.typeCorrected) reasons.push('resource was changed to satisfy the 4/3/4/4/3/1 counts');
    if (hh2.type !== 'desert' && !hh2.token.present) reasons.push('no number token was found');
    if (hh2.type === 'desert' && hh2.token.present) reasons.push('classified desert but a token was seen');
    if (hh2.token.inkConflict) reasons.push('ink colour conflicts with the reading');
    if (hh2.numberCorrected) reasons.push('number was changed to satisfy the legal token multiset');
    if (hh2.type !== 'desert' && hh2.pipConfidence < 0.45) reasons.push('pip count is uncertain');
    if (hh2.type !== 'desert' && hh2.numberConfidence < 0.35) reasons.push('the two same-pip candidates are hard to separate');
    if (hh2.token.notes && hh2.token.notes.length) reasons = reasons.concat(hh2.token.notes);
    if (reasons.length || conf < 0.45) {
      review.push({ hexId: i, confidence: conf, reasons: reasons });
    }
  }
  review.sort(function (a, b) { return a.confidence - b.confidence; });

  var validation = validateBoard(board);
  /* attach the lowest-confidence culprits to each problem */
  for (i = 0; i < validation.problems.length; i++) {
    var pr = validation.problems[i];
    var ids = (pr.hexIds || []).slice();
    ids.sort(function (x, y) { return hexes[x].confidence - hexes[y].confidence; });
    pr.likelyCulprits = ids.slice(0, 3);
    if (pr.likelyCulprits.length) {
      pr.message += '; lowest-confidence hexes here are ' +
        pr.likelyCulprits.map(function (x) {
          return x + ' (' + (hexes[x].confidence * 100).toFixed(0) + '%)';
        }).join(', ');
    }
  }

  var out = {
    ok: true,
    version: VERSION,
    board: board,
    rawBoard: rawBoard,
    enforcedCounts: enforce,
    hexes: hexes.map(function (h) {
      return {
        id: h.id, row: h.row, col: h.col, centre: h.centre,
        type: h.type, rawType: h.rawType,
        typeConfidence: h.typeConfidence, typeCorrected: !!h.typeCorrected,
        typeCosts: h.typeCosts,
        hsv: h.hsv, hsvSpread: h.hsvSpread,
        hasToken: h.token.present, tokenPresenceScore: h.token.presenceScore,
        pips: h.pips, rawPips: h.rawPips, pipConfidence: h.pipConfidence,
        pipEstimates: h.token.pipEstimates || null,
        number: h.number, rawNumber: h.rawNumber,
        numberConfidence: h.numberConfidence, numberCorrected: !!h.numberCorrected,
        candidates: h.token.candidates,
        ink: h.token.ink, inkConflict: h.token.inkConflict,
        numeralComps: h.token.numeralComps, holes: h.token.holes,
        rotationDeg: h.token.rotationDeg,
        decision: h.token.decision || null,
        confidence: h.confidence,
        notes: h.token.notes || []
      };
    }),
    review: review,
    validation: validation,
    calibration: {
      mode: cal.mode, corners: cal.corners, homography: Array.prototype.slice.call(cal.homography.m),
      residualPx: cal.residualPx, meanScalePx: cal.meanScalePx,
      mirroredFix: cal.mirroredFix, warnings: cal.warnings,
      source: opts.cornerSource || 'manual'
    },
    whiteBalance: wb,
    ports: portRes,
    needsCornerConfirmation: (opts.cornerSource === 'auto')
  };

  if (debug) {
    out.debug = {
      rectified: rectify(img, cal, opts.rectifyWidth || 600, 0, wb),
      hexCrops: hexes.map(function (h) {
        return { id: h.id, width: h._crop.width, height: h._crop.height,
                 data: h._crop.data, inkMask: h.token.mask || null,
                 normalisedNumeral: h.token.normMask || null,
                 normalisedSize: TPL_N };
      }),
      pipBlobs: hexes.map(function (h) { return { id: h.id, blobs: h.token.blobs }; }),
      hueSamples: hexes.map(function (h) {
        return { id: h.id, h: h.hsv.h, s: h.hsv.s, v: h.hsv.v,
                 spread: h.hsvSpread, type: h.type, costs: h.typeCosts };
      }),
      templates: TEMPLATES,
      tokenGeometry: geom
    };
  }

  var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  out.elapsedMs = t1 - t0;
  return out;
}

/* ===========================================================================
 * Stage 8 -- best-effort corner proposal
 *
 * This PROPOSES corners; it never commits to them.  The caller must show the
 * proposal to the user for confirmation (analyzeBoard sets
 * needsCornerConfirmation when cornerSource is 'auto').  If the proposal does
 * not verify, ok is false and the caller must fall back to manual taps.
 * ========================================================================= */

function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  var p = pts.slice().sort(function (a, b) {
    return a[0] - b[0] || a[1] - b[1];
  });
  function cross(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }
  var lo = [], hi = [], i;
  for (i = 0; i < p.length; i++) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p[i]) <= 0) lo.pop();
    lo.push(p[i]);
  }
  for (i = p.length - 1; i >= 0; i--) {
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p[i]) <= 0) hi.pop();
    hi.push(p[i]);
  }
  lo.pop(); hi.pop();
  return lo.concat(hi);
}

function downscale(img, maxDim) {
  var f = Math.max(1, Math.ceil(Math.max(img.width, img.height) / maxDim));
  var w = Math.max(1, Math.floor(img.width / f)), h = Math.max(1, Math.floor(img.height / f));
  var out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), factor: f };
  var i, j, dx, dy;
  for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
    var r = 0, g = 0, b = 0, n = 0;
    for (dy = 0; dy < f; dy++) for (dx = 0; dx < f; dx++) {
      var sx = i * f + dx, sy = j * f + dy;
      if (sx >= img.width || sy >= img.height) continue;
      var o = (sy * img.width + sx) * 4;
      r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++;
    }
    var q = (j * w + i) * 4;
    out.data[q] = r / n; out.data[q + 1] = g / n; out.data[q + 2] = b / n; out.data[q + 3] = 255;
  }
  return out;
}

function autoDetectCorners(image, opts) {
  opts = opts || {};
  var img = toImageData(image);
  if (!img) return { ok: false, reason: 'could not read the image' };
  var small = downscale(img, opts.workDim || 320);
  var w = small.width, h = small.height, d = small.data, i, j;

  /* background estimate from the image border */
  var bh = [], bs = [], bv = [], hsv = [0, 0, 0];
  for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
    if (i > 3 && i < w - 4 && j > 3 && j < h - 4) continue;
    var o = (j * w + i) * 4;
    rgb2hsv(d[o], d[o + 1], d[o + 2], hsv);
    bh.push(hsv[0]); bs.push(hsv[1]); bv.push(hsv[2]);
  }
  var bgH = circularMedian(bh), bgS = median(bs), bgV = median(bv);

  var mask = new Uint8Array(w * h);
  for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
    var o2 = (j * w + i) * 4;
    rgb2hsv(d[o2], d[o2 + 1], d[o2 + 2], hsv);
    var dh = hueDiff(hsv[0], bgH) / 60 * Math.min(hsv[1], bgS) / 0.25;
    var ds = (hsv[1] - bgS) / 0.18, dv = (hsv[2] - bgV) / 0.22;
    var dist = Math.sqrt(dh * dh + ds * ds + dv * dv);
    mask[j * w + i] = (dist > 1.1 || hsv[1] > bgS + 0.18) ? 1 : 0;
  }
  var cc = connectedComponents(mask, w, h);
  if (!cc.comps.length) return { ok: false, reason: 'no board-like region found' };
  var big = cc.comps.slice().sort(function (a, b) { return b.area - a.area; })[0];
  if (big.area < 0.06 * w * h) {
    return { ok: false, reason: 'the largest coloured region is too small to be a board' };
  }

  var pts = [];
  for (j = big.miny; j <= big.maxy; j++) for (i = big.minx; i <= big.maxx; i++) {
    if (cc.labels[j * w + i] === big.id) pts.push([i, j]);
  }
  var hull = convexHull(pts);
  if (hull.length < 3) return { ok: false, reason: 'degenerate board region' };

  /* minimum-area enclosing hexagon: the 6 supporting lines of the field's
   * long sides.  Their intersections sit at board radius 4/cos(30deg). */
  var bestHex = null, k, step;
  for (step = 0; step < 120; step++) {
    var th = step * Math.PI / 360;   /* 0..30 deg covers all hexagon phases */
    var nrm = [], sup = [];
    for (k = 0; k < 6; k++) {
      var a = th + k * Math.PI / 3;
      nrm.push([Math.cos(a), Math.sin(a)]);
      var mx = -Infinity;
      for (i = 0; i < hull.length; i++) {
        var v = hull[i][0] * Math.cos(a) + hull[i][1] * Math.sin(a);
        if (v > mx) mx = v;
      }
      sup.push(mx);
    }
    var verts = [], ok = true;
    for (k = 0; k < 6; k++) {
      var n1 = nrm[k], n2 = nrm[(k + 1) % 6], d1 = sup[k], d2 = sup[(k + 1) % 6];
      var det = n1[0] * n2[1] - n1[1] * n2[0];
      if (Math.abs(det) < 1e-9) { ok = false; break; }
      verts.push([(d1 * n2[1] - d2 * n1[1]) / det, (n1[0] * d2 - n2[0] * d1) / det]);
    }
    if (!ok) continue;
    var area = Math.abs(polyArea(verts));
    if (!bestHex || area < bestHex.area) bestHex = { area: area, verts: verts, theta: th };
  }
  if (!bestHex) return { ok: false, reason: 'could not fit a hexagon to the board outline' };

  /* the hexagon vertices sit at board radius 4/cos(30) = 4.6188; our canonical
   * corners sit at 2.5*sqrt(3) = 4.3301.  Shrink about the centroid. */
  var cxs = 0, cys = 0;
  for (k = 0; k < 6; k++) { cxs += bestHex.verts[k][0]; cys += bestHex.verts[k][1]; }
  cxs /= 6; cys /= 6;
  var shrink = CORNER_RAD / (4 / Math.cos(Math.PI / 6));
  var corners = bestHex.verts.map(function (v) {
    return [(cxs + (v[0] - cxs) * shrink) * small.factor + (small.factor - 1) / 2,
            (cys + (v[1] - cys) * shrink) * small.factor + (small.factor - 1) / 2];
  });

  /* order them: sort by angle about the centroid, then choose the cyclic start
   * that puts the board closest to upright.  The land field is 6-fold
   * symmetric, so this choice CANNOT be made from shape alone -- it is a
   * heuristic and is flagged. */
  var ccx = 0, ccy = 0;
  for (k = 0; k < 6; k++) { ccx += corners[k][0]; ccy += corners[k][1]; }
  ccx /= 6; ccy /= 6;
  corners.sort(function (a, b) {
    return Math.atan2(a[1] - ccy, a[0] - ccx) - Math.atan2(b[1] - ccy, b[0] - ccx);
  });
  var canonAng = [240, 300, 0, 60, 120, 180];
  var bestStart = 0, bestErr = Infinity;
  for (var s0 = 0; s0 < 6; s0++) {
    var sum = 0;
    for (k = 0; k < 6; k++) {
      var c = corners[(s0 + k) % 6];
      var ang = Math.atan2(c[1] - ccy, c[0] - ccx) * 180 / Math.PI;
      var dd = ang - canonAng[k];
      while (dd > 180) dd -= 360;
      while (dd < -180) dd += 360;
      sum += dd;
    }
    var err = Math.abs(sum / 6);
    if (err < bestErr) { bestErr = err; bestStart = s0; }
  }
  corners = rotateCorners(corners, bestStart);

  /* ---- verify the proposal, and refine the radial scale ---------------- */
  var bestScore = null, bestCorners = corners, bestScaleK = 1;
  var scalesToTry = [0.90, 0.94, 0.97, 1.00, 1.03, 1.06, 1.10];
  for (var si = 0; si < scalesToTry.length; si++) {
    var kk = scalesToTry[si];
    var cand = corners.map(function (c) {
      return [ccx * small.factor + (c[0] - ccx * small.factor) * kk,
              ccy * small.factor + (c[1] - ccy * small.factor) * kk];
    });
    var sc = scoreCalibration(img, cand);
    if (!sc) continue;
    if (!bestScore || sc.score > bestScore.score) {
      bestScore = sc; bestCorners = cand; bestScaleK = kk;
    }
  }
  if (!bestScore) return { ok: false, reason: 'the hexagon fit did not verify against the image' };

  var conf = clamp((bestScore.tokens - 10) / 8 * 0.6 + bestScore.margin * 0.4, 0, 0.95);
  var okFlag = bestScore.tokens >= 14 && bestScore.margin > 0.25;

  return {
    ok: okFlag,
    proposal: true,
    corners: bestCorners,
    confidence: conf,
    verification: bestScore,
    scaleRefinement: bestScaleK,
    orientationAmbiguous: true,
    reason: okFlag ? 'proposal verified against the image'
      : 'proposal could not be verified (' + bestScore.tokens + '/18 tokens found); ' +
        'ask the user to tap the 6 corners',
    note: 'The land field is 6-fold symmetric, so which corner is "top-left" ' +
          'cannot be recovered from shape alone. If the board comes out rotated, ' +
          'call CatanVision.rotateCorners(corners, k) and re-analyse.'
  };
}

/* Cheap verification: how many of the 19 hex positions look like they carry a
 * token, and how decisive the colour classification is. */
function scoreCalibration(img, corners) {
  var cal = buildCalibration(corners, {});
  if (!cal.ok) return null;
  var wb = computeWhiteBalance(img, cal, {});
  var geom = tokenGeom(), tokens = 0, margin = 0, i;
  for (i = 0; i < 19; i++) {
    var hx = LAYOUT_HEXES[i];
    var crop = warpPatch(img, cal.homography, wb, hx.x, hx.y, CROP_HALF, 64);
    var g2 = { tokenR: 64 * TOKEN_R / (2 * CROP_HALF) };
    g2.pipR = 0.070 * g2.tokenR;
    g2.pipArea = Math.PI * g2.pipR * g2.pipR;
    g2.pipSpacing = 0.24 * g2.tokenR;
    var tk = analyseToken(crop, g2);
    if (tk.present) tokens++;
    var st = sampleHexRing(img, cal, wb, i);
    var costs = typeCosts(st);
    margin += (costs._second - costs._best) / (costs._second + costs._best + 0.6);
  }
  return { tokens: tokens, margin: margin / 19,
           score: tokens + margin / 19 * 6 };
}

/* ------------------------------------------------------------------ export */

root.CatanVision = {
  VERSION: VERSION,

  /* canonical data (read-only reference for the rest of the app) */
  CANON: {
    ROW_SIZES: ROW_SIZES,
    TYPES: TYPES,
    RESOURCE_COUNTS: RESOURCE_COUNTS,
    RESOURCE_OF: RESOURCE_OF,
    TOKEN_MULTISET: TOKEN_MULTISET,
    PIP_VALUE: PIP_VALUE,
    RED_NUMBERS: RED_NUMBERS,
    PIP_CANDIDATES: PIP_CANDIDATES,
    PORT_MULTISET: PORT_MULTISET
  },

  /* board-space geometry */
  LAYOUT: {
    hexes: LAYOUT_HEXES,
    corners: BOARD_CORNERS,
    get portSlots() { return getPortSlots(); },
    hexRadius: HEX_R,
    tokenRadius: TOKEN_R,
    ring: [RING_IN, RING_OUT],
    cropHalf: CROP_HALF,
    cropPx: CROP_PX
  },

  /* maths */
  solveLinearSystem: solveLinearSystem,
  solveHomography: solveHomography,
  inferSixCorners: inferSixCorners,
  rotateCorners: rotateCorners,

  /* pipeline */
  buildCalibration: buildCalibration,
  autoDetectCorners: autoDetectCorners,
  analyzeBoard: analyzeBoard,
  validateBoard: validateBoard,

  /* transparency helpers */
  rectify: rectify,
  toImageData: toImageData,
  imageDataToCanvas: imageDataToCanvas,
  renderNumberTemplate: renderNumberMask,
  templates: TEMPLATES,

  /* small conveniences */
  pipValue: function (n) { return PIP_VALUE[n] || 0; },
  isRed: function (n) { return !!RED_NUMBERS[n]; },

  /* exposed for tests / tuning */
  _internal: {
    PROTOS: PROTOS,
    sampleHexRing: sampleHexRing,
    typeCosts: typeCosts,
    analyseToken: analyseToken,
    warpPatch: warpPatch,
    computeWhiteBalance: computeWhiteBalance,
    connectedComponents: connectedComponents,
    countHoles: countHoles,
    assign: assign,
    tokenGeom: tokenGeom,
    rgb2hsv: rgb2hsv,
    scoreCalibration: scoreCalibration
  }
};

})(typeof window !== 'undefined' ? window : this);
