"""Load human move data (data/human-moves.jsonl) for behavioral cloning.

Each JSONL row is one human decision: {g, phase, obs, action, mask, won}. For
imitation learning we keep only the WINNER's moves - we want the bot to imitate
how winning humans play, not every human. Used by train.py's BC phase.
"""

from __future__ import annotations

import json
import os
from typing import Optional, Tuple

import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PATH = os.path.join(REPO_ROOT, "data", "human-moves.jsonl")


def load_winner_moves(
    path: str = DEFAULT_PATH, phase: Optional[str] = None
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (obs, action, mask) arrays for the moves of winning humans.

    phase: optionally restrict to 'draw' or 'discard' (None = both).
    """
    obs, act, mask = [], [], []
    if not os.path.exists(path):
        return (
            np.zeros((0, 0), dtype=np.float32),
            np.zeros((0,), dtype=np.int64),
            np.zeros((0, 0), dtype=bool),
        )
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not r.get("won"):
                continue
            if phase is not None and r.get("phase") != phase:
                continue
            obs.append(r["obs"])
            act.append(int(r["action"]))
            mask.append(r["mask"])
    if not obs:
        return (
            np.zeros((0, 0), dtype=np.float32),
            np.zeros((0,), dtype=np.int64),
            np.zeros((0, 0), dtype=bool),
        )
    return (
        np.asarray(obs, dtype=np.float32),
        np.asarray(act, dtype=np.int64),
        np.asarray(mask, dtype=bool),
    )


if __name__ == "__main__":
    o, a, m = load_winner_moves()
    print(f"winner moves: {len(a)} | obs dim: {o.shape[1] if len(o) else 0}")
