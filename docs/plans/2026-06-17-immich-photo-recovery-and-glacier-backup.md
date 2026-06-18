# Immich — photo recovery, uid fix, and Glacier backup (runbook)

Started 2026-06-17, recovery completed 2026-06-18. This is the durable record of what happened
and how, plus the runbook for the S3 Glacier Deep Archive backup and restores.

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

## Glacier Deep Archive backup (runbook)

Goal: an **indefinite, encrypted, offsite mirror** of the photo originals + DB dumps. Local ZFS
snapshots remain the everyday/quick-recovery layer; Glacier is the "house burned down" copy.

### What to back up (source `/mnt/tank/photos`)

- **Include:** `upload/` (originals — managed + recovered, ~595 GB), `backups/` (immich DB dumps →
  makes Glacier a one-stop restore: photos + DB), plus tiny `library/`, `profile/`.
- **Exclude:** `thumbs/`, `encoded-video/` (immich regenerates these).

### AWS setup (reuse the existing account; region `us-west-1` to match the authentik backups)

1. **Bucket** e.g. `seyzahl-immich-photos` — Block Public Access ON, default encryption (SSE-S3) ON.
2. **IAM user** `immich-backup` scoped to that bucket only:
   `s3:ListBucket` on the bucket, `s3:PutObject`/`s3:GetObject` on `bucket/*` (Get needed for
   rclone integrity checks; no Delete — COPY mode never deletes). Save the access key.
3. **Storage class:** upload directly as `DEEP_ARCHIVE` (set in the sync task; avoids lifecycle
   transition costs).

### TrueNAS Cloud Sync Task (rclone under the hood; runs on the NAS)

- Credentials: add the IAM key as an S3 Cloud Credential.
- **Direction:** PUSH · **Provider:** Amazon S3 · **Bucket:** `seyzahl-immich-photos` · region `us-west-1`.
- **Source folder:** `/mnt/tank/photos`; **Exclude:** `thumbs/**`, `encoded-video/**`.
- **Transfer mode:** **COPY** (additive → indefinite; `SYNC` would prune deleted files — not wanted).
- **Advanced:** Storage class `DEEP_ARCHIVE`; **Remote Encryption ON** (rclone crypt) with a
  password + salt → store in **`pass`** (e.g. `immich.seyzahl.com/glacier-crypt`).
  **Losing this key = the backup is unreadable.** Keep a second offline copy of it.
- **Schedule:** weekly (e.g. Sun 04:00, after the 03:00 ZFS snapshot + 02:00 DB dump). Incremental
  after the first seed (only new files upload).
- **GitOps note:** this is TrueNAS-side config, not in the Flux repo. (Alternative: a k8s CronJob
  running rclone over the NFS mount — GitOps-native but pulls ~595 GB through the cluster; NAS-native preferred.)

### Initial seed

- First run pushes ~595 GB → hours/days on home upstream. Run manually first and monitor.
- Cost: storage ≈ `$1/TB/mo` (~$0.6/mo); PUTs ≈ 15k × `$0.05/1000` ≈ `$0.75` one-time. Negligible.

### Verify + test-restore (do once, before trusting it)

- Confirm objects land in the bucket (Deep Archive class).
- **Test-restore a single file:** initiate an S3 restore (Bulk tier), then `rclone copy` it back
  through the **same crypt config** and confirm it decrypts to the original. This proves both the
  retrieval flow and that the crypt key works. Don't skip this.

### Restore procedure (disaster recovery)

1. Initiate restore of the needed objects from Deep Archive (Bulk ≈ 48 h / Standard ≈ 12 h).
2. `rclone copy` (with the crypt remote configured from the `pass` key) S3 → local.
3. Restore the immich DB from the newest `backups/immich-db-backup-*.sql.gz` (or CNPG → Azure).
4. Costs (full ~595 GB): retrieval ≈ `$1.5` (Bulk) + egress ≈ `$0.09/GB` ≈ `$54`. DR-only.

## Future (out of scope)

- 2nd offsite with **14-day short retention** (no-minimum tier, e.g. Backblaze B2; versioning +
  lifecycle) — Deep Archive's 180-day minimum makes short retention there cost-ineffective.
- Recover + retire the rest of the external library (`ad079afe`/`852b4743`), same method, then
  delete the external library so the timeline stops surfacing old overlapping copies.
- Tighten the headscale ACL (currently `* → *`).
- Review the ~3,155 near-duplicate groups (Utilities → Duplicates); resource right-sizing; thumbnail/ML tuning.
