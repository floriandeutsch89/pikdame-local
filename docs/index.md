# Pik Dame

**Pik Dame** is a self-hosted, real-time multiplayer card game — the German
family variant of **Rommé** where the Queen of Spades is worth 100 points, for
better or worse. It runs in the browser, needs no app store, and plays 2–4
people across devices, filling empty seats with bots.

**▶ Live demo: [play.pikdame.online](https://play.pikdame.online)**

::::{grid} 2
:gutter: 3

:::{grid-item-card} 🚀 Getting started
:link: getting-started
:link-type: doc

Run it with Docker in a minute, or the full production stack with automatic TLS.
:::

:::{grid-item-card} 🛠️ Admin manual
:link: admin/index
:link-type: doc

Configuration, backup & restore, ONNX bots, monitoring, upgrades.
:::

:::{grid-item-card} 💻 Developer guide
:link: developer/index
:link-type: doc

Architecture, WebSocket protocol, contributing, running the tests.
:::

:::{grid-item-card} ❓ FAQ
:link: faq
:link-type: doc

Fairness of the shuffle, data privacy, bots, scaling.
:::

::::

## What it is

- **Real multiplayer, no accounts required.** Create a game, share the link or
  the six-character code, play. Accounts are optional and only add profiles and
  statistics.
- **Bots that hold up.** Three difficulty levels; every behavioural change to
  them is A/B-measured in self-play before it ships (see {doc}`developer/bots`).
- **Self-hosted.** One container plus a volume. No telemetry, no ads, no
  third-party services in the game path.
- **Survives deployments.** Running tables are snapshotted and restored across
  restarts, so a `docker pull` mid-game does not kill the round.

```{toctree}
:hidden:
:caption: Getting started

overview
getting-started
```

```{toctree}
:hidden:
:caption: Admin manual

admin/index
admin/configuration
admin/backup-restore
admin/onnx
admin/operations
```

```{toctree}
:hidden:
:caption: Developer guide

developer/index
developer/architecture
developer/protocol
developer/bots
developer/rl-training
developer/contributing
```

```{toctree}
:hidden:
:caption: Project

faq
roadmap
releases
```
