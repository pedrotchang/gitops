# Org Migration to `platform-infrastructure/` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the infra git repos `gitops-platform` and `homelab-private` from Forgejo user `pedrotchang/` into a new org `platform-infrastructure/`, flipping every live reference, with no update outage. (Note: Flux keeps serving the last-fetched artifact even if a source briefly becomes unreachable — so the worst case anywhere here is paused updates, not an outage. The redirect just keeps updates flowing during cutover.)

**Architecture:** Forgejo repo *transfer* (not recreate) so an old→new path redirect keeps Flux pulling during cutover. Deploy keys / push-mirror are repo-attached and survive transfer. Flux is repointed by editing each cluster's `gotk-sync.yaml` (committed, self-applied), data cluster first then tachtit (Forgejo runs on tachtit — bootstrap risk). The admin token in Azure KV `forgej-api-token` does all server-side work; the org creator (pedrotchang) becomes owner so existing tokens keep write access.

**Tech Stack:** Forgejo API, `az` CLI (Azure Key Vault), `flux` CLI, `git`, `curl`, `jq`. Two cluster kubeconfigs live in the repo root: `data-kubeconfig.yaml`, `tachtit-kubeconfig.yaml`.

**Spec:** `docs/superpowers/specs/2026-06-14-org-migration-platform-infrastructure-design.md`

---

## Conventions for every task

- All `curl` and `flux` commands assume the env block from Task 0 is exported in the current shell.
- A **Verify gate** step is mandatory: do not proceed to the next task until its expected output appears. This is the runbook's equivalent of a passing test.
- Commit messages: Conventional Commits, **no `Co-Authored-By` trailer** (project policy).
- Push goes to Forgejo `origin` only (GitHub is an auto push-mirror — never push it directly).
- **Token-scope assumption (the "no re-grant" insight):** Forgejo personal access tokens are *user-wide with category scopes* (e.g. `write:repository`), **not** repo/path-scoped like GitHub fine-grained tokens. So once pedrotchang is an org member/owner, his existing tokens (`flux-forgejo-token`, renovate, registry) automatically reach the org repos — **provided their scope categories already suffice**, which they do because the same tokens write these same repos today. The one scope this plan does *not* exercise is `write:package` for a CI registry push — that belongs to the deferred `custom-images` work (`docs/superpowers/plans/2026-06-14-supply-chain-pipeline-repo.md`), since Phase 4's build workflow is dormant. Token scopes can't be introspected via the admin token (Forgejo requires basic-auth for the tokens endpoint), so the **functional gates** — image-automation push (Task 4) and the next Renovate PR (Task 6) — are the verification that the grant actually carried.

---

## Task 0: Environment & preflight

**Files:** none (shell setup).

- [ ] **Step 1: Export connection vars + admin token**

```bash
export FORGEJO="https://forgejo.seyzahl.com"
export SSH_BASE="ssh://git@git.seyzahl.com:2222"
export ORG="platform-infrastructure"
export ADMIN="$(az keyvault secret show --vault-name seyzahl --name forgej-api-token --query value -o tsv)"
```

- [ ] **Step 2: Verify token works and identifies pedrotchang as admin**

Run:
```bash
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/user" | jq '{login, is_admin}'
```
Expected: `{"login": "pedrotchang", "is_admin": true}`

- [ ] **Step 3: Verify required CLIs present**

Run:
```bash
for c in az flux git curl jq; do command -v "$c" >/dev/null && echo "ok $c" || echo "MISSING $c"; done
```
Expected: five `ok` lines, no `MISSING`.

- [ ] **Step 4: Record baseline — both clusters Ready on the OLD url**

Run:
```bash
flux --kubeconfig ./data-kubeconfig.yaml get sources git -n flux-system
flux --kubeconfig ./tachtit-kubeconfig.yaml get sources git -n flux-system
```
Expected: both show `url: ...pedrotchang/gitops-platform` and `READY: True`. Save this output — it is the rollback reference.

---

## Task 1: Create the org

**Files:** none (API).

- [ ] **Step 1: Create org `platform-infrastructure`**

Run:
```bash
curl -fsS -X POST "$FORGEJO/api/v1/orgs" \
  -H "Authorization: token $ADMIN" -H "Content-Type: application/json" \
  -d '{"username":"platform-infrastructure","visibility":"private"}'
```
Expected: JSON with `"username": "platform-infrastructure"`, HTTP 201.

- [ ] **Step 2: Verify org exists and pedrotchang is an owner**

Run:
```bash
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/orgs/$ORG" | jq .username
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/orgs/$ORG/members" | jq '.[].login'
```
Expected: `"platform-infrastructure"`, and `"pedrotchang"` appears in the members list.

- [ ] **Step 3: Suspend tachtit image-automation (close the push-through-redirect gap)**

The Phase 2 redirect gate (Task 2 Step 4) tests `git ls-remote` — a *fetch*, which covers Flux pulls. But the `ImageUpdateAutomation` `blog` *pushes* policy commits via the in-cluster HTTP path; push-through-redirect is a separate, untested code path, and if the automation fires between the transfer (Task 2) and the push-url flip (Task 4 Step 4) it would push to the old path. Suspend it now and resume it after the url is flipped (Task 4).

Run:
```bash
flux --kubeconfig ./tachtit-kubeconfig.yaml suspend image update blog -n flux-system
flux --kubeconfig ./tachtit-kubeconfig.yaml get image update blog -n flux-system
```
Expected: `blog` shows `SUSPENDED: True`.

---

## Task 2: Transfer both repos + verify safety net + flip this checkout's origin

**Files:** none in-tree for the transfer; local git remote of this checkout changes.

- [ ] **Step 1: Transfer `gitops-platform` user → org**

Run:
```bash
curl -fsS -X POST "$FORGEJO/api/v1/repos/pedrotchang/gitops-platform/transfer" \
  -H "Authorization: token $ADMIN" -H "Content-Type: application/json" \
  -d "{\"new_owner\":\"$ORG\"}"
```
Expected: HTTP 202/200 with repo JSON showing `"full_name": "platform-infrastructure/gitops-platform"`.

- [ ] **Step 2: Transfer `homelab-private` user → org**

Run:
```bash
curl -fsS -X POST "$FORGEJO/api/v1/repos/pedrotchang/homelab-private/transfer" \
  -H "Authorization: token $ADMIN" -H "Content-Type: application/json" \
  -d "{\"new_owner\":\"$ORG\"}"
```
Expected: repo JSON with `"full_name": "platform-infrastructure/homelab-private"`.

- [ ] **Step 3: Verify repos resolve at the org path**

Run:
```bash
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/repos/$ORG/gitops-platform" | jq .full_name
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/repos/$ORG/homelab-private" | jq .full_name
```
Expected: `"platform-infrastructure/gitops-platform"` and `"platform-infrastructure/homelab-private"`.

- [ ] **Step 4: Verify the redirect (the strangler safety net) — SSH git ops on the OLD path still work**

Run:
```bash
git ls-remote "$SSH_BASE/pedrotchang/gitops-platform" HEAD
git ls-remote "$SSH_BASE/pedrotchang/homelab-private" HEAD
```
Expected: each prints a commit SHA + `HEAD` (the old path redirects to the org repo). The instance already 307-redirects the old `seyza` username (per the prior forgejo-migration plan), so transfer-redirect is likely — but rename and transfer are distinct ops, so verify rather than assume.
**If either fails:** there is no outage — Flux keeps serving the last-fetched artifact — but updates from the old path stop. Recover by doing Task 3 + Task 4 in one window (flip both clusters immediately to the new url) and treat the redirect-dependent staging as void.

- [ ] **Step 5: Verify deploy keys survived the transfer**

Run:
```bash
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/repos/$ORG/gitops-platform/keys" | jq 'length'
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/repos/$ORG/homelab-private/keys" | jq 'length'
```
Expected: each `>= 1` (the Flux read deploy keys carried over). If `0`, the Flux secrets must be regenerated — see "Deploy-key fallback" at the bottom before continuing.

- [ ] **Step 6: Verify GitHub push-mirror + any webhooks survived**

Run:
```bash
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/repos/$ORG/gitops-platform/push_mirrors" | jq '.[].remote_address'
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/repos/$ORG/gitops-platform/hooks" | jq '.[] | {type, url: .config.url, active}'
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/repos/$ORG/homelab-private/hooks" | jq '.[] | {type, url: .config.url, active}'
```
Expected: the `github.com/pedrotchang/...` mirror address (mirror config carried over). Webhooks: **none expected** — there is no user-defined Flux `Receiver` and CI is Forgejo Actions (internal, not webhook-driven). If any hook is listed, confirm it survived `active: true`; if a hook is missing that you rely on, recreate it via `POST .../hooks` before relying on it.

- [ ] **Step 7: Flip this checkout's `origin` to the org path and test push round-trip**

Run:
```bash
git remote set-url origin "$SSH_BASE/$ORG/gitops-platform.git"
git fetch origin
git remote -v
```
Expected: `origin` shows `platform-infrastructure/gitops-platform.git`, fetch succeeds. (This also proves the org SSH path accepts authenticated git ops, so all later pushes go direct, not via redirect.)

---

## Task 3: Flip the DATA cluster Flux source (Phase 3a)

**Files:**
- Modify: `clusters/data/flux-system/gotk-sync.yaml:14`

- [ ] **Step 1: Edit the data GitRepository url**

Change line 14 from:
```yaml
  url: ssh://git@git.seyzahl.com:2222/pedrotchang/gitops-platform
```
to:
```yaml
  url: ssh://git@git.seyzahl.com:2222/platform-infrastructure/gitops-platform
```
(The `# DO NOT EDIT` banner is Flux's generated-file marker; editing the url to repoint the source is the intended, supported operation.)

- [ ] **Step 2: Commit and push**

```bash
git add clusters/data/flux-system/gotk-sync.yaml
git commit -m "chore(flux): repoint data cluster source to platform-infrastructure org"
git push origin main
```

- [ ] **Step 3: Reconcile data Flux so it pulls the commit (via old url + redirect) and self-applies the new url**

Run:
```bash
flux --kubeconfig ./data-kubeconfig.yaml reconcile kustomization flux-system -n flux-system --with-source
```
Expected: completes without error (`applied revision main@sha1:<new-sha>`).

- [ ] **Step 4: Verify gate — data source now on the ORG url and Ready**

Run:
```bash
flux --kubeconfig ./data-kubeconfig.yaml get sources git -n flux-system
```
Expected: `url` = `...platform-infrastructure/gitops-platform`, `READY: True`, revision = the pushed SHA.

- [ ] **Step 5: Verify data cluster reconciles cleanly on the new source**

Run:
```bash
flux --kubeconfig ./data-kubeconfig.yaml get kustomizations -A
```
Expected: all Kustomizations `READY: True`, no `False`/stalled entries.

---

## Task 4: Soak, then flip the TACHTIT cluster (Phase 3b)

**Files:**
- Modify: `clusters/tachtit/flux-system/gotk-sync.yaml:14`
- Modify: `clusters/tachtit/private-apps.yaml:12`
- Modify: `infrastructure/configs/tachtit/image-automation/gitrepository-push.yaml:8`

- [ ] **Step 1: Soak the data cluster**

Wait ~15 minutes after Task 3. Re-run:
```bash
flux --kubeconfig ./data-kubeconfig.yaml get kustomizations -A
```
Expected: still all `READY: True`. This confirms the org source is stable before touching the cluster that hosts Forgejo.

- [ ] **Step 2: Edit the tachtit GitRepository url**

`clusters/tachtit/flux-system/gotk-sync.yaml:14` →
```yaml
  url: ssh://git@git.seyzahl.com:2222/platform-infrastructure/gitops-platform
```

- [ ] **Step 3: Edit the private-apps (homelab-private) source url**

`clusters/tachtit/private-apps.yaml:12` →
```yaml
  url: ssh://git@git.seyzahl.com:2222/platform-infrastructure/homelab-private
```

- [ ] **Step 4: Edit the image-automation push target**

`infrastructure/configs/tachtit/image-automation/gitrepository-push.yaml:8` →
```yaml
  url: http://forgejo.forgejo.svc.cluster.local:3000/platform-infrastructure/gitops-platform.git
```

- [ ] **Step 5: Commit and push**

```bash
git add clusters/tachtit/flux-system/gotk-sync.yaml \
        clusters/tachtit/private-apps.yaml \
        infrastructure/configs/tachtit/image-automation/gitrepository-push.yaml
git commit -m "chore(flux): repoint tachtit sources + image-automation to platform-infrastructure org"
git push origin main
```

- [ ] **Step 6: Reconcile tachtit Flux**

Run:
```bash
flux --kubeconfig ./tachtit-kubeconfig.yaml reconcile kustomization flux-system -n flux-system --with-source
```
Expected: `applied revision main@sha1:<new-sha>` without error.

- [ ] **Step 7: Verify gate — tachtit sources on the ORG urls and Ready**

Run:
```bash
flux --kubeconfig ./tachtit-kubeconfig.yaml get sources git -A
```
Expected: `flux-system` → `...platform-infrastructure/gitops-platform`, `private-apps` → `...platform-infrastructure/homelab-private`, both `READY: True`.

- [ ] **Step 8: Verify tachtit reconciles cleanly on the new sources**

Run:
```bash
flux --kubeconfig ./tachtit-kubeconfig.yaml get kustomizations -A
```
Expected: all Kustomizations `READY: True`, no `False`/stalled rows. (`image-automation` is still suspended from Task 1 Step 3 — that's expected here.)

- [ ] **Step 9: Resume image-automation and verify it pushes to the ORG repo**

Now that the push url points at the org (Step 4) and tachtit is healthy, resume:
```bash
flux --kubeconfig ./tachtit-kubeconfig.yaml resume image update blog -n flux-system
flux --kubeconfig ./tachtit-kubeconfig.yaml reconcile image update blog -n flux-system
flux --kubeconfig ./tachtit-kubeconfig.yaml get image update blog -n flux-system
```
Expected: `blog` shows `SUSPENDED: False` and a `Ready: True` status reporting a commit against `platform-infrastructure/gitops-platform` (or "no changes" if nothing to bump). If the push fails on auth, the `flux-forgejo-token` (user pedrotchang) lacks org write — re-check org membership from Task 1 and the token-scope note in Conventions. This is the functional gate for the "no re-grant" insight.

---

## Task 5: nextcloud registry namespace cleanup + registry audit

**Files:**
- Modify: `images/nextcloud/.forgejo/workflows/build.yaml:37-40`

> **NOTE — read before doing this task.** This workflow lives at `images/nextcloud/.forgejo/workflows/`, a *nested* path. Forgejo Actions only runs workflows from `.forgejo/workflows/` at the **repo root**, so this workflow is **dormant — it does not execute today**. This task therefore does NOT build or push an image; it only (a) replaces the stale `seyza` namespace (that user was renamed to `pedrotchang`, so `seyza/nextcloud` is invalid) with the org namespace so the file is correct when it is later extracted, and (b) audits what (if anything) is actually in the registry. Actually building the org-namespaced nextcloud image is **deferred to the `custom-images` repo** (separate spec), where the workflow will sit at repo root and run.

- [ ] **Step 1: Update the namespace in the dormant build workflow**

Replace lines 37-40:
```yaml
          tags: |
            forgejo.seyzahl.com/seyza/nextcloud:stable
            forgejo.seyzahl.com/seyza/nextcloud:${{ github.sha }}
          cache-from: type=registry,ref=forgejo.seyzahl.com/seyza/nextcloud:buildcache
          cache-to: type=registry,ref=forgejo.seyzahl.com/seyza/nextcloud:buildcache,mode=max
```
with:
```yaml
          tags: |
            forgejo.seyzahl.com/platform-infrastructure/nextcloud:stable
            forgejo.seyzahl.com/platform-infrastructure/nextcloud:${{ github.sha }}
          cache-from: type=registry,ref=forgejo.seyzahl.com/platform-infrastructure/nextcloud:buildcache
          cache-to: type=registry,ref=forgejo.seyzahl.com/platform-infrastructure/nextcloud:buildcache,mode=max
```

- [ ] **Step 2: Audit the registry to locate the nextcloud package authoritatively (no guessing)**

`seyza` is the legacy username, renamed to `pedrotchang` (id 1); old `seyza` URLs 307-redirect to `pedrotchang`. So a container package ever pushed to `seyza/nextcloud` now lives under the `pedrotchang` namespace — there is no separate `seyza` package owner to act on. Determine the exact owner + name + versions that actually exist:

```bash
# canonical list under the current user namespace:
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/packages/pedrotchang?type=container" \
  | jq '.[] | {owner: .owner.login, type, name, version}'
```
Expected: record the exact `{owner, name, version}` of any `nextcloud` package (if present). If the list shows no `nextcloud`, there is nothing to delete — record "none" and skip Task 8 Step 3. **Do not** infer a target; Task 8 deletes only what this step printed verbatim.

- [ ] **Step 3: Commit**

```bash
git add images/nextcloud/.forgejo/workflows/build.yaml
git commit -m "chore(images): point dormant nextcloud build at platform-infrastructure namespace"
git push origin main
```

---

## Task 6: Renovate, docs, and homelab-private local remote

**Files:**
- Modify: `infrastructure/controllers/base/renovate-operator/renovatejob.yaml:14`
- Modify: `README.md:5`
- Modify: `docs/backups.md` (lines ~249-250, ~265)
- Inspect: `renovate.json` (root)

- [ ] **Step 1: Update the Renovate repo list**

`infrastructure/controllers/base/renovate-operator/renovatejob.yaml:14` →
```yaml
    - "platform-infrastructure/gitops-platform"
```

- [ ] **Step 2: Confirm `renovate.json` has no owner self-reference**

Run:
```bash
grep -n "pedrotchang" renovate.json || echo "clean"
```
Expected: `clean` (config holds rules, not the repo owner). If a match appears, update it to `platform-infrastructure/...`.

- [ ] **Step 3: Update README canonical-home link**

`README.md:5` — replace both occurrences of `forgejo.seyzahl.com/pedrotchang/gitops-platform` with `forgejo.seyzahl.com/platform-infrastructure/gitops-platform`.

- [ ] **Step 4: Update the DR runbook in `docs/backups.md`**

- Line ~249: `ssh://git@git.seyzahl.com:2222/pedrotchang/gitops-platform` → `.../platform-infrastructure/gitops-platform`.
- Line ~250: `.../homelab-private` → `.../platform-infrastructure/homelab-private`.
- Line ~265: the GitHub mirror DR command stays pointed at `github.com/pedrotchang/...` (the mirror genuinely lives under the GitHub user — leave it, it is the cold fallback).
- Add one line under the DR section: rollback note — "Old `pedrotchang/` Forgejo paths redirect to the org; to roll back a cluster, revert its `gotk-sync.yaml` url commit."

- [ ] **Step 5: Verify no unexpected old refs remain in tracked, non-historical files**

Run:
```bash
grep -rIn "pedrotchang/gitops-platform\|pedrotchang/homelab-private" \
  --include=*.yaml --include=*.json --include=*.md . \
  | grep -v "docs/superpowers/" | grep -v "github.com/pedrotchang"
```
Expected: no output (the only allowed remaining mentions are historical plans/specs under `docs/superpowers/` and the intentional GitHub-mirror DR command).

- [ ] **Step 6: Commit**

```bash
git add infrastructure/controllers/base/renovate-operator/renovatejob.yaml README.md docs/backups.md
git commit -m "chore: repoint renovate + docs to platform-infrastructure org"
git push origin main
```

- [ ] **Step 7: Flip the homelab-private local checkout remote**

In the homelab-private working copy (not this repo):
```bash
git -C <path-to-homelab-private> remote set-url origin "$SSH_BASE/$ORG/homelab-private.git"
git -C <path-to-homelab-private> fetch origin
```
Expected: fetch succeeds against the org path. (If the checkout's path is unknown, find it with `find ~/Repos -maxdepth 4 -name homelab-private -type d`.)

- [ ] **Step 8: Verify Renovate targets the org on its next run**

After the renovate cron fires (or trigger it), confirm a Renovate PR/branch appears under `platform-infrastructure/gitops-platform`:
```bash
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/repos/$ORG/gitops-platform/pulls?state=open" | jq '.[].head.ref'
```
Expected: Renovate branches show up here (not under the old path) on the next cycle.

---

## Task 7: GitHub mirror descriptions

**Files:** none in-tree (GitHub-side, via `gh`).

- [ ] **Step 1: Update GitHub mirror repo descriptions**

```bash
gh repo edit pedrotchang/gitops --description "Mirror of forgejo.seyzahl.com/platform-infrastructure/gitops-platform"
gh repo edit pedrotchang/homelab-private --description "Mirror of forgejo.seyzahl.com/platform-infrastructure/homelab-private"
```
(Repo names per the prior forgejo-migration plan: `gitops-platform` mirrors to GitHub `pedrotchang/gitops`. Verify the exact GitHub name with `gh repo list pedrotchang` first if unsure.)
Expected: `gh` reports the descriptions updated.

- [ ] **Step 2: Verify the mirror is still receiving pushes**

Run:
```bash
git ls-remote https://github.com/pedrotchang/gitops HEAD
```
Expected: the SHA matches the latest Forgejo `main` (mirror is current after the Task 3-6 pushes).

---

## Task 8: Final verification + stale-package cleanup

**Files:** none.

- [ ] **Step 1: Both clusters Ready on the ORG url**

Run:
```bash
flux --kubeconfig ./data-kubeconfig.yaml get sources git -n flux-system
flux --kubeconfig ./tachtit-kubeconfig.yaml get sources git -A
```
Expected: every GitRepository shows a `platform-infrastructure/...` url and `READY: True`.

- [ ] **Step 2: Both clusters fully reconciled**

Run:
```bash
flux --kubeconfig ./data-kubeconfig.yaml get kustomizations -A
flux --kubeconfig ./tachtit-kubeconfig.yaml get kustomizations -A
```
Expected: no `READY: False` rows on either cluster.

- [ ] **Step 3: Delete the stale nextcloud package — only the exact target from Task 5 Step 2**

Skip entirely if Task 5 Step 2 recorded "none". Otherwise, this is a destructive `DELETE` — run it only against the exact `{owner, name, version}` that audit printed, and only after confirming nothing consumes the image:

```bash
# 1. Confirm no manifest references the image (HelmRelease uses upstream nextcloud:stable, so expect no hits):
grep -rIn "forgejo.seyzahl.com/.*/nextcloud" apps/ infrastructure/ --include=*.yaml || echo "no consumers — safe to delete"

# 2. Delete each version recorded in Task 5 Step 2 (substitute the audited values; do NOT guess):
#    curl -fsS -X DELETE -H "Authorization: token $ADMIN" \
#      "$FORGEJO/api/v1/packages/<owner>/container/<name>/<version>"

# 3. Re-list to confirm removal:
curl -fsS -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/packages/pedrotchang?type=container" | jq '.[] | select(.name=="nextcloud")'
```
Expected: step 1 prints "no consumers"; the re-list returns empty for `nextcloud`. If step 1 finds a consumer, **do not delete** — that means something was wired to the image; reconcile that first.

- [ ] **Step 4: Final ref sweep**

Run:
```bash
grep -rIn "pedrotchang/gitops-platform\|pedrotchang/homelab-private" \
  --include=*.yaml --include=*.json --include=*.md . \
  | grep -v "docs/superpowers/" | grep -v "github.com/pedrotchang"
```
Expected: no output.

---

## Deploy-key fallback (only if Task 2 Step 5 shows 0 keys)

If deploy keys did NOT survive the transfer, regenerate per repo before flipping that repo's cluster source:

1. `ssh-keygen -t ed25519 -f ./flux-data -N "" -C "flux-data@platform-infrastructure"`
2. Add the public key as a **read-only** deploy key:
   `curl -fsS -X POST -H "Authorization: token $ADMIN" "$FORGEJO/api/v1/repos/$ORG/gitops-platform/keys" -d '{"title":"flux-data","key":"<contents of flux-data.pub>","read_only":true}'`
3. Build `known_hosts`: `ssh-keyscan -p 2222 git.seyzahl.com > ./known_hosts`
4. Replace the cluster's `flux-system` secret keys (`identity`, `identity.pub`, `known_hosts`) — same key names the existing secret uses:
   `kubectl --kubeconfig ./data-kubeconfig.yaml -n flux-system create secret generic flux-system --from-file=identity=./flux-data --from-file=identity.pub=./flux-data.pub --from-file=known_hosts=./known_hosts --dry-run=client -o yaml | kubectl --kubeconfig ./data-kubeconfig.yaml apply -f -`
5. Repeat for `homelab-private` + the `private-apps` secret on tachtit.
6. Delete the local private keys after applying.

---

## Rollback

- **Soft (preferred):** the old `pedrotchang/` paths redirect, so for any cluster, `git revert` the `gotk-sync.yaml` url commit and reconcile — it returns to the old path transparently.
- **Hard:** transfer a repo back to the user — `curl -X POST .../repos/$ORG/<repo>/transfer -d '{"new_owner":"pedrotchang"}'`; or fail a cluster over to the GitHub mirror with the `kubectl patch gitrepository` command in `docs/backups.md`.

---

## Self-review notes (spec coverage)

- Spec §1 prep → Task 1. §2 transfers/redirect/keys/mirror → Task 2. §3 Flux flip (3a/3b) → Tasks 3-4. §4 registry → Task 5 (adjusted: dormant-workflow discovery, build deferred to custom-images). §5 refs/local/docs → Task 6. §6 GitHub mirror → Task 7. §7 rollback → Rollback section. Success criteria → Task 8.
- Deferred per spec: `custom-images` repo, wiring the nextcloud HelmRelease to the org image, moving blog/garden images off ghcr.io. None appear as tasks here, by design.
