# CKX Exam Environment Setup Design

**Date:** 2026-06-10
**Scope:** CKA and CKS practice environment on existing KubeVirt lab

## Goal

Mirror the actual CKA/CKS exam cluster environment inside the existing KubeVirt lab. Enable upgrade practice by starting at K8s 1.35.1 and upgrading to 1.35.5. Rename VMs to match exam-style node naming.

## What Does NOT Change

- KubeVirt/CDI operators, Flux manifests structure — kept as-is
- cluster-setup.sh logic (reset, kubeadm init, Cilium, join) — procedure unchanged
- Exercises and mock exams — used from external reference repo (GitHub), not copied here

## Changes

### 1. VM Rename (Flux manifests)

| Old name | New name | Old DV | New DV |
|----------|----------|--------|--------|
| `cka-cp` | `cp` | `cka-cp-disk` | `cp-disk` |
| `cka-worker-1` | `worker-1` | `cka-worker-1-disk` | `worker-1-disk` |
| `cka-worker-2` | `worker-2` | `cka-worker-2-disk` | `worker-2-disk` |

Files changed: `apps/base/cka-labs/vm-cp.yaml`, `apps/base/cka-labs/vm-workers.yaml`

**Destructive path:** Flux prune deletes old VM resources and DataVolumes, recreates with new names. CDI re-imports Ubuntu base image. VMs are disposable — this is acceptable. Node names in `kubectl get nodes` become `cp`, `worker-1`, `worker-2`, matching exam environment naming.

### 2. apps/base/cka-labs/cloud-init.yaml

Version strings in `runcmd`:
```
kubelet=1.35.5-1.1 kubeadm=1.35.5-1.1 kubectl=1.35.5-1.1
→
kubelet=1.35.1-1.1 kubeadm=1.35.1-1.1 kubectl=1.35.1-1.1
```

This is the base image provisioning. cluster-setup.sh reinstalls at runtime anyway, but both should be consistent.

### 3. scripts/cluster-setup.sh

Version and all VM name references:

```
K8S_VERSION="1.35.5-1.1"  →  K8S_VERSION="1.35.1-1.1"
cka-cp       →  cp
cka-worker-1 →  worker-1
cka-worker-2 →  worker-2
```

The apt repo (`pkgs.k8s.io/core:/stable:/v1.35/deb/`) serves all v1.35.x packages. No keyring change needed.

**Upgrade practice reset:** Re-run `just cluster-setup` at any time to reset back to 1.35.1 and repeat.

### 4. scripts/ckx-env-setup.sh (new)

Runs after `just cluster-setup`. Idempotent. Uses `virtctl ssh` (same `vssh` pattern as cluster-setup.sh).

**On cp:**
1. Detect etcd version from static pod image tag
2. Download matching `etcdctl` binary to `/usr/local/bin/`
3. Append to `/etc/bash.bashrc` (idempotent guard):
   - `export ETCDCTL_API=3`
   - `export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt`
   - `export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt`
   - `export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key`
   - `alias k=kubectl` + bash completion for `k`

**On worker-1 and worker-2:**
- Append to `/etc/bash.bashrc` (idempotent guard):
  - `alias k=kubectl` + bash completion for `k`

**Persistence:** `/usr/local/bin/etcdctl` and `/etc/bash.bashrc` survive `kubeadm reset`. Etcd cert paths (`/etc/kubernetes/pki/etcd/`) are regenerated at the same locations on each cluster-setup, so env vars remain valid.

**Not included:** No `kgp`, `kgn`, `kd`, `kaf`, `kdel` — these do not exist in the exam environment.

### 5. justfile

Update VM name references. Add recipe:

```
ckx-env-setup:
    bash scripts/ckx-env-setup.sh
```

### 6. docs/kubevirt.md

- All VM name references: `cka-cp` → `cp`, `cka-worker-1` → `worker-1`, `cka-worker-2` → `worker-2`
- Version table: Kubernetes v1.35.5 → v1.35.1
- Manual setup section: package version strings updated

## KubeVirt Quirks (Carried Forward)

Documented in docs/kubevirt.md, handled by cluster-setup.sh. ckx-env-setup.sh must respect:

- SSH via `virtctl ssh -n cka-labs ubuntu@vm/<name>` (not regular ssh)
- `kubeadm reset` wipes `/etc/kubernetes`, `/var/lib/etcd`, `/var/lib/kubelet`, `~/.kube` only — not `/usr/local/bin` or `/etc/bash.bashrc`
- etcdctl runs locally on cp; no CP_IP routing needed for it
- CP_IP (VMI pod IP) is dynamic — detected at runtime by cluster-setup.sh

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
