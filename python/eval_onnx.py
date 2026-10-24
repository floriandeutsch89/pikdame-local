"""Sanity-check an exported ONNX model against the live Node env.

Loads an exported model, plays a handful of episodes through the same env
server used for training, and reports the average reward and the win rate.
Confirms the ONNX graph runs and the encoder parity holds before wiring it into
Node. The model's input size picks the observation version (377 = v1, 385 = v2).

    python eval_onnx.py --tier zen --episodes 20
    python eval_onnx.py --model ../models/candidates/pikdame-zen.onnx --team --episodes 40

"self" seats play the evaluated model itself (--team defaults to hard,self,hard:
the model and its copy as partners against two hard bots). For the decision
whether a model ships, use scripts/sim-bots.js (the production path, see
docs/developer/rl-setup.md "Training v2").
"""
from __future__ import annotations

import argparse
import os

import numpy as np
import onnxruntime as ort

from pikdame_env import PikDameEnv

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OBS_VERSIONS = {377: 1, 385: 2}  # the StateEncoder contract


def masked_argmax(logits: np.ndarray, mask: np.ndarray) -> int:
    x = logits.copy()
    x[~mask] = -1e9
    return int(np.argmax(x))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="zen")
    ap.add_argument("--model", default=None, help="path to a .onnx (default: models/pikdame-<tier>.onnx)")
    ap.add_argument("--episodes", type=int, default=20)
    ap.add_argument("--team", action="store_true", help='"2 gegen 2" tables (needs a v2 model)')
    ap.add_argument(
        "--opponents", default=None,
        help='comma-separated per-seat difficulties or "self" (default: zen,zen,medium; --team: hard,self,hard)',
    )
    args = ap.parse_args()

    onnx_path = args.model or os.path.join(REPO_ROOT, "models", f"pikdame-{args.tier}.onnx")
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    size = int(inp.shape[-1])
    version = OBS_VERSIONS.get(size)
    if version is None:
        raise SystemExit(f"{onnx_path}: input size {size} fits no encoder version {sorted(OBS_VERSIONS)}")
    if args.team and version < 2:
        raise SystemExit(f"{onnx_path} is a v1 model (no team features): it never plays team tables")
    print(f"model {onnx_path}: input {size} -> observation v{version}")
    default_opp = "hard,self,hard" if args.team else "zen,zen,medium"
    opp = [d.strip() for d in (args.opponents or default_opp).split(",") if d.strip()]
    env = PikDameEnv(
        opponent_difficulties=opp, seed=999, obs_version=version,
        team_ratio=1.0 if args.team else 0.0, selfplay_models=[onnx_path],
    )

    total = 0.0
    wins = 0
    rewards = []
    for ep in range(args.episodes):
        obs, _ = env.reset()
        done = False
        ep_reward = 0.0
        won = False
        while not done:
            logits = sess.run(None, {inp.name: obs.reshape(1, -1).astype(np.float32)})[0][0]
            action = masked_argmax(logits, env.action_masks())
            obs, reward, done, _, info = env.step(action)
            ep_reward += reward
            if done:
                won = bool(info.get("won", False))
        wins += 1 if won else 0
        total += ep_reward
        rewards.append(ep_reward)
        print(f"  ep {ep+1}: reward {ep_reward:+.2f}  {'WIN' if won else 'loss'}")
    env.close()

    n = args.episodes
    mean = total / n
    sd = (sum((r - mean) ** 2 for r in rewards) / n) ** 0.5 if n > 1 else 0.0
    stderr = sd / (n ** 0.5) if n > 1 else 0.0
    par = 0.5 if args.team else 1.0 / (len(opp) + 1)

    print(f"\nmean episode reward over {n}: {mean:+.3f}  (+/- {stderr:.3f} std. error)")
    print(f"win rate: {100.0 * wins / n:.1f}%  ({wins}/{n}, par {100.0 * par:.0f}%)   <-- the number that matters")
    print(
        "\nHow to read this\n"
        "----------------\n"
        "The reward is RELATIVE: every round scores (my points - the AVERAGE\n"
        "opponent's points) / 100 - at a team table (my team - the other team) / 200 -\n"
        "and the game ends with +1 for a win, -1 otherwise.\n"
        "\n"
        "So the ROUND part is centred on zero. The TERMINAL part is not at a normal\n"
        "table: for four equal players its expected value is 0.25*(+1) + 0.75*(-1) =\n"
        "-0.50. At a team table it is 0 (two equal teams).\n"
        "\n"
        "Judge the model against the BASELINE, not against zero (docs/developer/\n"
        "rl-training.md lists the heuristic bot's numbers in this exact scheme).\n"
        "\n"
        "And use WIN RATE as the headline: par is 1/players at a normal table and\n"
        "50% at a team table. Note the std. error above - over only 40 games the\n"
        "noise is large, so do not read too much into small differences.\n"
        "\n"
        "NOTE: the reward changed in v1.63.0 (it used to compare against the BEST\n"
        "opponent, which made it structurally negative). Numbers from before are NOT\n"
        "comparable. PIKDAME_RL_REWARD=max reproduces the old scheme."
    )


if __name__ == "__main__":
    main()
