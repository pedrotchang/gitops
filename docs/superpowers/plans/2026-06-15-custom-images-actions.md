# custom-images + actions repos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `platform-infrastructure/actions` and `platform-infrastructure/custom-images` Forgejo repos so a `nextcloud/**` change builds and publishes `forgejo.seyzahl.com/platform-infrastructure/nextcloud:stable` (+`:<sha>`) via a cross-repo reusable workflow.

**Architecture:** `actions/` holds one reusable `workflow_call` workflow (`build-and-push.yml`) that checks out the **caller** repo, builds a Docker context, and pushes to the Forgejo registry. `custom-images/` holds per-image Dockerfiles in subdirs plus thin root-level path-filtered workflows that `uses:` the reusable workflow with `secrets: inherit`. Build-only — no consumer wiring, no security gate this pass.

**Tech Stack:** Forgejo 15.0.3 (gitea-1.22) Actions, Forgejo container registry, `docker/build-push-action`, reusable workflows (`workflow_call`), Azure Key Vault (vault `seyzahl`) for the API/registry tokens.

**Source spec:** `docs/superpowers/specs/2026-06-15-custom-images-actions-design.md`

---

## Prerequisites (verify before Task 1)

- [x] Org-level Actions **secrets** `REGISTRY_TOKEN` and `REGISTRY_USER` exist on the `platform-infrastructure` org (confirmed 2026-06-15 via `GET /orgs/platform-infrastructure/actions/secrets`; both are secrets — the variables endpoint is empty `[]`).
- [x] Registry credentials valid — `docker login forgejo.seyzahl.com` with KV `forgejo-registry-username` (`pedrotchang`) / `forgejo-registry-token` returned `Login Succeeded`; the registry v2 API answers (`GET /v2/_catalog` → HTTP 200). KV secret names confirmed: `forgejo-registry-username` / `forgejo-registry-token` (these are the package-scoped creds — **not** `forgej-api-token`, which lacks package scope).
- [ ] **`REGISTRY_TOKEN` `write:package` is proven by the first runner build in Task 3, not by a local probe.** This machine has no running docker daemon and no `skopeo`/`crane`, so a standalone push can't be staged here. If Task 3's build job fails at the push step with a 403, the token lacks `write:package` on the org namespace — re-mint it (Forgejo UI → user Settings → Applications → Generate Token → `write:package`) and update the org `REGISTRY_TOKEN` secret, then re-run. All published-image verification below uses the curl v2 API (daemon-independent):

```bash
# reusable verify helper (used in Task 3)
export REG_TOKEN=$(az keyvault secret show --vault-name seyzahl --name forgejo-registry-token --query value -o tsv)
export REG_USER=$(az keyvault secret show --vault-name seyzahl --name forgejo-registry-username --query value -o tsv)
```

- [ ] Token shell setup for repo creation (used in Task 1 and Task 2):

```bash
export FORGEJO_TOKEN=$(az keyvault secret show --vault-name seyzahl --name forgej-api-token --query value -o tsv)
export API=https://forgejo.seyzahl.com/api/v1
```

- [ ] Confirm the org exists (created in the org-migration; should already return):

```bash
curl -s -H "Authorization: token $FORGEJO_TOKEN" "$API/orgs/platform-infrastructure" | jq .username
```
Expected: `"platform-infrastructure"`.

---

## Task 1: Create + scaffold + push the `actions` repo

Build `actions` **first** — `custom-images` references it cross-repo, and an early push lets Task 3 de-risk the load-bearing `workflow_call` assumption.

**Files:**
- Create (remote): Forgejo repo `platform-infrastructure/actions` (public)
- Create (local, in `/tmp/actions`): `.gitignore`, `.forgejo/workflows/build-and-push.yml`, `README.md`

- [ ] **Step 1: Create the repo via API**

```bash
curl -sS -X POST "$API/orgs/platform-infrastructure/repos" \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"actions","description":"Reusable Forgejo Actions workflows (generic CI primitives)","private":false,"auto_init":true,"default_branch":"main"}' \
  | jq '{full_name, private, clone_url, ssh_url}'
```
Expected: JSON with `"full_name": "platform-infrastructure/actions"`, `"private": false`. If `422` "already exists", skip creation.

- [ ] **Step 2: Clone the new repo locally (separate from gitops-platform)**

```bash
cd /tmp && rm -rf /tmp/actions && git clone ssh://git@git.seyzahl.com:2222/platform-infrastructure/actions.git
cd /tmp/actions
```
Expected: clone succeeds over SSH, contains the auto-init `README.md`.

- [ ] **Step 3: Write `.gitignore`**

File: `/tmp/actions/.gitignore`
```
*.log
.DS_Store
```

- [ ] **Step 4: Write the reusable workflow**

File: `/tmp/actions/.forgejo/workflows/build-and-push.yml`

```yaml
name: build-and-push

on:
  workflow_call:
    inputs:
      context:
        description: Path within the caller repo to the docker build context
        required: true
        type: string
      image:
        description: Short image name; published as platform-infrastructure/<image>
        required: true
        type: string
      tag:
        description: Primary tag (e.g. stable); the commit SHA is always pushed too
        required: true
        type: string
    secrets:
      REGISTRY_TOKEN:
        description: Forgejo PAT with write:package on the platform-infrastructure namespace
        required: true
      REGISTRY_USER:
        description: Forgejo user the push authenticates as
        required: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f  # v3
        with:
          driver-opts: network=host

      - name: Login to Forgejo registry
        uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9  # v3
        with:
          registry: forgejo.seyzahl.com
          username: ${{ secrets.REGISTRY_USER }}
          password: ${{ secrets.REGISTRY_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8  # v6
        with:
          context: ${{ inputs.context }}
          push: true
          tags: |
            forgejo.seyzahl.com/platform-infrastructure/${{ inputs.image }}:${{ inputs.tag }}
            forgejo.seyzahl.com/platform-infrastructure/${{ inputs.image }}:${{ github.sha }}
```
**No `cache-from`/`cache-to`** — the original spec called for registry buildcache, but the Forgejo container registry rejects buildkit cache export: the image builds and pushes fine, then `cache-to type=registry,mode=max` fails with `error writing layer blob: unknown`, marking the whole run red (verified on run #4, 2026-06-15). Registry buildcache is dropped; the image still builds + publishes. If build time becomes a concern later, revisit `cache-to type=inline` (mode=min, embeds cache in the image manifest — Forgejo-compatible) rather than a separate `:buildcache` tag.

The four action SHAs are copied verbatim from the (now-dormant) gitops-platform `images/nextcloud/.forgejo/workflows/build.yaml`, which is the existing repo convention. **`runs-on: ubuntu-latest`, NOT `docker`** — the dormant workflow used `docker`, but that label was never validated (it never ran). The registered forgejo-runner advertises `ubuntu-latest` (matching the working supply-chain workflow). Using `docker` makes the callee `build` job unschedulable: the run flashes "running" during caller orchestration, then fails with no step logs (the callee task is never created → `job_id N resource does not exist`). Discovered 2026-06-15 on the first build (run #1). `${{ secrets.REGISTRY_USER }}` replaces the old `${{ github.actor }}`, and `${{ secrets.REGISTRY_TOKEN }}` replaces the old `${{ secrets.FORGEJO_TOKEN }}` — names match the supply-chain spec so the later swap to `scan-and-publish` needs no secret changes. **Both are org-level Actions _secrets_** (confirmed 2026-06-15: `REGISTRY_USER` was added as a secret, not a variable), so both are declared in `workflow_call.secrets` and flow from the caller via `secrets: inherit`.

- [ ] **Step 5: Write `README.md`** (input contract + usage)

File: `/tmp/actions/README.md`
````markdown
# actions

Reusable Forgejo Actions workflows (generic CI primitives) for the `platform-infrastructure` org.

## `build-and-push` (`.forgejo/workflows/build-and-push.yml`)

`on: workflow_call`. Checks out the **caller** repo, builds a Docker context, and pushes it to the Forgejo registry under `forgejo.seyzahl.com/platform-infrastructure/<image>`. Generic and security-agnostic — `supply-chain/scan-and-publish` reuses these mechanics and wraps gates around them.

### Inputs

| input | required | description |
|-------|----------|-------------|
| `context` | yes | Path within the **caller** repo to the build context (e.g. `nextcloud`). |
| `image` | yes | Short image name; published as `platform-infrastructure/<image>`. |
| `tag` | yes | Primary tag (e.g. `stable`). The commit SHA is always pushed as a second tag. |

### Secrets

| secret | required | description |
|--------|----------|-------------|
| `REGISTRY_TOKEN` | yes | Forgejo PAT with `write:package` on the `platform-infrastructure` namespace. Pass via `secrets: inherit`. |
| `REGISTRY_USER` | yes | Forgejo user the push authenticates as. Org-level Actions secret; pass via `secrets: inherit`. |

### Usage

```yaml
jobs:
  ship:
    uses: platform-infrastructure/actions/.forgejo/workflows/build-and-push.yml@main
    with:
      context: nextcloud
      image: nextcloud
      tag: stable
    secrets: inherit
```

Publishes `forgejo.seyzahl.com/platform-infrastructure/nextcloud:stable` and `:<sha>`.
````

- [ ] **Step 6: Commit and push**

```bash
cd /tmp/actions
git add .gitignore README.md .forgejo/workflows/build-and-push.yml
git commit -m "feat: add reusable build-and-push workflow"
git push origin main
```
Expected: push succeeds.

- [ ] **Step 7: Verify the workflow file is at the root path**

```bash
curl -s -H "Authorization: token $FORGEJO_TOKEN" \
  "$API/repos/platform-infrastructure/actions/contents/.forgejo/workflows/build-and-push.yml" | jq .name
```
Expected: `"build-and-push.yml"`. Confirms it lives at the repo-root `.forgejo/workflows/` path Forgejo requires.

---

## Task 2: Create + scaffold + push the `custom-images` repo

**Files:**
- Create (remote): Forgejo repo `platform-infrastructure/custom-images` (public)
- Create (local, in `/tmp/custom-images`): `.gitignore`, `nextcloud/Dockerfile`, `.forgejo/workflows/nextcloud.yml`, `README.md`

- [ ] **Step 1: Create the repo via API**

```bash
curl -sS -X POST "$API/orgs/platform-infrastructure/repos" \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"custom-images","description":"First-party container image builds (Dockerfiles + thin callers of actions/build-and-push)","private":false,"auto_init":true,"default_branch":"main"}' \
  | jq '{full_name, private, clone_url, ssh_url}'
```
Expected: JSON with `"full_name": "platform-infrastructure/custom-images"`, `"private": false`. If `422` "already exists", skip creation.

- [ ] **Step 2: Clone the new repo locally**

```bash
cd /tmp && rm -rf /tmp/custom-images && git clone ssh://git@git.seyzahl.com:2222/platform-infrastructure/custom-images.git
cd /tmp/custom-images
```
Expected: clone succeeds, contains the auto-init `README.md`.

- [ ] **Step 3: Write `.gitignore`**

File: `/tmp/custom-images/.gitignore`
```
*.log
.DS_Store
```

- [ ] **Step 4: Create the nextcloud build context (Dockerfile moved verbatim)**

File: `/tmp/custom-images/nextcloud/Dockerfile`
```dockerfile
FROM nextcloud:stable@sha256:80241648313b230e3546a8552260c17034a68b59c28271aecbf5317065bd0fd3

ARG USER_OIDC_VERSION=0.3.2

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL \
    "https://github.com/nextcloud/user_oidc/releases/download/v${USER_OIDC_VERSION}/user_oidc.tar.gz" \
    | tar -xz -C /usr/src/nextcloud/custom_apps/
```
**NOT byte-for-byte verbatim** — the original gitops-platform Dockerfile extracted to `/var/www/html/custom_apps/`, which is broken: in the nextcloud image `/var/www/html` is an empty runtime volume at build time (the dir doesn't exist → build fails `tar: Cannot open: No such file or directory`), and the entrypoint repopulates `/var/www/html` from `/usr/src/nextcloud` on container start (so build-time writes there would be lost anyway). Custom apps must go in `/usr/src/nextcloud/custom_apps/` (which exists in the image). The original never built — its nested workflow never ran — so this latent bug only surfaced on the first real build (run #1–#3, 2026-06-15). Verified the fixed path on the actual image before committing.

- [ ] **Step 5: Write the thin caller workflow**

File: `/tmp/custom-images/.forgejo/workflows/nextcloud.yml`
```yaml
name: nextcloud

on:
  push:
    branches: [main]
    paths:
      - nextcloud/**
  schedule:
    - cron: '0 3 1 * *'   # monthly base-image refresh
  workflow_dispatch:

jobs:
  ship:
    uses: platform-infrastructure/actions/.forgejo/workflows/build-and-push.yml@main
    with:
      context: nextcloud
      image: nextcloud
      tag: stable
    secrets: inherit
```
The `paths:` filter is `nextcloud/**` (the subdir), not `Dockerfile` — the old workflow's `paths: [Dockerfile]` only worked because the Dockerfile sat at that repo's root. The monthly `cron` is kept from the current build so the base image still refreshes without a push.

- [ ] **Step 6: Write `README.md`** (inventory + category table + how-to-add)

File: `/tmp/custom-images/README.md`
````markdown
# custom-images

Monorepo of first-party container image builds for the `platform-infrastructure` org. One subdirectory per image holds its Docker build context. Thin, path-filtered workflows at the repo root call the reusable `platform-infrastructure/actions/build-and-push` workflow.

## Why workflows live at the root

Forgejo only runs workflows from `.forgejo/workflows/` at the **repo root**; nested workflow dirs are ignored. So each image's workflow lives at the root and is scoped to its subdir with a `paths:` filter.

## Images

| image | base | published as | workflow |
|-------|------|--------------|----------|
| nextcloud | `nextcloud:stable` + ffmpeg, curl, `user_oidc` plugin | `platform-infrastructure/nextcloud:stable` (+`:<sha>`) | `.forgejo/workflows/nextcloud.yml` |

## Image categories (where a build belongs)

| Kind | Example | Lives here? | Pipeline |
|---|---|---|---|
| Custom build on 3rd-party base | nextcloud (`FROM nextcloud:stable`) | yes | now: `actions/build-and-push`; later: `supply-chain/scan-and-publish` (build mode, gated) |
| Personal / first-party | blog | yes | `actions/build-and-push` (no gate for now) |
| Pure 3rd-party import (no Dockerfile) | trivy, busybox | no | `supply-chain` import mode directly |

## How to add an image

1. Create `./<image>/Dockerfile` (plus any build-context files it needs).
2. Add `.forgejo/workflows/<image>.yml` at the repo root — copy `nextcloud.yml`, then change `name`, `paths`, `context`, `image`, and `tag`.
3. Push to `main`. The `paths:` filter triggers a build only when files under `<image>/` change.
````

- [ ] **Step 7: Commit and push**

```bash
cd /tmp/custom-images
git add .gitignore README.md nextcloud/Dockerfile .forgejo/workflows/nextcloud.yml
git commit -m "feat: add nextcloud image + thin build-and-push caller"
git push origin main
```
Expected: push succeeds. The push touches `nextcloud/**`, so it should trigger the `nextcloud` workflow (observed in Task 3).

---

## Task 3: First end-to-end build — load-bearing cross-repo `workflow_call` smoke test

This is the spec's central risk: Forgejo 15.0.3 cross-repo reusable `workflow_call` + `secrets: inherit` + `actions/checkout` resolving to the **caller** repo. If this fails, pivot to the composite-action fallback (Contingency below) — same repo split, different reuse primitive.

- [ ] **Step 1: Trigger the build**

The Task 2 push should have triggered it. If no run appears, dispatch manually in the Forgejo UI: `platform-infrastructure/custom-images` → Actions → `nextcloud` → "Run workflow" (workflow_dispatch on `main`).

- [ ] **Step 2: Watch the run**

Forgejo UI → `platform-infrastructure/custom-images` → Actions tab → open the latest `nextcloud` run. Confirm the runner picks it up (`runs-on: docker`) and the `uses:` line resolves the `actions` repo cross-repo.
Expected: a single `build` job runs all steps green (Checkout → Buildx → Login → Build and push).

- [ ] **Step 3: Verify the published tags exist (registry v2 API, no local docker needed)**

```bash
# REG_TOKEN/REG_USER exported in Prerequisites
curl -s -u "$REG_USER:$REG_TOKEN" \
  "https://forgejo.seyzahl.com/v2/platform-infrastructure/nextcloud/tags/list" | jq .
```
Expected: `{"name":"platform-infrastructure/nextcloud","tags":["stable","<sha>", ...]}` — both `stable` and the commit SHA present.

- [ ] **Step 4: Verify `:stable` and `:<sha>` resolve to the same digest (same build, two tags)**

```bash
SHA=$(git -C /tmp/custom-images rev-parse HEAD)
ACCEPT='Accept: application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json'
D_STABLE=$(curl -sI -u "$REG_USER:$REG_TOKEN" -H "$ACCEPT" \
  "https://forgejo.seyzahl.com/v2/platform-infrastructure/nextcloud/manifests/stable" \
  | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}')
D_SHA=$(curl -sI -u "$REG_USER:$REG_TOKEN" -H "$ACCEPT" \
  "https://forgejo.seyzahl.com/v2/platform-infrastructure/nextcloud/manifests/${SHA}" \
  | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}')
echo "stable=$D_STABLE  sha=$D_SHA"; [ -n "$D_STABLE" ] && [ "$D_STABLE" = "$D_SHA" ] && echo MATCH || echo "MISMATCH/empty"
```
Expected: `MATCH` — non-empty digests, identical for both tags.

**CHECKPOINT — stop and report before Task 4.** Task 3 proves the mechanism the whole spec rests on. If green, proceed to cleanup. If the cross-repo `uses:` fails to resolve or `secrets: inherit` does not pass `REGISTRY_TOKEN`, **stop** and apply the Contingency rather than deleting the working gitops-platform build.

### Contingency: composite-action fallback (only if Step 2 fails on cross-repo resolution)

If Forgejo 15.0.3 cannot resolve a cross-repo reusable `workflow_call`:
1. In `actions/`, replace `build-and-push.yml` with a composite action at `build-and-push/action.yml` (`runs:` using: `composite`) taking the same `context` / `image` / `tag` inputs plus a `registry-token` input (composite actions cannot read `secrets:` directly).
2. In `custom-images/nextcloud.yml`, the `ship` job builds in its own `runs-on: docker` job and calls `uses: platform-infrastructure/actions/build-and-push@main` as a step, passing `registry-token: ${{ secrets.REGISTRY_TOKEN }}` and `username: ${{ vars.REGISTRY_USER }}`.
The repo split, secret names, and published namespace are unchanged — only the reuse primitive differs. Re-run Task 3 Steps 1–4. Note the chosen primitive in both READMEs.

---

## Task 4: gitops-platform cleanup — remove the dormant `images/nextcloud/`

The nested workflow never executed (Forgejo ignores non-root workflow dirs), so removal has no runtime effect. `images/` is a non-manifest path, so Flux is unaffected.

**Files (this repo, `gitops-platform`):**
- Delete: `images/nextcloud/Dockerfile`, `images/nextcloud/.forgejo/workflows/build.yaml` (the whole `images/nextcloud/` tree)

- [ ] **Step 1: Confirm the only difference from the original is the custom_apps path fix**

```bash
diff images/nextcloud/Dockerfile /tmp/custom-images/nextcloud/Dockerfile
```
Expected: exactly one changed line — `/var/www/html/custom_apps/` (original, broken) → `/usr/src/nextcloud/custom_apps/` (fixed). No other differences. The original is being deleted regardless (it never built); this confirms nothing else was lost in the move.

- [ ] **Step 2: Create a branch (repo is on `main`, which Flux reconciles)**

```bash
cd /Users/seyza/Repos/forgejo.seyzahl.com/platform-infrastructure/gitops-platform
git checkout -b chore/remove-dormant-nextcloud-image
```

- [ ] **Step 3: Remove the directory**

```bash
git rm -r images/nextcloud
```
Expected: `rm 'images/nextcloud/Dockerfile'` and `rm 'images/nextcloud/.forgejo/workflows/build.yaml'`. If `images/` is now empty, `git rm -r images` instead.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove dormant images/nextcloud (moved to custom-images repo)

Never executed — Forgejo ignores nested .forgejo/workflows dirs. The
nextcloud image now builds in platform-infrastructure/custom-images via
the reusable actions/build-and-push workflow."
```

- [ ] **Step 5: Push the branch and open a PR**

```bash
git push -u origin chore/remove-dormant-nextcloud-image
```
Then open a PR to `main` in the Forgejo UI (or via API). The spec calls for landing on `main`; the PR is the review checkpoint before it merges.

- [ ] **Step 6: After merge, confirm Flux still reconciles clean**

Check the cluster's Flux Kustomization status (e.g. `flux get kustomizations -A` from the cluster context, or the Flux dashboard). `images/` was never a Flux source path.
Expected: no Kustomization moves to a failed/not-ready state from this change.

---

## Verification (whole spec)

1. [ ] `actions` + `custom-images` repos exist in the org (public), pushed (Task 1 Step 1/6, Task 2 Step 1/7).
2. [ ] A `nextcloud/**` change (or manual dispatch) triggers `custom-images/nextcloud.yml`; the runner picks it up; the reusable `uses:` resolves cross-repo; `secrets: inherit` passes `REGISTRY_TOKEN` (Task 3 Steps 1–2).
3. [ ] Image lands at `forgejo.seyzahl.com/platform-infrastructure/nextcloud:stable` and `:<sha>`; registry v2 API lists both tags and they resolve to the same digest (Task 3 Steps 3–4).
4. [ ] `images/nextcloud/` removed from gitops-platform; Flux still reconciles clean (Task 4 Steps 3, 6).

## Out of scope (deferred — documented in the spec, not built here)

`pull_request` PR-gating, Renovate-driven update PRs in custom-images, the `supply-chain/scan-and-publish` swap (one-line `uses:` change), and pointing the nextcloud HelmRelease at the new image. None are touched by this plan.
