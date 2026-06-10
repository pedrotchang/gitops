#!/usr/bin/env bash
# Tear down and rebuild the kubeadm cluster inside KubeVirt VMs.
# Run from your laptop after `make lab-up` and VMs are running.
#
# Usage: ./scripts/cluster-setup.sh
set -euo pipefail

NAMESPACE=cka-labs
K8S_VERSION="1.35.5-1.1"
CILIUM_VERSION="1.19.4"
POD_CIDR="10.244.0.0/16"

vssh() { virtctl ssh -n "$NAMESPACE" ubuntu@vm/"$1" -- "${@:2}"; }
log() { echo "==> $*"; }

# KubeVirt masquerade gives every VM the same internal IP (10.0.2.2).
# Workers must reach the CP via its pod IP instead.
log "Resolving cka-cp VMI IP..."
CP_IP=$(kubectl get vmi cka-cp -n "$NAMESPACE" -o jsonpath='{.status.interfaces[0].ipAddress}')
[[ -z "$CP_IP" ]] && { echo "ERROR: cka-cp VMI not running — run 'make lab-up' first"; exit 1; }
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
reset_node cka-worker-2
reset_node cka-worker-1
reset_node cka-cp

log "=== Bootstrapping nodes ==="
bootstrap_node cka-cp
bootstrap_node cka-worker-1
bootstrap_node cka-worker-2

log "=== Initializing control plane ==="
# kubeadm init may time out on the RBAC bootstrap step but the apiserver will
# still be running. We catch the exit code and run remaining phases manually.
vssh cka-cp "sudo kubeadm init --pod-network-cidr=$POD_CIDR --apiserver-advertise-address=10.0.2.2 --apiserver-cert-extra-sans=$CP_IP || true"
# super-admin.conf always has full cluster-admin access regardless of RBAC state
vssh cka-cp "mkdir -p ~/.kube && sudo cp /etc/kubernetes/super-admin.conf ~/.kube/config && sudo chown \$(id -u):\$(id -g) ~/.kube/config"

log "=== Completing kubeadm phases ==="
vssh cka-cp "sudo kubeadm init phase upload-config all                       || true"
vssh cka-cp "sudo kubeadm init phase mark-control-plane                      || true"
vssh cka-cp "sudo kubeadm init phase bootstrap-token                         || true"
vssh cka-cp "sudo kubeadm init phase kubelet-finalize all                    || true"
vssh cka-cp "sudo kubeadm init phase addon all --pod-network-cidr=$POD_CIDR  || true"

log "=== Installing Cilium ==="
vssh cka-cp "cilium install --version $CILIUM_VERSION 2>/dev/null || cilium status"

log "=== Waiting for control plane Ready ==="
vssh cka-cp "kubectl wait --for=condition=Ready node/cka-cp --timeout=300s"

log "=== Joining workers ==="
JOIN_CMD=$(vssh cka-cp "kubeadm token create --print-join-command 2>/dev/null" | grep "kubeadm join")
# Replace the advertised address (10.0.2.2) with the routable pod IP
JOIN_CMD="${JOIN_CMD/10.0.2.2/$CP_IP}"

for worker in cka-worker-1 cka-worker-2; do
  log "[$worker] joining..."
  # Redirect 10.0.2.2:6443 → CP_IP:6443 so kubelet can reach the apiserver
  # after join (kubelet.conf uses 10.0.2.2 which loops back to itself otherwise)
  vssh "$worker" "sudo iptables -t nat -A OUTPUT -d 10.0.2.2 -p tcp --dport 6443 -j DNAT --to-destination ${CP_IP}:6443 || true"
  vssh "$worker" "sudo $JOIN_CMD --ignore-preflight-errors=Hostname"
done

log "=== Cluster ready ==="
vssh cka-cp "kubectl get nodes -o wide"
