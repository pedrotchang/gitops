#!/usr/bin/env bun
/**
 * stage-secrets.ts — idempotent Key Vault staging for the media stack.
 *
 * Runs on the WORKSTATION (needs `az` logged in). Never overwrites an existing
 * secret except media-outpost-token, which must track authentik's generated
 * outpost token. Safe to rerun any time; rerun after the authentik blueprint
 * has created the "media" outpost to stage its token.
 *
 * Usage: bun scripts/media/stage-secrets.ts
 */

const VAULT = "seyzahl";
const AUTHENTIK_HOST = "https://auth.seyzahl.com";

type Plan = { name: string; kind: "hex32" | "alnum24" | "alnum64" };

const GENERATED: Plan[] = [
  { name: "media-sonarr-api-key", kind: "hex32" },
  { name: "media-radarr-api-key", kind: "hex32" },
  { name: "media-prowlarr-api-key", kind: "hex32" },
  { name: "media-bazarr-api-key", kind: "hex32" },
  { name: "media-jellyfin-api-key", kind: "hex32" },
  { name: "media-jellyseerr-api-key", kind: "hex32" },
  { name: "media-qbittorrent-password", kind: "alnum24" },
  { name: "media-jellyfin-admin-password", kind: "alnum24" },
  { name: "jellyfin-oidc-client-secret", kind: "alnum64" },
];

async function az(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["az", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout, stderr };
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomAlnum(len: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => alphabet[b % alphabet.length]).join("");
}

function generate(kind: Plan["kind"]): string {
  if (kind === "hex32") return randomHex(16);
  if (kind === "alnum24") return randomAlnum(24);
  return randomAlnum(64);
}

async function getSecret(name: string): Promise<string | null> {
  const r = await az(["keyvault", "secret", "show", "--vault-name", VAULT, "--name", name, "--query", "value", "-o", "tsv"]);
  return r.ok ? r.stdout.trim() : null;
}

async function setSecret(name: string, value: string): Promise<boolean> {
  const r = await az(["keyvault", "secret", "set", "--vault-name", VAULT, "--name", name, "--value", value, "-o", "none"]);
  if (!r.ok) console.error(`  az error: ${r.stderr.trim()}`);
  return r.ok;
}

async function main() {
  const summary: string[] = [];
  let failures = 0;

  console.log(`[kv] listing existing secrets in vault "${VAULT}"...`);
  const list = await az(["keyvault", "secret", "list", "--vault-name", VAULT, "--query", "[].name", "-o", "json"]);
  if (!list.ok) {
    console.error(`[kv] cannot list vault: ${list.stderr.trim()}`);
    process.exit(1);
  }
  const existing = new Set<string>(JSON.parse(list.stdout));

  for (const plan of GENERATED) {
    if (existing.has(plan.name)) {
      summary.push(`${plan.name}: exists, skipping`);
      console.log(`[kv] ${plan.name}: exists, skipping`);
      continue;
    }
    const value = generate(plan.kind);
    if (await setSecret(plan.name, value)) {
      summary.push(`${plan.name}: CREATED`);
      console.log(`[kv] ${plan.name}: created`);
    } else {
      summary.push(`${plan.name}: FAILED`);
      failures++;
    }
  }

  // ── media-outpost-token: fetched from authentik (blueprint creates the outpost) ──
  console.log(`[authentik] fetching outpost token for outpost "media"...`);
  const apiKey = await getSecret("authentik-api-key");
  if (!apiKey) {
    console.warn(`[authentik] authentik-api-key not readable from KV — cannot stage outpost token`);
    summary.push(`media-outpost-token: SKIPPED (no authentik-api-key)`);
  } else {
    try {
      const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
      const res = await fetch(`${AUTHENTIK_HOST}/api/v3/outposts/instances/?name__iexact=media`, { headers });
      if (!res.ok) throw new Error(`outpost list HTTP ${res.status}`);
      const body = (await res.json()) as { results: Array<{ pk: string; name: string; token_identifier: string }> };
      const outpost = body.results.find((o) => o.name === "media");
      if (!outpost) {
        console.warn(
          `[authentik] outpost "media" not found — the blueprint has not been applied yet. ` +
            `Merge the PR, let the authentik worker apply blueprint-media, then rerun this script.`,
        );
        summary.push(`media-outpost-token: PENDING (outpost not created yet — rerun after blueprint applies)`);
      } else {
        const keyRes = await fetch(`${AUTHENTIK_HOST}/api/v3/core/tokens/${outpost.token_identifier}/view_key/`, { headers });
        if (!keyRes.ok) throw new Error(`view_key HTTP ${keyRes.status}`);
        const { key } = (await keyRes.json()) as { key: string };
        const current = existing.has("media-outpost-token") ? await getSecret("media-outpost-token") : null;
        if (current === key) {
          summary.push(`media-outpost-token: in sync, skipping`);
          console.log(`[authentik] media-outpost-token: already in sync`);
        } else if (await setSecret("media-outpost-token", key)) {
          summary.push(`media-outpost-token: ${current ? "UPDATED (drifted)" : "CREATED"}`);
          console.log(`[authentik] media-outpost-token: ${current ? "updated" : "created"}`);
        } else {
          summary.push(`media-outpost-token: FAILED`);
          failures++;
        }
      }
    } catch (err) {
      console.warn(`[authentik] outpost token staging failed: ${err} — rerun later; not fatal`);
      summary.push(`media-outpost-token: ERROR (${err})`);
    }
  }

  console.log(`\n── summary ${"─".repeat(50)}`);
  for (const line of summary) console.log(`  ${line}`);
  process.exit(failures > 0 ? 1 : 0);
}

await main();
