# ONNX bots (optional)

By default the bots are a **heuristic engine** — hand-written rules, A/B-measured
in self-play. They are the shipped default and need nothing extra.

Optionally you can run a **trained neural policy** exported to ONNX. Two things
have to be true for it to actually take effect:

1. the **model files** must be inside the container, and
2. the **`onnxruntime-node`** runtime must be installed in the image.

If either is missing the server **falls back to the heuristic bot** — it never
takes the game down. It now also **says so loudly in the log** instead of failing
silently.

## Why isn't it in the default image?

`onnxruntime-node` is a native dependency of roughly **100 MB**. The point of the
default image is that it stays small and boring, and the heuristic bots are
perfectly good. So ONNX is **opt-in at build time**.

The model files themselves (~700 KB each) *are* baked into the image — harmless
when unused, since nothing loads them unless `PIKDAME_ONNX=1`.

## Option A — build an ONNX-capable image

```bash
docker build --build-arg WITH_ONNX=1 -f docker/Dockerfile -t pikdame-onnx .
```

Run it with the feature switched on:

```bash
docker run -d \
  -p 8080:8080 \
  -v pikdame-data:/app/data \
  -e PIKDAME_ONNX=1 \
  pikdame-onnx
```

In compose:

```yaml
services:
  app:
    build:
      context: ..
      dockerfile: docker/Dockerfile
      args:
        WITH_ONNX: "1"
    environment:
      - PIKDAME_ONNX=1
```

## Option B — swap models without rebuilding

Baking models into the image means a **new image for every retrained model**. If
you iterate on models, mount them instead and point the server at them:

```yaml
services:
  app:
    volumes:
      - pikdame-data:/app/data
      - ./models:/app/models:ro      # your trained .onnx files
    environment:
      - PIKDAME_ONNX=1
      - PIKDAME_MODELS_DIR=/app/models
```

`PIKDAME_MODELS_DIR` overrides where the server looks. Drop in a new
`pikdame-medium.onnx`, restart the container, done — no rebuild.

## File naming

The server loads **one model per difficulty**, by name:

```text
<models dir>/pikdame-easy.onnx
<models dir>/pikdame-medium.onnx
<models dir>/pikdame-zen.onnx
```

A difficulty with no model file simply keeps using the heuristic — you can ship a
trained `zen` and leave `easy` heuristic, for example.

## Verifying it actually works

This is the part people get wrong, because the fallback is *designed* to be
harmless. Check the log after start:

```bash
docker compose logs app | grep -iE "ONNX|Modell"
```

You want to see:

```text
ONNX-Modell geladen: /app/models/pikdame-medium.onnx (Schwierigkeit "medium")
```

If instead you see a warning that `onnxruntime-node` is missing, or that a model
file was not found, then **the bots are still heuristic** — the flag is on but
doing nothing.

## Training a model

Training is a separate, offline workflow (Python, `MaskablePPO`).

:::{tip}
Before tuning anything, read {doc}`../developer/rl-training` — especially why the
reward is *relative*, and why a mean episode reward around **−2.3 is better than
the heuristic bot**, not a failure.
:::

The full setup — WSL2, data collection from human games, self-play, export:

```{include} ../RL_TRAINING.md
:start-line: 1
```
