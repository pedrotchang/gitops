# Media Stack Runbook

The `media` namespace on **tachtit** runs the full acquisition + playback stack,
rebuilt 2026-07 (branch `feat/media-stack-rebuild`) as an improvement over the
pre-teardown design (removed in `b69f5ca`).

## Layout

One namespace, each app its own Deployment + Service + config PVC:

| App | Image (pinned, Renovate-managed) | Port | Exposure |
|-----|----------------------------------|------|----------|
| Jellyfin | `jellyfin/jellyfin:10.11.11` | 8096 | `jellyfin.seyzahl.com` — direct route, **native OIDC** (SSO plugin) |
| Sonarr | `lscr.io/linuxserver/sonarr:4.x` | 8989 | `sonarr.seyzahl.com` — via authentik outpost |
| Radarr | `lscr.io/linuxserver/radarr:6.x` | 7878 | `radarr.seyzahl.com` — via outpost |
| Prowlarr | `lscr.io/linuxserver/prowlarr:2.x` | 9696 | `prowlarr.seyzahl.com` — via outpost |
| Bazarr | `lscr.io/linuxserver/bazarr:1.x` | 6767 | `bazarr.seyzahl.com` — via outpost |
| Jellyseerr (**Seerr v3** — Jellyseerr's successor) | `ghcr.io/seerr-team/seerr:v3.3.0` | 5055 | `jellyseerr.seyzahl.com` — via outpost |
| qBittorrent + gluetun | `lscr.io/linuxserver/qbittorrent:5.x` + `qmcgaw/gluetun:v3.41.1` | 8080 | `qbittorrent.seyzahl.com` — via outpost |

The **only multi-container pod** is qBittorrent+gluetun (shared netns).
Manifests: `apps/base/media/` + overlay `apps/tachtit/media/`.

## VPN isolation model (safety-critical — fail closed)

qBittorrent has **no internet route of its own**; all egress rides gluetun →
**NordVPN (WireGuard)**. Four independent layers:

1. **gluetun kill switch** (`FIREWALL=on` default) — VPN drop blocks egress in-pod.
2. **tun0 binding** — `qbittorrent-init` ConfigMap pins `Session\Interface=tun0`;
   sockets die if the tunnel interface vanishes. It refuses to start unbound.
3. **CiliumNetworkPolicy `media-vpn-pod`** — node-level, outside the pod's trust
   boundary: only UDP 51820 (WireGuard) + cluster DNS may leave the pod. Gluetun
   needs no pre-tunnel HTTPS (serverlist is embedded; updater runs in-tunnel).
4. **`vpn-leak-canary` CronJob** (every 15 min) — the feedback loop the old
   design lacked: asserts tunnel IP ≠ WAN IP and qBittorrent still bound to
   tun0. Failures fail the Job → `KubeJobFailed` alert. Confinement failures
   are loud now, not silent.

gluetun runs as a **native sidecar** (initContainer, `restartPolicy: Always`)
so tun0 exists before qBittorrent starts. Deliberately absent vs the old
design: `DNS_KEEP_NAMESERVER=on` (DNS leak), pinned `SERVER_HOSTNAMES`
(rot → outage), `FIREWALL_OUTBOUND_SUBNETS` (unneeded once Prowlarr left the pod).

### Leak test (run after any gluetun/netpol change)

```bash
kubie ctx tachtit
# 1. Tunnel IP must be a NordVPN IP, different from the WAN IP:
kubectl -n media exec deploy/qbittorrent -c qbittorrent -- curl -s https://api.ipify.org
# 2. Kill test — with gluetun down, egress must time out entirely:
kubectl -n media exec deploy/qbittorrent -c gluetun -- sh -c 'kill 1' ; sleep 2
kubectl -n media exec deploy/qbittorrent -c qbittorrent -- timeout 10 curl -s https://api.ipify.org && echo LEAK || echo "fail-closed OK"
# 3. Or just trigger the canary:
kubectl -n media create job --from=cronjob/vpn-leak-canary leak-test-manual
```

## Exposure model — Headscale only

- Gateway API `HTTPRoute`s on the `cilium-gateway` (default ns), all annotated
  `external-dns.alpha.kubernetes.io/exclude: "true"` → **no public DNS records**.
- Hostnames resolve **only** via headscale split-DNS `extra_records`
  (`apps/base/headscale/headscale.yaml`) → gateway IP `10.104.130.214`.
- **No LoadBalancer Services, no cloudflared, no `*-local` auth-bypass routes.**
- Verify: `dig @8.8.8.8 sonarr.seyzahl.com` → NXDOMAIN; over the mesh it resolves.

## Auth model — Authentik on every UI

Declared in `apps/base/authentik/blueprint-media.yaml` (GitOps-managed
blueprint; admin-UI drift is overwritten):

- ***arr apps, qBittorrent, Jellyseerr***: proxy providers → one shared outpost
  (`authentik-outpost-media` Deployment, media ns). HTTPRoutes send all traffic
  to the outpost; it authenticates then proxies upstream. The *arr apps run
  `AUTH__METHOD=External` + `AUTH__REQUIRED=DisabledForLocalAddresses`.
- **Jellyfin**: native OIDC via the `jellyfin-plugin-sso` plugin (client id
  `jellyfin-media-sso`) — forward-auth would break native clients (TV/mobile).
- **Seerr**: behind the outpost; users sign in with their Jellyfin account
  inside. Its native OIDC is preview-only as of v3.3.0 — move to native OIDC
  when it reaches stable.
- In-cluster API traffic (Prowlarr↔Sonarr↔qBittorrent, canary, provisioner)
  uses ClusterIP services + API keys and never crosses the outpost.

## Secrets flow

```
Azure Key Vault "seyzahl"  ──ESO (ClusterSecretStore azure-kv-store)──▶  K8s Secrets  ──env──▶  apps
        ▲
        └── scripts/media/stage-secrets.ts  (workstation, az CLI — idempotent)
```

- Reused entries: `gluetun-wireguard-private-key`, `wireguard-address`,
  `authentik-api-key`, `truenas-api-key`.
- Created by stage-secrets: `media-{sonarr,radarr,prowlarr,bazarr,jellyfin,jellyseerr}-api-key`,
  `media-qbittorrent-password`, `media-jellyfin-admin-password`,
  `jellyfin-oidc-client-secret`, `media-outpost-token` (fetched from authentik
  after the blueprint creates the outpost).
- *arr API keys are **injected as env** (`SONARR__AUTH__APIKEY` etc.) so the
  running apps always match Key Vault. Bazarr gets the same via its init script.
- **No plaintext secrets in git.** Ever.

## Provisioning (zero-click rebuild)

`media-provisioner` Job (`apps/base/media/provisioner/`) runs `provision.ts`
(bun) against every app API, idempotently: Prowlarr indexers (**YTS, Knaben,
Tokyo Toshokan** — never Nyaa.si, it blocks automation) + full-sync to
Sonarr/Radarr; download clients; root folders; TRaSH anime custom formats;
Bazarr languages/providers; qBittorrent categories; Jellyfin wizard + libraries
+ API key; **Seerr full first-run** (owner + Jellyfin link + library sync +
Sonarr/Radarr servers). Every step GETs current state first and only writes on
drift, so reruns are safe.

**Two things are deliberately NOT automated** (see *Known click-ops* below):
the Jellyfin SSO plugin (needs a restart mid-setup) and the Cloudflare-gated
indexers Anime Tosho / 1337x (answer Forbidden from a datacenter IP). Both are
attempted best-effort and logged as warnings, never hard failures.

Rerun: `kubectl -n media delete job media-provisioner && flux reconcile kustomization apps -n flux-system`
(or edit `provision.ts` — the configMap hash change makes Flux replace the Job).

Bootstrap order for a from-scratch rebuild:
1. `bun scripts/media/stage-secrets.ts` (workstation) — creates KV entries.
2. Merge PR → `flux reconcile kustomization git flux-system`.
3. Authentik worker applies the blueprint → outpost "media" exists.
4. Rerun stage-secrets — it can now fetch `media-outpost-token` into KV.
5. ESO syncs; outpost pod goes Ready; provisioner Job completes the wiring.

## Media rules (encoded in provision.ts, not clicks)

- **English subtitles on ALL media**: Bazarr language profile "English" set as
  default for every series and movie, upgrades enabled, backfills existing
  library items via its wanted-search cycle.
- **No dubs for anime / K-drama — original audio + English subs**:
  - Custom format **"Dubs Only"** (TRaSH) scored **-10000** in every Sonarr and
    Radarr quality profile — dubbed releases are never grabbed.
  - **"Anime Raws"** -10000 (raw releases have no subs).
  - Original-audio sub groups preferred: **Erai-raws** (Web Tier 04, +500),
    **SubsPlease** (Web Tier 05, +400).
  - Anime indexer: **Tokyo Toshokan** via Prowlarr (automation-friendly). Anime
    Tosho mirrors Nyaa but is Cloudflare-gated — add it via the UI if wanted.
- Anime series should be added with series type **Anime** (Seerr sets this for
  anime automatically; check when adding manually in Sonarr).

## Adding a new title (user flow)

1. Open `jellyseerr.seyzahl.com` (over Headscale), authentik login → Jellyfin
   account sign-in, search, request.
2. Seerr → Sonarr/Radarr → Prowlarr (Tokyo Toshokan et al) → qBittorrent
   (`/data/downloads/{tv,movies}`, via NordVPN).
3. Import **hardlinks** into `/data/tv` or `/data/movies` (single NFS dataset
   `tank/media` — no byte copies, seeding continues).
4. Bazarr fetches English subs; Jellyfin picks the title up on library scan.

## Storage

One shared NFS PV (`192.168.7.14:/mnt/tank/media`, dataset `tank/media`)
mounted at `/data` in qBittorrent/Sonarr/Radarr/Bazarr (read-only in Jellyfin).
**Do not split downloads and library into separate PVs** — hardlinks fail
across mounts (EXDEV) and every import becomes a full copy. Config PVCs are
`local-path` (node-local): app config is **not** on TrueNAS; the recovery
story is git + Key Vault + the provisioner, not storage restores.

## Known click-ops (documented, unavoidable)

- **NordVPN**: the WireGuard private key came from NordVPN's manual-setup page
  (an access *token* is not a WG key). Rotate → update KV `gluetun-wireguard-private-key`.
- **Bazarr providers**: OpenSubtitles.com/SubDL accounts + credentials must be
  entered in Bazarr (Settings → Providers) or staged into KV and added to
  provision.ts — provider registration itself is a human step.
- **Jellyfin SSO plugin (authentik OIDC)** — the one genuinely un-scriptable
  step, because it needs a Jellyfin **restart** between install and config, and
  a single idempotent Job can't restart its own dependency mid-run. One-time:
  1. Dashboard → Plugins → Catalog → add repo
     `https://raw.githubusercontent.com/9p4/jellyfin-plugin-sso/manifest-release/manifest.json`,
     install **SSO Authentication**.
  2. **Restart Jellyfin** (`kubectl -n media rollout restart deploy/jellyfin`).
  3. Dashboard → Plugins → SSO-Auth → add an OIDC provider named `authentik`:
     - OID Endpoint: `https://auth.seyzahl.com/application/o/jellyfin/`
     - Client ID: `jellyfin-media-sso`
     - Client Secret: KV `media-jellyfin-oidc-client-secret` (env
       `JELLYFIN_OIDC_CLIENT_SECRET`, already in the pod's Secret)
     - Enabled ✔, Enable Authorization ✔, Enable All Folders ✔,
       Role Claim `groups`, Enabled for Admins ✔.

  Equivalent API call once the plugin is loaded (POST to
  `/Plugins/{ssoPluginId}/Configuration` with `X-Emby-Token`):
  ```jsonc
  { "OidConfigs": { "authentik": {
      "OidEndpoint": "https://auth.seyzahl.com/application/o/jellyfin/",
      "OidClientId": "jellyfin-media-sso",
      "OidSecret": "<JELLYFIN_OIDC_CLIENT_SECRET>",
      "Enabled": true, "EnableAuthorization": true, "EnableAllFolders": true,
      "RoleClaim": "groups", "EnabledForAdmins": true } } }
  ```
- **Cloudflare-gated indexers (Anime Tosho, 1337x)**: Prowlarr's API add/test
  fails from a datacenter IP (Cloudflare challenge). If wanted, add them via the
  Prowlarr UI (Indexers → Add) from a browser over Headscale — the provisioner
  logs a warning and moves on.
- **Seerr API key**: generated at init; if it differs from KV
  `media-jellyseerr-api-key`, copy it into KV (provisioner logs it). The rest of
  Seerr's first-run **is** automated (owner, Jellyfin link, library sync,
  Sonarr/Radarr) — `serverType: 2` numeric + a bare hostname are the two
  non-obvious API requirements, both handled in `provisionSeerr()`.
- **Authentik group bindings**: all authenticated users can currently reach all
  media apps; bind groups per application in authentik if family members should
  only see Jellyfin/Jellyseerr.
