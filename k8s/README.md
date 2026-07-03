# Pik Dame auf Kubernetes

## Wichtigste Betriebs-Eigenschaft zuerst

**Der Server ist bewusst eine Einzel-Instanz** (`replicas: 1`,
`strategy: Recreate`): Spielsitzungen leben im Prozess-Speicher, die
Konten-Datenbank ist eine lokale SQLite-Datei auf dem PVC. Horizontal
skalieren würde Spieler auf Instanzen verteilen, die nichts voneinander
wissen. Für den Zweck (Familien- und Freundesrunden, 200-Session-Limit)
reicht eine Instanz mit großem Abstand — Updates überbrückt der
Session-Snapshot: laufende Spiele überleben den Pod-Neustart.

## Deployment

```sh
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml   # Host vorher anpassen
```

In Produktion das Image auf eine feste Version pinnen
(`ghcr.io/floriandeutsch89/pikdame-local:vX.Y.Z`) — Rollback ist dann ein
`kubectl set image` auf den vorherigen Tag.

## Secrets (SMTP, Basis-URL)

```sh
kubectl create secret generic pikdame-env \
  --from-literal=PIKDAME_BASE_URL=https://spiel.pikdame.online \
  --from-literal=PIKDAME_SMTP_HOST=smtp.example.com \
  --from-literal=PIKDAME_SMTP_PORT=587 \
  --from-literal=PIKDAME_SMTP_SECURE=starttls \
  --from-literal=PIKDAME_SMTP_USER=noreply@pikdame.online \
  --from-literal=PIKDAME_SMTP_PASS=geheim \
  --from-literal=PIKDAME_MAIL_FROM='Pik Dame <noreply@pikdame.online>'
```

Danach im Deployment den `envFrom`-Block einkommentieren.

## Sicherheit

Der Pod spiegelt die OWASP-Härtung des Docker-Betriebs: non-root,
`readOnlyRootFilesystem`, alle Capabilities entzogen, kein
Privilege-Escalation, Seccomp `RuntimeDefault`, `/tmp` als begrenztes
emptyDir, Ressourcen-Limits. Details: `SECURITY.md` im Repo-Root.

## Backup

Dasselbe Prinzip wie unter Docker (siehe `docs/OPERATIONS.md`): Pod kurz
auf 0 skalieren, PVC-Inhalt archivieren, wieder auf 1 skalieren:

```sh
kubectl scale deploy/pikdame --replicas=0
kubectl run backup --rm -i --image=alpine --overrides='{"spec":{"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"pikdame-data"}}],"containers":[{"name":"backup","image":"alpine","stdin":true,"volumeMounts":[{"name":"d","mountPath":"/data"}],"command":["tar","czf","-","-C","/data","."]}]}}' > pikdame-backup.tar.gz
kubectl scale deploy/pikdame --replicas=1
```
