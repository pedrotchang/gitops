#!/usr/bin/env bash
# Tear down and rebuild the kubeadm cluster inside KubeVirt VMs.
# Run from your laptop after `just lab-up` and VMs are running.
#
# Usage: ./scripts/cluster-setup.sh
set -euo pipefail

NAMESPACE=cka-labs
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_VERSION="1.35.1-1.1"
K8S_SEMVER="v${K8S_VERSION%%-*}"   # 1.35.1-1.1 → v1.35.1
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
  vssh "$vm" "sudo rm -f /etc/resolv.conf && printf 'nameserver 8.8.8.8\n' | sudo tee /etc/resolv.conf >/dev/null"
  vssh "$vm" "grep -qF \"\$(hostname)\" /etc/hosts || echo \"127.0.1.1 \$(hostname)\" | sudo tee -a /etc/hosts >/dev/null"
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
vssh cp "sudo kubeadm init --kubernetes-version=$K8S_SEMVER --pod-network-cidr=$POD_CIDR --apiserver-advertise-address=10.0.2.2 --apiserver-cert-extra-sans=$CP_IP || true"
# super-admin.conf always has full cluster-admin access regardless of RBAC state
vssh cp "mkdir -p ~/.kube && sudo cp /etc/kubernetes/super-admin.conf ~/.kube/config && sudo chown \$(id -u):\$(id -g) ~/.kube/config"

log "=== Completing kubeadm phases ==="
vssh cp "sudo kubeadm init phase upload-config all                       || true"
vssh cp "sudo kubeadm init phase mark-control-plane                      || true"
vssh cp "sudo kubeadm init phase bootstrap-token                         || true"
vssh cp "sudo kubeadm init phase kubelet-finalize all                    || true"
vssh cp "sudo kubeadm init phase addon all --pod-network-cidr=$POD_CIDR  || true"

# Pin cp's kubelet --node-ip to its routable VMI pod IP, same as the workers
# below. cp hosts coredns, so without a routable InternalIP the workers' pods
# can't reach DNS (worker→cp tunnels to 10.0.2.2, which loops back to the worker).
# kubelet rejects a --node-ip not on a local interface, so add it as a /32 on lo.
log "=== Pinning cp node-ip ($CP_IP) ==="
vssh cp "sudo ip addr add ${CP_IP}/32 dev lo 2>/dev/null || true"
vssh cp "echo 'KUBELET_EXTRA_ARGS=--node-ip=${CP_IP}' | sudo tee /etc/default/kubelet >/dev/null && sudo systemctl restart kubelet"

log "=== Installing Cilium CLI ==="
vssh cp "command -v cilium >/dev/null 2>&1 || { CILIUM_CLI_VERSION=\$(curl -fsSL https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt) && curl -fsSL https://github.com/cilium/cilium-cli/releases/download/\${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz | sudo tar xz -C /usr/local/bin; }"

log "=== Installing Cilium ==="
# The host (talos) cluster also runs Cilium with VXLAN on the default UDP port
# 8472. These VMs share the host's network via masquerade, so the host's vxlan
# socket swallows the inner cluster's 8472 traffic and cross-node pod networking
# silently breaks (pods on different nodes can't talk, DNS to coredns fails).
# Move the inner cluster's tunnel to 8473 to dodge the collision.
vssh cp "cilium install --version $CILIUM_VERSION --set tunnelProtocol=vxlan --set tunnelPort=8473 2>/dev/null || cilium status"

log "=== Waiting for control plane Ready ==="
vssh cp "kubectl wait --for=condition=Ready node/cp --timeout=300s"

log "=== Joining workers ==="
JOIN_CMD=$(vssh cp "kubeadm token create --print-join-command 2>/dev/null" | grep "kubeadm join")
# Replace the advertised address (10.0.2.2) with the routable pod IP
JOIN_CMD="${JOIN_CMD/10.0.2.2/$CP_IP}"

for worker in worker-1 worker-2; do
  log "[$worker] joining..."
  WORKER_IP=$(kubectl get vmi "$worker" -n "$NAMESPACE" -o jsonpath='{.status.interfaces[0].ipAddress}')
  # Redirect 10.0.2.2:6443 → CP_IP:6443 so kubelet can reach the apiserver
  # after join (kubelet.conf uses 10.0.2.2 which loops back to itself otherwise)
  vssh "$worker" "sudo iptables -t nat -A OUTPUT -d 10.0.2.2 -p tcp --dport 6443 -j DNAT --to-destination ${CP_IP}:6443 || true"
  # Redirect the kubernetes ClusterIP 10.96.0.1:443 → CP_IP:6443. kube-proxy DNATs
  # 10.96.0.1 → 10.0.2.2:6443 (the apiserver endpoint) and that DNAT terminates the
  # nat OUTPUT pass, so the rule above never fires for ClusterIP traffic. Insert at
  # the top of OUTPUT (before KUBE-SERVICES) so it wins first — otherwise cilium and
  # every pod on the worker get "connection refused" reaching the apiserver.
  vssh "$worker" "sudo iptables -t nat -I OUTPUT 1 -d 10.96.0.1 -p tcp --dport 443 -j DNAT --to-destination ${CP_IP}:6443 || true"
  vssh "$worker" "sudo $JOIN_CMD --ignore-preflight-errors=Hostname"
  # Pin kubelet --node-ip to the routable VMI pod IP. Without this every node
  # registers InternalIP 10.0.2.2 (masquerade), so the apiserver on cp dials
  # 10.0.2.2:10250 and loops back to cp's own kubelet — breaking exec/logs/
  # port-forward to worker pods with "pod does not exist".
  #
  # kubelet rejects a --node-ip that isn't on a local interface, and the VM only
  # owns 10.0.2.2 (the VMI pod IP lives on the host-side virt-launcher, not in the
  # VM). Add it as a /32 alias on lo so kubelet accepts it and registers it as the
  # InternalIP. Inbound masquerade still DNATs ${WORKER_IP}:10250 → 10.0.2.2:10250,
  # so the apiserver reaches the kubelet via the routable pod IP.
  vssh "$worker" "sudo ip addr add ${WORKER_IP}/32 dev lo 2>/dev/null || true"
  vssh "$worker" "echo 'KUBELET_EXTRA_ARGS=--node-ip=${WORKER_IP}' | sudo tee /etc/default/kubelet >/dev/null && sudo systemctl restart kubelet"
done

log "=== Verifying cluster health ==="
# Self-verify the fresh build. If a gate fails (e.g. kube-proxy buried the
# ClusterIP DNAT), 'just lab-rejoin' re-asserts and re-converges.
bash "$SCRIPT_DIR/lab-verify.sh"
