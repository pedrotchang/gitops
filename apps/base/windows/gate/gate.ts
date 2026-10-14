/**
 * gate.ts — on-demand front door for the win11 VM.
 *
 * Sits behind the authentik embedded outpost (windows.seyzahl.com). Opening the
 * page starts the VM; the browser then gets the VM's screen over noVNC, which
 * this process pipes to KubeVirt's VNC subresource on the kube-apiserver.
 * After IDLE_MINUTES without keyboard/mouse input (or with no viewer
 * connected) the VM is stopped, which deletes its virt-launcher pod and frees
 * the Aorus. The OS disk persists, so the next visit boots the same Windows.
 *
 * No auth of its own: the CiliumNetworkPolicy only admits authentik's server
 * pods, and Windows has its own login.
 */

const NAMESPACE = process.env.NAMESPACE ?? "windows";
const VM = process.env.VM_NAME ?? "win11";
const IDLE_MS = Number(process.env.IDLE_MINUTES ?? "30") * 60_000;
const PORT = Number(process.env.PORT ?? "8080");
const NOVNC_DIR = process.env.NOVNC_DIR ?? "/novnc/package";

const API = "https://kubernetes.default.svc";
const TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const VM_PATH = `/apis/kubevirt.io/v1/namespaces/${NAMESPACE}/virtualmachines/${VM}`;
const SUB_PATH = `/apis/subresources.kubevirt.io/v1/namespaces/${NAMESPACE}`;

// RFB client-to-server message types that mean a human is at the keyboard.
const RFB_KEY_EVENT = 4;
const RFB_POINTER_EVENT = 5;

// The token is rotated by the kubelet; re-read it for every request.
async function kube(path: string, init: RequestInit = {}): Promise<Response> {
  const token = (await Bun.file(TOKEN_PATH).text()).trim();
  return fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
}

type VmStatus = { status: string; ready: boolean };

async function vmStatus(): Promise<VmStatus> {
  const res = await kube(VM_PATH);
  if (!res.ok) throw new Error(`get vm HTTP ${res.status}`);
  const vm = (await res.json()) as { status?: { printableStatus?: string; ready?: boolean } };
  return { status: vm.status?.printableStatus ?? "Unknown", ready: vm.status?.ready === true };
}

// start/stop return 409 when the VM is already in that state — not an error.
async function vmAction(action: "start" | "stop"): Promise<void> {
  const res = await kube(`${SUB_PATH}/virtualmachines/${VM}/${action}`, { method: "PUT", body: "{}" });
  if (!res.ok && res.status !== 409) throw new Error(`${action} vm HTTP ${res.status}: ${await res.text()}`);
  console.log(`[vm] ${action} requested`);
}

// ── idle shutdown ────────────────────────────────────────────────────
type Viewer = { upstream?: WebSocket; pending: (string | Buffer)[] };
const viewers = new Set<Bun.ServerWebSocket<Viewer>>();
let lastActive = Date.now();

setInterval(async () => {
  if (Date.now() - lastActive < IDLE_MS) return;
  try {
    const { status } = await vmStatus();
    if (status === "Stopped" || status === "Stopping") return;
    console.log(`[idle] no input for ${IDLE_MS / 60_000}m, stopping ${VM}`);
    for (const ws of viewers) ws.close(4000, "idle");
    await vmAction("stop");
  } catch (err) {
    console.error(`[idle] ${err}`);
  }
}, 60_000);

// ── static files ─────────────────────────────────────────────────────
const INDEX = Bun.file(new URL("./index.html", import.meta.url).pathname);

function staticFile(pathname: string): Response {
  const rel = pathname.slice("/novnc/".length);
  if (rel.split("/").some((p) => p === ".." || p === "")) return new Response("not found", { status: 404 });
  return new Response(Bun.file(`${NOVNC_DIR}/${rel}`));
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// ── server ───────────────────────────────────────────────────────────
Bun.serve<Viewer, undefined>({
  port: PORT,
  async fetch(req, server) {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === "/healthz") return new Response("ok");
      if (pathname === "/") return new Response(INDEX, { headers: { "Content-Type": "text/html" } });
      if (pathname.startsWith("/novnc/")) return staticFile(pathname);
      if (pathname === "/api/status") return json(await vmStatus());
      if (pathname === "/api/start" && req.method === "POST") {
        lastActive = Date.now();
        await vmAction("start");
        return json({ ok: true });
      }
      if (pathname === "/api/stop" && req.method === "POST") {
        for (const ws of viewers) ws.close(4001, "stopped");
        await vmAction("stop");
        return json({ ok: true });
      }
      if (pathname === "/vnc") {
        // Echo noVNC's requested subprotocol back, as browsers require.
        const protocol = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
        const headers = protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined;
        if (server.upgrade(req, { data: { pending: [] }, headers })) return undefined;
        return new Response("expected websocket", { status: 426 });
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error(`[http] ${pathname}: ${err}`);
      return json({ error: String(err) }, 502);
    }
  },
  websocket: {
    async open(ws) {
      viewers.add(ws);
      lastActive = Date.now();
      const token = (await Bun.file(TOKEN_PATH).text()).trim();
      const url = `wss://kubernetes.default.svc${SUB_PATH}/virtualmachineinstances/${VM}/vnc`;
      const upstream = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        protocols: ["plain.kubevirt.io"],
      } as unknown as string[]);
      upstream.binaryType = "arraybuffer";
      upstream.onopen = () => {
        for (const msg of ws.data.pending) upstream.send(msg);
        ws.data.pending = [];
      };
      upstream.onmessage = (ev) => ws.send(new Uint8Array(ev.data as ArrayBuffer));
      upstream.onclose = (ev) => ws.close(1000, `upstream closed (${ev.code})`);
      upstream.onerror = () => console.error("[vnc] upstream error");
      ws.data.upstream = upstream;
      console.log(`[vnc] viewer connected (${viewers.size})`);
    },
    message(ws, msg) {
      if (typeof msg !== "string" && (msg[0] === RFB_KEY_EVENT || msg[0] === RFB_POINTER_EVENT)) {
        lastActive = Date.now();
      }
      const upstream = ws.data.upstream;
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(msg);
      else ws.data.pending.push(msg);
    },
    close(ws) {
      viewers.delete(ws);
      lastActive = Date.now();
      ws.data.upstream?.close();
      console.log(`[vnc] viewer disconnected (${viewers.size})`);
    },
  },
});

console.log(`[gate] ${NAMESPACE}/${VM} on :${PORT}, idle stop after ${IDLE_MS / 60_000}m`);
