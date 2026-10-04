# ONNX bots

The bots play with a **trained neural policy** exported to ONNX. Since v2.43.0
there is **one image**, `ghcr.io/floriandeutsch89/pikdame-local`, with the
runtime (`onnxruntime-node`) and the models built in, and the learned bots are
**on by default**.

The **heuristic engine** — hand-written rules, A/B-measured in self-play — is
still part of every install:

- it is what you get with `PIKDAME_ONNX=0`,
- it takes over automatically whenever the learned path cannot run (runtime or
  model missing) — the server never goes down for it and says so in the log,
- it is what plain `node server.js` from a checkout uses (e.g. the iPhone/CodeApp
  hotspot mode): the repository itself has no native dependency.

## `PIKDAME_ONNX`

| Value | Behaviour |
| --- | --- |
| `1` / `true` (**image default**) | Learned bots. If the runtime or a model cannot load, the server says so loudly and plays on with the heuristic. |
| `0` / `false` | Heuristic bots, even though runtime and models are there. |
| *unset* (only outside the image) | **Auto**: learned bots when runtime **and** at least one model are present, heuristic otherwise — silently, so `node server.js` without the runtime behaves as before. |

Compose:

```yaml
services:
  pikdame:
    image: ghcr.io/floriandeutsch89/pikdame-local:latest
    environment:
      - PIKDAME_ONNX=0    # only if you want the heuristic bots
```

Helm: `--set onnx.enabled=false` (sets `PIKDAME_ONNX=0`; default `true`).

## What is in the image

Debian slim, ~436 MB, amd64 + arm64 (a Raspberry Pi with a 64-bit OS works).

:::{important}
**Why Debian and not Alpine:** `onnxruntime-node` ships pre-built native
binaries linked against **glibc** (`libstdc++.so.6`, `GLIBC_2.x` symbols).
Alpine uses **musl**; the package *appears* to install there and then fails to
load at `require()` time. Up to v2.42.0 there were therefore two images, a small
Alpine one with heuristic bots only and a separate `-onnx` one.
:::

Only the CPU runtime for the image's own architecture is kept: the package also
ships Windows and macOS binaries, the other CPU architecture and a 240 MB CUDA
GPU provider, all removed at build time (`node_modules` 503 MB → 41 MB).

Measured under the production limits (`docker-compose.prod.yml`: 512 MB, 1 CPU,
256 pids, read-only root) with two games against zen bots: ~35 MB RAM,
~45 threads on a 32-core host (fewer on a small VM).

## Swap models without rebuilding

The models are baked into the image. If you iterate on models, mount them and
point the server at them:

```yaml
services:
  pikdame:
    image: ghcr.io/floriandeutsch89/pikdame-local:latest
    volumes:
      - pikdame-data:/app/data
      - ./models:/app/models:ro      # your trained .onnx files
    environment:
      - PIKDAME_MODELS_DIR=/app/models
```

`PIKDAME_MODELS_DIR` overrides where the server looks. Drop in a new
`pikdame-medium.onnx`, restart the container, done — no rebuild.

## Kubernetes / Helm

The chart sets `PIKDAME_ONNX` from `onnx.enabled` (default `true`). There is no
separate values file any more. Verify after rollout:

```bash
kubectl logs deploy/pikdame | grep -E "ONNX-Bots|ONNX-Modell"
```

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
docker compose logs pikdame | grep -E "ONNX-Bots|ONNX-Modell"
```

You want to see:

```text
[config]  ✓ ONNX-Bots            aktiv
ONNX-Modell geladen: /app/models/pikdame-zen.onnx (Schwierigkeit "zen")
```

The model line appears with the first bot move of a difficulty, not at start.
If instead you see a warning that `onnxruntime-node` is missing, or that a model
file was not found, then **the bots are heuristic** — the most likely causes are
an image older than v2.43.0 (pull again) or a `PIKDAME_MODELS_DIR` that points
at an empty directory.

## Training a model

Training is a separate, offline workflow (Python, `MaskablePPO`).

:::{tip}
Before tuning anything, read {doc}`../developer/rl-training` — especially why the
reward is *relative*, and why a mean episode reward around **−2.3 is better than
the heuristic bot**, not a failure.
:::

The full setup — WSL2, data collection from human games, self-play, export —
is documented in {doc}`../developer/rl-setup`.
