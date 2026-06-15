# Image Supply-Chain Pipeline — Repo + Reusable Workflow Design

**Date:** 2026-06-14
**Scope:** Task 1 of `docs/superpowers/plans/2026-06-13-image-supply-chain.md`, expanded to a four-tool gate. Creates the `platform-infrastructure/supply-chain` Forgejo repo and its reusable Actions workflow.

## Goal

A generic reusable Forgejo Actions workflow that takes a container image (first-party build or third-party import), runs it through gating supply-chain checks, and on pass republishes it to the Forgejo registry under `forgejo.seyzahl.com/platform-infrastructure/<name>:<tag>`. Import mode adds an upstream **source-risk gate** (OpenSSF Scorecard + Hipcheck) ahead of the **image-CVE gate** (Trivy + Grype), producing one combined supply-chain verdict.

## Out of Scope (downstream, stay in the plan doc)

- **Task 2** blog onboarding (build mode end-to-end).
- **Task 3** per-app third-party import + manifest flips + Renovate mapping + registry cleanup rules.
- **Task 4** the upgrade wave with per-app breaking-change review.

This spec delivers the repo and the workflow those tasks call.

## Repo

- Location: **`platform-infrastructure/supply-chain`** (Forgejo org `platform-infrastructure`).
- Visibility: **private** (org-internal infra tooling). *(Open for review — flip to public if preferred for parity with `gitops-platform`.)*
- Files:
  - `.forgejo/workflows/scan-and-publish.yml` — the reusable `workflow_call` workflow.
  - `README.md` — usage for both modes, the threshold knobs, source-resolution behavior.
  - `.gitignore`.

## Published-image namespace

All artifacts the pipeline publishes land at `forgejo.seyzahl.com/platform-infrastructure/<name>:<tag>`. The upstream version is kept as the tag so Renovate can keep tracking upstream (mapping is a Task 3 detail). Registry cleanup (keep last 3 versions) is configured in Task 3.

## Reusable workflow — `.forgejo/workflows/scan-and-publish.yml`

`on: workflow_call`.

### Inputs

| input | required | default | purpose |
|-------|----------|---------|---------|
| `image` | yes | — | upstream ref (import) or build target name (build) |
| `mode` | yes | — | `import` \| `build` |
| `tag` | yes | — | published tag (import: upstream version; build: `build-<ts>`) |
| `context` | build only | `.` | docker build context |
| `source_repo` | no | — | override for upstream source repo URL (import) |
| `scorecard_min` | no | `4.0` | min Scorecard aggregate score to pass |
| `allow_missing_source` | no | `false` | if source repo unresolved, warn+skip source gate instead of failing |

### Jobs (in order; any gate breach fails the run)

1. **acquire**
   - build mode: `docker build` the `context`.
   - import mode: `docker pull <image>`, resolve to immutable digest.
2. **resolve-source** *(import only)*
   - Read `org.opencontainers.image.source` label from the pulled image (`docker inspect` / `skopeo inspect`).
   - Else use `source_repo` input.
   - Else: if `allow_missing_source=true` → warn and skip the source gate; otherwise **fail** with a message telling the user to pass `source_repo` or set `allow_missing_source`.
3. **source-gate** *(import only, gating)*
   - Scorecard: aggregate score (0–10) against the resolved repo.
   - Hipcheck: overall verdict against the resolved repo.
   - **Fail** if `score < scorecard_min` **or** Hipcheck overall `= fail`.
   - Hipcheck `investigate` / low Scorecard sub-checks → summary warning, non-fatal.
4. **image-gate** *(gating)*
   - `trivy image --exit-code 1 --severity CRITICAL,HIGH --ignore-unfixed <image>`.
   - `grype <image> --fail-on critical`.
5. **publish** *(only when all gates pass)*
   - Retag → `forgejo.seyzahl.com/platform-infrastructure/<name>:<tag>`, `docker push` with `REGISTRY_TOKEN`.
6. **summary**
   - Job summary: Scorecard score, Hipcheck verdict, Trivy + Grype counts, published ref + digest.

### Scanner sourcing

Trivy, Grype, Scorecard, Hipcheck run from the **already-mirrored** Forgejo registry images (no upstream rate limits). Exact mirror paths confirmed at implementation (assumed `forgejo.seyzahl.com/platform-infrastructure/{trivy,grype,scorecard,hipcheck}`).

### Secrets (Actions secrets on the repo/org)

| secret | source | scope |
|--------|--------|-------|
| `REGISTRY_TOKEN` | KV `forgejo-registry-token` | **package write** to `platform-infrastructure` namespace — verify; mint dedicated if insufficient |
| `GITHUB_AUTH_TOKEN` | KV (existing) or new PAT | **public-repo read** — required by Scorecard/Hipcheck to query GitHub-hosted upstream repos |

## Repo creation

- API: `POST https://forgejo.seyzahl.com/api/v1/orgs/platform-infrastructure/repos` with header `Authorization: token <forgej-api-token>` (Azure KV `forgej-api-token`; has `write:organization`). Body: `{ "name": "supply-chain", "private": true, "auto_init": true }`.
- Confirm org `platform-infrastructure` exists and the token can create in it before pushing.
- Push initial commit over SSH `git.seyzahl.com:2222`.

## Verification

1. Dispatch build/import with `docker.io/library/busybox:1.37` → lands at `forgejo.seyzahl.com/platform-infrastructure/busybox:1.37`.
2. Dispatch a knowingly-vulnerable old image → **image-gate FAILS** (proves the CVE gate gates).
3. Dispatch an import whose upstream repo scores below `scorecard_min` (or Hipcheck `fail`) → **source-gate FAILS** before any image scan (proves the source gate gates).
4. Dispatch an import for an image with no source label and `allow_missing_source=false` → **resolve-source FAILS** with the guidance message.

## Open items for implementation

- Confirm `REGISTRY_TOKEN` package-write scope on the org namespace; mint dedicated token if not.
- Confirm source for `GITHUB_AUTH_TOKEN`.
- Confirm mirrored scanner image paths.
- Confirm Forgejo runner has `skopeo`/`docker inspect` available for label reads (dind sidecar present per plan).
