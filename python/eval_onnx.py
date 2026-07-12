"""Sanity-check an exported ONNX model against the live Node env.

Loads models/pikdame-<tier>.onnx, plays a handful of episodes through the same
env server used for training, and reports the average score margin. Confirms
the ONNX graph runs and the encoder parity holds before wiring it into Node.

    python eval_onnx.py --tier zen --episodes 20
"""
from __future__ import annotations

import argparse
import os

import numpy as np
import onnxruntime as ort

from pikdame_env import PikDameEnv

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def masked_argmax(logits: np.ndarray, mask: np.ndarray) -> int:
    x = logits.copy()
    x[~mask] = -1e9
    return int(np.argmax(x))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", default="zen")
    ap.add_argument("--episodes", type=int, default=20)
    ap.add_argument(
        "--opponents", default="zen,zen,medium",
        help="comma-separated per-seat opponent difficulties (default: the zen baseline)",
    )
    args = ap.parse_args()

    onnx_path = os.path.join(REPO_ROOT, "models", f"pikdame-{args.tier}.onnx")
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    opp = [d.strip() for d in args.opponents.split(",") if d.strip()]
    env = PikDameEnv(opponent_difficulties=opp, seed=999)

    total = 0.0
    wins = 0
    rewards = []
    for ep in range(args.episodes):
        obs, _ = env.reset()
        done = False
        ep_reward = 0.0
        won = False
        while not done:
            logits = sess.run(["logits"], {"obs": obs.reshape(1, -1).astype(np.float32)})[0][0]
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

    print(f"\nmean episode reward over {n}: {mean:+.3f}  (+/- {stderr:.3f} std. error)")
    print(f"win rate: {100.0 * wins / n:.1f}%  ({wins}/{n})   <-- the number that matters")
    print(
        "\nHow to read this\n"
        "----------------\n"
        "The reward is RELATIVE: every round scores (my points - the AVERAGE\n"
        "opponent's points) / 100, and the game ends with +1 for a win, -1 otherwise.\n"
        "\n"
        "So the ROUND part is centred on zero - an average player scores about what\n"
        "the average opponent scores. The TERMINAL part is not: for four equal\n"
        "players its expected value is 0.25*(+1) + 0.75*(-1) = -0.50.\n"
        "\n"
        "Judge the model against the BASELINE, not against zero. The heuristic bot\n"
        "itself, measured over 400 games in this exact scheme, scores about\n"
        "-0.62 (medium) / -0.59 (zen). That is the number to beat.\n"
        "\n"
        "And use WIN RATE as the headline: 25% = on par with the opponents,\n"
        "clearly above 25% = genuinely stronger. Note the std. error above - over\n"
        "only 40 games the noise is large, so do not read too much into small\n"
        "differences.\n"
        "\n"
        "NOTE: the reward changed in v1.63.0 (it used to compare against the BEST\n"
        "opponent, which made it structurally negative: the heuristic bot scored\n"
        "about -5.4). Numbers from before are NOT comparable, and models trained\n"
        "before optimised a different objective - retrain them. PIKDAME_RL_REWARD=max\n"
        "reproduces the old scheme."
    )


if __name__ == "__main__":
    main()
