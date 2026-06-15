# Design: `custom-images` + `actions` repos (first-party image builds via reusable workflow)

**Date:** 2026-06-15
**Status:** approved (design); pending implementation plan
**Org:** `platform-infrastructure` (Forgejo `forgejo.seyzahl.com`, SSH `git.seyzahl.com:2222`)
**Related:** supply-chain spec `docs/superpowers/specs/2026-06-14-image-supply-chain-design.md`; org migration `project_org_migration`.

## Goal

Stand up two Forgejo repos that give the org a first-party container-image build pipeline:

- **`actions/`** — a library of reusable/repeatable Forgejo Actions workflows (generic CI primitives). First member: `build-and-push` (`workflow_call`).
- **`custom-images/`** — a monorepo of Dockerfiles (one subdir per image) whose thin, path-filtered workflows call `actions/build-and-push`. First image: **nextcloud** (extracted from gitops-platform `images/nextcloud/`).

Output of this spec: `forgejo.seyzahl.com/platform-infrastructure/nextcloud:stable` (+ `:<sha>`) builds and publishes on push/dispatch/cron. **Build-only** — wiring consumers and the security gate are deferred (below).

## Decisions (user, 2026-06-15)

- Three-repo split, **by concern**: `custom-images/` (Dockerfiles + callers), `actions/` (generic reusable workflows), `supply-chain/` (security gating — already a skeleton repo, built later, reuses `actions/` primitives + adds gates).
- **Build `actions/build-and-push` now**; `custom-images` workflows are thin callers from day one (proves the reusable-workflow mechanism early; DRY).
- Visibility: **public** for both new repos (matches `gitops-platform` and the existing public `supply-chain`).
- **Build-only** this task — do **not** wire nextcloud's HelmRelease to the custom image yet.
- Reusable-workflow (`workflow_call`), not composite action — matches supply-chain's `scan-and-publish` shape so the later swap is one line. (Composite-action revisited only if Forgejo cross-repo `workflow_call` proves limited.)

## Repo taxonomy (what goes where)

| Kind | Example | Repo | Pipeline |
|---|---|---|---|
| Custom build on 3rd-party base | nextcloud (`FROM nextcloud:stable`) | `custom-images/` | now: `actions/build-and-push`; later: `supply-chain/scan-and-publish` (build mode, gated) |
| Personal / first-party | blog | `custom-images/` | `actions/build-and-push` (no gate for now) |
| Pure 3rd-party import (no Dockerfile) | trivy, busybox | — | `supply-chain` import mode directly; not in `custom-images` |

## Hard constraint

Forgejo runs workflows **only** from `.forgejo/workflows/` at the **repo root** (nested workflow dirs are ignored — this is why the old `images/nextcloud/.forgejo/workflows/build.yaml` never ran). Therefore: **workflows at root, path-filtered; build contexts in per-image subdirs.**

## `actions/` repo

```
actions/
  .forgejo/workflows/build-and-push.yml   # on: workflow_call
  README.md                               # input contract + usage
  .gitignore
```

### `build-and-push.yml` contract
- `on: workflow_call`.
- **Inputs:** `context` (string, required — path within the caller repo, e.g. `nextcloud`); `image` (string, required — short name, published as `platform-infrastructure/<image>`); `tag` (string, required — primary tag, e.g. `stable`).
- **Secrets:** `REGISTRY_TOKEN` (required). **Vars:** `REGISTRY_USER`.
- **Steps:** `actions/checkout` (resolves to the **caller** repo, so the caller's `context` dir is present); `docker/setup-buildx-action`; `docker/login-action` → `forgejo.seyzahl.com` (`REGISTRY_USER` / `REGISTRY_TOKEN`); `docker/build-push-action` with `context: ${{ inputs.context }}`, push tags `forgejo.seyzahl.com/platform-infrastructure/${{ inputs.image }}:${{ inputs.tag }}` and `:${{ github.sha }}`, registry buildcache.
- All actions pinned by SHA (matches existing repo convention).
- Generic and security-agnostic. `supply-chain/scan-and-publish` will reuse it (build/publish mechanics) and wrap gates around it.

## `custom-images/` repo

```
custom-images/
  .forgejo/workflows/nextcloud.yml   # path-filtered caller
  nextcloud/Dockerfile               # moved verbatim from gitops-platform images/nextcloud/
  README.md                          # image inventory + category table + "how to add an image"
  .gitignore
```

### `nextcloud.yml` (the "now" state — thin caller)
```yaml
name: nextcloud
on:
  push: { branches: [main], paths: [nextcloud/**] }
  schedule: [{ cron: '0 3 1 * *' }]   # monthly base-image refresh (kept from current build)
  workflow_dispatch:
jobs:
  ship:
    uses: platform-infrastructure/actions/.forgejo/workflows/build-and-push.yml@main
    with: { context: nextcloud, image: nextcloud, tag: stable }
    secrets: inherit
```
The `Dockerfile` is moved unchanged (`FROM nextcloud:stable@sha256:…` + ffmpeg/curl + `user_oidc` plugin).

### Later swap (target, deferred)
Replace the `uses:` line with `platform-infrastructure/supply-chain/.forgejo/workflows/scan-and-publish.yml@main` (mode build). Publish namespace and consumers unchanged → one-line diff.

## Secrets / vars (org-level Actions, shared across repos)
- `REGISTRY_TOKEN` — **user adds**; must have `write:package` on the `platform-infrastructure` namespace. Org-level so `actions` (callee) sees it via `secrets: inherit` from `custom-images` (caller).
- `REGISTRY_USER` — org-level Actions **variable** (e.g. `pedrotchang` or a dedicated bot user).
- Names chosen to match the supply-chain spec, so the later swap needs no secret changes.

## gitops-platform cleanup
Delete `images/nextcloud/` (Dockerfile + dormant nested workflow). It never executed (nested path), so removal has no runtime effect. Commit to gitops-platform `main`.

## Target end-state (deferred — documented, not built here)
1. **`pull_request` gating:** add `on: pull_request` so the build/scan runs as a PR status check (blocks merge on gate failure).
2. **Renovate-driven updates:** Renovate watches `custom-images/nextcloud/Dockerfile` (base digest + `USER_OIDC_VERSION`) and opens update PRs **in custom-images** → PR check → merge → publish. (Update PRs live in the repo that owns the Dockerfile; do **not** drive custom-images from gitops-platform via cross-repo dispatch.)
3. **supply-chain wiring:** swap nextcloud's caller to `scan-and-publish` (Scorecard/Hipcheck source gate + Trivy/Grype image gate).
4. **Consumer wiring:** point the nextcloud HelmRelease at `platform-infrastructure/nextcloud` (`image.repository` + `imagePullSecrets` via the existing `forgejo-registry` ESO) — once the image is proven to build and pull.

## Verification (this spec)
1. `actions` + `custom-images` repos exist in the org (public), pushed.
2. A `nextcloud/**` change (or manual dispatch) triggers `custom-images/nextcloud.yml`; the Forgejo runner picks it up; the reusable `uses:` resolves cross-repo; `secrets: inherit` passes `REGISTRY_TOKEN`.
3. Image lands at `forgejo.seyzahl.com/platform-infrastructure/nextcloud:stable` and `:<sha>`; `docker pull` of it succeeds.
4. `images/nextcloud/` removed from gitops-platform; gitops-platform Flux still reconciles clean (it's a non-manifest path, no Flux impact).

## Verify-at-implementation (load-bearing assumptions)
- Forgejo 15.0.3 (gitea-1.22) cross-repo reusable `workflow_call` + `secrets: inherit` + `actions/checkout` resolving to the **caller** repo. Building `actions/` first de-risks this; if cross-repo `workflow_call` is limited on this version, fall back to a **composite action** in `actions/` (caller builds in its own job, uses the action to push) — same repo split, different reuse primitive.
- The Forgejo runner is org/instance-scoped and runs workflows in the new repos (it ran migration-era builds, so present — confirm it triggers for these repos).
- `REGISTRY_TOKEN` truly has `write:package` on the org namespace (smoke-test a push).
