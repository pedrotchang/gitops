# Forgejo Backup to AWS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily Forgejo backups to AWS S3 with 7-day retention: CNPG Postgres (continuous WAL + daily base via barman-cloud plugin) and the git-data NFS volume (Velero + Kopia file-system backup), plus local ZFS snapshots (retain 5).

**Architecture:** Two clusters. `data` cluster: forgejo-db CNPG cluster migrates from in-tree Azure barman backup to the barman-cloud CNPG-I plugin pointed at S3 (decision: **AWS becomes primary** — CNPG supports exactly one WAL archiver). `tachtit` cluster: new Velero install (chart 12.0.2, node-agent + Kopia) backs up the Forgejo pod's NFS volume to S3 daily. Local point-in-time: TrueNAS periodic ZFS snapshot task on `tank/git` (one-time setup, documented — **assumption: Q4 went unanswered; using the recommended ZFS option**). Secrets: AWS keys flow `pass` → Azure Key Vault → ExternalSecrets (existing repo pattern; ESO cannot read `pass` directly).

**Tech Stack:** plugin-barman-cloud (CNPG-I), Velero 1.18 / chart 12.0.2 + velero-plugin-for-aws, Kopia uploader, ExternalSecrets + Azure KV, TrueNAS API.

**Decisions already made with user (2026-06-11):**
- S3 **Standard**, not Standard-IA (IA's 30-day minimum billing costs ~2.3× more at 7-day retention; no tooling support anyway).
- **AWS primary** for CNPG: WAL + base → S3, 7d retention. Azure stops receiving new backups; old Azure backups remain until manually cleaned (retention pruning stops when writes stop).

**Execute BEFORE the Forgejo HA/upgrade plan** — upgrades require a verified full backup first.

**Assumption to confirm at execution:** AWS region `us-west-2`. Trivial to change in Task A/C/D before running.

---

### Task A: AWS account prep (one-time, CLI — not GitOps)

- [ ] **Step 1: Get AWS credentials from pass**

```bash
pass show aws.amazon.com/seyza
```

Inspect output. If it contains working access keys for an admin/console user, configure a temporary profile: `aws configure --profile homelab-admin`. If it only has a console password, create an access key for the admin user in the console first. (Do not use `aws.amazon.com/root`.)

- [ ] **Step 2: Create buckets**

```bash
aws --profile homelab-admin s3api create-bucket --bucket seyzahl-cnpg-backups --region us-west-2 --create-bucket-configuration LocationConstraint=us-west-2
aws --profile homelab-admin s3api create-bucket --bucket seyzahl-velero-backups --region us-west-2 --create-bucket-configuration LocationConstraint=us-west-2
for b in seyzahl-cnpg-backups seyzahl-velero-backups; do
  aws --profile homelab-admin s3api put-public-access-block --bucket $b --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
done
```

No lifecycle rules; objects stay S3 Standard. Retention is enforced by barman (7d) and Velero TTL (168h).

- [ ] **Step 3: Create scoped IAM user + keys**

```bash
aws --profile homelab-admin iam create-user --user-name homelab-backup
cat > /tmp/backup-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"],
      "Resource": ["arn:aws:s3:::seyzahl-cnpg-backups", "arn:aws:s3:::seyzahl-velero-backups"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::seyzahl-cnpg-backups/*", "arn:aws:s3:::seyzahl-velero-backups/*"]
    }
  ]
}
EOF
aws --profile homelab-admin iam put-user-policy --user-name homelab-backup --policy-name s3-backups --policy-document file:///tmp/backup-policy.json
aws --profile homelab-admin iam create-access-key --user-name homelab-backup
```

- [ ] **Step 4: Store the new keys in pass and Azure KV**

```bash
pass insert aws.amazon.com/homelab-backup   # paste AccessKeyId + SecretAccessKey
az keyvault secret set --vault-name seyzahl --name aws-backup-access-key-id --value '<AccessKeyId>'
az keyvault secret set --vault-name seyzahl --name aws-backup-secret-access-key --value '<SecretAccessKey>'
```

- [ ] **Step 5: Verify key works**

```bash
AWS_ACCESS_KEY_ID=<id> AWS_SECRET_ACCESS_KEY=<key> aws s3 ls s3://seyzahl-cnpg-backups/   # expect: empty listing, no error
```

### Task B: CNPG → S3 via barman-cloud plugin (data cluster)

**Files:**
- Create: `infrastructure/controllers/base/cert-manager-data-note` — none; reuse existing `base/cert-manager`
- Create: `infrastructure/controllers/data/cert-manager/kustomization.yaml`
- Create: `infrastructure/controllers/base/plugin-barman-cloud/kustomization.yaml`
- Create: `infrastructure/controllers/base/plugin-barman-cloud/manifest.yaml` (vendored release manifest)
- Create: `infrastructure/controllers/data/plugin-barman-cloud/kustomization.yaml`
- Modify: `infrastructure/controllers/data/kustomization.yaml`
- Modify: `databases/data/forgejo/secrets.yaml` (add AWS ExternalSecret)
- Create: `databases/data/forgejo/objectstore.yaml`
- Modify: `databases/data/forgejo/database.yaml`
- Modify: `databases/data/forgejo/scheduled-backups.yaml`
- Modify: `databases/data/forgejo/kustomization.yaml`

- [ ] **Step 1: Add cert-manager to the data cluster** (plugin-barman-cloud's webhook/sidecar certs require it; data cluster currently lacks it)

`infrastructure/controllers/data/cert-manager/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base/cert-manager
```

Add `  - cert-manager` to `infrastructure/controllers/data/kustomization.yaml` resources.

- [ ] **Step 2: Vendor the plugin manifest (pin latest release at execution time)**

```bash
mkdir -p infrastructure/controllers/base/plugin-barman-cloud
curl -sL -o infrastructure/controllers/base/plugin-barman-cloud/manifest.yaml \
  https://github.com/cloudnative-pg/plugin-barman-cloud/releases/latest/download/manifest.yaml
head -5 infrastructure/controllers/base/plugin-barman-cloud/manifest.yaml  # sanity check; note the version in the commit message
```

`infrastructure/controllers/base/plugin-barman-cloud/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - manifest.yaml
```

`infrastructure/controllers/data/plugin-barman-cloud/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base/plugin-barman-cloud
```

Add `  - plugin-barman-cloud` to `infrastructure/controllers/data/kustomization.yaml` resources (after cloudnativepg). The manifest installs into `cnpg-system`.

- [ ] **Step 3: Commit + reconcile the controllers, verify plugin runs**

```bash
git add infrastructure/controllers && git commit -m "feat(cnpg): install cert-manager and barman-cloud plugin on data cluster" && git push
export KUBECONFIG=data-kubeconfig.yaml
flux reconcile kustomization infra-controllers --with-source
kubectl get pods -n cnpg-system    # expect: barman-cloud plugin deployment Running alongside cnpg operator
kubectl get pods -n cert-manager   # expect: 3 pods Running
```

- [ ] **Step 4: Add AWS ExternalSecret + ObjectStore**

Append to `databases/data/forgejo/secrets.yaml`:

```yaml
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: aws-backup-creds
  namespace: forgejo
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: azure-kv-store
    kind: ClusterSecretStore
  data:
    - secretKey: ACCESS_KEY_ID
      remoteRef:
        key: aws-backup-access-key-id
    - secretKey: SECRET_ACCESS_KEY
      remoteRef:
        key: aws-backup-secret-access-key
```

`databases/data/forgejo/objectstore.yaml`:

```yaml
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: forgejo-aws-store
  namespace: forgejo
spec:
  retentionPolicy: "7d"
  configuration:
    destinationPath: s3://seyzahl-cnpg-backups/forgejo
    s3Credentials:
      accessKeyId:
        name: aws-backup-creds
        key: ACCESS_KEY_ID
      secretAccessKey:
        name: aws-backup-creds
        key: SECRET_ACCESS_KEY
    wal:
      compression: gzip
    data:
      compression: gzip
```

Add `  - objectstore.yaml` to `databases/data/forgejo/kustomization.yaml` resources.

- [ ] **Step 5: Switch the Cluster from in-tree Azure to the plugin**

In `databases/data/forgejo/database.yaml`, **delete** the entire `backup:` block (barmanObjectStore + retentionPolicy) and add at the same indent level:

```yaml
  plugins:
    - name: barman-cloud.cloudnative-pg.io
      isWALArchiver: true
      parameters:
        barmanObjectName: forgejo-aws-store
```

Keep the `azure-creds` ExternalSecret in `secrets.yaml` for now (needed if rollback to Azure is required during the verification window).

- [ ] **Step 6: Point ScheduledBackup at the plugin**

`databases/data/forgejo/scheduled-backups.yaml`:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: forgejo-db-data
spec:
  immediate: true
  schedule: "0 0 3 * * *"
  backupOwnerReference: cluster
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
  cluster:
    name: forgejo-db-data-cnpg-v0
```

- [ ] **Step 7: Commit, reconcile, verify archiving + first backup**

```bash
git add databases/data/forgejo && git commit -m "feat(forgejo-db): switch backups to AWS S3 via barman-cloud plugin" && git push
export KUBECONFIG=data-kubeconfig.yaml
flux reconcile kustomization databases --with-source
# Instances restart rolling to inject the plugin sidecar; wait for 2/2 ready:
kubectl get cluster -n forgejo forgejo-db-data-cnpg-v0 -w
# Continuous archiving healthy:
kubectl get cluster -n forgejo forgejo-db-data-cnpg-v0 -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")].status}'   # expect: True
# First base backup completed (immediate: true fires one):
kubectl get backup -n forgejo --sort-by=.metadata.creationTimestamp | tail -2   # expect: phase completed
# Objects actually in S3:
AWS_ACCESS_KEY_ID=<id> AWS_SECRET_ACCESS_KEY=<key> aws s3 ls --recursive s3://seyzahl-cnpg-backups/forgejo/ | head
# expect: wals/ segments + base/ directory
```

**Rollback:** `git revert` the commit; the in-tree Azure config resumes WAL archiving on reconcile.

### Task C: Velero + Kopia on tachtit

**Files:**
- Create: `infrastructure/controllers/base/velero/{namespace,repository,secrets,release,schedule,kustomization}.yaml`
- Create: `infrastructure/controllers/tachtit/velero/kustomization.yaml`
- Modify: `infrastructure/controllers/tachtit/kustomization.yaml`
- Modify: `apps/base/forgejo/deployment.yaml` (backup annotation)

- [ ] **Step 1: Write Velero base manifests**

`namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: velero
  labels:
    pod-security.kubernetes.io/enforce: privileged
```

`repository.yaml`:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: vmware-tanzu
  namespace: velero
spec:
  interval: 24h
  url: https://vmware-tanzu.github.io/helm-charts
```

`secrets.yaml` (ESO template renders the AWS credentials file Velero expects):

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: velero-aws-creds
  namespace: velero
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: azure-kv-store
    kind: ClusterSecretStore
  target:
    name: velero-aws-creds
    template:
      engineVersion: v2
      data:
        cloud: |
          [default]
          aws_access_key_id={{ .id }}
          aws_secret_access_key={{ .key }}
  data:
    - secretKey: id
      remoteRef:
        key: aws-backup-access-key-id
    - secretKey: key
      remoteRef:
        key: aws-backup-secret-access-key
```

`release.yaml`:

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: velero
  namespace: velero
spec:
  interval: 1h
  timeout: 10m
  chart:
    spec:
      chart: velero
      version: "12.0.2"
      sourceRef:
        kind: HelmRepository
        name: vmware-tanzu
        namespace: velero
  values:
    initContainers:
      - name: velero-plugin-for-aws
        image: velero/velero-plugin-for-aws:v1.13.0
        volumeMounts:
          - mountPath: /target
            name: plugins
    credentials:
      useSecret: true
      existingSecret: velero-aws-creds
    configuration:
      backupStorageLocation:
        - name: default
          provider: aws
          bucket: seyzahl-velero-backups
          prefix: forgejo
          config:
            region: us-west-2
      volumeSnapshotLocation: []
      uploaderType: kopia
      defaultVolumesToFsBackup: false
    deployNodeAgent: true
    nodeAgent:
      podSecurityContext:
        runAsUser: 0
    snapshotsEnabled: false
    backupsEnabled: true
  install:
    createNamespace: false
    remediation:
      retries: 3
  upgrade:
    cleanupOnFail: true
    remediation:
      retries: 3
```

(Verify at execution: `velero-plugin-for-aws` tag matching chart 12.0.2's appVersion — check the chart's default values; adjust tag if the chart README says otherwise.)

`schedule.yaml`:

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: forgejo-daily
  namespace: velero
spec:
  schedule: "0 10 * * *"
  template:
    ttl: 168h0m0s
    includedNamespaces:
      - forgejo
    defaultVolumesToFsBackup: false
    snapshotVolumes: false
```

(10:00 UTC; staggered after the 09:30 UTC ZFS snapshot in Task D and well clear of the 03:00 UTC CNPG backup.)

`kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: velero
resources:
  - namespace.yaml
  - repository.yaml
  - secrets.yaml
  - release.yaml
  - schedule.yaml
```

`infrastructure/controllers/tachtit/velero/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base/velero
```

Add `  - velero` to `infrastructure/controllers/tachtit/kustomization.yaml` resources.

- [ ] **Step 2: Opt the Forgejo volumes into file-system backup**

Velero FSB backs up *pod* volumes — this covers the inline NFS `forgejo-data` volume without converting it to a PVC. In `apps/base/forgejo/deployment.yaml`, add to the pod template metadata:

```yaml
  template:
    metadata:
      annotations:
        backup.velero.io/backup-volumes: forgejo-data,forgejo-config
```

**Cross-plan note:** the HA plan later splits Forgejo into web + cron deployments. When that happens, this annotation moves to the single-replica **cron** deployment only (avoids backing up the same NFS data once per web replica) and `forgejo-config` drops from the list (PVC removed by HA plan).

- [ ] **Step 3: Commit, reconcile, verify install**

```bash
git add infrastructure/controllers apps/base/forgejo/deployment.yaml
git commit -m "feat(backup): install Velero with Kopia FSB to AWS S3" && git push
export KUBECONFIG=tachtit-kubeconfig.yaml
flux reconcile kustomization infra-controllers --with-source
kubectl get pods -n velero          # expect: velero deploy + node-agent daemonset (2 nodes) Running
kubectl get backupstoragelocation -n velero default -o jsonpath='{.status.phase}'   # expect: Available
```

- [ ] **Step 4: Run a first backup and verify content**

Triggering a Backup CR is an operational action, not config drift — acceptable under GitOps rules:

```bash
kubectl create -n velero -f - <<'EOF'
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: forgejo-initial
spec:
  includedNamespaces: ["forgejo"]
  ttl: 168h0m0s
  defaultVolumesToFsBackup: false
EOF
kubectl get backup -n velero forgejo-initial -o jsonpath='{.status.phase}' -w   # expect: Completed
kubectl get podvolumebackup -n velero -l velero.io/backup-name=forgejo-initial   # expect: Completed for forgejo-data (+ forgejo-config)
AWS_ACCESS_KEY_ID=<id> AWS_SECRET_ACCESS_KEY=<key> aws s3 ls --recursive s3://seyzahl-velero-backups/forgejo/ | head
```

- [ ] **Step 5: Verify restore actually works (spot check)**

```bash
velero restore create forgejo-restore-test --from-backup forgejo-initial --namespace-mappings forgejo:forgejo-restore-test --wait
kubectl exec -n forgejo-restore-test deploy/forgejo -c forgejo -- ls /data/git   # expect: repositories present
kubectl delete namespace forgejo-restore-test
```

(If the restored pod can't start due to the LoadBalancer service or netpol, restoring just the PVC contents is still provable via the PodVolumeRestore status — note whatever was verified, honestly.)

### Task D: Local ZFS snapshots on tank/git (retain 5)

One-time TrueNAS setup via API; not GitOps-managed (TrueNAS is outside the cluster). Documented here and in the runbook.

- [ ] **Step 1: Create the periodic snapshot task**

```bash
export KUBECONFIG=tachtit-kubeconfig.yaml
KEY=$(kubectl get secret -n storage truenas-iscsi-driver-config -o jsonpath='{.data.driver-config-file\.yaml}' | base64 -d | grep apiKey | awk '{print $2}' | tr -d '"')
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  "http://192.168.7.14/api/v2.0/pool/snapshottask" -d '{
    "dataset": "tank/git",
    "recursive": false,
    "lifetime_value": 5,
    "lifetime_unit": "DAY",
    "naming_schema": "auto-%Y%m%d.%H%M-git",
    "schedule": {"minute": "30", "hour": "9", "dom": "*", "month": "*", "dow": "*"},
    "enabled": true
  }' | python3 -m json.tool
```

Daily at 09:30 (TrueNAS local time — confirm TZ; intent is to land just before the 10:00 UTC Velero run), 5-day lifetime = last 5 retained.

- [ ] **Step 2: Verify after first run (or trigger via UI once)**

```bash
curl -s -H "Authorization: Bearer $KEY" "http://192.168.7.14/api/v2.0/zfs/snapshot?dataset=tank/git" | python3 -c "import json,sys; [print(s['name']) for s in json.load(sys.stdin)]"
```

### Task E: Runbook

**Files:**
- Create: `docs/backups.md`

- [ ] **Step 1: Write `docs/backups.md`** covering, concretely:
  - What runs when: CNPG base 03:00 UTC + continuous WAL → `s3://seyzahl-cnpg-backups/forgejo` (7d); Velero `forgejo-daily` 10:00 UTC → `s3://seyzahl-velero-backups/forgejo` (168h TTL); ZFS snapshot 09:30 on `tank/git` (keep 5).
  - DB restore: new CNPG Cluster with `bootstrap.recovery` + `externalClusters` entry using `plugin: barman-cloud.cloudnative-pg.io` / `barmanObjectName: forgejo-aws-store` (include full YAML example).
  - Git-data restore: `velero restore create --from-backup <name>` example; fast local path: TrueNAS `zfs clone tank/git@auto-... ` or rollback.
  - Where credentials live: `pass aws.amazon.com/homelab-backup`, Azure KV keys `aws-backup-*`.
  - Cleanup TODO with date: after 2026-06-25 (14d Azure retention window), delete the stale Azure `forgejo` container contents and remove the `azure-creds` ExternalSecret from `databases/data/forgejo/secrets.yaml`.

- [ ] **Step 2: Commit**

```bash
git add docs/backups.md && git commit -m "docs: backup architecture and restore runbook for Forgejo" && git push
```

---

## Known caveats (accepted)
- Velero FSB of live git repos is crash-consistent at file level, not git-aware. Daily 10:00 UTC run + low homelab traffic makes a mid-push backup unlikely; ZFS snapshots give additional point-in-time copies. `forgejo dump` was rejected as heavyweight.
- With 2 CNPG instances, plugin sidecar injection causes one rolling restart at switch time (brief primary failover).
- Old Azure backups stop being pruned the moment writes stop — manual cleanup task is in the runbook.
