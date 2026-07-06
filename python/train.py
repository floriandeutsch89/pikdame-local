"""Train the four Pik Dame bot tiers and export each to ONNX.

The agent learns two decisions per turn - the draw source (draw pile vs. taking
the whole discard pile, when legal) and the discard - over a single masked
action space of 54 actions (see game/StateEncoder.js). Melding stays heuristic.

The four tiers differ by how strong the opponents are and how long we train -
a simple curriculum that yields four models of increasing skill:

    easy   : few steps vs. easy opponents      (deliberately shallow)
    medium : moderate steps vs. medium         opponents
    hard   : long training vs. hard            opponents
    zen    : longest training vs. hard          opponents (the ceiling model)

Each tier is saved as models/pikdame-<tier>.onnx, ready for the Node runtime
(game/OnnxPolicy.js). Usage on the RTX 5080 box (WSL2), see docs/RL_TRAINING.md:

    python train.py --tier all
    python train.py --tier zen --steps 3000000

Requires: torch, gymnasium, stable-baselines3, sb3-contrib, onnx.
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import torch
import torch.nn as nn

from sb3_contrib import MaskablePPO
from sb3_contrib.common.wrappers import ActionMasker
from stable_baselines3.common.monitor import Monitor

from pikdame_env import PikDameEnv

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(REPO_ROOT, "models")

# Each tier defines its opponent pool (sampled per episode). IMPORTANT, measured
# with scripts/bot-divergence.js: the heuristic tiers collapse to only THREE
# distinct playing styles - easy (random discards), medium == hard (identical
# policy, 0% discard disagreement), and zen (counting-refined, ~18% different
# discards from hard). Draw and meld phases are difficulty-independent above
# easy. So a "medium + hard" pool is secretly uniform; the pools below combine
# the genuinely distinct styles instead. Real diversity beyond this ceiling
# needs the self-play league (see docs/RL_TRAINING.md, "Opponent selection").
TIERS = {
    "easy":   {"pool": ["easy", "hard"],          "steps": 200_000},
    "medium": {"pool": ["hard", "zen"],           "steps": 800_000},
    "hard":   {"pool": ["hard", "zen"],           "steps": 2_000_000},
    "zen":    {"pool": ["zen", "hard", "easy"],   "steps": 3_000_000},
}


def mask_fn(env: PikDameEnv) -> np.ndarray:
    return env.action_masks()


def make_env(pool, seed: int) -> ActionMasker:
    # Sample a fresh 3-opponent mix from the pool each episode.
    env = PikDameEnv(opponent_pool=pool, opponents=3, seed=seed)
    env = Monitor(env)
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


def export_onnx(model: MaskablePPO, obs_size: int, out_path: str):
    model.policy.eval()
    wrapper = OnnxPolicy(model.policy).eval()
    dummy = torch.zeros(1, obs_size, dtype=torch.float32)
    torch.onnx.export(
        wrapper,
        dummy,
        out_path,
        input_names=["obs"],
        output_names=["logits"],
        dynamic_axes={"obs": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
    )
    print(f"  exported ONNX -> {out_path}")


def train_tier(tier: str, steps_override: int | None, device: str):
    cfg = TIERS[tier]
    steps = steps_override or cfg["steps"]
    os.makedirs(MODELS_DIR, exist_ok=True)
    print(f"[{tier}] training {steps} steps vs. pool {cfg['pool']} on {device}")

    env = make_env(cfg["pool"], seed=1234)
    model = MaskablePPO(
        "MlpPolicy",
        env,
        verbose=1,
        device=device,
        n_steps=2048,
        batch_size=512,
        gamma=0.997,
        ent_coef=0.01,
        learning_rate=3e-4,
        policy_kwargs=dict(net_arch=[256, 256]),
    )
    model.learn(total_timesteps=steps, progress_bar=True)

    sb3_path = os.path.join(MODELS_DIR, f"pikdame-{tier}.zip")
    model.save(sb3_path)
    print(f"  saved SB3 checkpoint -> {sb3_path}")

    obs_size = env.observation_space.shape[0]
    onnx_path = os.path.join(MODELS_DIR, f"pikdame-{tier}.onnx")
    export_onnx(model, obs_size, onnx_path)
    env.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="all", choices=["all", *TIERS.keys()])
    ap.add_argument("--steps", type=int, default=None, help="override step count")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    tiers = list(TIERS.keys()) if args.tier == "all" else [args.tier]
    for tier in tiers:
        train_tier(tier, args.steps, args.device)


if __name__ == "__main__":
    main()
