# Forgejo HA + Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forgejo upgraded 13.0.5 → 15.0.3 LTS and running 2 web replicas + 1 dedicated cron replica, all state on shared/NFS or Redis — no single-pod state left.

**Architecture:** Keep the existing **raw-manifest** deployment (user decision 2026-06-11 — not the Helm chart). HA blockers in current state: file-based sessions, on-disk level queue, in-memory cache, bleve issue indexer, instance secrets (INTERNAL_TOKEN etc.) generated into a per-pod app.ini, and an RWO config PVC. Fixes: Redis for session/cache/queue, `db` issue indexer, all generated secrets promoted to Azure KV → env (making app.ini fully env-derived so the custom dir becomes an emptyDir), cron deduplicated via a separate single-replica deployment with cron enabled while web replicas have it disabled. Git data already lives on shared NFS (`192.168.7.14:/mnt/tank/git` inline volume — already effectively RWX; no migration needed).

**Tech Stack:** Forgejo rootless image, Redis (alpine), ExternalSecrets + Azure KV, Flux.

**Prerequisite:** Backup plan (`2026-06-11-forgejo-aws-backups.md`) executed and verified — Forgejo upgrade docs require a full backup, and 13→14→15 crosses two majors.

**Current state inventory (verified on cluster 2026-06-11):**
- `apps/base/forgejo/deployment.yaml`: 1 replica, Recreate, image `forgejo:13.0.5-rootless`, custom dir on RWO PVC `forgejo-config` (contains only `conf/app.ini`), data on inline NFS.
- `apps/tachtit/forgejo/configmap.yaml`: env config; sessions at `/data/app/sessions` (file), no queue/cache/indexer settings (defaults: level queue on disk, memory cache, bleve issue indexer at `/data/app/indexers`), code indexer disabled (default) → **no Meilisearch/Elasticsearch needed; `db` issue indexer suffices**.
- ESO secret `forgejo-db-env` carries DB creds, runner token, SECRET_KEY. INTERNAL_TOKEN / OAuth2 JWT_SECRET / LFS_JWT_SECRET are **not** in env — they live only in the generated app.ini.

---

### Task 1: Promote app.ini-generated secrets to Azure KV → env

**Files:**
- Modify: `apps/base/forgejo/secrets.yaml` (forgejo-db-env ExternalSecret)

- [ ] **Step 1: Extract current values from the running pod and store in Azure KV** (values piped, never printed):

```bash
export KUBECONFIG=tachtit-kubeconfig.yaml
ini() { kubectl exec -n forgejo deploy/forgejo -c forgejo -- sh -c "awk -F' = ' '/^$1/ {print \$2}' /var/lib/gitea/custom/conf/app.ini"; }
az keyvault secret set --vault-name seyzahl --name forgejo-internal-token --value "$(ini INTERNAL_TOKEN)" -o none
az keyvault secret set --vault-name seyzahl --name forgejo-oauth2-jwt-secret --value "$(ini JWT_SECRET)" -o none
az keyvault secret set --vault-name seyzahl --name forgejo-lfs-jwt-secret --value "$(ini LFS_JWT_SECRET)" -o none
```

If `LFS_JWT_SECRET` or `JWT_SECRET` come back empty (never generated), generate instead: `kubectl exec -n forgejo deploy/forgejo -c forgejo -- forgejo generate secret JWT_SECRET` etc., and store that.

- [ ] **Step 2: Add the three keys to the `forgejo-db-env` ExternalSecret** in `apps/base/forgejo/secrets.yaml`:

```yaml
    - secretKey: FORGEJO__security__INTERNAL_TOKEN
      remoteRef:
        key: forgejo-internal-token
    - secretKey: FORGEJO__oauth2__JWT_SECRET
      remoteRef:
        key: forgejo-oauth2-jwt-secret
    - secretKey: FORGEJO__server__LFS_JWT_SECRET
      remoteRef:
        key: forgejo-lfs-jwt-secret
```

- [ ] **Step 3: Commit, reconcile, verify pod restarts clean** (env now authoritative; app.ini values identical, so no behavior change):

```bash
git add apps/base/forgejo/secrets.yaml && git commit -m "feat(forgejo): move instance secrets to Azure KV via ExternalSecrets" && git push
flux reconcile kustomization apps --with-source
kubectl rollout restart deploy/forgejo -n forgejo && kubectl rollout status deploy/forgejo -n forgejo
# login + clone smoke test against https://forgejo.seyzahl.com
```

### Task 2: Redis + config rewire (still single replica)

**Files:**
- Create: `apps/base/forgejo/redis.yaml`
- Modify: `apps/base/forgejo/kustomization.yaml`
- Modify: `apps/tachtit/forgejo/configmap.yaml`

- [ ] **Step 1: Write `apps/base/forgejo/redis.yaml`** (mirrors `apps/base/authentik/deployment-redis.yaml` style):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: forgejo-redis
  namespace: forgejo
  labels:
    app: forgejo-redis
    app.kubernetes.io/name: redis
    app.kubernetes.io/instance: forgejo
    app.kubernetes.io/component: cache
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: forgejo-redis
  template:
    metadata:
      labels:
        app: forgejo-redis
        app.kubernetes.io/name: redis
        app.kubernetes.io/instance: forgejo
        app.kubernetes.io/component: cache
        policy-type: app
    spec:
      securityContext:
        runAsUser: 999
        runAsGroup: 999
        fsGroup: 999
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: redis
          image: docker.io/library/redis:alpine
          command:
            - redis-server
            - --save
            - "60"
            - "1"
            - --loglevel
            - warning
          ports:
            - name: redis
              containerPort: 6379
              protocol: TCP
          livenessProbe:
            tcpSocket:
              port: redis
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            initialDelaySeconds: 5
            periodSeconds: 10
          securityContext:
            allowPrivilegeEscalation: false
            runAsNonRoot: true
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              memory: 256Mi
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: forgejo-redis
  namespace: forgejo
  labels:
    app: forgejo-redis
spec:
  selector:
    app: forgejo-redis
  ports:
    - name: redis
      port: 6379
      targetPort: 6379
      protocol: TCP
```

Add `  - redis.yaml` to `apps/base/forgejo/kustomization.yaml` resources.

- [ ] **Step 2: Rewire config in `apps/tachtit/forgejo/configmap.yaml`** — replace `FORGEJO__session__PROVIDER_CONFIG: /data/app/sessions` with:

```yaml
  FORGEJO__session__PROVIDER: redis
  FORGEJO__session__PROVIDER_CONFIG: redis://forgejo-redis:6379/0
  FORGEJO__cache__ADAPTER: redis
  FORGEJO__cache__HOST: redis://forgejo-redis:6379/1
  FORGEJO__queue__TYPE: redis
  FORGEJO__queue__CONN_STR: redis://forgejo-redis:6379/2
  FORGEJO__indexer__ISSUE_INDEXER_TYPE: db
```

- [ ] **Step 3: Commit, reconcile, verify**

```bash
git add apps/base/forgejo apps/tachtit/forgejo && git commit -m "feat(forgejo): redis-backed session/cache/queue, db issue indexer" && git push
flux reconcile kustomization apps --with-source
kubectl rollout status deploy/forgejo-redis -n forgejo
kubectl rollout status deploy/forgejo -n forgejo
kubectl logs -n forgejo deploy/forgejo -c forgejo --tail=50   # expect: no queue/session errors
# Web smoke test: login (session via redis), open an issue search (db indexer), push a commit (queue)
```

Note: users are logged out once (sessions moved file→redis). Old `/data/app/sessions` and `/data/app/indexers` left in place; harmless.

### Task 3: Custom dir → emptyDir, drop RWO PVC

**Files:**
- Modify: `apps/base/forgejo/deployment.yaml`
- Modify: `apps/base/forgejo/kustomization.yaml` + Delete: `apps/base/forgejo/storage.yaml`

- [ ] **Step 1: In `deployment.yaml`**: remove the `fix-permissions` initContainer entirely; replace the `forgejo-config` volume:

```yaml
        - name: forgejo-config
          emptyDir: {}
```

(`fsGroup: 1000` already covers emptyDir ownership; app.ini is regenerated from env on every start — Task 1 made env complete.)

- [ ] **Step 2: Delete `storage.yaml`**, remove `  - storage.yaml` from `apps/base/forgejo/kustomization.yaml`.

- [ ] **Step 3: Commit, reconcile, verify** (Flux prunes the PVC — its data is now disposable by construction):

```bash
git add -A apps/base/forgejo && git commit -m "refactor(forgejo): env-derived app.ini, drop config PVC" && git push
flux reconcile kustomization apps --with-source
kubectl rollout status deploy/forgejo -n forgejo
kubectl exec -n forgejo deploy/forgejo -c forgejo -- grep INTERNAL_TOKEN /var/lib/gitea/custom/conf/app.ini | head -c 40
# expect: INTERNAL_TOKEN present (from env). Login + push smoke test again.
kubectl get pvc -n forgejo   # expect: forgejo-config gone
```

### Task 4: Upgrade 13.0.5 → 14.0.5 → 15.0.3 (sequential majors, single replica)

Forgejo majors require manual verification per release; do not skip (13→15 direct is unsupported territory).

- [ ] **Step 1: Pre-upgrade safety** (backups exist from the backup plan; take fresh ones):

```bash
kubectl create -n velero -f - <<'EOF'
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: forgejo-pre-upgrade
spec:
  includedNamespaces: ["forgejo"]
  ttl: 336h0m0s
EOF
KUBECONFIG=data-kubeconfig.yaml kubectl create -n forgejo -f - <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: forgejo-db-pre-upgrade
spec:
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
  cluster:
    name: forgejo-db-data-cnpg-v0
EOF
# wait for both: phase Completed
kubectl exec -n forgejo deploy/forgejo -c forgejo -- forgejo manager flush-queues
kubectl exec -n forgejo deploy/forgejo -c forgejo -- forgejo doctor check --all   # expect: no problems
```

- [ ] **Step 2: Bump image to `data.forgejo.org/forgejo/forgejo:14.0.5-rootless`** in `apps/base/forgejo/deployment.yaml`; commit (`chore(forgejo): upgrade to 14.0.5`), push, reconcile, then:

```bash
kubectl rollout status deploy/forgejo -n forgejo
kubectl logs -n forgejo deploy/forgejo -c forgejo | grep -i migrat | tail -5   # migrations ran clean
kubectl exec -n forgejo deploy/forgejo -c forgejo -- forgejo doctor check --all
# Web login + repo browse + push smoke test. Check release notes for 14.0 breaking changes before this step:
# https://codeberg.org/forgejo/forgejo/src/branch/forgejo/RELEASE-NOTES.md
```

- [ ] **Step 3: Bump image to `data.forgejo.org/forgejo/forgejo:15.0.3-rootless`**; same commit/verify cycle as Step 2 (including 15.0 release notes review).

### Task 5: Split web (×2, cron off) + cron (×1) deployments

**Files:**
- Modify: `apps/base/forgejo/deployment.yaml`
- Create: `apps/base/forgejo/deployment-cron.yaml`
- Modify: `apps/base/forgejo/kustomization.yaml`

- [ ] **Step 1: Web deployment changes** in `deployment.yaml`:

```yaml
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
```

Add to the container `env` list:

```yaml
            - name: FORGEJO__cron__ENABLED
              value: "false"
```

Add pod anti-affinity (under `spec.template.spec`):

```yaml
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: forgejo
                topologyKey: kubernetes.io/hostname
```

Remove the `backup.velero.io/backup-volumes` pod-template annotation (moves to cron deployment) and drop `forgejo-config` from any remaining backup annotation values.

- [ ] **Step 2: Create `deployment-cron.yaml`** — copy of the (post-Task-3/4) web deployment with these differences and nothing else:
  - `metadata.name: forgejo-cron`; all `app: forgejo` labels/selectors become `app: forgejo-cron` (pod template labels too — keeps it OUT of both Services' selectors); keep `policy-type: app`.
  - `replicas: 1`, `strategy.type: Recreate`, no anti-affinity.
  - **No** `FORGEJO__cron__ENABLED` env (defaults to true → this is the only cron runner).
  - Pod template annotation: `backup.velero.io/backup-volumes: forgejo-data` (Velero backs up NFS via this single pod).
  - Same volumes (inline NFS `forgejo-data`, emptyDir `forgejo-config`), same envFrom, same probes/resources.

Add `  - deployment-cron.yaml` to `apps/base/forgejo/kustomization.yaml` resources.

- [ ] **Step 3: Commit, reconcile, verify HA properties**

```bash
git add apps/base/forgejo && git commit -m "feat(forgejo): HA - 2 web replicas + dedicated cron deployment" && git push
flux reconcile kustomization apps --with-source
kubectl get pods -n forgejo -o wide   # expect: 2 web (different nodes) + 1 cron + redis, all Ready
kubectl get endpoints -n forgejo forgejo forgejo-ssh   # expect: exactly the 2 web pod IPs
# Cron dedup: only the cron pod logs cron activity
kubectl logs -n forgejo deploy/forgejo-cron -c forgejo | grep -i cron | head
kubectl logs -n forgejo deploy/forgejo -c forgejo --tail=200 | grep -ci "cron"   # expect: 0 (or startup-only noise)
# Session survival: log in via browser, then kill one web pod by name:
kubectl get pods -n forgejo -l app=forgejo
kubectl delete pod -n forgejo <one-of-the-two-web-pod-names>
# expect: browser refresh stays logged in (redis sessions), git clone/push still works
```

- [ ] **Step 4: SSH host-key sanity** — both web pods must present the same host key (it lives in `/data/ssh` on shared NFS):

```bash
for i in 1 2; do ssh-keyscan -p 2222 git.seyzahl.com 2>/dev/null | sort; done   # expect: identical output across attempts
```

---

## Accepted limitations
- Redis is single-replica (SPOF for sessions/queue; pod reschedule = brief outage + re-login). Acceptable homelab trade-off; revisit only if it actually hurts.
- The cron deployment also serves HTTP/SSH internally but receives no Service traffic; it's a full Forgejo instance by design (Forgejo has no cron-only mode).
- Velero backs up git data via the cron pod only — if cron pod is down at 10:00 UTC the day's PodVolumeBackup is skipped (Backup still completes; check `podvolumebackup` status when auditing).
