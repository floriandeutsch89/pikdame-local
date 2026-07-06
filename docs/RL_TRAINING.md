# Pik Dame – Bot-Training mit Reinforcement Learning (WSL2 / Windows 11)

Diese Anleitung beschreibt, wie du die vier Bot-Stufen (`easy`, `medium`,
`hard`, `zen`) als neuronale Netze trainierst und als **ONNX-Dateien**
exportierst, die die Node-Spiel-Engine zur Laufzeit nutzen kann.

Das Besondere: Trainiert wird gegen die **echte Spiel-Engine**. Ein kleiner
Node-Server (`scripts/rl-env-server.js`) treibt den echten `GameManager`; die
Python-Umgebung steuert ihn über eine Textleitung. So lernt das Netz gegen die
exakten Spielregeln – kein fehleranfälliger Regel-Nachbau in Python.

Aktuell lernt der Agent die **Abwurfentscheidung** (Ziehen und Auslegen
übernimmt weiter die bewährte Heuristik). Der Aktionsraum sind 52 Kartentypen
mit Legalitäts-Maske. Der Beobachtungsvektor (376 Werte) kommt aus
`game/StateEncoder.js` – **dieselbe** Datei speist Training und Laufzeit, damit
beide garantiert identisch kodieren.

---

## 1. Voraussetzungen

- Windows 11 mit **WSL2** (Ubuntu 22.04 empfohlen)
- NVIDIA-Treiber für Windows (der WSL2-CUDA-Stack nutzt ihn automatisch mit)
- Deine **RTX 5080** – für PyTorch mit CUDA
- **Node.js 22+** und **Python 3.11** innerhalb der WSL2-Distribution

### 1.1 WSL2 vorbereiten

```bash
# in Windows PowerShell (als Admin), falls noch nicht geschehen:
wsl --install -d Ubuntu-22.04
```

### 1.2 Node.js in WSL2

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v22.x
```

### 1.3 Python-Umgebung

```bash
sudo apt-get install -y python3.11 python3.11-venv python3-pip
cd /pfad/zu/pikdame-local
python3.11 -m venv .venv
source .venv/bin/activate
```

### 1.4 PyTorch mit CUDA (RTX 5080)

Die RTX 5080 (Blackwell) braucht einen aktuellen CUDA-Build. Installiere das
zu deinem Treiber passende Wheel ZUERST, danach den Rest:

```bash
# Beispiel – prüfe die aktuell empfohlene CUDA-Version auf pytorch.org:
pip install torch --index-url https://download.pytorch.org/whl/cu124
pip install -r python/requirements.txt
```

Test, ob die GPU sichtbar ist:

```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# True  NVIDIA GeForce RTX 5080
```

### 1.5 Node-Abhängigkeiten (inkl. ONNX-Laufzeit)

```bash
npm install
npm install onnxruntime-node    # optionale Laufzeit für die Inferenz im Spiel
```

---

## 2. Schnelltest der Trainings-Bridge (ohne GPU)

Prüft, dass der Node-Env-Server läuft und Beobachtungen liefert:

```bash
printf '%s\n' \
  '{"cmd":"meta"}' \
  '{"cmd":"reset","difficulty":"hard","opponents":3,"seed":7}' \
  '{"cmd":"step","action":0}' \
  '{"cmd":"close"}' | node scripts/rl-env-server.js
```

Erwartete Ausgabe: eine `meta`-Zeile mit `obs_size` und `action_size`, dann
JSON-Objekte mit `obs`/`mask`/`reward`/`done`.

Ein Gegentest der Python-Anbindung:

```bash
source .venv/bin/activate
python - <<'PY'
from python.pikdame_env import PikDameEnv
env = PikDameEnv(opponent_difficulty="hard", opponents=3, seed=1)
obs, _ = env.reset()
print("obs shape:", obs.shape, "| legal actions:", int(env.action_masks().sum()))
obs, r, done, _, _ = env.step(int(env.action_masks().argmax()))
print("stepped -> reward", r, "done", done)
env.close()
PY
```

---

## 3. Training

Alle vier Stufen nacheinander:

```bash
source .venv/bin/activate
cd python
python train.py --tier all
```

Einzelne Stufe (mit eigener Schrittzahl):

```bash
python train.py --tier zen --steps 3000000
python train.py --tier easy --steps 200000
```

Die Stufen unterscheiden sich durch Gegnerstärke und Trainingsdauer (Curriculum
in `TIERS` in `train.py`):

| Stufe   | Gegner | Schritte (Default) |
|---------|--------|--------------------|
| easy    | easy   | 200 000            |
| medium  | medium | 800 000            |
| hard    | hard   | 2 000 000          |
| zen     | hard   | 3 000 000          |

Jede Stufe erzeugt:

- `models/pikdame-<stufe>.zip` – SB3-Checkpoint (zum Weitertrainieren)
- `models/pikdame-<stufe>.onnx` – das exportierte Netz für die Node-Laufzeit

Tipp: Mehrere Env-Prozesse parallel beschleunigen das Sammeln von Erfahrung.
Das lässt sich über SB3-`SubprocVecEnv` ergänzen (siehe Kommentar in
`train.py`); jeder Env startet einen eigenen `node`-Prozess.

---

## 4. Modelle prüfen

```bash
python eval_onnx.py --tier zen --episodes 20
```

Gibt die mittlere Episoden-Belohnung (Punktesaldo/100 + Sieg-Bonus) aus. Positiv
= der Agent schlägt die Heuristik-Gegner im Schnitt.

---

## 5. Im Spiel aktivieren

Die ONNX-Inferenz ist **per Umgebungsvariable** schaltbar und standardmäßig aus.
Liegen die Modelle unter `models/` und ist `onnxruntime-node` installiert:

```bash
PIKDAME_ONNX=1 node server.js
```

Ist die Variable nicht gesetzt (oder fehlt ein Modell / die Laufzeit), spielt der
Bot **exakt wie bisher** mit der Heuristik – die Integration greift nur, wenn
alles vorhanden ist, und fällt bei jedem Problem lautlos auf die Heuristik
zurück. Pro Bot-Stufe wird `models/pikdame-<stufe>.onnx` geladen.

Für den Produktions-Container: `PIKDAME_ONNX=1` als Environment-Variable setzen,
die `models/`-Dateien und `onnxruntime-node` ins Image aufnehmen.

---

## 6. Architektur auf einen Blick

```
Python (GPU-Training)                    Node (echte Spiel-Engine)
──────────────────────                   ──────────────────────────
train.py                                 scripts/rl-env-server.js
  └─ MaskablePPO (SB3)                      └─ GameManager (reale Regeln)
       └─ PikDameEnv  ── stdio JSON ───►        └─ StateEncoder.encode()
            (pikdame_env.py)             ◄───        obs / mask / reward
                                                └─ externalDiscard='pause'
       └─ export ONNX ─► models/pikdame-*.onnx

Laufzeit-Inferenz:
  server.js (PIKDAME_ONNX=1)
    └─ GameManager._runBotTurnWithOnnx()
         └─ OnnxPolicy.chooseDiscardCard()
              └─ StateEncoder.encode()  ─►  onnxruntime-node  ─►  Abwurf
```

**Wichtig – Encoder-Parität:** `game/StateEncoder.js` ist die einzige Stelle,
die Spielzustände fürs Netz kodiert. Ändere sie nie einseitig; jede Änderung
verändert die Modell-Eingabe und macht bestehende `.onnx`-Dateien inkompatibel
(dann neu trainieren).

---

## 7. Nächste Ausbaustufen (optional)

- **Ziehen & Auslegen lernen:** aktuell heuristisch. Der Aktionsraum ließe sich
  um „Stapel nehmen ja/nein" und Auslege-Entscheidungen erweitern (mehr Köpfe im
  Netz oder ein hierarchischer Agent).
- **Self-Play:** Gegner nicht heuristisch, sondern frühere Modell-Versionen
  (Liga-Training) für stärkere Endmodelle.
- **Reward-Shaping:** aktuell sparsamer Rundensaldo; Zwischenbelohnungen (z. B.
  gemeldeter Kartenwert) können das Lernen beschleunigen.
