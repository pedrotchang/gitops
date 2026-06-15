# Design: migrate infra repos to the `platform-infrastructure/` org

**Date:** 2026-06-14
**Status:** approved (design); pending implementation plan
**Forgejo instance:** `forgejo.seyzahl.com` (web/API/registry), `git.seyzahl.com:2222` (SSH git)

## Goal

Move the infrastructure git repositories out of the user namespace
`pedrotchang/` and into a new Forgejo organization `platform-infrastructure/`,
without ever leaving the GitOps source dead. Personal repos stay under
`pedrotchang/`.

## Decisions (user, 2026-06-14)

- **Org slug:** `platform-infrastructure` (corrected from the typo
  `platform-infrastucture`).
- **Infra repos that move:** `gitops-platform`, `homelab-private`.
- **Personal repos stay under `pedrotchang/`:** blog, garden, maincv, dotfiles,
  secondbrain-cli, .password-store, taxes. Their built images may still land in
  the Forgejo registry under `pedrotchang/*` (unchanged here — they are on
  `ghcr.io` today).
- **Approach A** — Forgejo repo *transfer* + redirect strangler (not
  create-new-and-push, not a hard simultaneous flip).
- **nextcloud registry image:** namespace moves in-place
  `forgejo.seyzahl.com/seyza/nextcloud` → `…/platform-infrastructure/nextcloud`.
- **`custom-images` repo: DEFERRED** to a follow-up spec. When built it will be
  a **monorepo, one subdir per image**, under the org, and will become the home
  for the nextcloud build (extracted from `images/nextcloud/`). Out of scope
  here.

## Scope

**In scope**
- Create org `platform-infrastructure`.
- Transfer `gitops-platform` and `homelab-private` user → org.
- Flip every live reference in this repo (Flux sources, image-automation push,
  renovate, README, backups doc) to the org paths.
- Move the nextcloud build's registry namespace to the org.
- Flip local git remotes.

**Out of scope**
- Creating the `custom-images` repo / extracting `images/nextcloud/`
  (deferred follow-up).
- Wiring the nextcloud HelmRelease to the custom image (it runs upstream
  `nextcloud:stable` today; the custom image is dormant).
- Moving blog/garden images off `ghcr.io` (separate image-supply-chain plan).
- Any personal-repo transfer.

## Token authority

The existing admin token in Azure KV `forgej-api-token` (user `pedrotchang`,
`is_admin: true`) has authority for every server-side step. No new tokens.

| Step | API | Note |
|---|---|---|
| Create org | `POST /api/v1/orgs` | creator (pedrotchang) auto-joins **Owners** team |
| Transfer repo | `POST /api/v1/repos/pedrotchang/<repo>/transfer` `{"new_owner":"platform-infrastructure"}` | admin/owner |
| Deploy keys | `GET/POST /repos/platform-infrastructure/<repo>/keys` | verify survival post-transfer |
| Push-mirror | `GET/POST /repos/.../push_mirrors` | verify survival post-transfer |
| Delete stale package | `DELETE /api/v1/packages/<owner>/container/nextcloud/<ver>` | after registry cutover |

Because pedrotchang **creates** the org he is auto-owner, so the existing
renovate / flux-push / registry tokens keep write access to org repos with no
re-grant. The only non-API steps are the `docker push` of the nextcloud image
(CI) and local `git remote set-url`.

## Affected references (live, must change)

| Ref | File | Phase |
|---|---|---|
| Flux GitRepository (data) | `clusters/data/flux-system/gotk-sync.yaml:14` | 3a |
| Flux GitRepository (tachtit) | `clusters/tachtit/flux-system/gotk-sync.yaml:14` | 3b |
| private-apps GitRepository (homelab-private) | `clusters/tachtit/private-apps.yaml:12` | 3b |
| image-automation push target | `infrastructure/configs/tachtit/image-automation/gitrepository-push.yaml:8` | 3b |
| Renovate repo list | `infrastructure/controllers/base/renovate-operator/renovatejob.yaml:14` | 5 |
| nextcloud build push tags + buildcache | `images/nextcloud/.forgejo/workflows/build.yaml:37-40` | 4 |
| Canonical-home link | `README.md:5` | 5 |
| DR runbook | `docs/backups.md:249-250,265` | 5 |
| Local git remote (this checkout + homelab-private) | n/a | 5 |

## Approach A — transfer + redirect strangler

Forgejo writes an old→new path redirect on repo transfer, honored by both SSH
and HTTP git operations. Deploy keys, webhooks and push-mirror settings are
repo-attached and survive transfer. Therefore Flux keeps pulling through the
redirect during the whole cutover — the GitOps source is never dead. Each
cluster is moved off the redirect onto the org URL only when its own
`gotk-sync.yaml` is flipped, as a committed edit.

Forgejo runs as a workload **on tachtit** (bootstrap-deadlock risk), so the
lower-risk **data** cluster is flipped first and soaked before tachtit.

## Phases

### Phase 1 — server-side prep
1. Create org `platform-infrastructure` (admin token). pedrotchang auto-owner.
2. Verify: `GET /api/v1/orgs/platform-infrastructure` 200, owner membership.

### Phase 2 — transfers + safety-net verification
1. `transfer` `gitops-platform` and `homelab-private` user → org.
2. **Verify redirect:** `git ls-remote ssh://git@git.seyzahl.com:2222/pedrotchang/gitops-platform`
   still resolves (and same for homelab-private). This redirect is the
   strangler safety net — do not proceed if it fails.
3. **Verify deploy keys survived:** `GET /repos/platform-infrastructure/<repo>/keys`
   lists the Flux read keys. If absent, regenerate keypairs and replace the
   `flux-system` (data) and `private-apps` (tachtit) secrets before Phase 3.
4. Confirm GitHub push-mirror settings survived
   (`GET /repos/platform-infrastructure/<repo>/push_mirrors`).

### Phase 3 — Flux source flip (staged, data-first)
- **3a (data):** edit `clusters/data/flux-system/gotk-sync.yaml:14` url →
  `ssh://git@git.seyzahl.com:2222/platform-infrastructure/gitops-platform`.
  Commit → push (carried by redirect). Data Flux pulls the commit and applies
  the new source URL to itself. **Verify** `flux get sources git` Ready on the
  **org** URL on the data cluster. Soak.
- **3b (tachtit):** one commit editing:
  - `clusters/tachtit/flux-system/gotk-sync.yaml:14` →
    `…/platform-infrastructure/gitops-platform`
  - `clusters/tachtit/private-apps.yaml:12` →
    `…/platform-infrastructure/homelab-private`
  - `infrastructure/configs/tachtit/image-automation/gitrepository-push.yaml:8` →
    `http://forgejo.forgejo.svc.cluster.local:3000/platform-infrastructure/gitops-platform.git`

  **Verify** tachtit sources Ready on org URLs and image-automation push works
  (trigger / observe an image-policy commit).

### Phase 4 — nextcloud registry namespace (in-place)
1. Edit `images/nextcloud/.forgejo/workflows/build.yaml:37-40`: push tags +
   buildcache `forgejo.seyzahl.com/seyza/nextcloud` →
   `forgejo.seyzahl.com/platform-infrastructure/nextcloud`.
2. Re-run CI → image lands in the org namespace.
3. Pull secret `forgejo-registry` (`apps/base/nextcloud/secrets.yaml:53`) is
   host-level (`forgejo.seyzahl.com`); username pedrotchang has org package
   read via ownership — **no secret change**.
4. The HelmRelease is not wired to this image, so **no deployment edit**.
5. After verifying the new package, delete the stale `seyza`/`pedrotchang`
   nextcloud container package via API.

### Phase 5 — remaining refs, automation, local, docs
1. `infrastructure/controllers/base/renovate-operator/renovatejob.yaml:14` →
   `platform-infrastructure/gitops-platform`. Check `renovate.json` for any
   repo self-reference. Verify the next run opens a PR against the org repo.
2. `README.md:5`, `docs/backups.md:249-250,265` → org paths; update the DR
   runbook (rollback options below).
3. Local: `git remote set-url origin
   ssh://git@git.seyzahl.com:2222/platform-infrastructure/gitops-platform.git`
   in this checkout and the homelab-private checkout. Test fetch + push.
   **Keep the local directory name** `…/pedrotchang/gitops-platform` — renaming
   it orphans the Claude memory dir keyed to that path.

### Phase 6 — GitHub mirror / DR
- Push-mirror survives transfer → GitHub stays current. Update the GitHub repo
  descriptions to `Mirror of forgejo.seyzahl.com/platform-infrastructure/<name>`.

## Rollback

- **Soft (preferred):** the redirect keeps the old `pedrotchang/` URLs live, so
  reverting the Phase 3 `gotk-sync` commits moves a cluster back onto the old
  path transparently.
- **Hard:** `transfer` the repo back to `pedrotchang`; or
  `kubectl patch gitrepository -n flux-system flux-system --type=merge
  -p '{"spec":{"url":"<github-mirror-url>"}}'` to fail over to the GitHub
  mirror (exact commands live in `docs/backups.md`).

## Success criteria

- Both repos resolve at the org path; the old `pedrotchang/` paths redirect.
- `flux get sources git` Ready on the **org** URL on **both** clusters.
- image-automation push and the next renovate run both target the org repo.
- nextcloud CI pushes to `platform-infrastructure/nextcloud`; pull succeeds.
- GitHub push-mirror still receiving pushes.
- No `pedrotchang/{gitops-platform,homelab-private}` references remain except
  intentional DR/mirror mentions.

## Verify-during-implementation (assumptions to confirm, not assert)

- Forgejo redirect covers **SSH** git ops after an *owner transfer* (not just
  rename). If it does not, fall back to flipping `gotk-sync` URLs immediately
  after transfer in the same change window, data-first.
- Deploy keys survive transfer (Phase 2.3 handles the failure case).
- `forgejo-runner` is registered org/instance-wide and runs the build workflow
  under the new owner.
