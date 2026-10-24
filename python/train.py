"""Train the Pik Dame bot networks (medium, zen) and export each to ONNX.

The agent learns two decisions per turn - the draw source (draw pile vs. taking
the whole discard pile, when legal) and the discard - over a single masked
action space of 54 actions (see game/StateEncoder.js). Melding stays heuristic.

Only medium and zen are trained: RL optimises for winning, so it cannot
"train weakness". 'easy' stays the hand-written beginner heuristic (an easy bot
finds no pikdame-easy.onnx and falls back to it automatically). The two trained
tiers differ by opponents and training length:

    medium : moderate steps vs. a medium/zen pool
    zen    : long training vs. a zen-anchored pool (the ceiling model)

Observation versions (--obs-version): 1 = 377 inputs, the shipped zen model,
4-player tables; written to models/pikdame-<tier>.onnx. 2 = 385 inputs, v1 plus
the "2 gegen 2" team features: normal tables of 2-4 players mixed with team
tables, self-play seats in the pool, written to models/candidates/ - a candidate
ships only after the acceptance runs in docs/developer/rl-setup.md
("Training v2"). Usage on the RTX 5080 box (WSL2):

    python train.py --tier all
    python train.py --tier zen --steps 3000000
    python train.py --tier zen --obs-version 2 --init-from ../models/pikdame-zen.zip --steps 10000000

Requires: torch, gymnasium, stable-baselines3, sb3-contrib, onnx, onnxruntime.
"""

from __future__ import annotations

import argparse
import glob
import os
import time
import warnings

import numpy as np
import torch
import torch.nn as nn

from sb3_contrib import MaskablePPO
from sb3_contrib.common.wrappers import ActionMasker
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.vec_env import SubprocVecEnv, VecMonitor

from pikdame_env import PikDameEnv
from human_dataset import load_winner_moves, DEFAULT_PATH as HUMAN_DATA_DEFAULT

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(REPO_ROOT, "models")
CANDIDATES_DIR = os.path.join(MODELS_DIR, "candidates")  # gitignored: v2 runs land here

# The StateEncoder contract (scripts/rl-env-server.js checks the same numbers).
OBS_SIZES = {1: 377, 2: 385}

# Each tier defines its opponent pool (sampled per episode). IMPORTANT, measured
# with scripts/bot-divergence.js: the heuristic tiers collapse to only THREE
# distinct playing styles - easy (random discards), medium == hard (identical
# policy, 0% discard disagreement), and zen (counting-refined, ~18% different
# discards from hard). Draw and meld phases are difficulty-independent above
# easy. So a "medium + hard" pool is secretly uniform; the pools below combine
# the genuinely distinct styles instead. Real diversity beyond this ceiling
# needs self-play ("self" seats, see V2_POOL).
# Only MEDIUM and ZEN are trained as networks. 'easy' is intentionally NOT
# trained: RL optimises for winning, so it makes bots stronger, not weaker -
# there is no easy pikdame-easy.onnx, and at runtime an easy bot automatically
# falls back to the existing beginner heuristic (random-ish discards).
TIERS = {
    "medium": {"pool": ["medium", "zen"],          "steps": 1_000_000},
    "zen":    {"pool": ["zen", "medium", "easy"],  "steps": 3_000_000},
}
# v2 default pool: a third self-play (frozen snapshots of this run), a third the
# zen heuristic (= hard), the rest medium and easy. Repeat entries to weight them.
V2_POOL = ["self", "self", "zen", "zen", "medium", "easy"]


def mask_fn(env: PikDameEnv) -> np.ndarray:
    return env.action_masks()


def make_env(env_kwargs: dict, seed: int) -> ActionMasker:
    # ActionMasker must be the outermost wrapper: MaskablePPO calls
    # action_masks() on the sub-env inside the VecEnv, and Monitor does not
    # forward that attribute reliably (VecMonitor wraps the VecEnv instead).
    env = PikDameEnv(seed=seed, **env_kwargs)
    return ActionMasker(env, mask_fn)


class OnnxPolicy(nn.Module):
    """Wraps the trained MaskablePPO policy so ONNX exports a clean
    observation -> action-logits graph. Masking is applied at RUNTIME in
    Node (game/OnnxPolicy.js), so we export raw logits here."""

    def __init__(self, policy):
        super().__init__()
        self.policy = policy

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        # Reproduce the policy's feature extractor + action net to get logits.
        features = self.policy.extract_features(obs)
        latent_pi = self.policy.mlp_extractor.forward_actor(features)
        logits = self.policy.action_net(latent_pi)
        return logits


def policy_logits(policy, obs: np.ndarray) -> np.ndarray:
    with torch.no_grad():
        t = torch.as_tensor(obs, dtype=torch.float32, device=policy.device)
        return OnnxPolicy(policy)(t).cpu().numpy()


def cpu_clone(policy):
    """A CPU copy rebuilt from the weights (deepcopy trips over the cached
    action distribution); the module names - and so the ONNX names - stay."""
    clone = policy.__class__(**policy._get_constructor_parameters())
    clone.load_state_dict(policy.state_dict())
    return clone.cpu().eval()


def export_onnx(policy, obs_size: int, out_path: str, quiet: bool = False):
    """Export a CPU copy (training keeps its device and mode), atomically: the
    file appears complete or not at all (self-play workers read the folder)."""
    wrapper = OnnxPolicy(cpu_clone(policy)).eval()
    dummy = torch.zeros(1, obs_size, dtype=torch.float32)
    tmp = out_path + ".tmp"
    kwargs = dict(
        input_names=["obs"],
        output_names=["logits"],
        dynamic_axes={"obs": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
    )
    with warnings.catch_warnings():
        if quiet:
            warnings.simplefilter("ignore")
        try:
            # dynamo=False: the legacy TorchScript exporter, reliable dynamic_axes
            # and no device-mismatch crash; newer torch may drop it - then dynamo.
            torch.onnx.export(wrapper, dummy, tmp, dynamo=False, **kwargs)
        except Exception:
            torch.onnx.export(wrapper, dummy, tmp, dynamo=True, **kwargs)
    os.replace(tmp, out_path)
    if not quiet:
        print(f"  exported ONNX -> {out_path}")


def verify_onnx(path: str, policy, obs_size: int, samples: np.ndarray):
    """The exported graph takes [batch, obs_size] and matches the torch policy."""
    import onnx
    import onnxruntime as ort

    m = onnx.load(path)
    onnx.checker.check_model(m)
    dims = [d.dim_value or d.dim_param for d in m.graph.input[0].type.tensor_type.shape.dim]
    if dims[-1] != obs_size:
        raise RuntimeError(f"{path}: input {dims}, expected [batch, {obs_size}]")
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    got = sess.run(None, {sess.get_inputs()[0].name: samples.astype(np.float32)})[0]
    want = policy_logits(policy, samples)
    diff = float(np.abs(got - want).max())
    if got.shape[1] != 54 or diff > 1e-3:
        raise RuntimeError(f"{path}: output {got.shape}, max |logit diff| vs torch {diff:.2e}")
    print(f"  verified {os.path.basename(path)}: input {dims}, output [batch, 54], "
          f"max |logit diff| vs torch {diff:.1e} over {len(samples)} observations")


def source_params(path: str) -> dict:
    """Policy tensors of a checkpoint: a SB3 .zip (actor + critic) or an
    exported .onnx (actor only - the export carries no value net)."""
    if path.endswith(".onnx"):
        import onnx
        from onnx import numpy_helper

        out = {}
        for init in onnx.load(path).graph.initializer:
            name = init.name[len("policy."):] if init.name.startswith("policy.") else init.name
            out[name] = torch.as_tensor(numpy_helper.to_array(init).copy())
        return out
    from stable_baselines3.common.save_util import load_from_zip_file

    _, params, _ = load_from_zip_file(path, device="cpu")
    return params["policy"]


def warm_start(model: MaskablePPO, path: str):
    """Copy matching weights; a first layer that gained inputs (v1 -> v2) keeps
    the old columns and gets ZERO weights for the new ones, so the warm-started
    net plays exactly like the source until training moves it."""
    src = source_params(path)
    state = model.policy.state_dict()
    copied, widened, fresh = [], [], []
    for key, value in state.items():
        old = src.get(key)
        if old is None:
            fresh.append(key)
        elif tuple(old.shape) == tuple(value.shape):
            state[key] = old.to(value.dtype)
            copied.append(key)
        elif old.dim() == 2 and old.shape[0] == value.shape[0] and old.shape[1] < value.shape[1]:
            wide = torch.zeros_like(value)
            wide[:, : old.shape[1]] = old.to(value.dtype)
            state[key] = wide
            widened.append(key)
        else:
            fresh.append(key)
    if not copied:
        raise RuntimeError(f"--init-from {path}: no tensor fits this network (net_arch differs?)")
    model.policy.load_state_dict(state)
    print(f"  warm start from {path}: {len(copied)} tensors copied, "
          f"{len(widened)} widened with zero columns ({', '.join(widened) or '-'}), "
          f"{len(fresh)} fresh ({', '.join(fresh) or '-'})")
    return src


def check_warm_start(model: MaskablePPO, path: str, obs: np.ndarray):
    """Proof: on the same observations the new net gives the source's logits."""
    if path.endswith(".onnx"):
        import onnxruntime as ort

        sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        size = int(sess.get_inputs()[0].shape[-1])
        want = sess.run(None, {sess.get_inputs()[0].name: obs[:, :size].astype(np.float32)})[0]
    else:
        source = MaskablePPO.load(path, device="cpu")
        size = int(source.observation_space.shape[0])
        want = policy_logits(source.policy, obs[:, :size])
    diff = float(np.abs(policy_logits(model.policy, obs) - want).max())
    print(f"  warm-start check: max |logit diff| vs source {diff:.1e} over {len(obs)} observations")
    if diff > 1e-3:
        raise RuntimeError("warm start does not reproduce the source policy")


class TableStats(BaseCallback):
    """Per rollout: win rate and episode reward by table kind (normal2..4, team).
    Par win rate: 1/players at a normal table, 50 % at a team table."""

    def _on_training_start(self):
        self.ep_rew = np.zeros(self.training_env.num_envs)
        self.rows = {}

    def _on_step(self) -> bool:
        self.ep_rew += self.locals["rewards"]
        for i, done in enumerate(self.locals["dones"]):
            if done:
                info = self.locals["infos"][i]
                kind = "team" if info.get("team") else f"normal{info.get('players', '')}"
                self.rows.setdefault(kind, []).append((float(info.get("won", False)), self.ep_rew[i]))
                self.ep_rew[i] = 0.0
        return True

    def _on_rollout_end(self):
        for kind, rows in sorted(self.rows.items()):
            arr = np.asarray(rows)
            self.logger.record(f"tables/{kind}_win_rate", float(arr[:, 0].mean()))
            self.logger.record(f"tables/{kind}_ep_rew", float(arr[:, 1].mean()))
            self.logger.record(f"tables/{kind}_episodes", len(rows))
        self.rows = {}


class SelfPlaySnapshots(BaseCallback):
    """Writes the policy to `directory` every `every` steps for the "self" seats:
    the first snapshot of the run stays (an anchor), plus the newest `keep`."""

    def __init__(self, directory: str, obs_size: int, every: int, keep: int):
        super().__init__()
        self.directory, self.obs_size, self.every, self.keep = directory, obs_size, every, keep
        self.last = 0

    def _snapshot(self):
        os.makedirs(self.directory, exist_ok=True)
        path = os.path.join(self.directory, f"snap-{time.time_ns()}.onnx")
        export_onnx(self.model.policy, self.obs_size, path, quiet=True)
        snaps = sorted(glob.glob(os.path.join(self.directory, "snap-*.onnx")))
        for old in snaps[1:-self.keep] if len(snaps) > self.keep + 1 else []:
            os.remove(old)
        self.last = self.num_timesteps

    def _on_training_start(self):
        self._snapshot()

    def _on_rollout_start(self):
        if self.num_timesteps - self.last >= self.every:
            self._snapshot()

    def _on_step(self) -> bool:
        return True


class CriticWarmup(BaseCallback):
    """Freezes the actor for the first `steps`: a warm-started actor waits until
    the critic predicts this run's returns (team rewards, a fresh value net
    after an ONNX start) instead of following noisy advantages."""

    def __init__(self, steps: int):
        super().__init__()
        self.steps = steps
        self.frozen = False

    def _actor(self):
        p = self.model.policy
        return list(p.mlp_extractor.policy_net.parameters()) + list(p.action_net.parameters())

    def _on_training_start(self):
        if self.steps > 0:
            for prm in self._actor():
                prm.requires_grad_(False)
            self.frozen = True
            print(f"  critic warm-up: actor frozen for the first {self.steps} steps")

    def _on_rollout_start(self):
        # Checked before each rollout, so at least one update trains the critic alone.
        if self.frozen and self.num_timesteps >= self.steps:
            for prm in self._actor():
                prm.requires_grad_(True)
            self.frozen = False
            print(f"  critic warm-up done at {self.num_timesteps} steps: actor trains")

    def _on_step(self) -> bool:
        return True


def behavioral_clone(model, human_data_path, epochs, device, batch=512):
    """Supervised pre-training: make the policy imitate WINNING humans before
    (optionally) refining with PPO. Trains the actor with masked cross-entropy
    on (obs -> human action). This injects human style and reduces overfitting
    to bot opponents (self-play alone makes bots predictable to people)."""
    obs, act, mask = load_winner_moves(human_data_path)
    if len(act) == 0:
        print(f"  [BC] no winning-human moves in {human_data_path} - skipping")
        return
    print(f"  [BC] cloning {len(act)} winner moves for {epochs} epochs")
    obs_t = torch.as_tensor(obs, dtype=torch.float32, device=device)
    act_t = torch.as_tensor(act, dtype=torch.long, device=device)
    mask_t = torch.as_tensor(mask, dtype=torch.bool, device=device)
    policy = model.policy
    policy.train()
    opt = torch.optim.Adam(policy.parameters(), lr=3e-4)
    n = len(act_t)
    for ep in range(epochs):
        perm = torch.randperm(n, device=device)
        total, nb = 0.0, 0
        for i in range(0, n, batch):
            idx = perm[i : i + batch]
            o, a, m = obs_t[idx], act_t[idx], mask_t[idx]
            features = policy.extract_features(o)
            latent_pi = policy.mlp_extractor.forward_actor(features)
            logits = policy.action_net(latent_pi)
            logits = logits.masked_fill(~m, -1e9)  # never learn illegal actions
            loss = nn.functional.cross_entropy(logits, a)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += loss.item()
            nb += 1
        print(f"  [BC] epoch {ep + 1}/{epochs}  loss {total / max(1, nb):.4f}")


def split_list(value):
    return [v.strip() for v in value.split(",") if v.strip()] if value else None


def train_tier(tier, args, human_data=None):
    cfg = TIERS[tier]
    v2 = args.obs_version == 2
    steps = cfg["steps"] if args.steps is None else args.steps  # 0: export only
    out_dir = args.out_dir or (CANDIDATES_DIR if v2 else MODELS_DIR)
    os.makedirs(out_dir, exist_ok=True)
    pool = split_list(args.pool) or (V2_POOL if v2 else cfg["pool"])
    team_ratio = args.team_ratio if args.team_ratio is not None else (0.5 if v2 else 0.0)
    normal_seats = split_list(args.normal_seats) or (["2", "3", "4"] if v2 else None)
    rollout = args.n_steps * args.n_envs
    selfplay_dir = os.path.join(out_dir, f"selfplay-{tier}")
    env_kwargs = dict(
        opponent_pool=pool,
        opponents=3,
        obs_version=args.obs_version,
        team_ratio=team_ratio,
        normal_seats=[int(n) for n in normal_seats] if normal_seats else None,
        partner_pool=split_list(args.partner_pool),
        selfplay_dir=selfplay_dir if "self" in pool or "self" in (split_list(args.partner_pool) or []) else None,
    )
    print(f"[{tier}] v{args.obs_version}: {steps} steps on {args.device} ({args.n_envs} envs), pool {pool}, "
          f"team share {team_ratio:.0%}, normal tables {normal_seats or [4]} players -> {out_dir}")

    # Each subprocess gets its own Node env-server process. n_envs parallel
    # workers saturate the CPU cores and keep the GPU fed with larger batches.
    env_fns = [lambda i=i: make_env(env_kwargs, seed=1234 + i) for i in range(args.n_envs)]
    env = VecMonitor(SubprocVecEnv(env_fns), info_keywords=("won",))
    obs_size = env.observation_space.shape[0]
    if obs_size != OBS_SIZES[args.obs_version]:
        raise RuntimeError(f"env serves {obs_size} observations, the v{args.obs_version} contract says {OBS_SIZES[args.obs_version]}")
    batch_size = max(64, rollout // 4)  # 512 * n_envs at the default n_steps 2048

    checkpoint = args.resume or os.path.join(out_dir, f"pikdame-{tier}.zip")
    callbacks = [TableStats()]
    if os.path.exists(checkpoint) and not args.init_from:
        print(f"  resuming from {checkpoint}")
        try:
            model = MaskablePPO.load(checkpoint, env=env, device=args.device)
        except ValueError as e:
            raise SystemExit(f"{checkpoint} does not fit this env ({e}). For v1 -> v2 use --init-from.")
        # Restore parallel-env batch size in case it differs from the saved run.
        model.batch_size = batch_size
    else:
        if args.init_from and os.path.exists(checkpoint):
            print(f"  note: --init-from starts fresh; {checkpoint} will be overwritten")
        model = MaskablePPO(
            "MlpPolicy",
            env,
            verbose=1,
            device=args.device,
            n_steps=args.n_steps,
            batch_size=batch_size,  # scales with workers so each GPU batch stays full
            gamma=0.997,
            ent_coef=0.01,
            learning_rate=args.lr,
            policy_kwargs=dict(net_arch=[256, 256]),
        )
        if args.init_from:
            warm_start(model, args.init_from)
            check_warm_start(model, args.init_from, env.reset())
            warmup = args.critic_warmup if args.critic_warmup >= 0 else rollout
            callbacks.append(CriticWarmup(warmup))
    if env_kwargs["selfplay_dir"]:
        callbacks.append(SelfPlaySnapshots(selfplay_dir, obs_size, args.selfplay_every or rollout, args.selfplay_keep))
    # Optional behavioral-cloning warm start from winning human games. This
    # seeds the policy with human style; PPO then refines it (SL -> RL, like
    # AlphaGo). Use --bc-only to ship a pure human-imitation model.
    if human_data:
        behavioral_clone(model, human_data, args.bc_epochs, args.device)
    if not args.bc_only and steps > 0:
        model.learn(total_timesteps=steps, progress_bar=not args.no_progress, callback=callbacks)

    sb3_path = os.path.join(out_dir, f"pikdame-{tier}.zip")
    model.save(sb3_path)
    print(f"  saved SB3 checkpoint -> {sb3_path}")

    onnx_path = os.path.join(out_dir, f"pikdame-{tier}.onnx")
    export_onnx(model.policy, obs_size, onnx_path)
    samples = model.rollout_buffer.observations.reshape(-1, obs_size) if model.rollout_buffer.full else env.reset()
    picks = np.random.default_rng(0).choice(len(samples), size=min(512, len(samples)), replace=False)
    verify_onnx(onnx_path, model.policy, obs_size, samples[picks])
    env.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="all", choices=["all", *TIERS.keys()])  # medium, zen
    ap.add_argument("--steps", type=int, default=None,
                    help="override step count; 0 = no training, only (warm start and) export")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument(
        "--human-data", default=None,
        help="path to human-moves.jsonl (defaults to data/human-moves.jsonl if it exists; v1 only)",
    )
    ap.add_argument("--bc-epochs", type=int, default=5, help="behavioral-cloning epochs")
    ap.add_argument(
        "--bc-only", action="store_true",
        help="only clone winning humans (no PPO) - a pure human-style model",
    )
    ap.add_argument(
        "--no-human-data", action="store_true",
        help="ignore human data even if data/human-moves.jsonl exists",
    )
    ap.add_argument(
        "--n-envs", type=int, default=200,
        help="parallel SubprocVecEnv workers (each spawns a Node process); default 200",
    )
    ap.add_argument(
        "--resume", default=None, metavar="PATH",
        help="SB3 .zip checkpoint to resume from (default: <out-dir>/pikdame-<tier>.zip if it exists)",
    )
    ap.add_argument("--obs-version", type=int, default=1, choices=sorted(OBS_SIZES),
                    help="StateEncoder version: 1 = 377 inputs (shipped zen), 2 = 385 (+ team features)")
    ap.add_argument("--team-ratio", type=float, default=None,
                    help='share of "2 gegen 2" episodes (default 0.5 with v2, 0 with v1)')
    ap.add_argument("--normal-seats", default=None,
                    help="players per normal episode, sampled, e.g. 2,3,4,4 (default v2: 2,3,4; v1: 4)")
    ap.add_argument("--pool", default=None,
                    help='seat pool, comma-separated levels and "self" (default v2: ' + ",".join(V2_POOL) + ")")
    ap.add_argument("--partner-pool", default=None, help="pool for the partner seat of team episodes (default: --pool)")
    ap.add_argument("--init-from", default=None, metavar="PATH",
                    help="warm start from a SB3 .zip (actor + critic) or an exported .onnx (actor only)")
    ap.add_argument("--critic-warmup", type=int, default=-1, metavar="STEPS",
                    help="with --init-from: train only the critic first (default: one rollout; 0 = off)")
    ap.add_argument("--selfplay-every", type=int, default=0, metavar="STEPS",
                    help='snapshot interval for "self" seats (default: every rollout)')
    ap.add_argument("--selfplay-keep", type=int, default=4, help="newest snapshots kept besides the first")
    ap.add_argument("--n-steps", type=int, default=2048, help="PPO rollout length per env")
    ap.add_argument("--lr", type=float, default=3e-4, help="learning rate")
    ap.add_argument("--out-dir", default=None, help="default: models/ (v1), models/candidates/ (v2)")
    ap.add_argument("--no-progress", action="store_true", help="no progress bar (logs, CI)")
    args = ap.parse_args()

    if args.team_ratio and args.obs_version < 2:
        ap.error("--team-ratio needs --obs-version 2 (the v1 encoding has no team features)")
    if args.init_from and args.resume:
        ap.error("--init-from starts a new run, --resume continues one: pick one")
    if args.init_from and not os.path.exists(args.init_from):
        ap.error(f"--init-from {args.init_from}: no such file")

    # By default, ANY v1 tier automatically warm-starts from human games when
    # the standard log exists - no extra flag needed. --no-human-data opts out.
    # The log holds v1 observations: a v2 behavioral clone is not built yet.
    human_data = args.human_data
    if args.obs_version >= 2:
        if human_data:
            ap.error("--human-data: the log holds v1 observations; v2 cloning is not built yet (rl-setup.md)")
    elif human_data is None and not args.no_human_data and os.path.exists(HUMAN_DATA_DEFAULT):
        human_data = HUMAN_DATA_DEFAULT
        print(f"[human data] using {human_data} for a behavioral-cloning warm start")

    tiers = list(TIERS.keys()) if args.tier == "all" else [args.tier]
    for tier in tiers:
        train_tier(tier, args, human_data=human_data)


if __name__ == "__main__":
    main()
