# Reading the training output

`train.py` uses **MaskablePPO** (sb3-contrib). Every `n_steps` it prints a table
of metrics. They look cryptic, so here is what each one means, what a *healthy*
value looks like, and what it tells you when it goes wrong.

## How the reward works — read this first

The reward (see `scripts/rl-env-server.js`) is:

```text
per round:      (my score − the AVERAGE opponent's score) / 100
at game over:   +1 if I win, −1 otherwise
```

Two consequences worth internalising:

1. **The round term is centred on zero.** An average player scores about the
   same as the average opponent, so their round reward is ≈ 0. A *positive*
   round reward therefore means genuinely "better than this table".
2. **The terminal term is not.** For four equal players its expected value is
   `0.25·(+1) + 0.75·(−1) = **−0.50**`. So even a perfectly average agent lands
   at roughly **−0.5**, not 0.

### The baseline to judge against

Measured over 400 games with the **heuristic bot** sitting on the agent's seat:

| Policy on the agent's seat | Mean episode reward | of which: rounds |
| --- | --- | --- |
| Heuristic bot (`medium`) | **−0.62** | −0.07 |
| Heuristic bot (`zen`) | **−0.59** | −0.12 |

So **≈ −0.6 is "as good as the bot you are playing against"**, and the number to
beat. Anything meaningfully above that is a real improvement; `0` would mean
winning noticeably more than a fair share of games.

**Use the win rate as the headline number.** With four players, **25 % is par**.
`eval_onnx.py` prints it with a standard error — over only 40 games the noise is
large, so do not over-read small differences.

:::{warning}
**This changed in v1.63.0.** The reward used to compare against the **maximum**
of the three opponents, which made it *structurally* negative (a heuristic bot
scored ≈ **−5.4** and a round reward of 0 was unreachable). Two things follow:

- **Numbers from before v1.63.0 are not comparable** with numbers after it.
- **Models trained before v1.63.0 optimised a different objective.** Retrain them
  to benefit; the old scheme can be reproduced with `PIKDAME_RL_REWARD=max`.
:::

### Why the change

Comparing against the *best* of three opponents means your reward depends heavily
on whichever opponent happened to draw a lucky hand — **noise the agent cannot
influence**. Noise in the target is exactly what prevents the critic from
learning (it shows up as a poor `explained_variance`), so the actor ends up
learning largely from luck.

Measured effect of switching to the average (400 games each):

| | Round reward for an average player | Spread (SD of episode reward) |
| --- | --- | --- |
| `max` (old) | **−5.17** | 3.69 |
| `mean` (new) | **−0.07** | **2.96** |

The signal is now centred *and* about 20 % less noisy, for the same games.

## The metric table

### The ones that tell you if it is learning

| Metric | What it is | Healthy | Trouble |
| --- | --- | --- | --- |
| `ep_rew_mean` | Mean episode reward over recent episodes. **The thing being optimised** — but see the trap above: judge it against the baseline, not zero. | Rising, then flattening | Flat from the start, or falling |
| `explained_variance` | How well the value network predicts actual returns. `1.0` = perfect, `0.0` = no better than guessing the mean, **negative = worse than guessing**. | Climbing towards 0.3–0.9 | Stuck near 0, or negative → the critic is not learning; usually the reward is too noisy or the observation is missing information |
| `ep_len_mean` | Mean episode length (decisions per game). | Stable | Wild swings usually mean the game is ending in a degenerate way |

### The ones that tell you if the optimisation is *healthy*

| Metric | What it is | Healthy | Trouble |
| --- | --- | --- | --- |
| `approx_kl` | How far the updated policy moved from the old one, per update. PPO's whole point is keeping this **small**. | ~0.003 – 0.02 | **Above ~0.05**: steps are too big — the policy lurches and can collapse. Lower the learning rate or `clip_range`. **Near 0**: it has stopped learning |
| `clip_fraction` | Fraction of samples where PPO's clipping actually kicked in — i.e. the update *wanted* to move further than allowed. | ~0.05 – 0.2 | Above ~0.3: consistently hitting the brakes → learning rate too high. Near 0: the brakes never engage, updates are timid |
| `policy_gradient_loss` | The actor's loss term. Its **absolute value is not meaningful** — only its trend. Negative values are normal. | Fluctuating, no explosion | Growing without bound |
| `value_loss` | Error of the critic predicting returns. Scale depends entirely on your reward magnitude. | Falls, then plateaus | Rising steadily → the critic is diverging, often paired with negative `explained_variance` |
| `entropy_loss` | Negative entropy of the policy. **More negative = more decisive** (less random). | Slowly becoming more negative | Crashes to very negative early = **premature convergence**: the policy locked in and stopped exploring. Raise `ent_coef` |
| `learning_rate` | Current LR (constant unless you schedule it). | — | — |

### The ones that are just bookkeeping

| Metric | Meaning |
| --- | --- |
| `fps` | Environment steps per second. Only matters for your patience. |
| `iterations` | Number of PPO update rounds so far. |
| `time_elapsed` | Seconds since training started. |
| `total_timesteps` | Environment steps consumed overall — the real measure of "how much training". |

## A quick diagnosis flow

**"Reward isn't improving."** First check `explained_variance`. If it is near zero
or negative, the critic cannot predict the return at all, and the actor is
therefore learning from noise. That is a *reward/observation* problem, not a
hyperparameter problem.

**"It learned, then got worse."** Look at `approx_kl` and `clip_fraction` around
the collapse. If `approx_kl` spiked above ~0.05, the update was too aggressive.
Lower the learning rate.

**"It plateaued early and plays the same move every time."** Look at
`entropy_loss`: if it dropped steeply and early, the policy converged before it
had explored. Increase `ent_coef`.

**"The numbers look fine but it still loses."** Check the **win rate** rather than
the reward — 25 % is par against three equal opponents. And judge the reward
against the heuristic baseline (**≈ −0.6**, see above), not against zero: the
terminal term alone puts an average player at −0.5.

## Reproducing the old reward

```bash
PIKDAME_RL_REWARD=max python train.py ...
```

Only useful for comparing against pre-v1.63.0 runs. The default (`mean`) is the
one to train with.
