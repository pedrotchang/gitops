# CKX Exam Environment Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename KubeVirt VMs to exam-style names, pin K8s to 1.35.1 for upgrade practice, and add `ckx-env-setup.sh` that installs etcdctl and the `k` alias on all cluster nodes.

**Architecture:** All changes are to existing manifests, scripts, and docs — no new infrastructure components. The VM rename is destructive (Flux prune recreates resources). The new script follows the same `vssh` pattern as `cluster-setup.sh`. Changes must be committed and pushed before the deploy step — Flux drives the VM lifecycle.

**Tech Stack:** KubeVirt, Flux (GitOps), kubeadm, CDI (DataVolumes), virtctl, bash, apt/pkgs.k8s.io

---

## File Map

| File | Action | What changes |
|------|--------|--------------|
| `apps/base/cka-labs/vm-cp.yaml` | Modify | VM name, DV name, label: `cka-cp` → `cp` |
| `apps/base/cka-labs/vm-workers.yaml` | Modify | VM/DV names/labels: `cka-worker-1/2` → `worker-1/2` |
| `apps/base/cka-labs/cloud-init.yaml` | Modify | K8s version `1.35.5-1.1` → `1.35.1-1.1` |
| `scripts/cluster-setup.sh` | Modify | `K8S_VERSION` + all VM name references |
| `scripts/ckx-env-setup.sh` | Create | Installs etcdctl on cp; `k` alias on all nodes |
| `justfile` | Modify | VM name refs in all recipes; add `ckx-env-setup` |
| `docs/kubevirt.md` | Modify | VM names + version table |

---

### Task 1: Rename cp VM manifest

**Files:**
- Modify: `apps/base/cka-labs/vm-cp.yaml`

- [ ] **Step 1: Verify current state**

```bash
grep -n 'cka-cp' apps/base/cka-labs/vm-cp.yaml
```
Expected: 4 occurrences (metadata.name, dataVolumeTemplates.metadata.name, label, dataVolume.name)

- [ ] **Step 2: Apply renames**

In `apps/base/cka-labs/vm-cp.yaml`, make these replacements:
- `name: cka-cp` (metadata) → `name: cp`
- `name: cka-cp-disk` (dataVolumeTemplates) → `name: cp-disk`
- `kubevirt.io/domain: cka-cp` → `kubevirt.io/domain: cp`
- `name: cka-cp-disk` (volumes.dataVolume) → `name: cp-disk`

Final file:
```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: cp
  namespace: cka-labs
spec:
  runStrategy: Manual
  dataVolumeTemplates:
    - metadata:
        name: cp-disk
      spec:
        storage:
          storageClassName: local-path
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 20Gi
        source:
          pvc:
            namespace: cka-labs
            name: ubuntu-22-04-base
  template:
    metadata:
      labels:
        kubevirt.io/domain: cp
        role: control-plane
    spec:
      domain:
        cpu:
          cores: 2
        resources:
          requests:
            memory: 4Gi
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: virtio
            - name: cloudinit
              disk:
                bus: virtio
          interfaces:
            - name: default
              masquerade: {}
      networks:
        - name: default
          pod: {}
      volumes:
        - name: rootdisk
          dataVolume:
            name: cp-disk
        - name: cloudinit
          cloudInitNoCloud:
            secretRef:
              name: cka-labs-cloud-init
```

- [ ] **Step 3: Verify no old names remain**

```bash
grep 'cka-cp' apps/base/cka-labs/vm-cp.yaml
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add apps/base/cka-labs/vm-cp.yaml
git commit -m "feat(cka-labs): rename cka-cp VM to cp"
```

---

### Task 2: Rename worker VM manifests

**Files:**
- Modify: `apps/base/cka-labs/vm-workers.yaml`

- [ ] **Step 1: Verify current state**

```bash
grep -n 'cka-worker' apps/base/cka-labs/vm-workers.yaml
```
Expected: multiple occurrences across both VM definitions

- [ ] **Step 2: Apply renames**

Final file:
```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: worker-1
  namespace: cka-labs
spec:
  runStrategy: Manual
  dataVolumeTemplates:
    - metadata:
        name: worker-1-disk
      spec:
        storage:
          storageClassName: local-path
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 20Gi
        source:
          pvc:
            namespace: cka-labs
            name: ubuntu-22-04-base
  template:
    metadata:
      labels:
        kubevirt.io/domain: worker-1
        role: worker
    spec:
      domain:
        cpu:
          cores: 2
        resources:
          requests:
            memory: 2Gi
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: virtio
            - name: cloudinit
              disk:
                bus: virtio
          interfaces:
            - name: default
              masquerade: {}
      networks:
        - name: default
          pod: {}
      volumes:
        - name: rootdisk
          dataVolume:
            name: worker-1-disk
        - name: cloudinit
          cloudInitNoCloud:
            secretRef:
              name: cka-labs-cloud-init
---
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: worker-2
  namespace: cka-labs
spec:
  runStrategy: Manual
  dataVolumeTemplates:
    - metadata:
        name: worker-2-disk
      spec:
        storage:
          storageClassName: local-path
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 20Gi
        source:
          pvc:
            namespace: cka-labs
            name: ubuntu-22-04-base
  template:
    metadata:
      labels:
        kubevirt.io/domain: worker-2
        role: worker
    spec:
      domain:
        cpu:
          cores: 2
        resources:
          requests:
            memory: 2Gi
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: virtio
            - name: cloudinit
              disk:
                bus: virtio
          interfaces:
            - name: default
              masquerade: {}
      networks:
        - name: default
          pod: {}
      volumes:
        - name: rootdisk
          dataVolume:
            name: worker-2-disk
        - name: cloudinit
          cloudInitNoCloud:
            secretRef:
              name: cka-labs-cloud-init
```

- [ ] **Step 3: Verify no old names remain**

```bash
grep 'cka-worker' apps/base/cka-labs/vm-workers.yaml
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add apps/base/cka-labs/vm-workers.yaml
git commit -m "feat(cka-labs): rename cka-worker-1/2 VMs to worker-1/2"
```

---

### Task 3: Update cloud-init K8s version

**Files:**
- Modify: `apps/base/cka-labs/cloud-init.yaml`

- [ ] **Step 1: Verify current version string**

```bash
grep '1.35' apps/base/cka-labs/cloud-init.yaml
```
Expected: `kubelet=1.35.5-1.1 kubeadm=1.35.5-1.1 kubectl=1.35.5-1.1`

- [ ] **Step 2: Update version**

In `apps/base/cka-labs/cloud-init.yaml`, line 52, change:
```
- apt-get update -q && apt-get install -yq kubelet=1.35.5-1.1 kubeadm=1.35.5-1.1 kubectl=1.35.5-1.1
```
to:
```
- apt-get update -q && apt-get install -yq kubelet=1.35.1-1.1 kubeadm=1.35.1-1.1 kubectl=1.35.1-1.1
```

- [ ] **Step 3: Verify**

```bash
grep '1.35' apps/base/cka-labs/cloud-init.yaml
```
Expected: `kubelet=1.35.1-1.1 kubeadm=1.35.1-1.1 kubectl=1.35.1-1.1`

- [ ] **Step 4: Commit**

```bash
git add apps/base/cka-labs/cloud-init.yaml
git commit -m "feat(cka-labs): pin cloud-init K8s install to 1.35.1"
```

---

### Task 4: Update cluster-setup.sh

**Files:**
- Modify: `scripts/cluster-setup.sh`

- [ ] **Step 1: Verify current references**

```bash
grep -n 'cka-\|1\.35\.5' scripts/cluster-setup.sh
```
Expected: K8S_VERSION line + multiple cka-cp/cka-worker references

- [ ] **Step 2: Apply all changes**

Final `scripts/cluster-setup.sh`:
```bash
#!/usr/bin/env bash
# Tear down and rebuild the kubeadm cluster inside KubeVirt VMs.
# Run from your laptop after `just lab-up` and VMs are running.
#
# Usage: ./scripts/cluster-setup.sh
set -euo pipefail

NAMESPACE=cka-labs
K8S_VERSION="1.35.1-1.1"
CILIUM_VERSION="1.19.4"
POD_CIDR="10.244.0.0/16"

vssh() { virtctl ssh -n "$NAMESPACE" ubuntu@vm/"$1" -- "${@:2}"; }
log() { echo "==> $*"; }

# KubeVirt masquerade gives every VM the same internal IP (10.0.2.2).
# Workers must reach the CP via its pod IP instead.
log "Resolving cp VMI IP..."
CP_IP=$(kubectl get vmi cp -n "$NAMESPACE" -o jsonpath='{.status.interfaces[0].ipAddress}')
[[ -z "$CP_IP" ]] && { echo "ERROR: cp VMI not running — run 'just lab-up' first"; exit 1; }
log "CP_IP=$CP_IP"

reset_node() {
  local vm=$1
  log "[$vm] resetting kubeadm..."
  vssh "$vm" "sudo kubeadm reset -f 2>/dev/null || true"
  vssh "$vm" "sudo rm -rf /etc/kubernetes /var/lib/etcd /var/lib/kubelet ~/.kube"
}

bootstrap_node() {
  local vm=$1
  log "[$vm] bootstrapping..."
  vssh "$vm" "echo 'nameserver 8.8.8.8' | sudo tee /etc/resolv.conf >/dev/null"
  vssh "$vm" "sudo rm -f /etc/containerd/config.toml && sudo systemctl restart containerd"
  vssh "$vm" "sudo rm -f /etc/apt/sources.list.d/kubernetes.list /etc/apt/keyrings/kubernetes-apt-keyring.gpg"
  vssh "$vm" "curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg"
  vssh "$vm" "echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.35/deb/ /' | sudo tee /etc/apt/sources.list.d/kubernetes.list >/dev/null"
  vssh "$vm" "sudo apt-get update -q && sudo apt-get install -yq --allow-change-held-packages kubelet=${K8S_VERSION} kubeadm=${K8S_VERSION} kubectl=${K8S_VERSION}"
  vssh "$vm" "sudo apt-mark hold kubelet kubeadm kubectl"
}

log "=== Resetting nodes ==="
reset_node worker-2
reset_node worker-1
reset_node cp

log "=== Bootstrapping nodes ==="
bootstrap_node cp
bootstrap_node worker-1
bootstrap_node worker-2

log "=== Initializing control plane ==="
# kubeadm init may time out on the RBAC bootstrap step but the apiserver will
# still be running. We catch the exit code and run remaining phases manually.
vssh cp "sudo kubeadm init --pod-network-cidr=$POD_CIDR --apiserver-advertise-address=10.0.2.2 --apiserver-cert-extra-sans=$CP_IP || true"
# super-admin.conf always has full cluster-admin access regardless of RBAC state
vssh cp "mkdir -p ~/.kube && sudo cp /etc/kubernetes/super-admin.conf ~/.kube/config && sudo chown \$(id -u):\$(id -g) ~/.kube/config"

log "=== Completing kubeadm phases ==="
vssh cp "sudo kubeadm init phase upload-config all                       || true"
vssh cp "sudo kubeadm init phase mark-control-plane                      || true"
vssh cp "sudo kubeadm init phase bootstrap-token                         || true"
vssh cp "sudo kubeadm init phase kubelet-finalize all                    || true"
vssh cp "sudo kubeadm init phase addon all --pod-network-cidr=$POD_CIDR  || true"

log "=== Installing Cilium ==="
vssh cp "cilium install --version $CILIUM_VERSION 2>/dev/null || cilium status"

log "=== Waiting for control plane Ready ==="
vssh cp "kubectl wait --for=condition=Ready node/cp --timeout=300s"

log "=== Joining workers ==="
JOIN_CMD=$(vssh cp "kubeadm token create --print-join-command 2>/dev/null" | grep "kubeadm join")
# Replace the advertised address (10.0.2.2) with the routable pod IP
JOIN_CMD="${JOIN_CMD/10.0.2.2/$CP_IP}"

for worker in worker-1 worker-2; do
  log "[$worker] joining..."
  # Redirect 10.0.2.2:6443 → CP_IP:6443 so kubelet can reach the apiserver
  # after join (kubelet.conf uses 10.0.2.2 which loops back to itself otherwise)
  vssh "$worker" "sudo iptables -t nat -A OUTPUT -d 10.0.2.2 -p tcp --dport 6443 -j DNAT --to-destination ${CP_IP}:6443 || true"
  vssh "$worker" "sudo $JOIN_CMD --ignore-preflight-errors=Hostname"
done

log "=== Cluster ready ==="
vssh cp "kubectl get nodes -o wide"
```

- [ ] **Step 3: Verify no old references remain**

```bash
grep -n 'cka-\|1\.35\.5' scripts/cluster-setup.sh
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add scripts/cluster-setup.sh
git commit -m "feat(cka-labs): rename nodes to cp/worker-1/2, pin K8s to 1.35.1"
```

---

### Task 5: Update justfile

**Files:**
- Modify: `justfile`

- [ ] **Step 1: Verify current references**

```bash
grep -n 'cka-' justfile
```
Expected: cka-cp, cka-worker-1, cka-worker-2 in lab-up/down/ssh recipes

- [ ] **Step 2: Apply changes**

Final `justfile`:
```just
namespace := "cka-labs"
kubevirt_version := "v1.8.3"
cdi_version      := "v1.65.0"

kubevirt_operator_url := "https://github.com/kubevirt/kubevirt/releases/download/" + kubevirt_version + "/kubevirt-operator.yaml"
cdi_operator_url      := "https://github.com/kubevirt/containerized-data-importer/releases/download/" + cdi_version + "/cdi-operator.yaml"

fetch-manifests:
    curl -L {{kubevirt_operator_url}} -o infrastructure/controllers/base/kubevirt/kubevirt-operator.yaml
    curl -L {{cdi_operator_url}}      -o infrastructure/controllers/base/cdi/cdi-operator.yaml
    @echo "Done. Uncomment operator lines in:"
    @echo "  infrastructure/controllers/base/kubevirt/kustomization.yaml"
    @echo "  infrastructure/controllers/base/cdi/kustomization.yaml"
    @echo "Then commit and push."

lab-up:
    virtctl start cp       -n {{namespace}}
    virtctl start worker-1 -n {{namespace}}
    virtctl start worker-2 -n {{namespace}}

lab-down:
    virtctl stop cp       -n {{namespace}}
    virtctl stop worker-1 -n {{namespace}}
    virtctl stop worker-2 -n {{namespace}}

ssh-cp:
    virtctl ssh ubuntu@vm/cp -n {{namespace}}

ssh-w1:
    virtctl ssh ubuntu@vm/worker-1 -n {{namespace}}

ssh-w2:
    virtctl ssh ubuntu@vm/worker-2 -n {{namespace}}

lab-status:
    kubectl get vm,vmi,dv -n {{namespace}}

cluster-setup:
    bash scripts/cluster-setup.sh

ckx-env-setup:
    bash scripts/ckx-env-setup.sh
```

- [ ] **Step 3: Verify no old VM names remain**

```bash
grep 'cka-' justfile
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add justfile
git commit -m "feat(cka-labs): update justfile for renamed VMs, add ckx-env-setup recipe"
```

---

### Task 6: Write scripts/ckx-env-setup.sh

**Files:**
- Create: `scripts/ckx-env-setup.sh`

- [ ] **Step 1: Create the script**

```bash
#!/usr/bin/env bash
# Install exam-environment tools inside KubeVirt VMs.
# Run from your laptop after `just cluster-setup`.
# Idempotent — safe to re-run after full disk wipe.
set -euo pipefail

NAMESPACE=cka-labs

vssh() { virtctl ssh -n "$NAMESPACE" ubuntu@vm/"$1" -- "${@:2}"; }
log() { echo "==> $*"; }

# --- etcdctl on cp ---
log "Detecting etcd version from static pod..."
ETCD_IMAGE=$(kubectl get pod -n kube-system etcd-cp \
  -o jsonpath='{.spec.containers[0].image}')
# Image tag format: registry.k8s.io/etcd:3.5.21-0 — strip the -0 build suffix
ETCD_VERSION=$(echo "$ETCD_IMAGE" | cut -d: -f2 | cut -d- -f1)
log "etcd version: $ETCD_VERSION"

log "[cp] downloading etcdctl v${ETCD_VERSION}..."
vssh cp "curl -fsSL https://github.com/etcd-io/etcd/releases/download/v${ETCD_VERSION}/etcd-v${ETCD_VERSION}-linux-amd64.tar.gz \
  | sudo tar -xz --strip-components=1 -C /usr/local/bin \
  etcd-v${ETCD_VERSION}-linux-amd64/etcdctl"

log "[cp] configuring etcdctl environment..."
vssh cp 'grep -qF "ETCDCTL_API" /etc/bash.bashrc || {
  echo "export ETCDCTL_API=3"
  echo "export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt"
  echo "export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt"
  echo "export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key"
} | sudo tee -a /etc/bash.bashrc > /dev/null'

# --- k alias + completion on all nodes ---
for vm in cp worker-1 worker-2; do
  log "[$vm] configuring k alias..."
  vssh "$vm" 'grep -qF "alias k=kubectl" /etc/bash.bashrc || {
    echo "source <(kubectl completion bash)"
    echo "alias k=kubectl"
    echo "complete -o default -F __start_kubectl k"
  } | sudo tee -a /etc/bash.bashrc > /dev/null'
done

log "=== ckx-env-setup complete ==="
log "Verify: just ssh-cp, then: etcdctl member list"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/ckx-env-setup.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/ckx-env-setup.sh
git commit -m "feat(cka-labs): add ckx-env-setup.sh — etcdctl and k alias"
```

---

### Task 7: Update docs/kubevirt.md

**Files:**
- Modify: `docs/kubevirt.md`

- [ ] **Step 1: Find all references to update**

```bash
grep -n 'cka-cp\|cka-worker\|1\.35\.5' docs/kubevirt.md
```

- [ ] **Step 2: Apply updates**

Replace all occurrences:
- `cka-cp` → `cp`
- `cka-worker-1` → `worker-1`
- `cka-worker-2` → `worker-2`
- `v1.35.5` → `v1.35.1` (version table)
- `1.35.5-1.1` → `1.35.1-1.1` (manual setup commands)
- `node/cka-cp` → `node/cp` (verify section)

- [ ] **Step 3: Verify**

```bash
grep -n 'cka-\|1\.35\.5' docs/kubevirt.md
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add docs/kubevirt.md
git commit -m "docs(cka-labs): update VM names and K8s version to 1.35.1"
```

---

### Task 8: Deploy — stop VMs, push, wait for Flux, bring up new cluster

> **Warning:** This step deletes the existing VMs and DataVolumes. CDI will re-import the Ubuntu base image (~5–10 min depending on cluster speed). Ensure you have nothing on the existing VMs worth keeping.

**Files:** none (operational step)

- [ ] **Step 1: Stop running VMs (if any)**

```bash
just lab-down
```

If VMs are already stopped, this is a no-op.

- [ ] **Step 2: Push all changes to git**

```bash
git push
```

- [ ] **Step 3: Force Flux reconciliation**

```bash
flux reconcile kustomization cka-labs --with-source
```

Flux will delete old VMs (`cka-cp`, `cka-worker-1`, `cka-worker-2`) and create new ones (`cp`, `worker-1`, `worker-2`). DataVolumes owned by old VMs are garbage-collected automatically.

- [ ] **Step 4: Wait for DataVolumes to complete import**

```bash
kubectl get dv -n cka-labs -w
```

Expected (all three succeed):
```
NAME        PHASE       PROGRESS   RESTARTS   AGE
cp-disk     Succeeded   100.0%                Xm
worker-1-disk  Succeeded   100.0%             Xm
worker-2-disk  Succeeded   100.0%             Xm
```

This takes 5–10 minutes. Do not proceed until all three show `Succeeded`.

- [ ] **Step 5: Verify new VMs exist**

```bash
kubectl get vm -n cka-labs
```

Expected:
```
NAME       AGE   STATUS    READY
cp         Xm    Stopped   False
worker-1   Xm    Stopped   False
worker-2   Xm    Stopped   False
```

- [ ] **Step 6: Start VMs**

```bash
just lab-up
```

Wait ~60s for boot.

- [ ] **Step 7: Run cluster setup**

```bash
just cluster-setup
```

Expected final output:
```
NAME       STATUS   ROLES           VERSION
cp         Ready    control-plane   v1.35.1
worker-1   Ready    <none>          v1.35.1
worker-2   Ready    <none>          v1.35.1
```

- [ ] **Step 8: Install exam tools**

```bash
just ckx-env-setup
```

---

### Task 9: Verify exam environment

**Files:** none (verification step)

- [ ] **Step 1: Verify etcdctl on cp**

```bash
just ssh-cp
```

Inside cp VM:
```bash
source /etc/bash.bashrc
etcdctl member list
```

Expected: output showing etcd member entry, e.g.:
```
<id>, started, cp, https://10.0.2.2:2380, https://10.0.2.2:2379, false
```

- [ ] **Step 2: Verify k alias on cp**

Still inside cp VM:
```bash
k get nodes
```

Expected:
```
NAME       STATUS   ROLES           AGE   VERSION
cp         Ready    control-plane   Xm    v1.35.1
worker-1   Ready    <none>          Xm    v1.35.1
worker-2   Ready    <none>          Xm    v1.35.1
```

Exit cp VM.

- [ ] **Step 3: Verify k alias on worker-1**

```bash
just ssh-w1
source /etc/bash.bashrc
k get nodes
```

Expected: same node listing. Exit.

- [ ] **Step 4: Verify upgrade path is clear**

Still on laptop:
```bash
just ssh-cp
```

Inside cp VM:
```bash
sudo apt-mark unhold kubeadm
sudo apt-get update -q
apt-cache madison kubeadm | grep 1.35
```

Expected: both `1.35.1-1.1` and `1.35.5-1.1` listed — confirming the upgrade target is available in the repo without keyring changes.

Exit cp VM.

- [ ] **Step 5: Confirm no aliases beyond k**

```bash
just ssh-cp
grep -E 'alias k[a-z]' /etc/bash.bashrc
```

Expected: no output (only `alias k=kubectl` exists, no `kgp`, `kgn`, etc.)

Exit.

---

## Post-Implementation Workflow

```
just lab-up           # start VMs
just cluster-setup    # fresh kubeadm cluster at 1.35.1 (~5 min)
just ckx-env-setup    # first time or after full disk wipe
# practice from: https://github.com/theplatformlab/CKA-Certified-Kubernetes-Administrator
# exercise 09: upgrade 1.35.1 → 1.35.5 manually
just cluster-setup    # reset back to 1.35.1 to repeat
just lab-down         # stop VMs when done
```
