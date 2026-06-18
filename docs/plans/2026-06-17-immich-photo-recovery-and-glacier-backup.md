# Immich — photo recovery, uid fix, and Glacier backup (runbook)

Started 2026-06-17, recovery + backup completed 2026-06-18. This is the durable record of what
happened and how, plus the runbook for the S3 Glacier Deep Archive backup and restores.

## System layout (reference)

- **App:** immich `v2.7.5` via the official Helm chart (`apps/base/immich/`), on the tachtit cluster.
  App version pinned by `image.tag` (chart version != app version).
- **Library (photos):** TrueNAS NFS `192.168.7.14:/mnt/tank/photos` (ZFS dataset `tank/photos`),
  mounted in immich at `/usr/src/app/upload`, PV `Retain`. Layout:
  - `upload/` — **originals** (managed; `originalPath` = `/usr/src/app/upload/upload/<userId>/…`, absolute).
  - `backups/` — immich's **built-in daily DB dumps** (`immich-db-backup-*.sql.gz`, ~355 MB/day).
  - `thumbs/`, `encoded-video/` — **derived** (regenerable; do not need backup).
  - `library/`, `profile/` — small/empty here.
- **DB:** CNPG `immich-db-tachtit-cnpg-v0` (data cluster, VectorChord image). Two DB backups exist:
  CNPG → Azure (`barmanObjectStore`), **and** immich's own dumps in `upload/backups/`.
- **Users:** Pedro `852b4743…` (admin), Hanna `ad079afe…`.
- **Access:** `immich.seyzahl.com` → cloudflared tunnel (public) and cilium gateway LB
  **`192.168.4.221`** (local). TrueNAS reaches immich via the LB IP (it can't resolve the public name).

## What happened (history)

1. **Chart conversion** (raw manifests → official chart) introduced a **regression**: the chart ran
   immich as **root**, NFS root-squashed it, and the `1000:1000`-owned library is `755`, so all
   **writes failed with `EACCES`** (uploads 500'd + the worker crash-looped). Reads worked, so it was
   invisible until the first write. **Fix (main `6edd72b`):** `defaultPodOptions.securityContext`
   `{runAsUser/runAsGroup/fsGroup: 1000, fsGroupChangePolicy: OnRootMismatch}` in
   `apps/base/immich/values.yaml`. **Lesson: carry over securityContext when converting a raw
   deployment to a chart — NFS-backed apps writing as root get squashed.**

2. **Lost photos recovered.** Two pre-SSO accounts (`3d9186ca…` 8,136, `547fce67…` 4,448 = ~13,793
   records) were dangling external-library assets whose files had been deleted from live long ago.
   The files survived in ZFS snapshot `tank/photos@auto-2026-04-19_03-00` (verified with `sudo` +
   a positive control; the snapshot is `zfs hold`-protected, tag `immich_recovery`). All were
   net-new (0 checksum overlap with the live library). Re-uploaded to Pedro's account as **managed**
   assets via `immich-go` run on TrueNAS against the snapshot → **Pedro 1,171 → 14,876 (+13,705)**,
   album "Recovered (old accounts)", 0 errors. Post-import immich regenerates thumbnails/ML.

### immich-go gotchas (TrueNAS, v0.31.0) — for any future bulk import

- TrueNAS `/home` is **`noexec`** → run the binary from `/mnt/tank/...`.
- TrueNAS can't resolve `immich.seyzahl.com` but reaches the gateway → add
  `192.168.4.221 immich.seyzahl.com` to `/etc/hosts`, then `--server=https://immich.seyzahl.com`
  works (correct SNI/cert + Host routing).
- `.zfs` snapshot **contents are not served over NFS** → must run on TrueNAS (sudo) to read them.
  Verify snapshot contents on TrueNAS, never from a cluster pod / NFS client.
- Default **`--concurrent-tasks=4` overwhelmed immich-server** (readiness blip → gateway `503` →
  default `--on-errors=stop` aborted). **Use `--concurrent-tasks=2 --on-errors=continue`.** Resumable
  (dedups by checksum). immich-go pauses immich jobs during upload.
- **Dry-run prints "uploaded successfully" but writes nothing — always verify via the DB, not the TUI.**

## Cleanup (post-recovery)

On TrueNAS:
```sh
sudo rm -f /mnt/tank/photos/immich-go /mnt/tank/photos/recover.sh
sudo rm -rf /root/.cache/immich-go
sudo sed -i '/immich.seyzahl.com/d' /etc/hosts        # remove the temp resolver entry
```
- **Leave** the dangling old external records in immich **trash** — they auto-purge (~30 days), or
  get removed with the deferred external-library cleanup. Do **not** "empty trash" (would nuke other
  trashed items).
- **Release the snapshot hold only after the Glacier backup exists:**
  `sudo zfs release immich_recovery 'tank/photos@auto-2026-04-19_03-00 - Weekly'`.

---

## Glacier Deep Archive backup — ✅ IMPLEMENTED 2026-06-18

Indefinite, encrypted, offsite mirror of the photo originals + DB dumps. Local ZFS snapshots remain
the everyday/quick-recovery layer; Glacier is the "house burned down" copy. Set up by driving
TrueNAS over `ssh root@truenas.seyzahl.com` (Mac key in root's authorized_keys) + the Mac's `aws`
CLI (user `seyza`, acct 917003953329).

### As-built

- **AWS** (`us-west-1`): bucket **`seyzahl-immich-photos`** — public access blocked, **versioning ON**
  (note: S3 versioning is OFF by default on all buckets; no account-wide default exists). IAM user
  **`immich-backup`**, inline policy scoped to this bucket only: `ListBucket`/`GetBucketLocation` on
  the bucket + `PutObject`/`GetObject`/`RestoreObject` on `/*`, **no Delete** (so the backup creds
  can't delete). Access key **rotated 2026-06-18** → current `AKIA…WYRQ77LA` (the first key leaked to
  a chat transcript and was deleted; rotation = new key → update credential + `s3immich` remote →
  abort/restart seed → delete old key).
- **TrueNAS Cloud Sync** task **id=1** + credential **id=1 `immich-aws`** (created via `midclt call
  cloudsync.credentials.create` / `cloudsync.create`): PUSH · **COPY** (additive/indefinite; `SYNC`
  would prune — not wanted) · source `/mnt/tank/photos` · **exclude `thumbs/**`, `encoded-video/**`** ·
  storage class **`DEEP_ARCHIVE`** · **encryption + filename_encryption ON** (rclone crypt) · weekly
  **Sun 04:00**. Captures `upload/` (ALL originals incl. the external-lib `ad079afe`/`852b4743`
  ~321 GB) + `backups/` (immich DB dumps → one-stop restore) + tiny `library/`,`profile/`.
- **Crypt password:** `pass` at **`immich.seyzahl.com/glacier-crypt`** (48-hex). **Losing it = the
  backup is permanently unreadable.** Keep an offline copy too.
- **Seed:** ~830 GiB / 52,183 files, started manually (`midclt call cloudsync.sync 1`), ~32–40 MiB/s.
  Objects verified landing as `StorageClass=DEEP_ARCHIVE` with encrypted (gibberish) keys. Cost ≈ $0.85/mo.
- **Helper rclone remotes on TrueNAS** (root, for restore/inspection): `s3immich` (S3, the
  immich-backup key) and `immichcrypt` (crypt over `s3immich:seyzahl-immich-photos`, password from
  the pass key, `filename_encryption=standard`, `directory_name_encryption=true`). Update these if
  the AWS key or crypt password change.

### Verify recoverability

- **Free key check (no thaw, anytime):** `rclone lsf immichcrypt: --max-depth 1` → returns the real
  decrypted dirs (`upload/ backups/ …`) ⇒ crypt key+config decrypt correctly. ✅ passed 2026-06-18.
- **Full single-file test (≈$0.03, ~12–48 h thaw):**
  ```sh
  P='upload/<userId>/xx/yy/<uuid>.ext'
  ENC=$(ssh root@truenas.seyzahl.com "rclone backend encode immichcrypt: '$P'" | tail -1)
  aws s3api restore-object --bucket seyzahl-immich-photos --key "$ENC" \
    --restore-request '{"Days":3,"GlacierJobParameters":{"Tier":"Bulk"}}'
  # wait until: aws s3api head-object --bucket seyzahl-immich-photos --key "$ENC" --query Restore  → ongoing-request="false"
  ssh root@truenas.seyzahl.com "rclone copy 'immichcrypt:$P' /tmp/gtest/ && sha256sum /tmp/gtest/* '/mnt/tank/photos/$P'"
  ```
  (In progress 2026-06-18 on `upload/ad079afe…/09/09/0909e5a1….png`.)

### Restore procedure (disaster recovery)

1. Re-create the `s3immich` + `immichcrypt` rclone remotes if needed (S3 creds + the `pass` crypt key).
2. Thaw the needed objects from Deep Archive (Bulk ≈ 48 h / Standard ≈ 12 h) via `aws s3api
   restore-object` on the **encrypted** keys, or `rclone backend restore s3immich:…` — the `restore`
   backend command must run on **`s3immich:`**, NOT through `immichcrypt:` (crypt doesn't forward it).
3. After thaw, `rclone copy immichcrypt:<decrypted/path> <local>` — downloads **and decrypts** in one step.
4. Restore the immich DB from the newest `backups/immich-db-backup-*.sql.gz` (or CNPG → Azure).
5. Costs (full ~830 GB): retrieval ≈ `$2` (Bulk) + egress ≈ `$0.09/GB` ≈ `$75`. DR-only.

## Future (out of scope)

- Finish the single-file restore verification once the test object thaws (~2026-06-19/20).
- 2nd offsite with **14-day short retention** (no-minimum tier, e.g. Backblaze B2; versioning +
  lifecycle) — Deep Archive's 180-day minimum makes short retention there cost-ineffective.
- Recover + retire the rest of the external library (`ad079afe`/`852b4743`) — same method, then
  delete the external library so the timeline stops surfacing old overlapping copies. (Their
  originals are already in the Glacier backup regardless.)
- Bump CNPG DB backup retention to **30 days** (authentik ~7d / immich ~10d today) via each cluster's
  `retentionPolicy` — discussed, not done.
- Tighten the headscale ACL (currently `* → *`).
