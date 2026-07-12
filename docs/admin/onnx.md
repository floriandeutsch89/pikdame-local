# ONNX bots (optional)

By default the bots are a **heuristic engine** — hand-written rules, tuned and
A/B-measured in self-play. They are the shipped default and need nothing extra.

Optionally you can run a **trained neural policy** exported to ONNX instead.

## Enabling it

```bash
PIKDAME_ONNX=1
```

The model is loaded through `onnxruntime-node`. If either the runtime or the
model file is missing, the server **falls back to the heuristic bot** and logs
it — a broken model can never take the game down.

:::{note}
`onnxruntime-node` is an optional dependency and is not in the default image.
Enabling ONNX means building an image that includes it; the base install stays
lean on purpose.
:::

## Training a model

Training is a separate, offline workflow (Python, PyTorch), documented in full —
including WSL2 setup, data collection from human games, self-play, and export:

```{include} ../RL_TRAINING.md
:start-line: 1
```
