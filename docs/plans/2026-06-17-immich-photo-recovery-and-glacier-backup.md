# Immich photo recovery + Glacier Deep Archive backup

Date: 2026-06-17

Two sequenced workstreams: **(A)** recover 13,793 photos from old (pre-SSO) immich accounts
that were deleted from the live filesystem but survive in a ZFS snapshot, then **(B)** stand up
an indefinite encrypted offsite mirror of the photo library to S3 Glacier Deep Archive.

## Background / what we found

- immich (chart, v2.7.5) runs on tachtit; library on TrueNAS NFS `192.168.7.14:/mnt/tank/photos`
  (PV `Retain`); DB on CNPG (`immich-db-tachtit-cnpg-v0`, data cluster).
- Two ex-accounts (`3d9186ca…`, `547fce67…`) — leftovers from an SSO migration — had **13,793**
  external-library asset records whose files were **deleted from live** long ago. An immich
  external scan during investigation soft-deleted those dangling records (now in trash).
- The files are **recoverable**: confirmed present (sudo + positive control) in ZFS snapshot
  `tank/photos@auto-2026-04-19_03-00`, which is now **`zfs hold`-protected** (`immich_recovery`).
- All 13,793 are **net-new** vs the live library: `already_in_LIVE_library = 0`,
  `net_new_unique_checksums = 13,793` (0 checksum overlap). immich CLI dedup will import them all
  without overwriting/duplicating existing photos; a subset may be encoding-variants that surface
  in Utilities → Duplicates for manual review.

## Decisions (locked)

- Recovery method **(b)**: restore + immich CLI upload as **managed** assets owned by the admin
  (Pedro) account, then retire the dangling external records.
- Run the uploader **on TrueNAS** (1a) directly against the read-only snapshot — no 200 GB copy.
- API key: `pass -c immich.seyzahl.com/api_admin`.
- Recovered photos go **into the timeline AND a "Recovered (old accounts)" album** (asset can be both).
- Backup model: **indefinite, encrypted mirror → S3 Glacier Deep Archive** (`COPY`/additive, never
  prune). Keep local ZFS snapshots as the everyday delete/version history. A separate 14-day
  short-retention 2nd offsite comes **later** (not in this plan).

---

## Plan A — Recovery (do first)

- **A0 — Safety.** Fresh CNPG backup `immich-db-pre-recovery` (barmanObjectStore → Azure) taken
  before any change. Snapshot already held. Generate/confirm admin API key.
- **A1 — Tooling on TrueNAS.** Use **immich-go** (single Go binary, no node needed) downloaded to
  TrueNAS. Confirm exact upload subcommand/flags for the installed version before running.
- **A2 — Upload** the two snapshot dirs
  `/mnt/tank/photos/.zfs/snapshot/auto-2026-04-19_03-00 - Weekly/upload/{3d9186ca…,547fce67…}`
  → `https://immich.seyzahl.com` with the admin key, `--recursive`, into album
  "Recovered (old accounts)". Originals carry real EXIF dates → correct timeline placement.
  Heavy: ~13,793 files → thumbnail + ML jobs, runs for hours.
- **A3 — Verify.** Managed asset count +≈13,793; spot-check thumbnails + dates.
- **A4 — Dedupe review.** Run duplicate detection; resolve encoding-variants in the UI.
- **A5 — Cleanup.** Purge the dead-account records from immich trash.
- **Deferred:** the external library also holds Hanna's/Pedro's *own* old external photos
  (`ad079afe` 20,252 / `852b4743` 925, files present, also 0 overlap) — same recovery applies;
  then delete the external library entirely. Separate pass.

**Risk:** read-only on the snapshot; additive on import; reversible (delete album/assets).

---

## Plan B — Glacier Deep Archive mirror (after A)

- **Scope:** back up **originals only** — `/mnt/tank/photos/upload` (+ `/library` if used);
  **exclude** regenerable `thumbs/`, `encoded-video/`, `profile/`. Include the **immich DB dump**
  (metadata/albums/faces — files alone are not a full restore).
- **Tool:** TrueNAS **Cloud Sync Task** (rclone), running from the NAS.
  - Provider: AWS S3 (reuse existing AWS account from authentik backups), dedicated bucket.
  - Storage class: `DEEP_ARCHIVE` on upload.
  - Mode: `COPY` (additive → indefinite; `SYNC` would prune and is not wanted).
  - Encryption: client-side (rclone crypt / TrueNAS remote-encryption). **Crypt key → `pass`**
    (lost key = unreadable backup).
  - Schedule: weekly after the initial push.
- **Initial upload:** ~350 GB now, ~550 GB after recovery; then incremental.
- **Restore:** Deep Archive = 12–48 h + retrieval cost — DR only; ZFS snapshots cover everyday recovery.
- **Not GitOps** (TrueNAS-side config); alternative is a k8s rclone CronJob over NFS (GitOps-native
  but pulls 550 GB through the cluster). NAS-native preferred.

## Future (out of scope here)

- 2nd offsite with 14-day short retention (no-minimum tier, e.g. B2; versioning + lifecycle).
- Tighten the headscale ACL (currently `* → *`).
- Recover + retire the rest of the external library (`ad079afe`/`852b4743`).
