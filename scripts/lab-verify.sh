#!/usr/bin/env bash
# Read-only health gate for the cka-labs kubeadm lab. NO mutations.
#
# Verifies the cluster is actually usable after a lab-up / lab-rejoin, instead of
# trusting that the pinning "probably worked". Fails FAST at the first broken
# check so you know exactly what's wrong. Exit 0 = green, non-zero = the printed
# gate is what to fix.
#
# Checks (each retried so transient settling doesn't false-fail):
#   1. cp reachable + kubeadm cluster present
#   2. all 3 nodes Ready (and schedulable)
#   3. all cilium agent pods Running
#   4. apiserver reachable via the ClusterIP 10.96.0.1 from EACH worker
#      (this is the kube-proxy-buried-our-DNAT detector)
#   5. a worker-scheduled pod resolves kubernetes.default via CoreDNS on cp
#      (the real worker→cp networking + DNS end-to-end proof)
#
# Usage: ./scripts/lab-verify.sh        (or: just lab-verify)
# Must run from the laptop with the tachtit kube context active.
set -uo pipefail

NAMESPACE=cka-labs
APISERVER_CLUSTERIP=10.96.0.1

vssh() {
  virtctl ssh -n "$NAMESPACE" \
    --local-ssh-opts="-o StrictHostKeyChecking=no" \
    --local-ssh-opts="-o UserKnownHostsFile=/dev/null" \
    --local-ssh-opts="-o ConnectTimeout=15" \
    --local-ssh-opts="-o BatchMode=yes" \
    --local-ssh-opts="-o LogLevel=ERROR" \
    ubuntu@vm/"$1" -c "${2}"
}
kc()  { vssh cp "sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl $*"; }
log() { echo "==> $*"; }
fail() { echo; echo "❌ FAILED: $*" >&2; exit 1; }

# gate <label> <tries> <delay> <cmd...> : run cmd until it succeeds or budget runs out.
gate() {
  local label=$1 tries=$2 delay=$3; shift 3
  printf '  • %-46s' "$label"
  local i
  for ((i = 1; i <= tries; i++)); do
    if "$@"; then echo "PASS"; return 0; fi
    sleep "$delay"
  done
  echo "FAIL"
  return 1
}

# --- check implementations (return 0/1, no output) --------------------------
cp_reachable()   { vssh cp "test -f /etc/kubernetes/admin.conf" >/dev/null 2>&1; }

nodes_ready() {
  local out ready total
  out="$(kc get nodes --no-headers 2>/dev/null)" || return 1
  total="$(printf '%s\n' "$out" | grep -c . )"
  ready="$(printf '%s\n' "$out" | awk '{print $2}' | grep -cx 'Ready')"
  [ "$total" -eq 3 ] && [ "$ready" -eq 3 ]
}

cilium_running() {
  local out total running
  out="$(kc -n kube-system get pods -l k8s-app=cilium --no-headers 2>/dev/null)" || return 1
  total="$(printf '%s\n' "$out" | grep -c . )"
  running="$(printf '%s\n' "$out" | awk '{print $3}' | grep -cx 'Running')"
  [ "$total" -ge 3 ] && [ "$running" -eq "$total" ]
}

apiserver_via_clusterip() {  # $1 = worker
  local code
  code="$(vssh "$1" "curl -sk --max-time 8 https://${APISERVER_CLUSTERIP}:443/healthz -o /dev/null -w '%{http_code}' 2>/dev/null")" || return 1
  [ "$code" = "200" ]
}

dns_resolves() {
  # Throwaway pod resolves kubernetes.default through CoreDNS (which lives on cp).
  # Kept arg-simple (no --overrides JSON) because kc() flattens args via $*; the
  # per-worker apiserver-via-ClusterIP gates above already prove worker→cp paths,
  # so this only needs to prove CoreDNS itself answers.
  local pod="labverify-dns-$$" ok=1 out=""
  kc run "$pod" --image=busybox:1.36 --restart=Never --command -- sleep 90 >/dev/null 2>&1
  if kc wait --for=condition=Ready "pod/$pod" --timeout=70s >/dev/null 2>&1; then
    # Query the FQDN, NOT the short name "kubernetes.default": busybox nslookup
    # mishandles search-domain expansion for short names and false-fails even
    # when DNS is healthy. The "Name:" answer line only prints on success.
    out="$(kc exec "$pod" -- nslookup kubernetes.default.svc.cluster.local 2>&1)"
    printf '%s\n' "$out" | grep -qE 'Name:[[:space:]]*kubernetes\.default\.svc\.cluster\.local' && ok=0
  fi
  kc delete pod "$pod" --wait=false >/dev/null 2>&1
  return $ok
}

# --- run the gates ----------------------------------------------------------
log "Verifying cka-labs cluster health..."

gate "cp reachable + cluster present"        6  5 cp_reachable          || fail "cp unreachable or no kubeadm cluster (run 'just lab-up' / 'just cluster-setup')"
gate "all 3 nodes Ready"                      24 5 nodes_ready           || { kc get nodes -o wide; fail "nodes not Ready — kubelet/node-ip pinning (see lab-rejoin.sh)"; }
gate "cilium agents Running"                  24 5 cilium_running        || { kc -n kube-system get pods -l k8s-app=cilium -o wide; fail "cilium agents not Running"; }
for w in worker-1 worker-2; do
  gate "apiserver via ClusterIP ($w)"         18 5 apiserver_via_clusterip "$w" \
    || fail "$w cannot reach apiserver via $APISERVER_CLUSTERIP — kube-proxy buried the DNAT (lab-rejoin Phase 2)"
done
gate "DNS: worker pod resolves kubernetes"    3  5 dns_resolves          || fail "worker→CoreDNS DNS resolution broken — check cilium tunnel / cp node-ip"

echo
log "✅ cka-labs cluster is healthy:"
kc get nodes -o wide
