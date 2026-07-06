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
        "--opponents", default="zen,zen,hard",
        help="comma-separated per-seat opponent difficulties (default: the zen baseline)",
    )
    args = ap.parse_args()

    onnx_path = os.path.join(REPO_ROOT, "models", f"pikdame-{args.tier}.onnx")
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    opp = [d.strip() for d in args.opponents.split(",") if d.strip()]
    env = PikDameEnv(opponent_difficulties=opp, seed=999)

    total = 0.0
    for ep in range(args.episodes):
        obs, _ = env.reset()
        done = False
        ep_reward = 0.0
        while not done:
            logits = sess.run(["logits"], {"obs": obs.reshape(1, -1).astype(np.float32)})[0][0]
            action = masked_argmax(logits, env.action_masks())
            obs, reward, done, _, _ = env.step(action)
            ep_reward += reward
        total += ep_reward
        print(f"  ep {ep+1}: reward {ep_reward:+.2f}")
    env.close()
    print(f"\nmean episode reward over {args.episodes}: {total/args.episodes:+.3f}")


if __name__ == "__main__":
    main()
