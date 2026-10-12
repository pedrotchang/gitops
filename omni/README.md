# Omni cluster templates

Source of truth for the Talos/Kubernetes clusters managed by Sidero Omni
(cluster shape, versions, per-machine extensions and patches). Not read by
Flux; applied with `omnictl`:

```bash
omnictl cluster template diff   -f omni/tachtit.yaml   # preview
omnictl cluster template sync   -f omni/tachtit.yaml   # apply after merge
omnictl cluster template status -f omni/tachtit.yaml   # watch rollout
```

Upgrades: bump `talos.version` one minor at a time (Omni rolls nodes one by
one, waiting for etcd health), then `kubernetes.version` one minor at a time
within the range the new Talos supports. Never edit versions in the Omni UI;
the next `sync` reverts anything that isn't in these files.
