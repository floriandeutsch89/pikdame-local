# Pik Dame on Kubernetes

## The most important property first

**The server is a single instance by design** (`replicas: 1`,
`strategy: Recreate`): game sessions live in process memory. Scaling out
would split players across instances that know nothing about each other.
For its purpose (family and friends' tables, 200-session limit) one instance
is plenty; the session snapshot bridges updates, running games survive a pod
restart.

**PostgreSQL is mandatory.** Without `PIKDAME_DATABASE_URL` the server does
not start. Use a managed or operator-run database and put the URL into a
Secret (see below).

## Recommended: Helm chart

The chart lives in `helm/pikdame` and is published as an OCI artifact on
GHCR with every release, so no checkout is needed:

```sh
kubectl create secret generic pikdame-db \
  --from-literal=url='postgres://pikdame:<password>@<host>:5432/pikdame'

helm install pikdame oci://ghcr.io/floriandeutsch89/charts/pikdame \
  --version <X.Y.Z> \
  --set ingress.host=spiel.pikdame.online \
  --set image.tag=v<X.Y.Z>

# Update / rollback:
helm upgrade pikdame oci://ghcr.io/floriandeutsch89/charts/pikdame --version <new> --reuse-values
helm rollback pikdame
```

The chart reads the database URL from the Secret `pikdame-db` (key `url`)
unless `database.existingSecret` or `database.url` say otherwise. Every other
setting (TLS, storage class, secret name, limits) is documented in
`helm/pikdame/values.yaml`. CI lints and renders the chart on every PR.

## Alternative: plain manifests

```sh
kubectl create secret generic pikdame-db --from-literal=url='postgres://…'
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml   # adjust the host first
```

Pin the image to a fixed version in production
(`ghcr.io/floriandeutsch89/pikdame-local:vX.Y.Z`); a rollback is then a
`kubectl set image` to the previous tag.

## Secrets (SMTP, base URL)

```sh
kubectl create secret generic pikdame-env \
  --from-literal=PIKDAME_BASE_URL=https://spiel.pikdame.online \
  --from-literal=PIKDAME_SMTP_HOST=smtp.example.com \
  --from-literal=PIKDAME_SMTP_PORT=587 \
  --from-literal=PIKDAME_SMTP_SECURE=starttls \
  --from-literal=PIKDAME_SMTP_USER=noreply@pikdame.online \
  --from-literal=PIKDAME_SMTP_PASS=secret \
  --from-literal=PIKDAME_MAIL_FROM='Pik Dame <noreply@pikdame.online>'
```

Then uncomment the `envFrom` block in the deployment.

## Security

The pod mirrors the OWASP hardening of the Docker setup: non-root,
`readOnlyRootFilesystem`, all capabilities dropped, no privilege escalation,
seccomp `RuntimeDefault`, `/tmp` as a bounded emptyDir, resource limits.
Details: `SECURITY.md` in the repository root.

## Backup

Back up the PostgreSQL database with the tools of its operator or provider
(`pg_dump` at minimum). The PVC holds the remaining files of the data
directory; archive it the same way as under Docker (see
https://pik-dame.readthedocs.io/en/latest/admin/operations.html): scale the
pod to 0, archive the PVC, scale back to 1:

```sh
kubectl scale deploy/pikdame --replicas=0
kubectl run backup --rm -i --image=alpine --overrides='{"spec":{"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"pikdame-data"}}],"containers":[{"name":"backup","image":"alpine","stdin":true,"volumeMounts":[{"name":"d","mountPath":"/data"}],"command":["tar","czf","-","-C","/data","."]}]}}' > pikdame-backup.tar.gz
kubectl scale deploy/pikdame --replicas=1
```
