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

vssh() { virtctl ssh -n "$NAMESPACE" ubuntu@vm/"$1" -c "${@:2}"; }
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

log "=== Installing Cilium CLI ==="
vssh cp "command -v cilium >/dev/null 2>&1 || { CILIUM_CLI_VERSION=\$(curl -fsSL https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt) && curl -fsSL https://github.com/cilium/cilium-cli/releases/download/\${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz | sudo tar xz -C /usr/local/bin; }"

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
