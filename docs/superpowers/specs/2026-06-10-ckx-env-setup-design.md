# CKX Exam Environment Setup Design

**Date:** 2026-06-10
**Scope:** CKA and CKS practice environment on existing KubeVirt lab

## Goal

Mirror the actual CKA/CKS exam cluster environment inside the existing KubeVirt lab (cka-cp + cka-worker-1 + cka-worker-2). Enable upgrade practice by starting at K8s 1.35.1 and upgrading to 1.35.5.

## What Does NOT Change

- KubeVirt VMs (cka-cp, cka-worker-1, cka-worker-2) — kept as-is
- Flux manifests — no change
- cluster-setup.sh logic (reset, kubeadm init, Cilium, join) — no change to procedure
- Exercises and mock exams — used from external reference repo (GitHub), not copied here

## Changes

### 1. scripts/cluster-setup.sh

Single variable change:

```
K8S_VERSION="1.35.5-1.1"  →  K8S_VERSION="1.35.1-1.1"
```

The apt repo (`pkgs.k8s.io/core:/stable:/v1.35/deb/`) serves all v1.35.x packages. No keyring change needed. The reset-then-reinstall pattern means this is a fresh install, not a downgrade.

**Upgrade practice reset:** Re-run `just cluster-setup` at any time to reset back to 1.35.1 and repeat the exercise.

### 2. scripts/ckx-env-setup.sh (new)

Runs after `just cluster-setup`. Idempotent. Uses `virtctl ssh` (same `vssh` pattern as cluster-setup.sh).

**On cka-cp:**
1. Detect etcd version from static pod image tag
2. Download matching `etcdctl` binary to `/usr/local/bin/`
3. Append to `/etc/bash.bashrc` (idempotent check before writing):
   - `export ETCDCTL_API=3`
   - `export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt`
   - `export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt`
   - `export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key`
   - `alias k=kubectl` + `source <(kubectl completion bash)` + `complete -o default -F __start_kubectl k`

**On cka-worker-1 and cka-worker-2:**
- Append to `/etc/bash.bashrc` (idempotent):
  - `alias k=kubectl` + bash completion

**Persistence:** `/usr/local/bin/etcdctl` and `/etc/bash.bashrc` survive `kubeadm reset`. Etcd cert paths (`/etc/kubernetes/pki/etcd/`) are regenerated at the same locations on each cluster-setup, so env vars remain valid.

**Not included:** No `kgp`, `kgn`, `kd`, `kaf`, `kdel` or other shortcuts — these do not exist in the exam environment.

### 3. justfile

Add recipe:

```
ckx-env-setup:
    bash scripts/ckx-env-setup.sh
```

### 4. docs/kubevirt.md

Update:
- Version table: Kubernetes v1.35.5 → v1.35.1
- Manual setup section: package version strings updated

## KubeVirt Quirks (Carried Forward)

These are documented in docs/kubevirt.md and handled by cluster-setup.sh. ckx-env-setup.sh must respect:

- SSH via `virtctl ssh -n cka-labs ubuntu@vm/<name>` (not regular ssh)
- `kubeadm reset` wipes `/etc/kubernetes`, `/var/lib/etcd`, `/var/lib/kubelet`, `~/.kube` only — not `/usr/local/bin` or `/etc/bash.bashrc`
- etcdctl runs locally on cka-cp; no CP_IP routing needed for it

## Regular Workflow

```
just lab-up           # start VMs
just cluster-setup    # fresh kubeadm cluster at 1.35.1
just ckx-env-setup    # first time or after full disk wipe (etcdctl persists otherwise)
# practice exercises from: https://github.com/theplatformlab/CKA-Certified-Kubernetes-Administrator
# for upgrade exercise: upgrade 1.35.1 → 1.35.5 manually
just cluster-setup    # reset back to 1.35.1 to repeat
just lab-down         # stop VMs
```

## Out of Scope

- Docker — not in current CKA/CKS exam environment (containerd + crictl)
- Exercise content in repo — use external reference repo
- CKS-specific tools (trivy, Falco, AppArmor) — separate future scope
