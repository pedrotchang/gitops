# Forgejo Backup Architecture and Restore Runbook

## Overview

| What | Destination | Schedule | Retention | Tooling |
|------|-------------|----------|-----------|---------|
| Postgres WAL (continuous) | `s3://seyzahl-cnpg-backups/forgejo` | Continuous | 7 days | CNPG barman-cloud plugin v0.13.0 |
| Postgres base backup | `s3://seyzahl-cnpg-backups/forgejo` | Daily 03:00 UTC | 7 days | CNPG `ScheduledBackup` (method: plugin) |
| Git data + config volumes | `s3://seyzahl-velero-backups/forgejo` | Daily 10:00 UTC | 7 days (168h) | Velero 12.0.2 + Kopia FSB |
| ZFS snapshots of `tank/git` | TrueNAS local | Hourly (keep 3d), weekly (keep 2w), monthly (keep 2mo) | See retention | TrueNAS built-in snapshot tasks |

Buckets are in `us-west-1`, S3 Standard (not Standard-IA — 30-day minimum billing makes IA uneconomical at 7-day retention).

Credentials: IAM user `homelab-backup` (account 917003953329). Access key stored in `pass aws.amazon.com/homelab-backup` and Azure KV `seyzahl` as `aws-backup-access-key-id` / `aws-backup-secret-access-key`. ESO pulls them as ExternalSecret `aws-backup-creds` (forgejo ns) and `velero-aws-creds` (velero ns).

**ZFS note:** No new daily/retain-5 task was created. The existing TrueNAS snapshot schedule (hourly/weekly/monthly) provides coverage that exceeds the original plan requirement.

---

## 1. Restore Postgres (CNPG)

### Full restore from latest base backup

Create a new recovery Cluster. The `externalClusters` entry references the same ObjectStore (`forgejo-aws-store`) and the source server name (`forgejo-db-data-cnpg-v0`).

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: forgejo-db-recovery
  namespace: forgejo
spec:
  imageName: ghcr.io/cloudnative-pg/postgresql:17.2
  instances: 1
  storage:
    size: 2Gi

  bootstrap:
    recovery:
      source: forgejo-backup-source

  externalClusters:
    - name: forgejo-backup-source
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters:
          barmanObjectName: forgejo-aws-store
          serverName: forgejo-db-data-cnpg-v0
```

```bash
kubectl apply -f recovery-cluster.yaml -n forgejo
kubectl get cluster forgejo-db-recovery -n forgejo -w
```

### Point-in-time recovery (PITR)

Add `recoveryTarget` inside `bootstrap.recovery`:

```yaml
  bootstrap:
    recovery:
      source: forgejo-backup-source
      recoveryTarget:
        targetTime: "2026-06-10 14:00:00"
```

Once the recovery cluster is healthy, promote it or copy data as needed, then delete it.

---

## 2. Restore Git Data

### Fast path: TrueNAS ZFS rollback / clone

List available snapshots on TrueNAS:

```bash
zfs list -t snapshot -o name,creation tank/git
```

Snapshot name format: `tank/git@auto-2026-06-11_19-00 - Hourly` (note the space — quote the name).

**Rollback** (destroys newer data, stops any NFS clients first):

```bash
zfs rollback "tank/git@auto-2026-06-11_19-00 - Hourly"
```

**Clone** (non-destructive, mounts alongside live data):

```bash
zfs clone "tank/git@auto-2026-06-11_19-00 - Hourly" tank/git-restore
# mount or rsync from /mnt/tank/git-restore, then destroy when done
zfs destroy tank/git-restore
```

### From S3: Velero restore

The velero CLI is not installed; use kubectl to apply a Restore CR. The inline-NFS volumes restore by writing back into the same NFS export (`/mnt/tank/git`).

```yaml
apiVersion: velero.io/v1
kind: Restore
metadata:
  name: forgejo-git-restore-20260611
  namespace: velero
spec:
  backupName: forgejo-daily-<timestamp>   # replace with actual backup name
  includedNamespaces:
    - forgejo
  namespaceMapping:
    forgejo: forgejo-scratch              # restore into an isolated namespace first
  restorePVs: true
```

```bash
# Find available backups
kubectl get backups -n velero -l velero.io/schedule-name=forgejo-daily

# Apply the restore
kubectl apply -f restore.yaml

# Watch progress
kubectl get restore forgejo-git-restore-20260611 -n velero -w
kubectl get podvolumerestores -n velero
```

---

## 3. Manual Backup Commands

### Trigger an on-demand CNPG backup

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: forgejo-db-manual-20260611
  namespace: forgejo
spec:
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
  cluster:
    name: forgejo-db-data-cnpg-v0
```

```bash
kubectl apply -f manual-backup.yaml
kubectl get backup forgejo-db-manual-20260611 -n forgejo -w
```

### Trigger an on-demand Velero backup

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: forgejo-manual-20260611
  namespace: velero
spec:
  includedNamespaces:
    - forgejo
  defaultVolumesToFsBackup: false
  snapshotVolumes: false
  ttl: 168h0m0s
```

```bash
kubectl apply -f velero-manual-backup.yaml
kubectl get backup forgejo-manual-20260611 -n velero -w
```

---

## 4. Verification

### CNPG

```bash
# Check ScheduledBackup status
kubectl get scheduledbackup forgejo-db-data -n forgejo

# Check recent Backup objects
kubectl get backups -n forgejo --sort-by=.metadata.creationTimestamp

# Confirm WAL archiving is healthy (look for ContinuousArchiving condition)
kubectl describe cluster forgejo-db-data-cnpg-v0 -n forgejo | grep -A5 "Continuous"

# Confirm ObjectStore
kubectl get objectstore forgejo-aws-store -n forgejo

# List base backups in S3
aws s3 ls s3://seyzahl-cnpg-backups/forgejo/base/ --region us-west-1
aws s3 ls s3://seyzahl-cnpg-backups/forgejo/wals/ --region us-west-1
```

### Velero

```bash
# Check schedule
kubectl get schedule forgejo-daily -n velero

# Check BSL health
kubectl get backupstoragelocation default -n velero

# List recent backups
kubectl get backups -n velero -l velero.io/schedule-name=forgejo-daily

# Check pod volume backups (Kopia FSB)
kubectl get podvolumebackups -n velero --sort-by=.metadata.creationTimestamp

# List in S3
aws s3 ls s3://seyzahl-velero-backups/forgejo/ --region us-west-1
```

---

## 5. Cleanup TODO (after 2026-06-25)

Azure backups stopped on 2026-06-11. The stale container and the ExternalSecret that referenced it can be removed once the 7-day Azure retention window has passed (use 2026-06-25 as the safe date).

1. Delete Azure container contents:
   ```bash
   az storage blob delete-batch \
     --account-name seyzahldata \
     --source forgejo
   ```
   Container URL: `https://seyzahldata.blob.core.windows.net/forgejo`

2. Remove the `azure-creds` ExternalSecret from `databases/data/forgejo/secrets.yaml`. The `forgejo-connection-string` Azure KV secret it references can be archived or deleted as well once confirmed no other consumers exist.
