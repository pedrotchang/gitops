# Image Supply-Chain Pipeline + Cluster-Wide Upgrade Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every container image running in the clusters passes a gating trivy+grype scan and is served from the Forgejo registry (`forgejo.seyzahl.com/pedrotchang/*`); all app images upgraded to current versions with per-app breaking-change review first.

**Architecture:** A generic reusable Forgejo Actions workflow (name TBD by user — see options) living in its own repo. Two entry modes: **build** (first-party: blog) and **import** (third-party: pull upstream digest → scan → retag/push local). Cluster manifests flip to the local registry, keeping the *upstream version as the tag* so Renovate can keep tracking upstream. Registry retention: Forgejo cleanup rules keep last 3 versions.

**Verified foundations (2026-06-12):** kubelet pulls from `forgejo.seyzahl.com` work (public unproxied A record → 192.168.4.221, wildcard LE cert via cilium Gateway, pull-secret pattern proven in nextcloud ns). Runner: forgejo-runner 6.4.0, dind sidecar, `ubuntu-latest` label. Packages live on dedicated `tank/forgejo-packages` volume excluded from backups (imported images = rebuildable artifacts).

**Pipeline name options (user picks):**
1. `supply-chain` — industry-standard term, professional, CV-friendly (recommended)
2. `image-intake` — plain and self-explanatory
3. `admission` — Kubernetes-flavored (gate before entry)
4. `customs` — memorable metaphor (inspection at the border)

---

### Task 1: Pipeline repo + reusable workflow

**Files (new repo `pedrotchang/<name>`):**
- `.forgejo/workflows/scan-and-publish.yml` — `workflow_call` reusable workflow:
  - inputs: `image` (upstream ref or local build), `mode` (`import`|`build`), `context` (build mode), `tag`
  - jobs: (1) build or `docker pull` upstream; (2) `trivy image --exit-code 1 --severity CRITICAL,HIGH --ignore-unfixed` (gating); (3) `grype --fail-on critical` (gating); (4) on pass: retag `forgejo.seyzahl.com/pedrotchang/<name>:<tag>` + push with `forgejo-registry-token`; (5) job summary with scan counts.
- `README.md` — usage examples for both modes.
- Registry secret: org/repo Actions secret `REGISTRY_TOKEN` from KV `forgejo-registry-token` (package write scope — verify scope covers write, else mint dedicated).

Verification: dispatch with a known-good small image (e.g. `docker.io/library/busybox:1.37`) → lands in registry; dispatch with a knowingly-vulnerable old image → pipeline FAILS (prove the gate gates).

### Task 2: Blog onboarding (first-party build mode)

- Port `blog/.github/workflows/publish.yaml` → `blog/.forgejo/workflows/publish.yml` calling the reusable workflow (build mode, `build-<ts>` tag scheme kept).
- Flip `infrastructure/configs/tachtit/image-automation/imagerepository.yaml` → `forgejo.seyzahl.com/pedrotchang/blog` + add pull secret to blog deployment (ESO `forgejo-registry` pattern from nextcloud).
- Disable blog GitHub Actions (last M8 leftover); push a test post commit → verify build→scan→push→Flux image-automation bumps manifest→blog redeploys.

### Task 3: Third-party import flow

- Per-app import: workflow_dispatch in the pipeline repo (`image=docker.io/sissbruecker/linkding:1.31.0` etc.) — manual at first; scheduled re-imports later if wanted.
- Manifest flip per app: image → `forgejo.seyzahl.com/pedrotchang/<app>:<upstream-tag>` + imagePullSecrets (namespaced ExternalSecret, nextcloud pattern).
- **Renovate compatibility:** keep upstream version as tag; add `packageRules` with `customDatasources`/`replacements` so Renovate maps `forgejo.seyzahl.com/pedrotchang/<app>` → upstream datasource (design detail to settle in implementation; fallback: Renovate watches manifests via regex managers).
- Forgejo cleanup rule (UI, owner settings → Packages): keep last 3 versions, all container packages.

### Task 4: Upgrade wave with breaking-change review (the slow, careful part)

Inventory (tachtit, 2026-06-12) — apps to review+upgrade, **one PR each through the pipeline**, never bulk:
- Pinned & behind: commafeed 6.1.1, grafana 11.5.1, homepage v0.10.9, pgadmin 9.11, wallabag 2.6.14, immich v2.5.0 (check release cadence!), authentik 2025.10.3, n8n 2.4.8, suwayomi v2.1.2065, headscale v0.26.0 + headplane 0.6.3, nextcloud `stable` (pin it!), velero v1.18.1, external-secrets v1.3.1, redis 8.0.1 (bitnamilegacy! migrate off bitnami), forgejo-runner 6.4.0.
- `:latest` offenders to pin + route through pipeline: jellyfin, jellyseerr, bazarr/prowlarr/qbittorrent/radarr/sonarr (lscr.io set), kapowarr, garden, democratic-csi `next`.
- Per app: read upstream release notes between current→target (breaking changes, migration steps), import target through pipeline, bump manifest, verify app health, then next. Immich and authentik are the two with the strictest upgrade discipline (DB migrations, version-specific steps).
- Data cluster (CNPG postgres images) handled separately via CNPG minor-version policy — not this pipeline.

### Sequencing
1 → 2 (proves both modes end-to-end) → 3 applied to two pilot apps (linkding suggested + one lscr `:latest`) → 4 as a rolling background effort, few apps per session.
