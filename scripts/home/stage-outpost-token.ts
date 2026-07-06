#!/usr/bin/env bun
/**
 * stage-outpost-token.ts — stage the "home" Authentik proxy outpost token into
 * Key Vault (KV: home-outpost-token) → ESO → authentik-outpost-home Deployment.
 *
 * Runs on the WORKSTATION (needs `az` logged in). Idempotent: only writes when
 * the KV value drifts from authentik's current token. Run AFTER blueprint-frigate
 * has been applied by the authentik worker (the "home" outpost must exist first).
 *
 * Mirrors the outpost-token half of scripts/media/stage-secrets.ts.
 *
 * Usage: bun scripts/home/stage-outpost-token.ts
 */

const VAULT = "seyzahl";
const AUTHENTIK_HOST = "https://auth.seyzahl.com";
const OUTPOST = "home";

async function az(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["az", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { ok: (await proc.exited) === 0, stdout, stderr };
}

async function getSecret(name: string): Promise<string | null> {
  const r = await az(["keyvault", "secret", "show", "--vault-name", VAULT, "--name", name, "--query", "value", "-o", "tsv"]);
  return r.ok ? r.stdout.trim() : null;
}

async function main() {
  const apiKey = await getSecret("authentik-api-key");
  if (!apiKey) {
    console.error("[authentik] authentik-api-key not readable from KV — aborting");
    process.exit(1);
  }
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

  const res = await fetch(`${AUTHENTIK_HOST}/api/v3/outposts/instances/?name__iexact=${OUTPOST}`, { headers });
  if (!res.ok) throw new Error(`outpost list HTTP ${res.status}`);
  const body = (await res.json()) as { results: Array<{ name: string; token_identifier: string }> };
  const outpost = body.results.find((o) => o.name === OUTPOST);
  if (!outpost) {
    console.warn(`[authentik] outpost "${OUTPOST}" not found — apply blueprint-frigate first, then rerun.`);
    process.exit(1);
  }

  const keyRes = await fetch(`${AUTHENTIK_HOST}/api/v3/core/tokens/${outpost.token_identifier}/view_key/`, { headers });
  if (!keyRes.ok) throw new Error(`view_key HTTP ${keyRes.status}`);
  const { key } = (await keyRes.json()) as { key: string };

  const current = await getSecret("home-outpost-token");
  if (current === key) {
    console.log("[authentik] home-outpost-token: already in sync");
    return;
  }
  const set = await az(["keyvault", "secret", "set", "--vault-name", VAULT, "--name", "home-outpost-token", "--value", key, "-o", "none"]);
  if (!set.ok) {
    console.error(`[kv] set failed: ${set.stderr.trim()}`);
    process.exit(1);
  }
  console.log(`[authentik] home-outpost-token: ${current ? "updated (drifted)" : "created"}`);
}

await main();
