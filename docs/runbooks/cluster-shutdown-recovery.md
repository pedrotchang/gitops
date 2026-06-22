# Cluster shutdown & recovery — tachtit + data (runbook)

Durable procedure for **deliberately powering down** both Talos clusters and **bringing them
back to the exact current git state**, plus the **crash-recovery** path for an unplanned outage
(power loss, node death). Clusters are Talos Linux managed by **Sidero Omni** (SaaS) and
reconciled by **Flux** from `git.seyzahl.com`.

> **Golden rule:** the clusters are GitOps-reconciled. "Current state" = whatever is committed to
> `platform-infrastructure/gitops-platform`. You almost never restore *state* by hand — you restore
> *the nodes*, and Flux + etcd + CNPG converge back. Your job is to power down cleanly and power up
> in the right order so that convergence is automatic.

---

## 1. System model — what depends on what

| Cluster | Role | Nodes (hardware) | Flux roots |
| --- | --- | --- | --- |
| **data** | PostgreSQL (CNPG), Headscale coordinator | HP 800 G2 (16 GB) + HP Laptop (8 GB) | `databases`, `infra-controllers`, `infra-controllers-plugins`, `infra-configs` |
| **tachtit** | Apps (Forgejo, Immich, Authentik, Nextcloud, …) | HP 800 G2 (16 GB) + ThinkPad P14s (32 GB) | `apps`, `infra-controllers`, `infra-configs`, `monitoring-*`, `velero-schedule`, `cka-labs` |

**Dependency chain (this dictates the order):**

```
TrueNAS (192.168.7.14)         ← storage: iSCSI PVs + immich NFS. MUST be up first.
   └── data cluster            ← all CNPG Postgres + Headscale (VPN) DB
          └── tachtit cluster  ← apps; Forgejo (Flux's own git source) lives here
                 └── Flux       ← pulls from git.seyzahl.com (Forgejo) → reconciles everything
```

**Three chicken-and-egg traps to respect:**

1. **Flux's git source is self-hosted.** Flux pulls from `ssh://git@git.seyzahl.com:2222/...`, which
   is **Forgejo on tachtit** backed by **`forgejo-db-data-cnpg-v0` on data**. Until both clusters are
   up, Flux cannot fetch new revisions — but controllers still restart from **etcd**, so the cluster
   self-heals to its last applied state without Flux. Flux re-syncs once Forgejo answers.
2. **The VPN coordinator is inside the thing you're recovering.** **Headscale runs on the data
   cluster.** If you are remote and the data cluster is down, you may not be able to bring up *new*
   VPN sessions. **Do recovery from the LAN, or from an already-connected machine.**
3. **Omni can power nodes OFF but not necessarily back ON.** Omni reaches nodes over SideroLink
   (outbound from the node). A **fully powered-off machine has no SideroLink** — Omni cannot wake it.
   See §6.

---

## 2. Pre-shutdown checklist (do this before ANY planned power-down)

- [ ] **Confirm backups are current.** CNPG → Azure (`barmanObjectStore`) and Velero
      (`velero-schedule` on tachtit). Immich also has its own DB dumps + Glacier copy
      (see `docs/runbooks/immich.md`).
      ```bash
      mise run -E tachtit -- flux get kustomizations velero-schedule
      # spot-check a recent CNPG base backup exists in Azure for at least forgejo + immich + authentik
      ```
- [ ] **Note the current git revision** — this is the "current state" you're returning to:
      ```bash
      git -C <repo> rev-parse --short HEAD     # record this; verify after recovery
      ```
- [ ] **Confirm you'll have access to power the machines back ON** (§6) — WoL configured, or you are
      physically on-site. Do not power down remotely if you cannot power back up.
- [ ] **Have `talosconfig` + `kubeconfig` for both clusters** locally (the `mise.*.toml` env files
      point at them; they are gitignored and must already be on disk).
- [ ] **Be on the LAN** (recovery instructions assume LAN reachability, since Headscale is on-cluster).

---

## 3. Procedure A — Planned graceful shutdown

Shut down **apps first, databases last** (reverse of the dependency chain) so nothing is mid-write
to a database that's already gone.

### A1 — Quiesce the apps cluster (tachtit)

```bash
eval "$(mise env -E tachtit)"          # exports KUBECONFIG/TALOSCONFIG for tachtit

# Optional but tidy: suspend Flux so it doesn't fight the shutdown
flux suspend kustomization --all

# Let stateful apps flush. Most app state is in Postgres on `data`; tachtit apps are mostly
# stateless or read NFS. No per-app action needed unless an app holds local writes.
kubectl get pods -A --field-selector=status.phase=Running -o wide | sort -k1
```

### A2 — Hibernate Postgres cleanly (data cluster)

CNPG needs a clean primary shutdown so it checkpoints and the cluster restarts without replica
re-sync. Use the **CNPG hibernate** plugin — it scales the cluster down after a clean checkpoint and
records how to bring it back identically.

```bash
eval "$(mise env -E data)"

# Hibernate every CNPG cluster (clean checkpoint, no data loss). Repeat per cluster:
for c in forgejo-db-data-cnpg-v0 immich-db-tachtit-cnpg-v0 authentik-db-tachtit-cnpg-v1 \
         nextcloud-db-tachtit-cnpg-v0 n8n-db-tachtit-cnpg-v0 headscale-db-tachtit-cnpg-v0 \
         linkding-db-tachtit-cnpg-v0 commafeed-db-tachtit-cnpg-v0; do
  ns=$(kubectl get cluster.postgresql.cnpg.io -A -o jsonpath="{range .items[?(@.metadata.name=='$c')]}{.metadata.namespace}{end}")
  echo ">> hibernate $c (ns=$ns)"
  kubectl cnpg hibernate on "$c" -n "$ns"
done
```

> If the `cnpg` kubectl plugin isn't installed, a graceful **Talos node shutdown drains the pods**
> and CNPG will still checkpoint on SIGTERM — hibernate is the *belt-and-suspenders* clean path.
> For a quick planned power-down you can skip hibernate and rely on the graceful node shutdown in A3.

### A3 — Power the nodes off via Omni

Drive this from the **Sidero Omni** console — the hosted Sidero Labs web UI. Omni reaches each node
over SideroLink, so **you never touch a node IP**: just pick the machine and shut it down.

- **Omni UI (primary):** open your Omni instance → **Clusters** → select the cluster → for each
  machine → **Shutdown**. Do **tachtit** (apps) first, then **data** (DBs).
- **Optional CLI** via the Omni-issued talosconfig (addresses nodes by their Omni **name**, not a raw
  IP; Omni proxies the call):
  ```bash
  talosctl -n <node-name> shutdown        # node-name as shown in the Omni UI; tachtit nodes, then data
  ```

After this, both clusters are off. **Note (see §6):** Omni cannot wake these machines back up once
they're fully off — power-on is WoL/BMC or physical.

---

## 4. Procedure B — Recovery (power-on → current state)

Bring up in **dependency order: storage → data → tachtit**, then let Flux converge.

### B0 — Preconditions

- [ ] **TrueNAS (`192.168.7.14`) is up and healthy** — it serves the iSCSI PVs and immich NFS. If
      storage isn't up, CNPG pods and immich will not mount. Verify before powering on `data`.
- [ ] **LAN + DNS/gateway up.** You're on the LAN (Headscale is on-cluster, §1 trap 2).
- [ ] **Omni reachable** — the hosted Sidero Labs UI opens in a browser (`omniconfig.yaml` present if
      you also want `omnictl`/`talosctl`).

### B1 — Power ON the data cluster

Power on both `data` nodes (§6 — WoL/physical; Omni can't wake an off box). Watch them come back in
the **Omni UI dashboard** (it shows node + etcd health directly — no IPs needed), or from the CLI:

```bash
eval "$(mise env -E data)"
talosctl health --wait-timeout 10m   # uses the Omni-scoped context; no -n <ip> required
kubectl get nodes -o wide            # both Ready
```

### B2 — Wake Postgres and confirm primaries

```bash
# Reverse the hibernation from A2 (only if you hibernated):
for c in forgejo-db-data-cnpg-v0 immich-db-tachtit-cnpg-v0 authentik-db-tachtit-cnpg-v1 \
         nextcloud-db-tachtit-cnpg-v0 n8n-db-tachtit-cnpg-v0 headscale-db-tachtit-cnpg-v0 \
         linkding-db-tachtit-cnpg-v0 commafeed-db-tachtit-cnpg-v0; do
  ns=$(kubectl get cluster.postgresql.cnpg.io -A -o jsonpath="{range .items[?(@.metadata.name=='$c')]}{.metadata.namespace}{end}")
  kubectl cnpg hibernate off "$c" -n "$ns" 2>/dev/null || true
done

# Every CNPG cluster should reach "Cluster in healthy state" with a primary elected:
kubectl get cluster.postgresql.cnpg.io -A
kubectl cnpg status forgejo-db-data-cnpg-v0 -n <ns>   # primary + replicas streaming
```

**Do not proceed to tachtit until `forgejo-db-data-cnpg-v0` has a healthy primary** — Forgejo (and
therefore Flux's git source) needs it.

### B3 — Power ON the tachtit cluster

Power on both `tachtit` nodes (§6). Watch in the Omni UI dashboard, or:

```bash
eval "$(mise env -E tachtit)"
talosctl health --wait-timeout 10m   # Omni-scoped context; no -n <ip>
kubectl get nodes -o wide            # both Ready
```

### B4 — Re-establish Flux and reconcile to current state

Even with the git source briefly unreachable, controllers restart from etcd. Once Forgejo answers,
re-sync Flux explicitly:

```bash
# If you suspended Flux in A1, resume it:
flux resume kustomization --all

# Confirm Forgejo is actually serving git first:
kubectl -n <forgejo-ns> get pods -l app.kubernetes.io/name=forgejo
git ls-remote ssh://git@git.seyzahl.com:2222/platform-infrastructure/gitops-platform HEAD

# Force a source refresh + cascade reconcile from the root (per repo CLAUDE.md):
flux reconcile source git flux-system
flux reconcile kustomization flux-system --with-source
```

Repeat the source reconcile on the **data** context too (each cluster has its own flux-system):

```bash
eval "$(mise env -E data)"; flux reconcile source git flux-system; flux reconcile kustomization flux-system --with-source
```

### B5 — Verify "spun up to current state" → §7.

---

## 5. Procedure C — Crash DR (unplanned power loss / node death)

For an *ungraceful* outage (breaker tripped, node hardware died) you did **not** hibernate CNPG and
nodes went down hard. Recover the survivors first, then fix what didn't come back.

### C1 — Bring back whatever you can, in dependency order

Run **B0–B4** as written. Most of the time Talos + etcd + CNPG recover automatically from a hard
power cut — that's the whole point of the platform. The differences below are the failure branches.

### C2 — etcd / control-plane didn't come healthy

The Omni UI shows per-machine health, service status, and the etcd backup/restore controls directly.
From the CLI, address nodes by their Omni **name** (not a raw IP):

```bash
talosctl -n <node-name> service etcd status
talosctl -n <node-name> logs etcd
talosctl -n <node-name> dmesg | tail -50
```

- **Single CP node that lost quorum / won't form etcd:** recover from the Talos etcd snapshot via Omni
  (Omni → cluster → etcd backups), or `talosctl bootstrap` **only** on a single surviving CP if etcd
  data is intact. Never `bootstrap` twice. If unsure, restore the etcd snapshot rather than guessing.
- **A node is dead hardware:** in Omni, remove/replace the machine; Talos reprovisions it and it
  rejoins. Flux + CNPG then rebuild its share of the workload.

### C3 — CNPG came up without a primary (unclean shutdown)

```bash
kubectl get cluster.postgresql.cnpg.io -A
kubectl cnpg status <cluster> -n <ns>
```

- CNPG usually re-elects and replays WAL automatically. If a cluster is stuck "not healthy":
  ```bash
  kubectl -n <ns> get pods -l cnpg.io/cluster=<cluster>
  kubectl cnpg promote <cluster> <preferred-instance> -n <ns>     # if it needs a nudge
  ```
- **If a Postgres PVC is corrupt / lost:** restore from the CNPG Azure backup (`barmanObjectStore`)
  by bootstrapping a recovery cluster — see CNPG `bootstrap.recovery`. For Immich specifically, see
  `docs/runbooks/immich.md` (Glacier + DB-dump restore).

### C4 — Partial fleet (one node of a cluster is down)

Both clusters are 2-node. Many CNPG clusters are 2–3 instances, so they tolerate one node down but
may run degraded. Bring the missing node back (§6); CNPG re-syncs the replica and Flux reschedules.
Don't force-promote unless the **primary's** node is the one that's gone and didn't fail over.

---

## 6. Powering the machines back ON (the manual gap)

**Omni shuts nodes down gracefully, but cannot power a fully-off machine back on** — there's no
SideroLink to a powered-off box. Decide your power-on path *before* shutting down:

- **Wake-on-LAN** (if enabled in each machine's BIOS): send a magic packet from a LAN host, e.g.
  `wakeonlan <MAC>` or `etherwake <MAC>`. The HP EliteDesk 800 G2s support WoL; **laptops
  (HP laptop, ThinkPad P14s) often do not wake reliably from full power-off**, especially on battery.
- **BMC/AMT:** the EliteDesk 800 G2 may have Intel AMT/vPro — if provisioned, power-on via AMT.
- **Physical button:** the always-works fallback. Press power on each box on-site.

> **TODO to close this gap:** record each node's MAC, enable WoL in BIOS, and (for the laptops)
> set "AC power loss → power on" / lid-closed-stays-on, so a planned or crash recovery doesn't
> require a physical visit. Until then, treat **on-site access as a recovery precondition.**

---

## 7. Verification — "is it back to the current state?"

Run top-to-bottom; everything green = recovered.

```bash
# --- per cluster (run for both: -E data and -E tachtit) ---
kubectl get nodes -o wide                         # all Ready
flux get kustomizations -A                         # all Ready=True, no failures
flux get sources git -A                            # Revision matches the HEAD you recorded in §2
kubectl get cluster.postgresql.cnpg.io -A          # every CNPG: "Cluster in healthy state"
kubectl get pods -A | grep -vE 'Running|Completed' # should be empty (no CrashLoop/Pending)
kubectl get pvc -A | grep -v Bound                 # should be empty (all storage bound)
```

**Functional smoke test (the things that prove the chain healed):**

| Check | Why it matters |
| --- | --- |
| `git ls-remote …/gitops-platform HEAD` succeeds | Forgejo (Flux's own git source) is back |
| `flux get sources git -A` revision == §2 HEAD | Flux is synced to current committed state |
| Headscale / VPN reconnects | data-cluster coordinator is back (remote access restored) |
| Immich + Nextcloud + Authentik load | apps ↔ Postgres ↔ TrueNAS storage path intact |
| Grafana shows nodes reporting | monitoring stack reconverged |

If `flux get sources git` revision matches the `HEAD` recorded in §2 and all Kustomizations are
`Ready=True`, the cluster has **reconciled back to the exact current state** by definition.

---

## 8. Quick reference

```bash
# Contexts (per repo tooling)
eval "$(mise env -E tachtit)"   # or:  kubie ctx pedrotchang-tachtit
eval "$(mise env -E data)"

# Shutdown order:   tachtit (apps)  →  data (DBs)      [+ CNPG hibernate first]
# Power-on order:   TrueNAS → data (DBs) → tachtit (apps) → flux reconcile

# CNPG clusters (all on `data`):
#   forgejo-db-data-cnpg-v0          immich-db-tachtit-cnpg-v0
#   authentik-db-tachtit-cnpg-v1     nextcloud-db-tachtit-cnpg-v0
#   n8n-db-tachtit-cnpg-v0           headscale-db-tachtit-cnpg-v0
#   linkding-db-tachtit-cnpg-v0      commafeed-db-tachtit-cnpg-v0
```

**Related:** `docs/runbooks/immich.md` (photo/DB restore), `docs/backups.md`, repo `CLAUDE.md`
(Flux reconcile workflow — push first, never `kubectl apply` directly).
