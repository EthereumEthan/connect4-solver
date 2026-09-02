# Connect 4 + Solver

A modern Connect 4 web game with a built-in **solver** — a deterministic game-tree
calculator (no AI/ML) that computes the best move by brute-force search.

**[Play it here](https://ethereumethan.github.io/connect4-solver/)** (GitHub Pages)

## Features

- 🎮 Play vs the solver (4 search depths) or local 2-player
- 💡 **Hint** button — the solver calculates the best move for you
- 📊 Live evaluation bar showing who's winning
- ↩ Undo, drop animations, win highlighting, responsive design

## How the solver works

The solver is pure calculation — minimax over the game tree. No neural networks,
no training data, no heuristics learned from games. Just math:

- **Bitboards in two 32-bit words** — the 7×6 board is encoded in 49 bits
  (7 bits per column), split across two machine integers. Win detection is a
  chain of shifts and ANDs that tests every possible four-in-a-row at once.
- **Negamax with alpha-beta pruning** — explores the tree of future moves,
  pruning branches that can't affect the result.
- **Principal-variation search** — after the first move, searches with a
  null window and only re-searches when a move beats expectations.
- **Transposition table** — a 32 MB open-addressed table in a typed array,
  keyed so that a position and its mirror image share an entry. Each distinct
  position is calculated once, and the table persists between moves.
- **Allocation-free move ordering** — tries the best known move first, then
  threat-creating moves, then center columns, scoring lazily so an early
  cutoff skips the work entirely.
- **Non-losing move generation** — immediate wins, forced blocks, double
  threats, and moves that hand the opponent a win are all resolved exactly
  before any recursion happens.
- **Iterative deepening** — searches depth 2, 3, 4… within a time budget,
  measuring how fast the tree is growing so it never starts an iteration it
  can't finish.

When the remaining game tree is small enough to search to the end, the solver's
evaluation is **mathematically exact** — "R in 7" means Red wins in exactly 7
moves against any defense. The search runs in a Web Worker, so the UI never
freezes.

### Performance

Measured in Chrome, versus a first version that used `BigInt` for the bitboard:

| | before | after |
|---|---|---|
| Search rate | 520K positions/sec | **4.2M positions/sec** |
| "Hard" reply | 925 ms | **46 ms** |
| "Perfect" reply | ~7 s (always) | **60 ms – 2.5 s** |
| Depth reached in 3 s | 16 plies | **21 plies** |

The single biggest win was replacing `BigInt` with two 32-bit integers:
`BigInt` heap-allocates on every operation, and win detection was 60% of all
CPU time. Correctness was checked by differential testing against an
independent brute-force solver — every position solved to the end matched on
winner, move, and exact distance to the win.

## Run locally

Any static file server works (a server is needed because of the Web Worker):

```bash
npx serve .
```

Then open the printed URL.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure |
| `style.css` | Styling & animations |
| `app.js` | Game state, UI, worker orchestration |
| `solver.js` | Web Worker: bitboard negamax solver |
