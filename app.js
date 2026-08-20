'use strict';

const COLS = 7, ROWS = 6;

// ---------------- difficulty presets (search budget, not "AI") ----------------
const LEVELS = {
  easy:    { maxDepth: 2,  timeMs: 200,   fuzz: 40 }, // shallow + noisy
  medium:  { maxDepth: 9,  timeMs: 800,   fuzz: 0 },
  hard:    { maxDepth: 15, timeMs: 2500,  fuzz: 0 },
  perfect: { maxDepth: 42, timeMs: 7000, fuzz: 0 },
};
const EVAL_BUDGET = { maxDepth: 10, timeMs: 400 };
const WIN_SCORE = 100000;

// ---------------- state ----------------
let grid;            // grid[col][row], row 0 = bottom; 0 empty, 1 red, 2 yellow
let heights;         // discs per column
let moveHistory;     // list of columns played
let current;         // 1 red, 2 yellow
let gameOver;
let mode = 'ai';     // 'ai' | '2p'
let level = 'medium';
let busy = false;    // solver is choosing its move

// ---------------- worker ----------------
const worker = new Worker('solver.js');
let reqId = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const cb = pending.get(e.data.id);
  if (cb) { pending.delete(e.data.id); cb(e.data); }
};
function askSolver(budget) {
  return new Promise((resolve) => {
    const id = ++reqId;
    pending.set(id, resolve);
    const { position, mask } = toBitboard();
    worker.postMessage({ id, position, mask, maxDepth: budget.maxDepth, timeMs: budget.timeMs });
  });
}

function toBitboard() {
  // position = bits of the side to move, mask = all discs (7 bits per column)
  let position = 0n, mask = 0n;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (!grid[c][r]) break;
      const bit = 1n << BigInt(c * 7 + r);
      mask |= bit;
      if (grid[c][r] === current) position |= bit;
    }
  }
  return { position: position.toString(), mask: mask.toString() };
}

// ---------------- DOM ----------------
const boardEl = document.getElementById('board');
const hoverRowEl = document.getElementById('hover-row');
const statusEl = document.getElementById('status-msg');
const p1Chip = document.getElementById('p1-chip');
const p2Chip = document.getElementById('p2-chip');
const p1Label = document.getElementById('p1-label');
const p2Label = document.getElementById('p2-label');
const thinkingEl = document.getElementById('thinking');
const evalFill = document.getElementById('eval-fill');
const evalLabel = document.getElementById('eval-label');
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlaySub = document.getElementById('overlay-sub');
const overlayEmoji = document.getElementById('overlay-emoji');

const cellEls = [];   // cellEls[col][row]
const hoverCells = [];

function buildBoard() {
  boardEl.innerHTML = '';
  hoverRowEl.innerHTML = '';
  cellEls.length = 0;
  hoverCells.length = 0;
  for (let c = 0; c < COLS; c++) cellEls.push([]);
  // grid is rendered top row first
  for (let r = ROWS - 1; r >= 0; r--) {
    for (let c = 0; c < COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.col = c;
      cell.addEventListener('click', () => onColumnClick(c));
      boardEl.appendChild(cell);
      cellEls[c][r] = cell;
    }
  }
  for (let c = 0; c < COLS; c++) {
    const hc = document.createElement('div');
    hc.className = 'hover-cell';
    const disc = document.createElement('div');
    disc.className = 'hover-disc red';
    hc.appendChild(disc);
    hoverRowEl.appendChild(hc);
    hoverCells.push(hc);
  }
  boardEl.addEventListener('mousemove', onBoardHover);
  boardEl.addEventListener('mouseleave', clearHover);
}

function onBoardHover(e) {
  const cell = e.target.closest('.cell');
  clearHover();
  if (!cell || gameOver || busy) return;
  if (mode === 'ai' && current === 2) return;
  const c = +cell.dataset.col;
  if (heights[c] >= ROWS) return;
  const hc = hoverCells[c];
  hc.classList.add('show');
  hc.firstChild.className = 'hover-disc ' + (current === 1 ? 'red' : 'yellow');
}
function clearHover() {
  for (const hc of hoverCells) hc.classList.remove('show');
}

// ---------------- game ----------------
function newGame() {
  grid = Array.from({ length: COLS }, () => new Array(ROWS).fill(0));
  heights = new Array(COLS).fill(0);
  moveHistory = [];
  current = 1;
  gameOver = false;
  busy = false;
  overlay.hidden = true;
  clearHint();
  buildBoard();
  setEval(0, false);
  updateStatus();
}

function onColumnClick(col) {
  if (gameOver || busy) return;
  if (mode === 'ai' && current === 2) return;
  if (heights[col] >= ROWS) return;
  playMove(col);
}

function playMove(col) {
  clearHint();
  clearHover();
  const row = heights[col];
  grid[col][row] = current;
  heights[col]++;
  moveHistory.push(col);

  animateDrop(col, row, current);

  const winLine = findWin(col, row);
  if (winLine) {
    endGame(current, winLine);
    return;
  }
  if (moveHistory.length === COLS * ROWS) {
    endGame(0, null);
    return;
  }

  current = current === 1 ? 2 : 1;
  updateStatus();
  refreshEval();

  if (mode === 'ai' && current === 2 && !gameOver) {
    solverMove();
  }
}

function animateDrop(col, row, player) {
  const cell = cellEls[col][row];
  const disc = document.createElement('div');
  disc.className = 'disc dropping ' + (player === 1 ? 'red' : 'yellow');
  const cellPx = cell.getBoundingClientRect().height || 60;
  const dist = (ROWS - row) * (cellPx + 8) + cellPx;
  disc.style.setProperty('--drop-dist', dist + 'px');
  cell.appendChild(disc);
}

function findWin(col, row) {
  const p = grid[col][row];
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dc, dr] of dirs) {
    const line = [[col, row]];
    for (const s of [1, -1]) {
      let c = col + dc * s, r = row + dr * s;
      while (c >= 0 && c < COLS && r >= 0 && r < ROWS && grid[c][r] === p) {
        line.push([c, r]);
        c += dc * s; r += dr * s;
      }
    }
    if (line.length >= 4) return line;
  }
  return null;
}

async function solverMove() {
  busy = true;
  thinkingEl.hidden = false;
  updateStatus();
  const budget = LEVELS[level];
  const t0 = performance.now();
  const res = await askSolver(budget);
  const elapsed = Math.round(performance.now() - t0);

  let col = res.col;
  // Easy mode: pick randomly among near-equivalent moves so it's beatable.
  if (budget.fuzz > 0 && res.results.length > 1) {
    const ok = res.results.filter(r => r.score >= res.score - budget.fuzz);
    col = ok[Math.floor(Math.random() * ok.length)].col;
  }

  thinkingEl.hidden = true;
  busy = false;
  if (gameOver || col < 0) return;
  console.log(`solver: col ${col}, score ${res.score}, depth ${res.depth}, ` +
              `${res.nodes.toLocaleString()} nodes in ${elapsed}ms${res.exact ? ' (exact)' : ''}`);
  playMove(col);
}

function endGame(winner, line) {
  gameOver = true;
  clearHover();
  if (line) {
    for (const [c, r] of line) {
      const disc = cellEls[c][r].querySelector('.disc');
      if (disc) disc.classList.add('winning');
    }
  }
  if (winner === 0) {
    statusEl.textContent = 'Draw!';
    overlayEmoji.textContent = '🤝';
    overlayTitle.textContent = 'Draw!';
    overlaySub.textContent = 'The board is full — dead even.';
  } else {
    const name = playerName(winner);
    statusEl.textContent = `${name} wins!`;
    overlayEmoji.textContent = winner === 1 ? '🔴' : '🟡';
    overlayTitle.textContent = `${name} wins!`;
    overlaySub.textContent = mode === 'ai'
      ? (winner === 1 ? 'You beat the solver — nice calculation!' : 'The solver calculated its way to victory.')
      : 'Connect four achieved.';
  }
  setEval(winner === 1 ? WIN_SCORE : winner === 2 ? -WIN_SCORE : 0, true, winner);
  setTimeout(() => { overlay.hidden = false; }, line ? 900 : 400);
  updateChips();
}

function playerName(p) {
  if (mode === '2p') return p === 1 ? 'Red' : 'Yellow';
  return p === 1 ? 'You' : 'Solver';
}

function updateStatus() {
  if (gameOver) return;
  if (busy) statusEl.textContent = 'Solver is calculating…';
  else statusEl.textContent = `${playerName(current)} to move`;
  updateChips();
}

function updateChips() {
  p1Chip.classList.toggle('turn', !gameOver && current === 1);
  p2Chip.classList.toggle('turn', !gameOver && current === 2);
}

// ---------------- eval bar ----------------
let evalReq = 0;
async function refreshEval() {
  const myReq = ++evalReq;
  const res = await askSolver(EVAL_BUDGET);
  if (myReq !== evalReq || gameOver) return;
  // res.score is from the side-to-move's perspective; convert to Red's.
  const mover = current;
  const redScore = mover === 1 ? res.score : -res.score;
  setEval(redScore, Math.abs(res.score) > WIN_SCORE - 100);
}

function setEval(redScore, decisive, winner) {
  let pct, label;
  if (winner === 0) { pct = 50; label = '½–½'; }
  else if (decisive || Math.abs(redScore) > WIN_SCORE - 100) {
    const movesToEnd = Math.ceil((WIN_SCORE - Math.abs(redScore)) / 2);
    pct = redScore > 0 ? 97 : 3;
    label = (redScore > 0 ? 'R' : 'Y') + (movesToEnd > 0 && movesToEnd < 22 ? ` in ${movesToEnd}` : ' wins');
  } else {
    pct = 50 + 50 * Math.tanh(redScore / 40);
    label = (redScore >= 0 ? '+' : '') + (redScore / 12).toFixed(1);
  }
  evalFill.style.width = pct + '%';
  evalLabel.textContent = label;
}

// ---------------- hint ----------------
let hintCol = -1;
async function showHint() {
  if (gameOver || busy) return;
  if (mode === 'ai' && current === 2) return;
  clearHint();
  const btn = document.getElementById('hint-btn');
  btn.disabled = true;
  const res = await askSolver(LEVELS.hard);
  btn.disabled = false;
  if (gameOver || res.col < 0) return;
  hintCol = res.col;
  const row = heights[hintCol];
  if (row < ROWS) cellEls[hintCol][row].classList.add('hint');
}
function clearHint() {
  if (hintCol >= 0) {
    for (const colCells of cellEls) {
      for (const cell of colCells) cell.classList.remove('hint');
    }
    hintCol = -1;
  }
}

// ---------------- undo ----------------
function undo() {
  if (busy || moveHistory.length === 0) return;
  const steps = (mode === 'ai' && moveHistory.length >= 2 && current === 1 && !gameOver) ? 2
              : (mode === 'ai' && gameOver && current === 2) ? 1
              : (mode === 'ai') ? Math.min(2, moveHistory.length) : 1;
  for (let i = 0; i < steps && moveHistory.length; i++) {
    const col = moveHistory.pop();
    heights[col]--;
    const row = heights[col];
    grid[col][row] = 0;
    const disc = cellEls[col][row].querySelector('.disc');
    if (disc) disc.remove();
    current = current === 1 ? 2 : 1;
  }
  if (gameOver) {
    gameOver = false;
    overlay.hidden = true;
    document.querySelectorAll('.disc.winning').forEach(d => d.classList.remove('winning'));
  }
  clearHint();
  updateStatus();
  refreshEval();
}

// ---------------- controls ----------------
document.getElementById('mode-select').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  mode = btn.dataset.mode;
  document.querySelectorAll('#mode-select button').forEach(b => b.classList.toggle('active', b === btn));
  document.getElementById('difficulty-group').style.visibility = mode === 'ai' ? 'visible' : 'hidden';
  p1Label.textContent = mode === 'ai' ? 'You' : 'Red';
  p2Label.textContent = mode === 'ai' ? 'Solver' : 'Yellow';
  newGame();
});

document.getElementById('difficulty-select').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  level = btn.dataset.level;
  document.querySelectorAll('#difficulty-select button').forEach(b => b.classList.toggle('active', b === btn));
});

document.getElementById('new-game-btn').addEventListener('click', newGame);
document.getElementById('overlay-btn').addEventListener('click', newGame);
document.getElementById('hint-btn').addEventListener('click', showHint);
document.getElementById('undo-btn').addEventListener('click', undo);

newGame();
