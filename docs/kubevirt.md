# KubeVirt CKA Lab

## Prerequisites

### 1. Verify KVM is available

On bare metal with VT-x/AMD-V enabled in BIOS, `kvm_intel`/`kvm_amd` loads automatically — no Talos machineconfig patch needed. Confirm `/dev/kvm` is present on worker nodes:

```bash
talosctl read /proc/modules -n <worker-node-ip> | grep kvm
```

KubeVirt's device plugin detects `/dev/kvm` automatically. If the module is missing, check BIOS virtualization settings.

### 2. Azure Key Vault secret

Create the SSH public key secret in Azure KV (`seyzahl.vault.azure.net`):

```bash
az keyvault secret set \
  --vault-name seyzahl \
  --name cka-labs-ssh-public-key \
  --value "$(cat ~/.ssh/id_ed25519.pub)"
```

### 3. Fetch vendor manifests

KubeVirt and CDI release manifests are not in their git trees — they must be downloaded and committed. Operator YAMLs are already vendored in this repo. To upgrade versions, update `Makefile` and re-run:

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

The operator + CR being in the same Flux reconciliation means the CR will fail on first apply (CRD not yet ready), then succeed on retry (`retryInterval: 2m` from infra-controllers). This is expected.

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

VMs use `runStrategy: Manual` — Flux reconciliation does NOT restart or stop them. Start/stop is fully manual via `virtctl`.

Wait for the Ubuntu DataVolume import to complete before first `lab-up`:
```bash
kubectl get dv ubuntu-22-04-base -n cka-labs -w
```

## kubeadm setup (inside the VMs)

On `cka-cp`:
```bash
sudo kubeadm init --pod-network-cidr=10.244.0.0/16
mkdir -p $HOME/.kube && sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config
kubectl apply -f https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml
kubeadm token create --print-join-command  # copy for workers
```

On `cka-worker-1` and `cka-worker-2`:
```bash
sudo kubeadm join <cp-ip>:6443 --token <token> --discovery-token-ca-cert-hash sha256:<hash>
```

## VPN access

VMs are accessible only via `virtctl` (through the Kubernetes API). The Kubernetes API is reachable only via Headscale VPN. No external Istio Gateway or LoadBalancer is created for this namespace. The `cka-labs-restrict-external` NetworkPolicy blocks non-cluster ingress.

## Upgrading KubeVirt/CDI versions

1. Update `KUBEVIRT_VERSION` and `CDI_VERSION` in `Makefile`
2. `make fetch-manifests`
3. Commit and push — Flux reconciles automatically

## Versions

Pinned in `Makefile` (`KUBEVIRT_VERSION`, `CDI_VERSION`). Update there and re-run `make fetch-manifests` to upgrade.
