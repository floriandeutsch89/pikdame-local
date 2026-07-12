# Reading the training output

`train.py` uses **MaskablePPO** (sb3-contrib). Every `n_steps` it prints a table
of metrics. They look cryptic, so here is what each one means, what a *healthy*
value looks like, and what it tells you when it goes wrong.

## The reward trap — read this first

:::{warning}
**A mean episode reward of ‑2.3 is not a bug, and not even bad.** The reward is
*relative*, and against three equally strong opponents it is **negative by
construction**.
:::

The reward (see `scripts/rl-env-server.js`) is:

```text
per round:      (my score − the BEST opponent's score) / 100
at game over:   +1 if I win, −1 otherwise
```

Two things follow immediately:

1. **You are compared against the maximum of three opponents, every round.** Even
   a perfectly average player scores below the best of three most of the time.
   Summed over the ~6 rounds of a game, that alone is worth roughly **−5**.
2. **The terminal term has an expected value of −0.5** for an equal player:
   `0.25·(+1) + 0.75·(−1) = −0.50`.

So a mean reward near **zero would mean beating the best of three opponents in
essentially every round *and* winning the game** — which is not achievable in a
fair four-player game, no matter how good the policy is.

### What to compare against instead

The **heuristic bot itself**, measured in this exact reward scheme over 300
games, scores:

| Policy on the agent's seat | Mean episode reward |
| --- | --- |
| Heuristic bot (`medium`) | **−5.37** |
| Heuristic bot (`zen`) | **−5.17** |
| *(a trained model at)* | *−2.33 → clearly **better** than the bot it plays against* |

**Use the win rate as the headline number.** With four players, **25 % is par**;
meaningfully above 25 % means the policy is genuinely stronger. `eval_onnx.py`
now prints it, alongside the standard error — over only 40 games the noise is
large, so do not over-read small differences.

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

**"The numbers look fine but it still loses."** That is the most likely case here,
and it is not a training problem at all — see the reward trap above. Measure the
**win rate** against the heuristic and compare with the −5.2/−5.4 baseline.

## Suggested improvement to the reward

The current reward compares against the **maximum** of the opponents. That is a
harsh, high-variance signal: your reward depends heavily on whichever opponent
happened to get a lucky hand. Comparing against the **mean** of the opponents
would be a lower-variance signal that still measures "am I better than the
table", and would make `explained_variance` easier to improve:

```js
// scripts/rl-env-server.js, _roundReward()
const avg = others.reduce((a, b) => a + b, 0) / others.length;
return (mine - avg) / 100;   // instead of Math.max(...others)
```

This is a **suggestion, not a change** — it alters what the agent optimises, so
it should be tried and measured rather than assumed better.
