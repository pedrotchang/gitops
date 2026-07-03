# Headscale VPN Runbook

All `*.seyzahl.com` services resolve (headscale split-DNS `extra_records`) to
the cluster gateway ClusterIP `10.104.130.214` and are reachable **only**
through the Headscale tunnel via `tachtit-subnet-router`, which advertises
`10.96.0.0/12, 10.244.0.0/16, 192.168.4.0/24, 192.168.7.14/32`.

**Symptom "everything is down" almost always means this one path**, not the
apps. Layout (headscale ns): `headscale-0` (server — the `headscale` CLI lives
here, NOT in headplane), `headplane` (web UI), `tailscale-subnet-router`,
`headscale-gateway-istio`, and `vpn-canary` (watchdog, see below).

## Known failure mode: subnet-router forwarding wedge (2026-07-03)

The router pod's forwarding state can wedge with everything else healthy:
tunnel up ("active; direct", but client **tx >> rx**), routes Approved+Serving,
router's own egress fine, client route table fine — yet tunneled traffic
blackholes. Its iptables rules can *look* correct. **Fix: bounce the pod.**

```bash
kubectl -n headscale rollout restart deploy/tailscale-subnet-router
```

## Self-healing: vpn-canary

`vpn-canary` (Deployment, headscale ns) joins the tailnet as a real userspace
client (ephemeral node, user `vpn-canary`, key KV `headscale-canary-authkey`)
and every 60s dials `10.104.130.214:443` **through the subnet route** — the
exact client path. On 3 consecutive failures it logs evidence
(`tailscale status` + `netcheck`) and deletes the router pod via scoped RBAC,
then cools down 180s. Expected outage window with the canary: **~2–4 min**.

- Watch it: `kubectl -n headscale logs deploy/vpn-canary -f`
- A `RECOVERED after N failed probes` line without a self-heal in between
  means a transient blip; a `SELF-HEAL` line means the wedge recurred —
  grab the evidence block above it.
- Key rotation: `headscale preauthkeys create --user 4 --reusable --ephemeral
  --expiration 8760h -o json` (in `headscale-0`) → KV
  `headscale-canary-authkey` → ESO refreshes within 1h.

## Manual triage path (when the canary itself is in doubt)

Each step rules out a layer:

1. Workstation: `tailscale status` — router peer "active"? `tx >> rx` ⇒
   forwarding wedge (see above).
2. In-cluster data path:
   `kubectl -n media exec deploy/sonarr -- curl -sk -o /dev/null -w '%{http_code}' --resolve x.seyzahl.com:443:10.104.130.214 https://x.seyzahl.com/`
   — gateway serving? (any HTTP code = yes)
3. Route approvals:
   `kubectl -n headscale exec headscale-0 -- headscale nodes list-routes`
4. WG path both ways: `tailscale ping 100.64.0.1`
5. Router egress: `kubectl -n headscale exec deploy/tailscale-subnet-router --
   wget -qO- -T 6 --no-check-certificate https://10.104.130.214/` (404 = fine)
6. Client routes: `netstat -rn | grep 10.104` (macOS)
7. All healthy but still broken ⇒ the wedge ⇒ bounce the router.

## Evidence to capture BEFORE bouncing (root cause still unconfirmed)

```bash
kubectl -n headscale exec deploy/tailscale-subnet-router -- sh -c \
  'iptables -vnL ts-forward; iptables -t nat -vnL ts-postrouting; \
   conntrack -L 2>/dev/null | wc -l; tailscale status; tailscale netcheck' \
  > /tmp/router-wedge-$(date +%s).log 2>&1
```

## Notes

- headscale ns has explicit `pod-security.kubernetes.io/enforce: privileged`
  (namespace.yaml) — required by the router (NET_ADMIN, hostPath tun). The
  canary needs no privileges (userspace networking).
- PSA `warn: restricted` noise on router restarts is expected and harmless.
