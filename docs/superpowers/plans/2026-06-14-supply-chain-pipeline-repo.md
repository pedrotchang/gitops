# Supply-Chain Pipeline Repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `platform-infrastructure/supply-chain` Forgejo repo with a reusable/dispatchable Actions workflow that gates container images through a source-risk check (Scorecard + Hipcheck, import mode) then an image-CVE check (Trivy + Grype), and republishes passing images to `forgejo.seyzahl.com/platform-infrastructure/<name>:<tag>`.

**Architecture:** One workflow file `scan-and-publish.yml` triggered by both `workflow_dispatch` (manual imports) and `workflow_call` (first-party build callers, e.g. blog). A **single job** runs ordered steps — acquire → resolve-source → scorecard → hipcheck → trivy → grype → publish — so gating order is guaranteed by step order and any gate fails the run via non-zero exit. Scanners run as `docker run` of the already-mirrored Forgejo registry images, mounting the docker socket to scan the local image.

**Tech Stack:** Forgejo Actions (Gitea-compatible), forgejo-runner 6.4.0 with dind sidecar, `ubuntu-latest` label; Trivy, Grype, OpenSSF Scorecard, Hipcheck (mirrored images); Forgejo HTTP API for repo + secret/variable provisioning; `jq`/`awk` for parsing.

---

## Prerequisites (verify before Task 1)

- [ ] Forgejo org `platform-infrastructure` exists (created 2026-06-14 in the org-migration; should already return): `curl -s -H "Authorization: token $FORGEJO_TOKEN" https://forgejo.seyzahl.com/api/v1/orgs/platform-infrastructure | jq .username` → `platform-infrastructure`.
- [ ] `forgej-api-token` (KV) can create repos in the org (has `write:organization`; pedrotchang is an org owner).
- [ ] **Token scope caveat:** `forgej-api-token` **lacks `read:package`/`write:package`**. Do NOT use it against `/api/v1/packages/...` — those calls 403. Verify published artifacts with `docker manifest inspect` (registry creds), and delete packages via the Forgejo UI. The registry push/pull uses `forgejo-registry-token` (package scope), provisioned in Task 2.
- [ ] Mirrored scanner images exist and note their exact refs (used in Task 2 variables): `trivy`, `grype`, `scorecard`, `hipcheck` under `forgejo.seyzahl.com/platform-infrastructure/`.
- [ ] forgejo-runner online with `ubuntu-latest` label and dind sidecar (per plan verified foundations).

**Token shell setup (used throughout):**
```bash
export FORGEJO_TOKEN=$(az keyvault secret show --vault-name seyzahl --name forgej-api-token --query value -o tsv)
export API=https://forgejo.seyzahl.com/api/v1
```

---

## Task 1: Create the repo + local scaffold + push

**Files:**
- Create (remote): Forgejo repo `platform-infrastructure/supply-chain`
- Create (local): `README.md`, `.gitignore`, `.forgejo/workflows/.gitkeep`

- [ ] **Step 1: Create the repo via API**

```bash
curl -sS -X POST "$API/orgs/platform-infrastructure/repos" \
  -H "Authorization: token $FORGEJO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"supply-chain","description":"Image supply-chain gate: scorecard+hipcheck source risk, trivy+grype CVE, republish to local registry","private":true,"auto_init":true,"default_branch":"main"}' \
  | jq '{full_name, private, clone_url, ssh_url}'
```
Expected: JSON with `"full_name": "platform-infrastructure/supply-chain"`. If `422` "already exists", skip creation.

- [ ] **Step 2: Clone the new repo locally (separate from gitops-platform)**

```bash
cd /tmp && git clone ssh://git@git.seyzahl.com:2222/platform-infrastructure/supply-chain.git
cd /tmp/supply-chain
```
Expected: clone succeeds, contains the auto-init `README.md`.

- [ ] **Step 3: Write `.gitignore`**

```
# local scratch
*.log
sc.json
hc.json
```

- [ ] **Step 4: Write initial `README.md`** (finalized in Task 6)

```markdown
# supply-chain

Image supply-chain gate for the homelab clusters.

Gates a container image through:
1. **Source risk** (import mode only): OpenSSF Scorecard + Hipcheck against the upstream source repo.
2. **Image CVEs**: Trivy + Grype.

On pass, republishes to `forgejo.seyzahl.com/platform-infrastructure/<name>:<tag>`.

Usage docs: see below (filled in once the workflow lands).
```

- [ ] **Step 5: Create workflow dir placeholder**

```bash
mkdir -p /tmp/supply-chain/.forgejo/workflows && touch /tmp/supply-chain/.forgejo/workflows/.gitkeep
```

- [ ] **Step 6: Commit and push**

```bash
cd /tmp/supply-chain
git add .gitignore README.md .forgejo/workflows/.gitkeep
git commit -m "chore: initial scaffold"
git push origin main
```
Expected: push succeeds. Verify in Forgejo UI the repo shows the files.

---

## Task 2: Provision Actions secrets + variables

**Files:** none (Forgejo repo settings via API).

Repo-level Actions secrets endpoint: `PUT $API/repos/platform-infrastructure/supply-chain/actions/secrets/<NAME>` body `{"data":"<value>"}`. Variables endpoint: `POST $API/repos/platform-infrastructure/supply-chain/actions/variables/<NAME>` body `{"value":"<value>"}`.

- [ ] **Step 1: Set `REGISTRY_TOKEN` secret**

```bash
REG_TOKEN=$(az keyvault secret show --vault-name seyzahl --name forgejo-registry-token --query value -o tsv)
curl -sS -X PUT "$API/repos/platform-infrastructure/supply-chain/actions/secrets/REGISTRY_TOKEN" \
  -H "Authorization: token $FORGEJO_TOKEN" -H "Content-Type: application/json" \
  -d "{\"data\":\"$REG_TOKEN\"}" -w '%{http_code}\n'
```
Expected: `201` or `204`.

- [ ] **Step 2: Verify `forgejo-registry-token` has package-write to the org namespace**

```bash
echo "$REG_TOKEN" | docker login forgejo.seyzahl.com -u "$REGISTRY_USER_VALUE" --password-stdin
docker pull docker.io/library/busybox:1.37
docker tag docker.io/library/busybox:1.37 forgejo.seyzahl.com/platform-infrastructure/_scopecheck:probe
docker push forgejo.seyzahl.com/platform-infrastructure/_scopecheck:probe
```
(`REGISTRY_USER_VALUE` = the Forgejo username that owns `forgejo-registry-token`.)
Expected: push succeeds. If `denied`, mint a dedicated token with org package-write and use that for `REGISTRY_TOKEN` instead. Delete the probe package afterward via UI.

- [ ] **Step 3: Provision a GitHub read token for Scorecard/Hipcheck**

If a public-repo-read GitHub PAT already exists in KV, reuse it; else mint a fine-grained GitHub PAT with `public_repo` read only and store it:
```bash
az keyvault secret set --vault-name seyzahl --name github-readonly-token --value "<PAT>"
GH_TOKEN=$(az keyvault secret show --vault-name seyzahl --name github-readonly-token --query value -o tsv)
curl -sS -X PUT "$API/repos/platform-infrastructure/supply-chain/actions/secrets/GITHUB_AUTH_TOKEN" \
  -H "Authorization: token $FORGEJO_TOKEN" -H "Content-Type: application/json" \
  -d "{\"data\":\"$GH_TOKEN\"}" -w '%{http_code}\n'
```
Expected: `201`/`204`.

- [ ] **Step 4: Set workflow variables (scanner refs + registry user)**

Replace each value with the confirmed mirror ref / username from Prerequisites:
```bash
for kv in \
  "REGISTRY_USER=<forgejo-username>" \
  "TRIVY_IMAGE=forgejo.seyzahl.com/platform-infrastructure/trivy:latest" \
  "GRYPE_IMAGE=forgejo.seyzahl.com/platform-infrastructure/grype:latest" \
  "SCORECARD_IMAGE=forgejo.seyzahl.com/platform-infrastructure/scorecard:latest" \
  "HIPCHECK_IMAGE=forgejo.seyzahl.com/platform-infrastructure/hipcheck:latest" ; do
  name=${kv%%=*}; val=${kv#*=}
  curl -sS -X POST "$API/repos/platform-infrastructure/supply-chain/actions/variables/$name" \
    -H "Authorization: token $FORGEJO_TOKEN" -H "Content-Type: application/json" \
    -d "{\"value\":\"$val\"}" -w "$name %{http_code}\n"
done
```
Expected: each `201`. Pin `:latest` to digests once verified (Renovate manages later).

---

## Task 3: Workflow — acquire + publish (no gates yet, prove the round-trip)

**Files:**
- Create: `/tmp/supply-chain/.forgejo/workflows/scan-and-publish.yml`

- [ ] **Step 1: Write the workflow (acquire + publish only)**

```yaml
name: scan-and-publish
on:
  workflow_dispatch:
    inputs:
      image: { description: "Upstream image ref (import) or build target name", required: true, type: string }
      mode: { description: "import | build", required: true, type: choice, options: [import, build], default: import }
      tag: { description: "Published tag", required: true, type: string }
      context: { description: "Build context (build mode)", required: false, type: string, default: "." }
      source_repo: { description: "Override upstream source repo URL (import)", required: false, type: string, default: "" }
      scorecard_min: { description: "Min Scorecard score to pass", required: false, type: string, default: "4.0" }
      allow_missing_source: { description: "Warn+skip source gate if repo unresolved", required: false, type: boolean, default: false }
  workflow_call:
    inputs:
      image: { required: true, type: string }
      mode: { required: true, type: string }
      tag: { required: true, type: string }
      context: { required: false, type: string, default: "." }
      source_repo: { required: false, type: string, default: "" }
      scorecard_min: { required: false, type: string, default: "4.0" }
      allow_missing_source: { required: false, type: boolean, default: false }

jobs:
  pipeline:
    runs-on: ubuntu-latest
    steps:
      - name: Derive published name
        id: name
        run: |
          # strip registry + tag, keep last path element as <name>
          REF="${{ inputs.image }}"
          BASE="${REF%@*}"; BASE="${BASE%:*}"
          echo "name=${BASE##*/}" >> "$GITHUB_OUTPUT"

      - name: Acquire image
        run: |
          set -euo pipefail
          if [ "${{ inputs.mode }}" = "build" ]; then
            docker build -t "${{ inputs.image }}" "${{ inputs.context }}"
          else
            docker pull "${{ inputs.image }}"
          fi
          docker image inspect "${{ inputs.image }}" >/dev/null

      - name: Registry login
        run: echo "${{ secrets.REGISTRY_TOKEN }}" | docker login forgejo.seyzahl.com -u "${{ vars.REGISTRY_USER }}" --password-stdin

      - name: Publish
        run: |
          set -euo pipefail
          DEST="forgejo.seyzahl.com/platform-infrastructure/${{ steps.name.outputs.name }}:${{ inputs.tag }}"
          docker tag "${{ inputs.image }}" "$DEST"
          docker push "$DEST"
          echo "Published $DEST" >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 2: Commit and push**

```bash
cd /tmp/supply-chain
git add .forgejo/workflows/scan-and-publish.yml && git rm -q .forgejo/workflows/.gitkeep
git commit -m "feat: scan-and-publish workflow (acquire + publish)"
git push origin main
```

- [ ] **Step 3: Dispatch a known-good import (the green round-trip test)**

```bash
curl -sS -X POST "$API/repos/platform-infrastructure/supply-chain/actions/workflows/scan-and-publish.yml/dispatches" \
  -H "Authorization: token $FORGEJO_TOKEN" -H "Content-Type: application/json" \
  -d '{"ref":"main","inputs":{"image":"docker.io/library/busybox:1.37","mode":"import","tag":"1.37"}}' -w '%{http_code}\n'
```
Expected: `204`. Then watch the run in the Forgejo UI Actions tab.

- [ ] **Step 4: Verify the artifact landed**

`forgej-api-token` lacks `read:package`, so verify via the registry directly (uses registry creds, not the package API):
```bash
echo "$REG_TOKEN" | docker login forgejo.seyzahl.com -u "$REGISTRY_USER_VALUE" --password-stdin
docker manifest inspect forgejo.seyzahl.com/platform-infrastructure/busybox:1.37 | jq '.config.digest // .manifests[0].digest'
```
Expected: run succeeds and `docker manifest inspect` returns a digest — `busybox:1.37` is present at `forgejo.seyzahl.com/platform-infrastructure/busybox:1.37`. (Browse owner → Packages in the UI as a cross-check.)

---

## Task 4: Add the image-CVE gate (Trivy + Grype)

**Files:**
- Modify: `/tmp/supply-chain/.forgejo/workflows/scan-and-publish.yml` (insert two steps before `Publish`)

- [ ] **Step 1: Insert Trivy + Grype gate steps (immediately before the `Publish` step)**

```yaml
      - name: Image gate — Trivy
        run: |
          set -euo pipefail
          docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
            "${{ vars.TRIVY_IMAGE }}" image \
            --exit-code 1 --severity CRITICAL,HIGH --ignore-unfixed \
            "${{ inputs.image }}"

      - name: Image gate — Grype
        run: |
          set -euo pipefail
          docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
            "${{ vars.GRYPE_IMAGE }}" "docker:${{ inputs.image }}" --fail-on critical
```

- [ ] **Step 2: Commit and push**

```bash
cd /tmp/supply-chain
git add .forgejo/workflows/scan-and-publish.yml
git commit -m "feat: gate images on trivy(CRITICAL,HIGH) + grype(critical)"
git push origin main
```

- [ ] **Step 3: Re-dispatch busybox — gate should PASS**

```bash
curl -sS -X POST "$API/repos/platform-infrastructure/supply-chain/actions/workflows/scan-and-publish.yml/dispatches" \
  -H "Authorization: token $FORGEJO_TOKEN" -H "Content-Type: application/json" \
  -d '{"ref":"main","inputs":{"image":"docker.io/library/busybox:1.37","mode":"import","tag":"1.37"}}' -w '%{http_code}\n'
```
Expected: run succeeds (busybox is clean), republishes.

- [ ] **Step 4: Dispatch a knowingly-vulnerable old image — gate should FAIL (proves the gate gates)**

```bash
curl -sS -X POST "$API/repos/platform-infrastructure/supply-chain/actions/workflows/scan-and-publish.yml/dispatches" \
  -H "Authorization: token $FORGEJO_TOKEN" -H "Content-Type: application/json" \
  -d '{"ref":"main","inputs":{"image":"docker.io/library/debian:10.0","mode":"import","tag":"vuln-probe"}}' -w '%{http_code}\n'
```
Expected: run FAILS at the Trivy or Grype step; **no** `debian:vuln-probe` package published. (If `debian:10.0` ever comes back clean, substitute any image with known fixed CRITICALs.)

---

## Task 5: Add the source-risk gate (resolve-source + Scorecard + Hipcheck, import mode)

**Files:**
- Modify: `/tmp/supply-chain/.forgejo/workflows/scan-and-publish.yml` (insert steps after `Acquire image`, before the image gate)

- [ ] **Step 1: Insert resolve-source + Scorecard + Hipcheck steps (after `Acquire image`)**

```yaml
      - name: Resolve source repo
        id: src
        if: ${{ inputs.mode == 'import' }}
        run: |
          set -euo pipefail
          SRC=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' "${{ inputs.image }}" 2>/dev/null || true)
          [ -z "$SRC" ] && SRC="${{ inputs.source_repo }}"
          if [ -z "$SRC" ]; then
            if [ "${{ inputs.allow_missing_source }}" = "true" ]; then
              echo "::warning::No source repo resolved; skipping source gate (allow_missing_source=true)"
              echo "skip=true" >> "$GITHUB_OUTPUT"
            else
              echo "::error::No org.opencontainers.image.source label and no source_repo input. Pass source_repo or set allow_missing_source=true."
              exit 1
            fi
          else
            # normalize https://github.com/owner/repo(.git) -> github.com/owner/repo
            SRC=${SRC#https://}; SRC=${SRC#http://}; SRC=${SRC%.git}
            echo "repo=$SRC" >> "$GITHUB_OUTPUT"
            echo "Source repo: $SRC" >> "$GITHUB_STEP_SUMMARY"
          fi

      - name: Source gate — Scorecard
        if: ${{ inputs.mode == 'import' && steps.src.outputs.skip != 'true' }}
        env:
          GITHUB_AUTH_TOKEN: ${{ secrets.GITHUB_AUTH_TOKEN }}
        run: |
          set -euo pipefail
          docker run --rm -e GITHUB_AUTH_TOKEN \
            "${{ vars.SCORECARD_IMAGE }}" \
            --repo="${{ steps.src.outputs.repo }}" --format=json > sc.json
          SCORE=$(jq -r '.score' sc.json)
          MIN="${{ inputs.scorecard_min }}"
          echo "Scorecard: $SCORE (min $MIN)" >> "$GITHUB_STEP_SUMMARY"
          if awk "BEGIN{exit !($SCORE < $MIN)}"; then
            echo "::error::Scorecard $SCORE below minimum $MIN"; exit 1
          fi

      - name: Source gate — Hipcheck
        if: ${{ inputs.mode == 'import' && steps.src.outputs.skip != 'true' }}
        env:
          HC_GITHUB_TOKEN: ${{ secrets.GITHUB_AUTH_TOKEN }}
        run: |
          set -euo pipefail
          # hc exits non-zero when policy verdict is fail; capture report for the summary
          docker run --rm -e HC_GITHUB_TOKEN \
            "${{ vars.HIPCHECK_IMAGE }}" check -f json "https://${{ steps.src.outputs.repo }}" > hc.json || HC_RC=$?
          VERDICT=$(jq -r '.passed // .verdict // "unknown"' hc.json 2>/dev/null || echo unknown)
          echo "Hipcheck: $VERDICT" >> "$GITHUB_STEP_SUMMARY"
          if [ "${HC_RC:-0}" -ne 0 ]; then
            echo "::error::Hipcheck verdict failed"; exit "${HC_RC}"
          fi
```

> **Implementation note:** confirm Hipcheck's exact CLI (`hc check`), JSON shape, and exit-code semantics against the mirrored image at execution time; adjust the `jq` path and the invocation to match. Do the same one-line check for Scorecard's JSON `.score` field.

- [ ] **Step 2: Commit and push**

```bash
cd /tmp/supply-chain
git add .forgejo/workflows/scan-and-publish.yml
git commit -m "feat: gate import-mode images on scorecard+hipcheck source risk"
git push origin main
```

- [ ] **Step 3: Dispatch import with a healthy upstream — source gate PASSES**

```bash
curl -sS -X POST "$API/repos/platform-infrastructure/supply-chain/actions/workflows/scan-and-publish.yml/dispatches" \
  -H "Authorization: token $FORGEJO_TOKEN" -H "Content-Type: application/json" \
  -d '{"ref":"main","inputs":{"image":"docker.io/sissbruecker/linkding:1.31.0","mode":"import","tag":"1.31.0"}}' -w '%{http_code}\n'
```
Expected: source gate passes (or the run fails only at the image gate if linkding has CVEs — that is a true image-gate result, not a source-gate failure). Confirm the summary shows a Scorecard score and Hipcheck verdict.

- [ ] **Step 4: Dispatch import with missing source + `allow_missing_source=false` — FAILS at resolve-source**

```bash
curl -sS -X POST "$API/repos/platform-infrastructure/supply-chain/actions/workflows/scan-and-publish.yml/dispatches" \
  -H "Authorization: token $FORGEJO_TOKEN" -H "Content-Type: application/json" \
  -d '{"ref":"main","inputs":{"image":"docker.io/library/busybox:1.37","mode":"import","tag":"nosrc-probe"}}' -w '%{http_code}\n'
```
Expected: FAILS at `Resolve source repo` with the guidance error (busybox sets no source label). Re-dispatching the same with `"allow_missing_source":true` should skip the source gate and proceed to the image gate.

- [ ] **Step 5: (Optional) Prove the source gate fails on a low-scoring repo**

Dispatch an import whose `source_repo` points at a repo known to score below `scorecard_min`, or temporarily set `scorecard_min` high (e.g. `"9.9"`) on a normal import. Expected: FAILS at `Source gate — Scorecard`.

---

## Task 6: Finalize summary + README

**Files:**
- Modify: `/tmp/supply-chain/README.md`

- [ ] **Step 1: Replace README with full usage**

```markdown
# supply-chain

Image supply-chain gate for the homelab clusters. One workflow, `scan-and-publish.yml`, triggerable two ways:

- **`workflow_dispatch`** — manual third-party imports (UI or API).
- **`workflow_call`** — first-party build callers (e.g. blog) reuse it with `mode: build`.

## Gate order (single job, ordered steps)

1. **acquire** — `docker build` (build) or `docker pull` (import).
2. **resolve-source** (import) — read `org.opencontainers.image.source` label → else `source_repo` input → else fail (unless `allow_missing_source: true`).
3. **source gate** (import) — OpenSSF Scorecard (`score >= scorecard_min`, default 4.0) + Hipcheck (verdict not `fail`).
4. **image gate** — Trivy (`CRITICAL,HIGH`, `--ignore-unfixed`) + Grype (`--fail-on critical`).
5. **publish** — retag → `forgejo.seyzahl.com/platform-infrastructure/<name>:<tag>` and push.

Any gate failure stops the run; nothing is published.

## Inputs

| input | required | default | notes |
|-------|----------|---------|-------|
| `image` | yes | — | upstream ref (import) or build target (build) |
| `mode` | yes | `import` | `import` \| `build` |
| `tag` | yes | — | published tag (import: upstream version) |
| `context` | no | `.` | build context (build mode) |
| `source_repo` | no | — | override upstream source repo URL |
| `scorecard_min` | no | `4.0` | min Scorecard score |
| `allow_missing_source` | no | `false` | warn+skip source gate if unresolved |

## Manual import (API)

\`\`\`bash
curl -X POST "$API/repos/platform-infrastructure/supply-chain/actions/workflows/scan-and-publish.yml/dispatches" \
  -H "Authorization: token $FORGEJO_TOKEN" -H "Content-Type: application/json" \
  -d '{"ref":"main","inputs":{"image":"docker.io/sissbruecker/linkding:1.31.0","mode":"import","tag":"1.31.0"}}'
\`\`\`

## Call from a first-party build (build mode)

\`\`\`yaml
jobs:
  publish:
    uses: platform-infrastructure/supply-chain/.forgejo/workflows/scan-and-publish.yml@main
    with: { image: blog, mode: build, tag: build-${{ github.run_number }}, context: . }
    secrets: inherit
\`\`\`

## Secrets / variables

- secret `REGISTRY_TOKEN` — package-write to `platform-infrastructure`.
- secret `GITHUB_AUTH_TOKEN` — public-repo read (Scorecard/Hipcheck).
- vars `REGISTRY_USER`, `TRIVY_IMAGE`, `GRYPE_IMAGE`, `SCORECARD_IMAGE`, `HIPCHECK_IMAGE`.
```

- [ ] **Step 2: Commit and push**

```bash
cd /tmp/supply-chain
git add README.md
git commit -m "docs: full usage for scan-and-publish"
git push origin main
```

- [ ] **Step 3: Clean up probe artifacts**

Delete `busybox:nosrc-probe`, `debian:vuln-probe`, and `_scopecheck:probe` packages via the Forgejo UI (owner → Packages) if they were created.

---

## Done criteria

- Repo `platform-infrastructure/supply-chain` exists with `scan-and-publish.yml` + README.
- Green: a clean import publishes to `forgejo.seyzahl.com/platform-infrastructure/<name>:<tag>`.
- Red proven: vulnerable image fails the image gate; missing-source fails resolve-source; low Scorecard fails the source gate — none publish.
- Secrets + variables provisioned.
- Downstream (plan `2026-06-13-image-supply-chain.md` Tasks 2–4: blog onboarding, per-app import + manifest flips + Renovate mapping + cleanup rules, upgrade wave) remain to do.
```
