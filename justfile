namespace := "cka-labs"
kubevirt_version := "v1.8.3"
cdi_version      := "v1.65.0"

# The lab VMs live on the tachtit cluster. Recipes that touch the cluster
# guard on this so they never silently run against the wrong kube context
# (e.g. a dead local minikube). Enter it first with: kubie ctx pedrotchang-tachtit
expected_context := "pedrotchang-tachtit"

kubevirt_operator_url := "https://github.com/kubevirt/kubevirt/releases/download/" + kubevirt_version + "/kubevirt-operator.yaml"
cdi_operator_url      := "https://github.com/kubevirt/containerized-data-importer/releases/download/" + cdi_version + "/cdi-operator.yaml"

# Abort unless the active kube context targets the lab cluster.
# Private (leading _) — used as a dependency by cluster-touching recipes.
_guard:
    #!/usr/bin/env bash
    set -euo pipefail
    ctx="$(kubectl config current-context 2>/dev/null || true)"
    if [ "$ctx" != "{{expected_context}}" ]; then
        echo "✗ Wrong kube context: '${ctx:-<none>}' (expected '{{expected_context}}')" >&2
        echo "  The {{namespace}} VMs live on the tachtit cluster." >&2
        echo "  Run:  kubie ctx {{expected_context}}" >&2
        echo "  then re-run this recipe inside that subshell." >&2
        exit 1
    fi

fetch-manifests:
    curl -L {{kubevirt_operator_url}} -o infrastructure/controllers/base/kubevirt/kubevirt-operator.yaml
    curl -L {{cdi_operator_url}}      -o infrastructure/controllers/base/cdi/cdi-operator.yaml
    @echo "Done. Uncomment operator lines in:"
    @echo "  infrastructure/controllers/base/kubevirt/kustomization.yaml"
    @echo "  infrastructure/controllers/base/cdi/kustomization.yaml"
    @echo "Then commit and push."

# Start the lab VMs, wait for them to boot, then re-pin the cluster networking
# so you get a SCHEDULABLE cluster — not just running VMs. Under masquerade the
# pod IPs change every boot and cluster-setup's pinning is wiped, so a plain
# start leaves workers NotReady. See scripts/lab-rejoin.sh. Idempotent.
lab-up: _guard
    #!/usr/bin/env bash
    set -euo pipefail
    for vm in cp worker-1 worker-2; do
        virtctl start "$vm" -n {{namespace}} 2>/dev/null || true
    done
    echo "==> waiting for VMIs to reach Running..."
    for i in $(seq 1 60); do
        running="$(kubectl get vmi -n {{namespace}} --no-headers 2>/dev/null | grep -c Running || true)"
        [ "${running:-0}" -eq 3 ] && break
        sleep 5
    done
    echo "==> waiting for SSH on each VM..."
    for vm in cp worker-1 worker-2; do
        for i in $(seq 1 60); do
            if virtctl ssh ubuntu@vm/"$vm" -n {{namespace}} \
                --local-ssh-opts="-o StrictHostKeyChecking=no" \
                --local-ssh-opts="-o UserKnownHostsFile=/dev/null" \
                --local-ssh-opts="-o ConnectTimeout=5" \
                --local-ssh-opts="-o BatchMode=yes" \
                -c true 2>/dev/null; then break; fi
            sleep 5
        done
    done
    bash scripts/lab-rejoin.sh

# Re-pin cluster networking after a reboot WITHOUT restarting the VMs.
# lab-up runs this automatically; use it standalone to recover an already-up lab.
lab-rejoin: _guard
    bash scripts/lab-rejoin.sh

lab-down: _guard
    -virtctl stop cp       -n {{namespace}}
    -virtctl stop worker-1 -n {{namespace}}
    -virtctl stop worker-2 -n {{namespace}}

ssh-cp: _guard
    virtctl ssh ubuntu@vm/cp -n {{namespace}}

ssh-w1: _guard
    virtctl ssh ubuntu@vm/worker-1 -n {{namespace}}

ssh-w2: _guard
    virtctl ssh ubuntu@vm/worker-2 -n {{namespace}}

lab-status: _guard
    kubectl get vm,vmi,dv -n {{namespace}}

cluster-setup: _guard
    bash scripts/cluster-setup.sh

ckx-env-setup: _guard
    bash scripts/ckx-env-setup.sh
