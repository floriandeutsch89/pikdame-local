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
from human_dataset import load_winner_moves

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
# Only MEDIUM and ZEN are trained as networks. 'easy' is intentionally NOT
# trained: RL optimises for winning, so it makes bots stronger, not weaker -
# there is no easy pikdame-easy.onnx, and at runtime an easy bot automatically
# falls back to the existing beginner heuristic (random-ish discards). Pools
# still draw on all three heuristic styles for opponent variety. Real diversity
# beyond that needs the self-play league (docs/RL_TRAINING.md).
TIERS = {
    "medium": {"pool": ["medium", "zen"],          "steps": 1_000_000},
    "zen":    {"pool": ["zen", "medium", "easy"],  "steps": 3_000_000},
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


def train_tier(tier, steps_override, device, human_data=None, bc_epochs=5, bc_only=False):
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
    # Optional behavioral-cloning warm start from winning human games. This
    # seeds the policy with human style; PPO then refines it (SL -> RL, like
    # AlphaGo). Use --bc-only to ship a pure human-imitation model.
    if human_data:
        behavioral_clone(model, human_data, bc_epochs, device)
    if not bc_only:
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
    ap.add_argument("--tier", default="all", choices=["all", *TIERS.keys()])  # medium, zen
    ap.add_argument("--steps", type=int, default=None, help="override step count")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument(
        "--human-data", default=None,
        help="path to data/human-moves.jsonl; enables a behavioral-cloning warm start",
    )
    ap.add_argument("--bc-epochs", type=int, default=5, help="behavioral-cloning epochs")
    ap.add_argument(
        "--bc-only", action="store_true",
        help="only clone winning humans (no PPO) - a pure human-style model",
    )
    args = ap.parse_args()

    tiers = list(TIERS.keys()) if args.tier == "all" else [args.tier]
    for tier in tiers:
        train_tier(
            tier, args.steps, args.device,
            human_data=args.human_data, bc_epochs=args.bc_epochs, bc_only=args.bc_only,
        )


if __name__ == "__main__":
    main()
