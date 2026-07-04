# KubeVirt / CDI on tachtit

This repo manages only the KubeVirt and CDI **operators** (Flux, under
`infrastructure/controllers/`). The CKA/CKS practice lab that runs on top of them —
VMs, WireGuard-mesh networking, cluster-setup, security tooling, exercises — lives in
its own repo: **https://forgejo.seyzahl.com/continuous-learning/cka-labs** (applied by
Flux via the `cka-labs` GitRepository + Kustomization in `clusters/tachtit/`).

## Versions

| Component | Version | Source |
|-----------|---------|--------|
| KubeVirt | v1.8.x | `infrastructure/controllers/base/kubevirt/` |
| CDI | v1.65.x | `infrastructure/controllers/base/cdi/` |

## Prerequisites

### KVM on Talos

On bare metal with VT-x/AMD-V enabled in BIOS, `kvm_intel`/`kvm_amd` loads automatically —
no Talos machineconfig patch needed.

```bash
talosctl read /proc/modules -n <worker-node-ip> | grep kvm
```

### Updating operator manifests

```bash
just fetch-manifests
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
└── GitRepository continuous-learning/cka-labs → ./manifests
```

## CDI configuration notes

- `HonorWaitForFirstConsumer` feature gate is required: the lab uses `local-path`
  (node-pinned) storage with node-pinned VMs, so DataVolume imports must bind on the
  VM's target node, not wherever the importer pod happens to schedule.
- KubeVirt CR runs with `useEmulation: false` (real KVM required).

## History

The lab formerly lived in this repo (`apps/*/cka-labs`, `scripts/cluster-setup.sh`,
`scripts/lab-rejoin.sh`) using masquerade networking with post-boot re-pinning. It was
replaced 2026-07 by the WireGuard-mesh design in the dedicated repo; see that repo's
`ISA.md` for the architecture and rationale. Historical design docs:
`docs/specs/2026-06-10-ckx-env-setup-design.md`, `docs/plans/2026-06-10-ckx-env-setup.md`.
