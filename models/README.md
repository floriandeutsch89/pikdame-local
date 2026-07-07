# Trained models

This directory holds the exported bot networks `pikdame-medium.onnx` and
`pikdame-zen.onnx`. There is deliberately no `pikdame-easy.onnx`: the beginner
bot stays the hand-written heuristic (RL only makes bots stronger, so 'easy' is
not trained). An easy bot with no model falls back to that heuristic. They are produced by `python/train.py` and are
**committed to the repo** so anyone can run the AI bots without training first.

Activate them in the game with `PIKDAME_ONNX=1` (see `docs/RL_TRAINING.md`).
The SB3 `.zip` checkpoints (used to resume training) are gitignored.
