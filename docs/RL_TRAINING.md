# Pik Dame – Reinforcement-Learning Bot Training (Ubuntu 24.04 / WSL2)

This guide explains how to train the bot networks and export them as **ONNX**
files that the Node game engine loads at runtime. Only **`medium`** and
**`zen`** are trained as networks - see "Why `easy` isn't trained" below.
(The old `hard` tier was identical to `medium` and was removed.) The policy can
also be warm-started from **winning human games** - see "Learning from human
games".

The key design choice: training runs against the **real game engine**. A small
Node server (`scripts/rl-env-server.js`) drives the actual `GameManager`; the
Python environment steers it over a text line. The network therefore learns
against the exact game rules — no error-prone rule reimplementation in Python.

The agent learns **two decisions per turn**:

1. **Draw source** — draw face-down from the draw pile, or take the whole
   discard pile (offered only when taking it is rule-legal).
2. **Discard** — which card to throw (52 card types, jokers never discarded).

The observation vector (377 values) and action space (54 actions) come from
`game/StateEncoder.js` — the **same** file feeds training and runtime, so both
encode identically. Laying off / melding still uses the existing heuristic.

---

## 1. Prerequisites

- Ubuntu 24.04 (native or under WSL2 on Windows 11)
- NVIDIA driver (the WSL2 CUDA stack picks up the Windows driver automatically)
- Your **RTX 5080** for CUDA-accelerated PyTorch
- **Node.js 22+**
- **[uv](https://docs.astral.sh/uv/)** for Python & dependency management

### 1.1 WSL2 with Ubuntu 24.04 (skip if native Linux)

```powershell
# Windows PowerShell (admin)
wsl --install -d Ubuntu-24.04
```

### 1.2 Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v22.x
```

### 1.3 uv

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
exec "$SHELL"       # reload PATH
uv --version
```

---

## 2. Python environment with uv

Use the newest Python your ML stack ships wheels for. PyTorch and
stable-baselines3 track releases with a short lag, so **pick the highest
supported interpreter** — at the time of writing that is 3.12/3.13; once
PyTorch publishes 3.14 wheels, simply bump the pin. uv makes this a one-liner
and will download the interpreter for you:

```bash
cd /path/to/pikdame-local

# Create a venv on the newest supported Python (try 3.14, fall back if wheels
# are missing). uv installs the interpreter automatically.
uv venv --python 3.14 || uv venv --python 3.13 || uv venv --python 3.12
source .venv/bin/activate
```

### 2.1 PyTorch with CUDA (RTX 5080 / Blackwell)

The RTX 5080 needs a recent CUDA build. Install the matching wheel first, then
the rest. Check the current recommended CUDA tag on pytorch.org:

```bash
uv pip install torch --index-url https://download.pytorch.org/whl/cu124
uv pip install -r python/requirements.txt
```

Verify the GPU is visible:

```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# True  NVIDIA GeForce RTX 5080
```

> If a wheel is missing for your chosen Python, recreate the venv one minor
> version lower (`uv venv --python 3.13`) and reinstall. uv keeps this cheap.

### 2.2 Node dependencies (incl. the ONNX runtime)

```bash
npm install
npm install onnxruntime-node    # optional runtime used for in-game inference
```

---

## 3. Quick check of the training bridge (no GPU needed)

Confirm the Node env server runs and returns observations:

```bash
printf '%s\n' \
  '{"cmd":"meta"}' \
  '{"cmd":"reset","difficulty":"medium","opponents":3,"seed":7}' \
  '{"cmd":"step","action":52}' \
  '{"cmd":"close"}' | node scripts/rl-env-server.js
```

Expected: a `meta` line with `obs_size` (377) and `action_size` (54), then
JSON objects with `obs` / `mask` / `reward` / `done` / `phase`.

Python-side smoke test:

```bash
source .venv/bin/activate
python - <<'PY'
from python.pikdame_env import PikDameEnv
import numpy as np
env = PikDameEnv(opponent_difficulty="medium", opponents=3, seed=1)
obs, _ = env.reset()
print("obs shape:", obs.shape, "| legal actions:", int(env.action_masks().sum()))
obs, r, done, _, _ = env.step(int(np.where(env.action_masks())[0][0]))
print("stepped -> reward", r, "done", done)
env.close()
PY
```

---

## 4. Training

Both trained tiers in sequence:

```bash
source .venv/bin/activate
cd python
python train.py --tier all
```

A single tier with a custom step count:

```bash
python train.py --tier zen --steps 3000000
python train.py --tier medium --steps 1000000
```

Tiers differ by opponent strength and training length (curriculum in `TIERS`
in `train.py`):

| Tier    | Opponents | Steps (default) |
|---------|-----------|-----------------|
| medium  | medium, zen          | 1 000 000 |
| zen     | zen, medium, easy    | 3 000 000 |

Each trained tier produces:

- `models/pikdame-<tier>.zip` — SB3 checkpoint (to resume training)
- `models/pikdame-<tier>.onnx` — the exported network for the Node runtime

### Why `easy` isn't trained

RL optimises for winning, so it can only make a bot *stronger* - it cannot
"train weakness" in any controllable way. So the beginner bot is simply the
existing hand-written heuristic: there is no `pikdame-easy.onnx`, and at runtime
an `easy` bot finds no model and falls back to that heuristic automatically
(random-ish discards, ~60% pile skipping - a natural "makes beginner mistakes"
opponent). If you ever want a *tunable* easy/medium from one strong network,
weaken it at inference (epsilon-greedy or temperature sampling over the logits)
rather than training a deliberately weak net.

Tip: several env processes in parallel speed up experience collection
(SB3 `SubprocVecEnv`); each env spawns its own `node` process.

---

## 5. Evaluate a model

```bash
python eval_onnx.py --tier zen --episodes 20
```

Prints the mean episode reward (score margin / 100 + game-win bonus). Positive
means the agent beats the heuristic opponents on average.

---

## 6. Activate in the game

ONNX inference is toggled by an **environment variable** and is off by default.
With the models in `models/` and `onnxruntime-node` installed:

```bash
PIKDAME_ONNX=1 node server.js
```

Without the variable — or if a model or the runtime is missing — the bots play
**exactly as before** with the heuristic; any problem falls back silently, so
the default path is unchanged. Each tier loads `models/pikdame-<tier>.onnx`.

For the production container: set `PIKDAME_ONNX=1` and include the `models/`
files plus `onnxruntime-node` in the image.

---

## 7. Architecture at a glance

```
Python (GPU training)                     Node (real game engine)
──────────────────────                    ──────────────────────────
train.py                                  scripts/rl-env-server.js
  └─ MaskablePPO (SB3)                       └─ GameManager (real rules)
       └─ PikDameEnv  ── stdio JSON ───►         └─ StateEncoder.encode()
            (pikdame_env.py)              ◄───        obs / mask / reward
                                                 └─ forcedDrawSource +
                                                    externalDiscard='pause'
       └─ export ONNX ─► models/pikdame-*.onnx

Runtime inference:
  server.js (PIKDAME_ONNX=1)
    └─ GameManager._runBotTurnWithOnnx()
         ├─ OnnxPolicy.chooseDrawSource()   (draw decision)
         └─ OnnxPolicy.chooseDiscardCard()  (discard decision)
              └─ StateEncoder.encode()  ─►  onnxruntime-node
```

**Encoder parity — important:** `game/StateEncoder.js` is the single place that
encodes game state for the network. Never change it one-sidedly; any change
alters the model input and makes existing `.onnx` files incompatible (retrain).

---

## 8. Opponent selection & baselines

Who the agent trains against matters as much as how long it trains.

**Anchor against the zen master (recommended).** Including the existing
hand-crafted `zen` heuristic as a fixed opponent gives two things: a stable,
strong learning signal, and a clear answer to *"is the network actually better
than our best hand-written bot?"* It also prevents the classic failure where an
agent learns to beat copies of itself yet forgets how to punish conventional
play.

**How distinct are the heuristic tiers, really?** Measured with
`node scripts/bot-divergence.js` (disagreement on the same discard decision):

| Pair            | Different discards |
|-----------------|--------------------|
| medium vs zen   | ~18%               |
| easy vs any     | ~75% (easy discards randomly) |

(The former `hard` tier was measured identical to `medium` - 0% discard
disagreement - and has been removed.)

So the heuristic bots offer only **three genuinely distinct styles**:
`easy` (random), `medium` (value heuristic), and `zen` (counting-refined,
differing from medium in ~1 in 5 discards). Draw and meld play are
difficulty-independent above easy. Consequence: `zen` vs `medium` gives real but
**modest, one-dimensional** diversity (~18%, only in the discard tie-break) -
enough to avoid trivially memorising a single opponent, but not broad. For
robust anti-overfitting the **self-play league below is the primary lever**,
not the heuristic mix.

**Do not train against zen alone.** A single opponent invites overfitting - the
network learns to exploit that opponent's quirks instead of playing well in
general. Mix difficulties so it generalizes. The default tiers in `train.py`
therefore use a zen-anchored **pool** that is resampled each episode:

| Tier   | Opponent pool (sampled per episode) |
|--------|-------------------------------------|
| medium | medium, zen                |
| zen    | zen, medium, easy          |

You can pass any mix directly:

```python
# explicit per-seat opponents (anchor on the zen master)
PikDameEnv(opponent_difficulties=["zen", "medium", "easy"])
# or a pool to sample a fresh 3-seat table from every reset
PikDameEnv(opponent_pool=["zen", "zen", "medium", "easy"])
```

Evaluate specifically against the zen baseline:

```bash
python eval_onnx.py --tier zen --opponents zen,zen,medium --episodes 40
```

**Next step - a self-play league.** Once a tier beats the zen baseline, add its
own past checkpoints as opponents (a league), keeping the zen heuristic in the
pool as a fixed anchor so the league cannot drift into degenerate strategies.
This needs the env to run a learned policy for opponent seats (load an ONNX per
opponent) - a natural extension of the current heuristic-opponent env.

## 9. Learning from human games (imitation learning)

Training only against bots makes the policy overfit to bot behaviour and become
predictable to people. Learning from **winning human games** injects human
style and unpredictability. We do this with behavioral cloning (supervised
imitation) as a warm start, then optionally refine with PPO (the SL -> RL
recipe, like AlphaGo).

**1. Collect data.** Human-move logging is **on by default**; just run the server:

```bash
node server.js                 # logging on (writes data/human-moves.jsonl)
PIKDAME_LOG_GAMES=0 node server.js   # to turn it off
```

Every human draw and discard decision is encoded with the same
`StateEncoder` the network uses and appended to **`data/human-moves.jsonl`** at
the end of each game. This is the file `train.py` imports - keep it at
`<repo>/data/human-moves.jsonl` (or point `--human-data` / `PIKDAME_LOG_PATH`
elsewhere). Rows are **minified by default** (compact JSON, observations rounded
to 4 decimals, mask as 0/1) to keep the file small.

Only anonymous data is written (no names, accounts or raw cards). Each row
carries as much training-useful context as possible: the encoded observation,
the chosen action, the legal-action mask, and per-move/-game metadata -
`phase`, `won`, `rank` (1 = winner), `finalTotal`, `winnerTotal`, `players`,
`rounds`, `turns`, the `round`/`turn` the move was made on, the mover's `hand`
size, the opponents' hand sizes `opp`, `pileTakeLegal`, and an anonymous
per-game id `g`. That lets the Python side weight or filter moves (e.g. by
margin, rank, or game phase), not just clone winners blindly.

> **Running in Docker?** `/app/data` is auto-created and persisted in the named
> volume `pikdame-data`, so the log survives restarts. To pull it to your
> training box, either `docker cp <container>:/app/data/human-moves.jsonl .`, or
> switch the app service to a bind mount (a commented example is in
> `docker/docker-compose*.yml`). Logging is on by default; set
> `PIKDAME_LOG_GAMES=0` in the app service to turn it off.

**2. Train.** If `data/human-moves.jsonl` exists, **every tier automatically
warm-starts from it** - no extra flag needed:

```bash
python train.py --tier zen            # auto behavioral-cloning + PPO if the log exists
python train.py --tier zen --no-human-data   # ignore the human log
python train.py --tier zen --bc-only          # pure human-imitation model (no PPO)
python train.py --tier zen --human-data /path/to/other.jsonl   # a different log
```

The behavioral-cloning phase clones the winners' moves (masked cross-entropy
over the 54-action space) before PPO starts; PPO then refines it. `--bc-only`
ships the cloned policy directly as ONNX without any RL.

**Why this helps:** the resulting bot starts from *how people actually win*,
not from self-play equilibria, so it plays in a more human, less exploitable
way - and PPO on top still lifts its strength. More human data = better; a few
hundred games already shift the style noticeably.

## 10. Next extensions (optional)

- **Learn melding / lay-offs too:** currently heuristic. The action space could
  grow to cover which cards to meld (more heads or a hierarchical agent).
- **Self-play:** train against previous model versions (a league) instead of
  the heuristic for stronger endgame models.
- **Reward shaping:** the reward is a sparse round margin; intermediate signals
  (e.g. melded card value) can speed up learning.
