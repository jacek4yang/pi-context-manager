# pi-context-manager

Experimental context management and session continuity for
[Pi](https://github.com/earendil-works/pi). The product is context management —
compaction is one pluggable engine, not the product.

**Status: bootstrap.** Layers land on `feat/*` branches:
observability → deterministic hygiene → recoverable evidence → semantic
reduction → continuity checkpoints → compaction engines → recall → optional
memory. Architecture: `make-pi-great-again/docs/CONTEXT-MODEL.md`, invariants:
`docs/INVARIANTS.md` (C1–C16).

## Fundamental invariant

> Recover before summarize. Summarize before discard.
> No destructive context reduction unless the removed evidence remains
> recoverable from canonical session history or from a verified retrievable artifact.

## Development

```bash
npm ci
npm run ci
npm run package-smoke
pi -e ./
```
