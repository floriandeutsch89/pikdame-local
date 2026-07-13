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

## Why the default image cannot do it

:::{important}
**The default image is Alpine, and ONNX cannot work there — at all.**

`onnxruntime-node` ships **pre-built native binaries linked against glibc**
(they need `libstdc++.so.6`, `libm.so.6`, `GLIBC_2.x` symbols). Alpine uses
**musl**. Installing the package on Alpine *appears* to succeed and then fails
to load at `require()` time.

So the ONNX build is a **separate image on a Debian (glibc) base**:
`docker/Dockerfile.onnx`. The default Alpine image stays small and ONNX-free.
:::

The runtime is also a ~100 MB native dependency, which is the second reason not
to put it in the default image — the heuristic bots are good and need nothing.

## Option A — use the prebuilt ONNX image

Every release publishes a **second image** with the runtime and the trained
models already inside:

```bash
docker pull ghcr.io/floriandeutsch89/pikdame-local-onnx:latest
```

```bash
docker run -d \
  -p 8080:8080 \
  -v pikdame-data:/app/data \
  ghcr.io/floriandeutsch89/pikdame-local-onnx:latest
```

The image already sets `PIKDAME_ONNX=1`, so there is nothing else to configure.
Tags follow the app version (`:v1.63.0`), and it is built for **amd64 + arm64**.

In compose, point at the ONNX package instead of the default one:

```yaml
services:
  app:
    image: ghcr.io/floriandeutsch89/pikdame-local-onnx:latest
    environment:
      - PIKDAME_ONNX=1
```

It uses the **same UID/GID (10001)** as the default image, so an existing data
volume keeps working if you switch between the two.

Building it yourself works too:

```bash
docker build -f docker/Dockerfile.onnx -t pikdame-onnx .
```

:::{tip}
All three compose files (`docker/docker-compose.yml`, `.ghcr.yml`, `.prod.yml`)
already carry a **ready-to-uncomment ONNX block** on the `pikdame` service — the
image swap, the env var and the optional model mount. You do not have to piece it
together from this page.
:::

## Option B — swap models without rebuilding

The models are baked into the ONNX image, so a retrained model would mean a new
image. If you iterate on models, mount them instead and point the server at them
(still using the **ONNX image** — the runtime has to be there):

```yaml
services:
  app:
    image: ghcr.io/floriandeutsch89/pikdame-local-onnx:latest
    volumes:
      - pikdame-data:/app/data
      - ./models:/app/models:ro      # your trained .onnx files
    environment:
      - PIKDAME_ONNX=1
      - PIKDAME_MODELS_DIR=/app/models
```

`PIKDAME_MODELS_DIR` overrides where the server looks. Drop in a new
`pikdame-medium.onnx`, restart the container, done — no rebuild.

## Kubernetes / Helm

There is **no separate ONNX chart** — the chart already parameterises the image,
so a second one would only duplicate the ingress/PVC/service templates. Use the
ready-made overrides instead:

```bash
helm install pikdame oci://ghcr.io/floriandeutsch89/charts/pikdame \
  --version <X.Y.Z> \
  -f helm/pikdame/values-onnx.yaml \
  --set ingress.host=spiel.example.org \
  --set image.tag=v<X.Y.Z>
```

That sets `image.repository` to the ONNX package and `onnx.enabled=true` (which
adds `PIKDAME_ONNX=1`). The image uses the **same UID/GID (10001)**, so an
existing PVC keeps working.

:::{note}
The chart **refuses to render** `onnx.enabled=true` together with the default
Alpine image — that combination would quietly fall back to the heuristic bots,
which is exactly the kind of misconfiguration that is better caught at install
time than discovered weeks later.
:::

Verify after rollout:

```bash
kubectl logs deploy/pikdame | grep -i "ONNX-Modell"
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
docker compose logs app | grep -iE "ONNX|Modell"
```

You want to see:

```text
ONNX-Modell geladen: /app/models/pikdame-medium.onnx (Schwierigkeit "medium")
```

If instead you see a warning that `onnxruntime-node` is missing, or that a model
file was not found, then **the bots are still heuristic** — the flag is on but
doing nothing. The most likely cause is running the **default Alpine image**
rather than the ONNX one.

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
