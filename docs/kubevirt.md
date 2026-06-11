# KubeVirt CKA Lab

## Prerequisites

### 1. Verify KVM is available

On bare metal with VT-x/AMD-V enabled in BIOS, `kvm_intel`/`kvm_amd` loads automatically — no Talos machineconfig patch needed.

```bash
talosctl read /proc/modules -n <worker-node-ip> | grep kvm
```

### 2. Azure Key Vault secret

```bash
az keyvault secret set \
  --vault-name seyzahl \
  --name cka-labs-ssh-public-key \
  --value "$(cat ~/.ssh/id_ed25519.pub)"
```

### 3. Fetch vendor manifests

```bash
make fetch-manifests
git add infrastructure/controllers/base/kubevirt/kubevirt-operator.yaml \
        infrastructure/controllers/base/cdi/cdi-operator.yaml
git commit -m "chore(kubevirt): bump operator manifests"
```

## Flux dependency chain

```
flux-system (gotk-sync)
└── infra-controllers → infrastructure/controllers/tachtit/
    ├── kubevirt  (namespace + operator + KubeVirt CR)
    └── cdi       (namespace + operator + CDI CR)

cka-labs (separate Kustomization, dependsOn: infra-controllers)
└── apps/tachtit/cka-labs/
    ├── ExternalSecret  → Azure KV (ssh key → cloud-init Secret)
    ├── DataVolume      → Ubuntu 22.04 cloud image (CDI import)
    ├── VirtualMachine  cp        (2 vCPU, 4Gi, runStrategy: Manual)
    ├── VirtualMachine  worker-1  (2 vCPU, 2Gi, runStrategy: Manual)
    └── VirtualMachine  worker-2  (2 vCPU, 2Gi, runStrategy: Manual)
```

Monitor convergence:
```bash
flux get kustomizations -A
kubectl get kubevirt -n kubevirt
kubectl get cdi -n cdi
kubectl get dv -n cka-labs -w   # wait for all DataVolumes Succeeded
```

## Lab session lifecycle

```bash
make lab-up      # virtctl start all 3 VMs
make lab-down    # virtctl stop all 3 VMs
make lab-status  # show VM/VMI/DataVolume state
make ssh-cp      # SSH into control plane
make ssh-w1      # SSH into worker-1
make ssh-w2      # SSH into worker-2
```

VMs use `runStrategy: Manual` — Flux does NOT restart or stop them.

## Cluster setup (first time or after teardown)

```bash
make lab-up
# wait ~60s for VMs to boot
make cluster-setup
```

`cluster-setup` resets kubeadm on all nodes, re-initializes the cluster, installs Cilium, and joins both workers. See `scripts/cluster-setup.sh` for details.

### What the script does

1. Gets `cp`'s current VMI pod IP (changes on every `make lab-up`)
2. Resets kubeadm on all three nodes
3. Fixes DNS (`nameserver 8.8.8.8`) and containerd on each node
4. Installs kubelet/kubeadm/kubectl v1.35.1 from the official pkgs.k8s.io repo
5. Runs `kubeadm init` on cp with `--apiserver-cert-extra-sans=<vmi-ip>`
6. Copies `super-admin.conf` as the kubeconfig (see [Known issues](#known-issues))
7. Completes remaining kubeadm phases manually (see [Known issues](#known-issues))
8. Installs Cilium v1.19.4
9. Adds an iptables DNAT rule on each worker (see [Networking](#networking))
10. Joins both workers

### After every `make lab-up`

The VMI pod IP of `cp` changes on restart. Re-run `make cluster-setup` to rebuild the cluster. The script is idempotent — it resets first.

## Networking

KubeVirt masquerade networking gives every VM the same internal IP (`10.0.2.2`). This means workers cannot reach the control plane via `10.0.2.2` — it resolves to themselves.

**Workaround:** each worker gets an iptables DNAT rule that redirects `10.0.2.2:6443` → `<cp vmi pod IP>:6443`. The `cluster-setup` script applies this automatically. The rule is ephemeral (lost on VM reboot); re-running `cluster-setup` reapplies it.

To inspect the current VMI pod IP:
```bash
kubectl get vmi cp -n cka-labs -o jsonpath='{.status.interfaces[0].ipAddress}'
```

## Known issues

### kubeadm init timeout

`kubeadm init` sometimes times out while bootstrapping RBAC (`context deadline exceeded`). The apiserver and etcd are still running. The setup script handles this by catching the error and running the remaining phases individually:

```bash
sudo kubeadm init phase upload-config all
sudo kubeadm init phase mark-control-plane
sudo kubeadm init phase bootstrap-token
sudo kubeadm init phase kubelet-finalize all
sudo kubeadm init phase addon all --pod-network-cidr=10.244.0.0/16
```

### admin.conf vs super-admin.conf

When the init RBAC bootstrap times out, `kubernetes-admin` in `admin.conf` lacks the ClusterRoleBinding to `cluster-admin`. `super-admin.conf` always works because its certificate carries `O=system:masters`. The setup script uses `super-admin.conf`.

### Hostname DNS warnings

All VMs lack DNS entries so `kubeadm join` emits hostname warnings. These are non-fatal — the setup script passes `--ignore-preflight-errors=Hostname`.

## Manual cluster setup (step by step)

If `make cluster-setup` fails, run manually.

### On each VM

```bash
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf
sudo rm -f /etc/containerd/config.toml && sudo systemctl restart containerd
sudo rm -f /etc/apt/sources.list.d/kubernetes.list /etc/apt/keyrings/kubernetes-apt-keyring.gpg
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.35/deb/ /" | sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update && sudo apt-get install -yq --allow-change-held-packages kubelet=1.35.1-1.1 kubeadm=1.35.1-1.1 kubectl=1.35.1-1.1
sudo apt-mark hold kubelet kubeadm kubectl
```

### Control plane (cp)

Get CP VMI IP from laptop first:
```bash
CP_IP=$(kubectl get vmi cp -n cka-labs -o jsonpath='{.status.interfaces[0].ipAddress}')
```

Then on cp:
```bash
sudo kubeadm init --pod-network-cidr=10.244.0.0/16 --apiserver-advertise-address=10.0.2.2 --apiserver-cert-extra-sans=$CP_IP
mkdir -p ~/.kube
sudo cp /etc/kubernetes/super-admin.conf ~/.kube/config
sudo chown $(id -u):$(id -g) ~/.kube/config
```

If init times out, run the phases above, then:
```bash
cilium install --version 1.19.4
kubectl get nodes -w   # wait for Ready
kubeadm token create --print-join-command
```

### Workers (worker-1, worker-2)

Replace `<CP_IP>` with the VMI pod IP:
```bash
sudo iptables -t nat -A OUTPUT -d 10.0.2.2 -p tcp --dport 6443 -j DNAT --to-destination <CP_IP>:6443
sudo kubeadm join <CP_IP>:6443 --token <token> --discovery-token-ca-cert-hash sha256:<hash> --ignore-preflight-errors=Hostname
```

### Verify

```bash
kubectl get nodes
# NAME       STATUS   ROLES           VERSION
# cp         Ready    control-plane   v1.35.1
# worker-1   Ready    <none>          v1.35.1
# worker-2   Ready    <none>          v1.35.1
```

## Reset lab (full disk wipe)

To reprovision from the base Ubuntu image (slower, full reset):
```bash
make lab-down
kubectl delete dv cp-disk worker-1-disk worker-2-disk -n cka-labs
make lab-up   # CDI re-imports from ubuntu-22-04-base
make cluster-setup
```

## VPN access

VMs accessible only via `virtctl` → Kubernetes API → Headscale VPN. No external Gateway created.

## Upgrading KubeVirt/CDI versions

1. Update `KUBEVIRT_VERSION` / `CDI_VERSION` in `Makefile`
2. `make fetch-manifests`
3. Commit and push — Flux reconciles automatically, live VMs unaffected

## Versions

| Component | Version |
|-----------|---------|
| KubeVirt  | v1.8.3  |
| CDI       | v1.65.0 |
| Kubernetes | v1.35.1 |
| Cilium    | v1.19.4 |
| Ubuntu    | 22.04   |

Pinned in `Makefile` (`KUBEVIRT_VERSION`, `CDI_VERSION`). Update there and re-run `make fetch-manifests` to upgrade.
