# Trained models

This directory holds the exported bot networks `pikdame-<tier>.onnx`
(easy / medium / hard / zen). They are produced by `python/train.py` and are
**committed to the repo** so anyone can run the AI bots without training first.

Activate them in the game with `PIKDAME_ONNX=1` (see `docs/RL_TRAINING.md`).
The SB3 `.zip` checkpoints (used to resume training) are gitignored.
