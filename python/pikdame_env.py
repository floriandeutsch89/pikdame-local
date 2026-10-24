"""Gymnasium environment for Pik Dame.

Drives the Node.js env server (scripts/rl-env-server.js), which runs the REAL
game engine, so the policy trains against the exact production rules. The
agent controls the draw source and the discard; the action is a card-type
index (see game/StateEncoder.js). Action masking is exposed for sb3-contrib
MaskablePPO.

Episodes can mix normal tables (2-4 players) and "2 gegen 2" team tables
(team_ratio; needs obs_version=2, the encoder with the team features). Seats
come from a pool of heuristic levels plus "self": a frozen ONNX snapshot of
the policy (self-play), played here in Python.

Run nothing here directly - this is imported by train.py.
"""

from __future__ import annotations

import glob
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

SELF = "self"  # pool entry: a self-play seat
HEURISTIC_FALLBACK = "zen"  # plays a "self" seat while no snapshot exists


class PikDameEnv(gym.Env):
    """One learning seat vs. heuristic and self-play seats, talking to Node over stdio."""

    metadata = {"render_modes": []}

    def __init__(
        self,
        opponent_difficulty: str = "hard",
        opponents: int = 3,
        opponent_difficulties: Optional[list] = None,
        opponent_pool: Optional[list] = None,
        seed: Optional[int] = None,
        node_bin: str = "node",
        obs_version: int = 1,
        team_ratio: float = 0.0,
        normal_seats: Optional[list] = None,
        partner_pool: Optional[list] = None,
        selfplay_dir: Optional[str] = None,
        selfplay_models: Optional[list] = None,
    ):
        """Opponent selection (in priority order):
          - opponent_difficulties: an explicit per-seat list, e.g.
            ["zen", "hard", "medium"] (anchor training against the zen master),
          - opponent_pool: a list to SAMPLE each seat from at every reset,
            e.g. ["self", "zen", "zen", "medium"] (repeat an entry to weight it),
          - else opponents x opponent_difficulty (a uniform table).
        Table size: normal_seats (e.g. [2, 3, 4]) is sampled per normal episode
        when a pool is used; without it a pool fills 3 opponents (4 players).
        team_ratio: share of team episodes (4 seats, partner at seat 2, drawn
        from partner_pool when given). "self" seats play an ONNX snapshot from
        selfplay_dir / selfplay_models; without one they play heuristic zen.
        """
        super().__init__()
        if team_ratio > 0 and obs_version < 2:
            raise ValueError("team episodes need obs_version=2 (the v1 encoding has no team features)")
        self.opponent_difficulty = opponent_difficulty
        self.opponents = opponents
        self.opponent_difficulties = opponent_difficulties
        self.opponent_pool = opponent_pool
        self.partner_pool = partner_pool
        self.obs_version = int(obs_version)
        self.team_ratio = float(team_ratio)
        self.normal_seats = [int(n) for n in normal_seats] if normal_seats else None
        self.selfplay_dir = selfplay_dir
        self.selfplay_models = list(selfplay_models or [])
        self._rng = np.random.default_rng(seed)
        self._seed = seed
        self._node_bin = node_bin
        self._proc: Optional[subprocess.Popen] = None
        self._last_mask = None
        self._team = False
        self._players = 0
        self._seat_policy: dict = {}  # seat index -> (session, input name, input size)
        self._snapshots: dict = {}  # path -> (mtime, session, input name, input size)

        self._start_proc()
        meta = self._rpc({"cmd": "meta", "obsVersion": self.obs_version})
        if "error" in meta:
            raise RuntimeError(f"env server: {meta['error']}")
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
        resp = json.loads(line)
        if "error" in resp:
            raise RuntimeError(f"env server: {resp['error']}")
        return resp

    # -- self-play -------------------------------------------------------------
    def _snapshot_paths(self) -> list:
        paths = list(self.selfplay_models)
        if self.selfplay_dir:
            paths += sorted(glob.glob(os.path.join(self.selfplay_dir, "*.onnx")))
        return [p for p in paths if os.path.exists(p)]

    def _load_snapshot(self, path: str):
        """An ONNX session per snapshot file, reloaded when the trainer replaces it."""
        try:
            mtime = os.path.getmtime(path)
            cached = self._snapshots.get(path)
            if cached and cached[0] == mtime:
                return cached[1:]
            import onnxruntime as ort  # only needed for self-play

            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 1  # hundreds of env workers: one thread each
            opts.inter_op_num_threads = 1
            sess = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
            inp = sess.get_inputs()[0]
            size = int(inp.shape[-1])
            if size > self.obs_size:
                return None  # a model for a newer encoder than this env serves
            self._snapshots[path] = (mtime, sess, inp.name, size)
            return sess, inp.name, size
        except Exception as e:  # a half-written or broken file: heuristic this episode
            print(f"[self-play] cannot load {path}: {e}", file=sys.stderr)
            return None

    def _resolve_seats(self, diffs: list) -> list:
        """Map "self" entries to snapshot policies; fall back to heuristic zen."""
        self._seat_policy = {}
        paths = self._snapshot_paths() if SELF in diffs else []
        out = []
        for i, d in enumerate(diffs):
            if d == SELF and paths:
                policy = self._load_snapshot(paths[int(self._rng.integers(len(paths)))])
                if policy is not None:
                    self._seat_policy[i + 1] = policy
                    out.append(SELF)
                    continue
            out.append(HEURISTIC_FALLBACK if d == SELF else str(d))
        return out

    def _selfplay_action(self, seat: int, resp: dict) -> int:
        mask = np.asarray(resp["mask"], dtype=bool)
        policy = self._seat_policy.get(seat)
        if policy is None:  # should not happen: the server only waits on "self" seats
            return int(np.flatnonzero(mask)[0])
        sess, name, size = policy
        # A v1 snapshot reads the first 377 values: v2 starts with v1 unchanged (StateEncoder contract).
        obs = np.asarray(resp["obs"], dtype=np.float32)[:size].reshape(1, -1)
        logits = sess.run(None, {name: obs})[0][0].astype(np.float64)
        logits[~mask] = -np.inf
        return int(np.argmax(logits))  # greedy, like the bot at runtime

    def _drive(self, resp: dict, reward: float = 0.0):
        """Answer self-play seats until the agent (seat 0) decides or the game ends."""
        while not resp["done"] and int(resp.get("seat", 0)) != 0:
            resp = self._rpc({"cmd": "step", "action": self._selfplay_action(int(resp["seat"]), resp)})
            reward += float(resp.get("reward", 0.0))
        return resp, reward

    # -- gym api ---------------------------------------------------------------
    def _sample_table(self):
        self._team = self.team_ratio > 0 and bool(self._rng.random() < self.team_ratio)
        if self.opponent_difficulties is not None:
            return list(self.opponent_difficulties)
        if not self.opponent_pool:
            return None
        if self._team:
            seats = 3
        elif self.normal_seats:
            seats = int(self._rng.choice(self.normal_seats)) - 1
        else:
            seats = 3
        diffs = [str(d) for d in self._rng.choice(self.opponent_pool, size=seats)]
        if self._team and self.partner_pool:
            diffs[1] = str(self._rng.choice(self.partner_pool))  # seat 2 is the partner
        return diffs

    def reset(self, *, seed=None, options=None):
        if seed is not None:
            self._seed = seed
        opp_diffs = self._sample_table()
        msg = {"cmd": "reset", "difficulty": self.opponent_difficulty, "opponents": self.opponents}
        if opp_diffs is not None:
            msg["opponentDifficulties"] = self._resolve_seats(opp_diffs)
        else:
            self._seat_policy = {}
        if self._team:
            msg["teamMode"] = True
        if self._seed is not None:
            msg["seed"] = int(self._seed) & 0xFFFFFFFF
            # vary the seed per episode so we do not overfit one deal
            self._seed = (self._seed * 1103515245 + 12345) & 0xFFFFFFFF
        if self._team:
            self._players = 4
        elif opp_diffs is not None:
            self._players = len(opp_diffs[:3]) + 1
        else:
            self._players = max(2, min(4, int(self.opponents or 3)))  # the server's count rule
        resp, _ = self._drive(self._rpc(msg))
        self._last_mask = np.array(resp["mask"], dtype=bool)
        obs = np.array(resp["obs"], dtype=np.float32)
        return obs, {"team": self._team, "players": self._players}

    def step(self, action):
        resp = self._rpc({"cmd": "step", "action": int(action)})
        resp, reward = self._drive(resp, float(resp.get("reward", 0.0)))
        self._last_mask = np.array(resp["mask"], dtype=bool)
        obs = np.array(resp["obs"], dtype=np.float32)
        done = bool(resp["done"])
        # On the terminal step the bridge also reports the OUTCOME. The reward is
        # a relative margin and cannot tell you who won, so pass it through in
        # `info` - that is what evaluation needs for a win rate.
        info = {"team": self._team, "players": self._players}
        if done:
            info["won"] = bool(resp.get("won", False))
            info["totals"] = resp.get("totals", {})
            if "teamTotals" in resp:
                info["team_totals"] = resp["teamTotals"]
        return obs, reward, done, False, info

    def action_masks(self) -> np.ndarray:
        """Consumed by sb3-contrib MaskablePPO. All-False (terminal) -> allow all
        so the sampler does not divide by zero; those steps are ignored anyway."""
        if self._last_mask is None or not self._last_mask.any():
            return np.ones(self.action_size, dtype=bool)
        return self._last_mask

    def close(self):
        if self._proc is not None:
            try:
                self._proc.stdin.write(json.dumps({"cmd": "close"}) + "\n")
                self._proc.stdin.flush()
            except Exception:
                pass
            try:
                self._proc.wait(timeout=5)
            except Exception:
                self._proc.terminate()
            self._proc = None
