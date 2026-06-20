#!/usr/bin/env bash
# Re-pin the cka-labs masquerade cluster after a reboot.
#
# Why this exists: under KubeVirt masquerade every VM sees the same internal IP
# (10.0.2.2) and its routable pod IP changes on every boot. cluster-setup.sh
# pins the cluster to those pod IPs via `ip addr` / `iptables` / kubelet
# --node-ip, but that runtime state is wiped on reboot — so `just lab-up` alone
# comes back with workers NotReady and nothing schedulable. This re-resolves the
# CURRENT pod IPs and re-applies the pinning, WITHOUT a kubeadm reset. Idempotent.
# Must run from the laptop: a VM cannot discover its own pod IP from inside.
#
# Usage: ./scripts/lab-rejoin.sh   (or: just lab-rejoin)
#
# NOTE: the pinning mirrors the post-join steps in cluster-setup.sh. Keep the two
# in sync if the masquerade approach changes.
set -euo pipefail

NAMESPACE=cka-labs
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

vssh() {
  virtctl ssh -n "$NAMESPACE" \
    --local-ssh-opts="-o StrictHostKeyChecking=no" \
    --local-ssh-opts="-o UserKnownHostsFile=/dev/null" \
    --local-ssh-opts="-o ConnectTimeout=15" \
    --local-ssh-opts="-o LogLevel=ERROR" \
    ubuntu@vm/"$1" -c "${2}"
}
vmi_ip() { kubectl get vmi "$1" -n "$NAMESPACE" -o jsonpath='{.status.interfaces[0].ipAddress}'; }
kc() { vssh cp "sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl $*"; }
log() { echo "==> $*"; }

# Bail cleanly if no cluster has been built yet (lab-up calls us unconditionally).
if ! vssh cp "test -f /etc/kubernetes/admin.conf"; then
  log "No kubeadm cluster found on cp (/etc/kubernetes/admin.conf missing)."
  log "Build it first with:  just cluster-setup"
  exit 0
fi

CP_IP="$(vmi_ip cp)"
[[ -z "$CP_IP" ]] && { echo "ERROR: cp VMI not running — run 'just lab-up' first" >&2; exit 1; }
log "cp pod IP = $CP_IP"

# pin_node_ip <vm> <ip>: register the node's current pod IP as its kubelet
# InternalIP. kubelet rejects a --node-ip not on a local interface, and the VM
# only owns 10.0.2.2, so add the pod IP as a /32 alias on lo.
pin_node_ip() {
  local vm=$1 ip=$2
  vssh "$vm" "sudo ip addr add ${ip}/32 dev lo 2>/dev/null || true"
  vssh "$vm" "echo 'KUBELET_EXTRA_ARGS=--node-ip=${ip}' | sudo tee /etc/default/kubelet >/dev/null"
}

# --- Phase 1: pin node-ips, set up apiserver reachability, restart kubelets ---
# cp hosts coredns; without a routable InternalIP, worker pods can't reach DNS.
log "[cp] pinning node-ip + restarting kubelet"
pin_node_ip cp "$CP_IP"
vssh cp "sudo systemctl restart kubelet"

for w in worker-1 worker-2; do
  WIP="$(vmi_ip "$w")"
  [[ -z "$WIP" ]] && { echo "WARN: $w not running — skipping" >&2; continue; }
  log "[$w] pod IP = $WIP — pinning node-ip + apiserver route, restarting kubelet"
  # kubelet.conf targets the apiserver at 10.0.2.2:6443, which loops back to the
  # worker itself. DNAT it to cp's CURRENT pod IP. This rule is order-independent
  # (10.0.2.2 is not a ClusterIP, so kube-proxy's KUBE-SERVICES never matches it).
  vssh "$w" "sudo iptables -t nat -C OUTPUT -d 10.0.2.2 -p tcp --dport 6443 -j DNAT --to-destination ${CP_IP}:6443 2>/dev/null || sudo iptables -t nat -A OUTPUT -d 10.0.2.2 -p tcp --dport 6443 -j DNAT --to-destination ${CP_IP}:6443"
  pin_node_ip "$w" "$WIP"
  vssh "$w" "sudo systemctl restart kubelet"
done

# --- Phase 2: force the ClusterIP apiserver DNAT ABOVE kube-proxy ------------
# Pods (e.g. the cilium agent) reach the apiserver via the kubernetes ClusterIP
# 10.96.0.1:443. kube-proxy's KUBE-SERVICES jump — which it re-inserts at the TOP
# of OUTPUT every time it (re)starts — would DNAT that to the apiserver endpoint
# (10.0.2.2:6443) and loop back to the worker. So our redirect must sit ABOVE
# KUBE-SERVICES, and must be (re)asserted AFTER the kubelet/kube-proxy restart
# above — otherwise the cilium agent never connects, never goes Ready, and the
# node.cilium.io/agent-not-ready taint never clears (pods stay Pending).
for w in worker-1 worker-2; do
  vmi_ip "$w" >/dev/null 2>&1 || continue
  [[ -z "$(vmi_ip "$w")" ]] && continue
  log "[$w] asserting ClusterIP apiserver DNAT at top of OUTPUT"
  for _ in $(seq 1 24); do
    if vssh "$w" "sudo iptables -t nat -S OUTPUT | grep -q KUBE-SERVICES" 2>/dev/null; then break; fi
    sleep 5
  done
  vssh "$w" "sudo iptables -t nat -D OUTPUT -d 10.96.0.1 -p tcp --dport 443 -j DNAT --to-destination ${CP_IP}:6443 2>/dev/null || true"
  vssh "$w" "sudo iptables -t nat -I OUTPUT 1 -d 10.96.0.1 -p tcp --dport 443 -j DNAT --to-destination ${CP_IP}:6443"
  code="$(vssh "$w" "curl -sk --max-time 8 https://10.96.0.1:443/healthz -o /dev/null -w '%{http_code}' || true")"
  log "[$w] apiserver via ClusterIP -> HTTP ${code:-error}"
done

# --- Phase 3: refresh cilium node IPs ---------------------------------------
# cilium caches each node's InternalIP in its CiliumNode resource and uses it as
# the VXLAN tunnel endpoint. After the node-ip change above it does NOT refresh
# on its own, so workers keep tunnelling pod traffic to cp's OLD pod IP — which
# silently breaks worker→cp networking (coredns lives on cp, so cluster DNS dies)
# while worker→worker still works. Restarting the agents + operator forces them
# to re-read current InternalIPs. This also clears node.cilium.io/agent-not-ready.
log "Refreshing cilium node IPs (restart agents + operator)..."
kc -n kube-system delete pod -l k8s-app=cilium --wait=false 2>/dev/null || true
kc -n kube-system delete pod -l name=cilium-operator --wait=false 2>/dev/null || true
kc -n kube-system rollout status ds/cilium --timeout=180s || true

# --- Uncordon ---------------------------------------------------------------
log "Uncordoning nodes"
for n in cp worker-1 worker-2; do kc uncordon "$n" 2>/dev/null || true; done

# --- Phase 4: converge + verify ---------------------------------------------
# The ClusterIP apiserver DNAT (Phase 2) is the most fragile rule: kube-proxy
# re-inserts KUBE-SERVICES at the top of OUTPUT whenever it restarts, which can
# bury our redirect and silently cut pods off from the apiserver. So before each
# verification attempt, cheaply re-assert that one rule on every worker, then run
# the read-only health gate. We only exit 0 once the gate is actually green — no
# more "succeeding" with a broken cluster.
reassert_clusterip_dnat() {
  for w in worker-1 worker-2; do
    [[ -z "$(vmi_ip "$w" 2>/dev/null)" ]] && continue
    vssh "$w" "sudo iptables -t nat -D OUTPUT -d 10.96.0.1 -p tcp --dport 443 -j DNAT --to-destination ${CP_IP}:6443 2>/dev/null || true"
    vssh "$w" "sudo iptables -t nat -I OUTPUT 1 -d 10.96.0.1 -p tcp --dport 443 -j DNAT --to-destination ${CP_IP}:6443"
  done
}

log "Converging + verifying..."
for attempt in 1 2 3; do
  reassert_clusterip_dnat
  if bash "$SCRIPT_DIR/lab-verify.sh"; then
    log "✅ lab-rejoin complete — cluster healthy."
    exit 0
  fi
  log "attempt $attempt not green; re-asserting and retrying..."
  sleep 10
done

echo
echo "❌ lab-rejoin could not converge after 3 attempts." >&2
echo "   'just lab-verify' shows the failing gate. If it persists, 'just cluster-setup' rebuilds." >&2
exit 1
