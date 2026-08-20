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

- **Bitboards** — the 7×6 board is encoded in 49 bits (7 bits per column), so
  win detection and move generation are a handful of bit operations.
- **Negamax with alpha-beta pruning** — explores the tree of future moves,
  pruning branches that can't affect the result.
- **Transposition table** — positions reachable by different move orders are
  cached so each is only calculated once.
- **Move ordering** — tries center columns and threat-creating moves first,
  which makes alpha-beta pruning dramatically more effective.
- **Iterative deepening** — searches depth 2, 3, 4… within a time budget, so
  it always has an answer and deepens as time allows.
- **Threat logic** — immediate wins, forced blocks, and double-threat
  detection are handled exactly at every node.

When the remaining game tree is small enough to search to the end (roughly from
the midgame on, on "Perfect"), the solver's evaluation is **mathematically
exact** — "R in 7" means Red wins in exactly 7 moves with perfect play.

The search runs in a Web Worker, so the UI never freezes.

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
