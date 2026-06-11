#!/usr/bin/env bash
# Install exam-environment tools inside the KubeVirt VMs after `just cluster-setup`.
# Idempotent — safe to re-run.
#
# Usage: ./scripts/ckx-env-setup.sh
set -euo pipefail

NAMESPACE=cka-labs

vssh() { virtctl ssh -n "$NAMESPACE" ubuntu@vm/"$1" -c "${@:2}"; }
log() { echo "==> $*"; }

# ---------------------------------------------------------------------------
# Detect etcd version from the static pod running on cp
# Image tag format: registry.k8s.io/etcd:3.5.21-0 — strip the -N build suffix
# ---------------------------------------------------------------------------
log "Detecting etcd version from cp static pod..."
ETCD_IMAGE=$(vssh cp "kubectl get pod -n kube-system etcd-cp -o jsonpath='{.spec.containers[0].image}'")
ETCD_TAG="${ETCD_IMAGE##*:}"        # e.g. 3.5.21-0
ETCD_VERSION="${ETCD_TAG%-*}"       # e.g. 3.5.21
log "etcd version: $ETCD_VERSION"

# ---------------------------------------------------------------------------
# cp — install etcdctl
# ---------------------------------------------------------------------------
log "[cp] Installing etcdctl v${ETCD_VERSION} (skip if already installed)..."
vssh cp "etcdctl version 2>/dev/null | grep -q 'etcdctl version: ${ETCD_VERSION}' || { \
  curl -fsSL https://github.com/etcd-io/etcd/releases/download/v${ETCD_VERSION}/etcd-v${ETCD_VERSION}-linux-amd64.tar.gz \
  | sudo tar -xz --strip-components=1 -C /usr/local/bin \
  etcd-v${ETCD_VERSION}-linux-amd64/etcdctl; }"

# cp — set ETCDCTL_* env vars in /etc/bash.bashrc (idempotent)
log "[cp] Configuring ETCDCTL env vars in /etc/bash.bashrc..."
vssh cp 'grep -qF "ETCDCTL_API" /etc/bash.bashrc || {
  echo "export ETCDCTL_API=3"
  echo "export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt"
  echo "export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt"
  echo "export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key"
} | sudo tee -a /etc/bash.bashrc > /dev/null'

# ---------------------------------------------------------------------------
# All nodes — kubectl completion + k alias (idempotent)
# ---------------------------------------------------------------------------
for node in cp worker-1 worker-2; do
  log "[$node] Configuring kubectl completion and k alias in /etc/bash.bashrc..."
  vssh "$node" 'grep -qF "alias k=kubectl" /etc/bash.bashrc || {
  echo "source <(kubectl completion bash)"
  echo "alias k=kubectl"
  echo "complete -o default -F __start_kubectl k"
} | sudo tee -a /etc/bash.bashrc > /dev/null'
done

# ---------------------------------------------------------------------------
log "=== ckx-env-setup complete ==="
log "Verify: just ssh-cp, then: etcdctl member list"
