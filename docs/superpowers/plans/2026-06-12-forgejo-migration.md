# GitHub → Forgejo Migration (Strangler Fig) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** forgejo.seyzahl.com/pedrotchang becomes the source of truth for the repos that matter; GitHub demotes to an unattended push-mirror (disaster-recovery cold copy). Flux flips per cluster, data first.

**Architecture:** Forgejo user `pedrotchang` (renamed from seyza, id 1, admin) owns everything. Forgejo's built-in GitHub migration API imports repos; built-in push-mirrors keep GitHub identical on every push. Flux `gotk-sync.yaml` lives in git on both clusters, so the source flip is a committed edit + a new read-only deploy credential per cluster. Strangler order: migrate repos → mirror → flip local remotes → flip data-cluster Flux → soak → flip tachtit Flux + automation (image-automation, Renovate) → demote GitHub.

**Decisions (user, 2026-06-12):** owner = user `pedrotchang` (no org — reversible later via repo transfer). Repos now: homelab (**renamed `gitops`** — `gitops-platform` name collides with an existing GitHub repo), homelab-private, blog, maincv, dotfiles, secondbrain-cli, .password-store, taxes. Strangler with both sources alive; GitHub stays as permanent mirror (bootstrap-deadlock mitigation: Forgejo runs ON tachtit).

**Verified facts:** maincv already exists on Forgejo (skip or refresh). Old `seyza` URLs 307-redirect. No admin API token exists yet — mint via `forgejo admin user generate-access-token` through kubectl. `flux-github-token` + `lux-api-github-pat` exist in Azure KV. Renovate runs `RENOVATE_PLATFORM: github`. Nextcloud's imagePullSecret uses KV `forgejo-registry-username` = stale value `seyza`.

---

### Task 1: Credentials groundwork (controller-led — secrets)

- [ ] Admin token EXISTS: Azure KV `forgej-api-token` (sic, typo'd name) — verified `pedrotchang`, `is_admin: true`. Use it; no minting. (KV `forgejo-registry-password` is stale — its token was deleted server-side; flag for cleanup.)
- [ ] Fix rename fallout: `az keyvault secret set --vault-name seyzahl --name forgejo-registry-username --value pedrotchang`. Verify nextcloud ExternalSecret re-renders (refreshInterval 1h or force: annotate ES) and pulls still work; check `apps/base/nextcloud/secrets.yaml` template for hardcoded `seyza` references.
- [ ] Delete leftover UI tokens `pkg-verify-tmp`/`pkg-verify-tmp2` (user, UI) — or via admin API now that we have a token: `curl -X DELETE -H "Authorization: token $ADMIN" https://forgejo.seyzahl.com/api/v1/users/pedrotchang/tokens/pkg-verify-tmp` (basic-auth requirement applies to creation, deletion works with admin sudo — verify, else leave for UI).
- [ ] GitHub side token for migration + mirrors: use `gh auth token` locally (has repo scope). For the permanent push-mirrors, create a dedicated GitHub fine-grained PAT `forgejo-push-mirror` (contents:write on the 8 target repos, no expiry or 1y) — store in KV as `github-mirror-token` + pass.

### Task 2: Migrate the 8 repos (admin token + migration API)

For each of: homelab→**gitops**, homelab-private, blog, dotfiles, secondbrain-cli, .password-store, taxes (maincv: already present — verify it's current; re-push if stale):

```bash
curl -s -X POST -H "Authorization: token $ADMIN" -H "Content-Type: application/json" \
  https://forgejo.seyzahl.com/api/v1/repos/migrate -d '{
    "clone_addr": "https://github.com/pedrotchang/<gh-name>.git",
    "auth_token": "<gh-token>",
    "repo_name": "<forgejo-name>",
    "repo_owner": "pedrotchang",
    "private": <true|false per source>,
    "service": "github",
    "issues": true, "labels": true, "milestones": true, "releases": true, "wiki": true
  }'
```

- [ ] homelab → `gitops` (public on GH; decide: keep public). All others: private per GitHub visibility.
- [ ] Verify each: `GET /api/v1/repos/pedrotchang/<name>` 200, branch count, latest commit SHA matches GitHub HEAD (`git ls-remote` both sides, compare).
- [ ] Rename GitHub repo for symmetry: `gh repo rename gitops -R pedrotchang/homelab` (GitHub auto-redirects old URL; Flux keeps working through the redirect until the flip — verify `flux get sources git` stays Ready on both clusters right after).

### Task 3: Push-mirrors Forgejo → GitHub (all 8)

```bash
curl -s -X POST -H "Authorization: token $ADMIN" -H "Content-Type: application/json" \
  https://forgejo.seyzahl.com/api/v1/repos/pedrotchang/<name>/push_mirrors -d '{
    "remote_address": "https://github.com/pedrotchang/<gh-name>.git",
    "remote_username": "pedrotchang",
    "remote_password": "<github-mirror-token>",
    "interval": "8h0m0s",
    "sync_on_commit": true
  }'
```

- [ ] Verify: push a trivial commit to Forgejo gitops, confirm it lands on GitHub within a minute (`sync_on_commit`).
- [ ] From this point: GitHub is write-never for humans. Forgejo is where pushes go.

### Task 4: Flip local remotes (this machine)

- [ ] `git remote set-url origin ssh://git@git.seyzahl.com:2222/pedrotchang/gitops.git` in the homelab checkout (and homelab-private). Test `git fetch` + a push (ssh host key on first use). Keep using existing local dir name — renaming `/Users/seyza/Repos/github.com/pedrotchang/homelab` would orphan the Claude memory dir keyed to that path; optional cosmetic move later (copy `~/.claude/projects/-Users-seyza-...-homelab/memory/` alongside if done).
- [ ] Other migrated repos' local checkouts: same set-url, opportunistically.
- [ ] `pass git remote` — `.password-store` is itself git-backed; flip its remote too (`pass git remote set-url origin ...`).

### Task 5: Flip data-cluster Flux (strangler first bite — no circularity)

- [ ] Create read-only deploy credential: generate ed25519 keypair locally, add public key as deploy key (read-only) on Forgejo `gitops` repo (`POST /repos/pedrotchang/gitops/keys`), put private key + known_hosts (`ssh-keyscan -p 2222 git.seyzahl.com`) in a new `flux-system` secret on the data cluster (replace contents of existing `flux-system` secret — same keys: identity, identity.pub, known_hosts).
- [ ] Edit `clusters/data/flux-system/gotk-sync.yaml`: url → `ssh://git@git.seyzahl.com:2222/pedrotchang/gitops.git`. Commit to **Forgejo** (now origin), push (mirror carries it to GitHub).
- [ ] `flux reconcile source git flux-system` on data; expect Ready with new URL pulling from Forgejo. All downstream Kustomizations stay Ready (same content, same revision SHAs).
- [ ] Soak: leave data cluster on Forgejo for several days before Task 6 (user judgment on duration).

### Task 6: Flip tachtit Flux + private-apps

> **Lesson from the data-cluster flip (2026-06-12):** replacing the `flux-system` secret while the
> GitRepository still points at GitHub deadlocks the source controller (new key can't fetch old URL,
> so it never fetches the commit that changes the URL). Sequence for tachtit: replace secret AND
> `kubectl patch gitrepository -n flux-system flux-system --type=merge -p '{"spec":{"url":"ssh://git@git.seyzahl.com:2222/pedrotchang/gitops"}}'`
> in the same breath, with the gotk-sync.yaml commit already pushed (it just confirms live state on next apply).

- [ ] Same deploy-key dance for tachtit `flux-system` secret + `clusters/tachtit/flux-system/gotk-sync.yaml` (separate deploy key `flux-tachtit-cluster`).
- [ ] `private-apps` GitRepository (clusters/tachtit/private-apps.yaml or its secretRef): url → `ssh://git@git.seyzahl.com:2222/pedrotchang/homelab-private.git`, new deploy key on that repo.
- [ ] Verify all 10 tachtit Kustomizations Ready from Forgejo revisions.
- [ ] **DR runbook entry in docs/backups.md**: "tachtit down → `flux create source git flux-system --url=ssh://git@github.com/pedrotchang/gitops ...` (or kubectl-edit GitRepository back to GitHub mirror) → rebuild → flip back." Exact commands written out.

### Task 7: Port automation off GitHub

- [ ] image-automation (`infrastructure/configs/tachtit/image-automation/`): `gitrepository-push.yaml` url → Forgejo https, `github-token-secret.yaml` → ExternalSecret pulling `forgejo-admin-token` (or a dedicated `forgejo-flux-token` with write:repository scope — prefer dedicated, mint in Task 1). ImageUpdateAutomation push branch unchanged. Verify by waiting for next image bump commit authored on Forgejo.
- [ ] Renovate (`infrastructure/controllers/base/renovate/`): `RENOVATE_PLATFORM: gitea`, `RENOVATE_ENDPOINT: https://forgejo.seyzahl.com/api/v1`, token secret → forgejo token, `RENOVATE_REPOSITORIES: pedrotchang/gitops` (+ others as desired). Renovate's gitea platform supports Forgejo. Verify next cron run opens a Forgejo PR.
- [ ] Revoke/clean GitHub PATs no longer needed (`flux-github-token` stays ONLY if something still uses it — after this task nothing should; delete from KV + GitHub).

### Task 8: Demote GitHub

- [ ] On the 8 GitHub repos: disable Actions, Issues, PRs (Settings), description → "Mirror of forgejo.seyzahl.com/pedrotchang/<name>".
- [ ] Leave repos unarchived (archived repos reject mirror pushes).
- [ ] Remaining 20+ GitHub repos: untouched (future second pass).

---

## Risks / notes
- **Bootstrap deadlock** mitigated by permanent GitHub push-mirror + DR runbook (Task 6).
- Data-cluster Flux now depends on Forgejo-on-tachtit: tachtit outage *stalls* data reconciliation (last-applied state keeps running) — acceptable.
- Forgejo repo `gitops` becomes self-referential (Flux applies manifests that run the Forgejo serving the repo). Same-cluster config mistakes that kill Forgejo block the GitOps fix path — fix is kubectl rollback or DR repoint; note in runbook.
- `.password-store` on Forgejo: GPG-encrypted at rest, fine; it's already on GitHub today.
- maincv/blog publicly visible: keep visibility parity with GitHub.
