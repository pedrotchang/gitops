# KubeVirt CKA Lab

## Prerequisites

### 1. Verify KVM is available

On bare metal with VT-x/AMD-V enabled in BIOS, `kvm_intel`/`kvm_amd` loads automatically — no Talos machineconfig patch needed. Confirm `/dev/kvm` is present on worker nodes:

```bash
talosctl read /proc/modules -n <worker-node-ip> | grep kvm
```

### 2. Azure Key Vault secret

Create the SSH public key secret in Azure KV (`seyzahl.vault.azure.net`):

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
    ├── VirtualMachine  cka-cp        (2 vCPU, 4Gi, runStrategy: Manual)
    ├── VirtualMachine  cka-worker-1  (2 vCPU, 2Gi, runStrategy: Manual)
    └── VirtualMachine  cka-worker-2  (2 vCPU, 2Gi, runStrategy: Manual)
```

Monitor convergence:
```bash
flux get kustomizations -A
kubectl get kubevirt -n kubevirt
kubectl get cdi -n cdi
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

Wait for DataVolumes before first `lab-up`:
```bash
kubectl get dv -n cka-labs -w  # wait for all Succeeded
```

## First-time VM setup (run on EACH VM)

Cloud-init installs the tooling but containerd config must be reset before kubeadm works. Run on `cka-cp`, `cka-worker-1`, `cka-worker-2`:

```bash
# Fix DNS
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf

# Fix containerd (default config disables CRI plugin)
sudo rm /etc/containerd/config.toml
sudo systemctl restart containerd

# Switch to k8s v1.35 repo and pin version
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.35/deb/ /" | sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update && sudo apt-get install -yq --allow-change-held-packages kubelet=1.35.5-1.1 kubeadm=1.35.5-1.1 kubectl=1.35.5-1.1
sudo apt-mark hold kubelet kubeadm kubectl
```

## kubeadm setup

### Control plane (`cka-cp`)

```bash
sudo kubeadm init --pod-network-cidr=10.244.0.0/16
mkdir -p $HOME/.kube
sudo cp -f /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

Install Cilium CNI:
```bash
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -L --fail --remote-name-all https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz{,.sha256sum}
sha256sum --check cilium-linux-amd64.tar.gz.sha256sum
sudo tar xzvfC cilium-linux-amd64.tar.gz /usr/local/bin
rm cilium-linux-amd64.tar.gz{,.sha256sum}
cilium install --version 1.19.4
```

Wait for node Ready:
```bash
kubectl get nodes -w
```

Get join command for workers:
```bash
kubeadm token create --print-join-command
```

### Workers (`cka-worker-1`, `cka-worker-2`)

Run the first-time VM setup above, then:
```bash
sudo kubeadm join <cp-ip>:6443 --token <token> --discovery-token-ca-cert-hash sha256:<hash>
```

### Verify

Back on `cka-cp`:
```bash
kubectl get nodes
# NAME           STATUS   ROLES           VERSION
# cka-cp         Ready    control-plane   v1.35.5
# cka-worker-1   Ready    <none>          v1.35.5
# cka-worker-2   Ready    <none>          v1.35.5
```

## Reset lab

To wipe and start fresh (e.g. after exam practice):
```bash
make lab-down
kubectl delete dv cka-cp-disk cka-worker-1-disk cka-worker-2-disk ubuntu-22-04-base -n cka-labs
make lab-up  # re-provisions from base image
```

## VPN access

VMs accessible only via `virtctl` → Kubernetes API → Headscale VPN. No external Gateway created. `cka-labs-restrict-external` NetworkPolicy blocks non-cluster ingress.

## Upgrading KubeVirt/CDI versions

1. Update `KUBEVIRT_VERSION` / `CDI_VERSION` in `Makefile`
2. `make fetch-manifests`
3. Commit and push — Flux reconciles automatically, live VMs unaffected

## Versions

Pinned in `Makefile` (`KUBEVIRT_VERSION`, `CDI_VERSION`). Update there and re-run `make fetch-manifests` to upgrade.
