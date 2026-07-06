"""Gymnasium environment for Pik Dame.

Drives the Node.js env server (scripts/rl-env-server.js), which runs the REAL
game engine, so the policy trains against the exact production rules. The
agent controls the discard decision; the action is a card-type index (see
game/StateEncoder.js). Action masking is exposed for sb3-contrib MaskablePPO.

Run nothing here directly - this is imported by train.py.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Optional

import numpy as np
import gymnasium as gym
from gymnasium import spaces

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_SERVER = os.path.join(REPO_ROOT, "scripts", "rl-env-server.js")


class PikDameEnv(gym.Env):
    """One learning seat vs. heuristic opponents, talking to Node over stdio."""

    metadata = {"render_modes": []}

    def __init__(
        self,
        opponent_difficulty: str = "hard",
        opponents: int = 3,
        seed: Optional[int] = None,
        node_bin: str = "node",
    ):
        super().__init__()
        self.opponent_difficulty = opponent_difficulty
        self.opponents = opponents
        self._seed = seed
        self._node_bin = node_bin
        self._proc: Optional[subprocess.Popen] = None
        self._last_mask = None

        self._start_proc()
        meta = self._rpc({"cmd": "meta"})
        self.obs_size = int(meta["obs_size"])
        self.action_size = int(meta["action_size"])
        self.observation_space = spaces.Box(
            low=-1.0, high=1.0, shape=(self.obs_size,), dtype=np.float32
        )
        self.action_space = spaces.Discrete(self.action_size)

    # -- process / rpc plumbing ------------------------------------------------
    def _start_proc(self):
        if self._proc is not None:
            return
        self._proc = subprocess.Popen(
            [self._node_bin, ENV_SERVER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
            bufsize=1,
        )

    def _rpc(self, msg: dict) -> dict:
        assert self._proc and self._proc.stdin and self._proc.stdout
        self._proc.stdin.write(json.dumps(msg) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError("env server closed unexpectedly")
        return json.loads(line)

    # -- gym api ---------------------------------------------------------------
    def reset(self, *, seed=None, options=None):
        if seed is not None:
            self._seed = seed
        msg = {
            "cmd": "reset",
            "difficulty": self.opponent_difficulty,
            "opponents": self.opponents,
        }
        if self._seed is not None:
            msg["seed"] = int(self._seed) & 0xFFFFFFFF
            # vary the seed per episode so we do not overfit one deal
            self._seed = (self._seed * 1103515245 + 12345) & 0xFFFFFFFF
        resp = self._rpc(msg)
        self._last_mask = np.array(resp["mask"], dtype=bool)
        obs = np.array(resp["obs"], dtype=np.float32)
        return obs, {}

    def step(self, action):
        resp = self._rpc({"cmd": "step", "action": int(action)})
        self._last_mask = np.array(resp["mask"], dtype=bool)
        obs = np.array(resp["obs"], dtype=np.float32)
        reward = float(resp["reward"])
        done = bool(resp["done"])
        return obs, reward, done, False, {}

    def action_masks(self) -> np.ndarray:
        """Consumed by sb3-contrib MaskablePPO. All-False (terminal) -> allow all
        so the sampler does not divide by zero; those steps are ignored anyway."""
        if self._last_mask is None or not self._last_mask.any():
            return np.ones(self.action_size, dtype=bool)
        return self._last_mask

    def close(self):
        if self._proc is not None:
            try:
                self._rpc({"cmd": "close"})
            except Exception:
                pass
            try:
                self._proc.terminate()
            except Exception:
                pass
            self._proc = None
