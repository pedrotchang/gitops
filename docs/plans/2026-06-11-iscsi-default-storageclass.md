# iSCSI StorageClass Fix + Default Flip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify democratic-csi iSCSI provisioning works end-to-end on the tachtit cluster, then make `truenas-iscsi` the default StorageClass (keeping `truenas-nfs` non-default for RWX).

**Architecture:** democratic-csi (freenas-api-iscsi) is already deployed via Flux HelmRelease in the `storage` namespace, talking to TrueNAS SCALE 25.04 at 192.168.7.14. All changes go through git + Flux; a temporary smoke-test manifest validates provisioning before flipping the default.

**Tech Stack:** Flux Kustomizations, democratic-csi 0.14.7 chart, TrueNAS SCALE API v2, Talos with iscsi-tools extension.

---

## Investigation findings (2026-06-11, read-only — no changes made)

Everything statically verifiable is **correctly configured**. The stack was fixed in a series of commits 135 days ago (`b897a79` and earlier) but **no CreateVolume was ever attempted since** — zero iSCSI PVs exist, controller logs show only successful Probes. "Never worked" almost certainly means "never re-tested after the last fix."

Verified working:
- Controller pod 6/6 Running; TrueNAS API reachable (`TrueNAS-25.04.2.4`), API key valid.
- TrueNAS iSCSI service `RUNNING`; portal id 1/tag 1 on `0.0.0.0:3260`; initiator group id 1 (allow-all); basename `iqn.2005-10.org.freenas.ctl`.
- Datasets `tank/k8s/iscsi/volumes` and `tank/k8s/iscsi/snapshots` exist.
- `iscsiadm 2.1.11` present on both Talos nodes via nsenter (iscsi-tools extension installed).
- `iscsiadm -m discovery` from both nodes connects to the portal. It returns "No portals found" only because the lone target (`kubernetes-csi`, a manual leftover with **zero extents**) is not announced — expected. democratic-csi creates its own target per volume (`csi-<vol>-tachtit`).

Leftover to ignore: manual target `kubernetes-csi` (id 1) on TrueNAS. Harmless; do not delete in this plan.

**Default StorageClass trap:** `local-path` base kustomization (`infrastructure/controllers/base/local-path/kustomization.yaml`) sets `is-default-class: "true"` and is shared by BOTH clusters. The `data` cluster has no iSCSI and its CNPG clusters rely on the default SC. The default flip must therefore happen **only in the tachtit overlay**.

---

### Task 1: GitOps smoke test — prove provisioning + mount works

**Files:**
- Create: `apps/tachtit/iscsi-smoke/kustomization.yaml`
- Create: `apps/tachtit/iscsi-smoke/test.yaml`
- Modify: `apps/tachtit/kustomization.yaml` (add `- iscsi-smoke` to resources)

- [ ] **Step 1: Write smoke-test manifests**

`apps/tachtit/iscsi-smoke/test.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: iscsi-smoke
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: truenas-iscsi
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: iscsi-smoke
  namespace: default
spec:
  containers:
    - name: test
      image: busybox:1.37
      command: ["sh", "-c", "echo iscsi-ok > /mnt/test && cat /mnt/test && sleep 3600"]
      volumeMounts:
        - name: vol
          mountPath: /mnt
  volumes:
    - name: vol
      persistentVolumeClaim:
        claimName: iscsi-smoke
  restartPolicy: Never
```

`apps/tachtit/iscsi-smoke/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - test.yaml
```

In `apps/tachtit/kustomization.yaml`, add `  - iscsi-smoke` to the resources list.

- [ ] **Step 2: Commit and push**

```bash
git add apps/tachtit/iscsi-smoke apps/tachtit/kustomization.yaml
git commit -m "test(storage): add temporary iSCSI smoke test"
git push
```

- [ ] **Step 3: Reconcile and verify**

```bash
export KUBECONFIG=tachtit-kubeconfig.yaml
flux reconcile kustomization apps --with-source
kubectl get pvc -n default iscsi-smoke -w   # expect: Bound within ~1min
kubectl get pod -n default iscsi-smoke      # expect: Running
kubectl logs -n default iscsi-smoke         # expect: iscsi-ok
```

Also confirm the zvol on TrueNAS (API key read from in-cluster secret):

```bash
KEY=$(kubectl get secret -n storage truenas-iscsi-driver-config -o jsonpath='{.data.driver-config-file\.yaml}' | base64 -d | grep apiKey | awk '{print $2}' | tr -d '"')
curl -s -H "Authorization: Bearer $KEY" "http://192.168.7.14/api/v2.0/pool/dataset?name=tank/k8s/iscsi/volumes" | python3 -m json.tool | grep '"name"'
# expect: a child zvol named after the PV
```

- [ ] **Step 4: If the PVC does not bind or pod does not start, debug before proceeding**

| Symptom | Where to look | Likely cause / fix |
|---|---|---|
| PVC Pending, provision error in events | `kubectl logs -n storage deploy/csi-driver-iscsi-democratic-csi-controller -c csi-driver` | TrueNAS API rejects create — check API key scope, dataset perms (config lives in ExternalSecret `infrastructure/controllers/base/csi-driver-iscsi/secrets.yaml`) |
| PV created, pod stuck ContainerCreating, "iscsiadm: Could not login" | `kubectl logs -n storage csi-driver-iscsi-democratic-csi-node-<x> -c csi-driver` | targetGroup portal/initiator IDs wrong in driver config (must be `1`/`1` — verified correct today) |
| Login OK, mount/fsck failure | same node logs | `fsType: ext4` formatting issue — check `parameters.fsType` in `release.yaml` storageClasses |

Do not continue to Task 2 until the smoke test passes. (systematic-debugging skill applies if it fails.)

### Task 2: Make truenas-iscsi the default StorageClass (tachtit only)

**Files:**
- Modify: `infrastructure/controllers/base/csi-driver-iscsi/release.yaml` (storageClasses entry)
- Modify: `infrastructure/controllers/tachtit/local-path/kustomization.yaml` (un-default local-path, overlay only)

- [ ] **Step 1: Set defaultClass true in the iSCSI HelmRelease**

In `infrastructure/controllers/base/csi-driver-iscsi/release.yaml`:

```yaml
    storageClasses:
      - name: truenas-iscsi
        defaultClass: true        # was: false
```

(iSCSI base is only included by the tachtit overlay, so base edit is safe.)

- [ ] **Step 2: Un-default local-path in the tachtit overlay only**

`infrastructure/controllers/tachtit/local-path/kustomization.yaml` — add a patch (keep existing base reference):

```yaml
patches:
  - patch: |-
      apiVersion: storage.k8s.io/v1
      kind: StorageClass
      metadata:
        name: local-path
        annotations:
          storageclass.kubernetes.io/is-default-class: "false"
```

**Do NOT touch `infrastructure/controllers/base/local-path/kustomization.yaml`** — the data cluster needs local-path to stay default there.

- [ ] **Step 3: Commit, push, reconcile, verify**

```bash
git add infrastructure/controllers/base/csi-driver-iscsi/release.yaml infrastructure/controllers/tachtit/local-path/kustomization.yaml
git commit -m "feat(storage): make truenas-iscsi the default StorageClass on tachtit"
git push
flux reconcile kustomization infra-controllers --with-source
kubectl get sc
# expect: truenas-iscsi (default), local-path no longer default, truenas-nfs unchanged (non-default)
```

Verify the data cluster is untouched:

```bash
KUBECONFIG=data-kubeconfig.yaml kubectl get sc
# expect: local-path still (default)
```

### Task 3: Remove smoke test

- [ ] **Step 1: Delete `apps/tachtit/iscsi-smoke/` and remove `- iscsi-smoke` from `apps/tachtit/kustomization.yaml`**

```bash
git rm -r apps/tachtit/iscsi-smoke
# edit apps/tachtit/kustomization.yaml: remove the iscsi-smoke line
git add apps/tachtit/kustomization.yaml
git commit -m "test(storage): remove iSCSI smoke test"
git push
flux reconcile kustomization apps --with-source
kubectl get pvc -n default iscsi-smoke   # expect: NotFound (pruned); zvol deleted on TrueNAS (reclaimPolicy Delete)
```

---

## Out of scope (noted, not done — Rule 3)
- Pinning the `docker.io/democraticcsi/democratic-csi:next` floating tag and lowering `logLevel: debug` — worth a follow-up once iSCSI is proven stable.
- Deleting the leftover manual `kubernetes-csi` target on TrueNAS.
