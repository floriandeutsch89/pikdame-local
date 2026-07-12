# Releases

Every merge to `main` with a version bump is tagged and released automatically.

**➡️ [All releases on GitHub](https://github.com/floriandeutsch89/pikdame-local/releases)**

**Two** container images are published to the GitHub Container Registry on every
release, both for **amd64 and arm64** (so a Raspberry Pi works too):

```bash
# The default image: small, Alpine-based, heuristic bots
docker pull ghcr.io/floriandeutsch89/pikdame-local:latest

# With the trained ONNX bots baked in (Debian-based, larger)
docker pull ghcr.io/floriandeutsch89/pikdame-local-onnx:latest
```

Most people want the first one. The ONNX image exists because
`onnxruntime-node` ships glibc-linked binaries that cannot run on Alpine — see
{doc}`admin/onnx`. Both use the same UID/GID, so they share a data volume.

## Versioning

[Semantic versioning](https://semver.org/), loosely:

- **Major** — a breaking change to how you run or configure it.
- **Minor** — new features, new gameplay, notable behaviour changes.
- **Patch** — bug fixes, performance, internals.

## Changelog

The complete, human-readable changelog is kept in the repository — in German,
since it is written for the people who actually play the game:

**➡️ [CHANGELOG.md](https://github.com/floriandeutsch89/pikdame-local/blob/main/CHANGELOG.md)**

## Upgrading

The stack auto-updates nightly via Watchtower. To pull a new version by hand:

```bash
cd docker
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

Running games survive the restart — tables are snapshotted on shutdown and
restored on start, and clients reconnect on their own.
