#!/usr/bin/env bun
/**
 * stage-secrets.ts — idempotent Key Vault staging for the manga stack.
 *
 * Runs on the WORKSTATION (needs `az` logged in). Never overwrites an existing
 * secret; safe to rerun any time. Only the SEED secret is staged here — the
 * runtime-minted credentials (manga-komf-komga-password, manga-komga-api-key)
 * are written to KV by the in-cluster PushSecret after the manga-provisioner
 * Job mints them.
 *
 * Usage: bun scripts/manga/stage-secrets.ts
 */

const VAULT = "seyzahl";

type Plan = { name: string; kind: "alnum24" | "alnum64" };

const GENERATED: Plan[] = [
  { name: "manga-komga-admin-password", kind: "alnum24" },
  { name: "komga-oidc-client-secret", kind: "alnum64" },
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

function randomAlnum(len: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => alphabet[b % alphabet.length]).join("");
}

async function getSecret(name: string): Promise<string | null> {
  const r = await az([
    "keyvault", "secret", "show",
    "--vault-name", VAULT,
    "--name", name,
    "--query", "value",
    "-o", "tsv",
  ]);
  return r.ok ? r.stdout.trim() : null;
}

async function setSecret(name: string, value: string): Promise<void> {
  const r = await az([
    "keyvault", "secret", "set",
    "--vault-name", VAULT,
    "--name", name,
    "--value", value,
    "-o", "none",
  ]);
  if (!r.ok) throw new Error(`az keyvault secret set ${name} failed: ${r.stderr}`);
}

for (const plan of GENERATED) {
  const existing = await getSecret(plan.name);
  if (existing) {
    console.log(`${plan.name}: already staged, leaving as-is`);
    continue;
  }
  await setSecret(plan.name, randomAlnum(plan.kind === "alnum64" ? 64 : 24));
  console.log(`${plan.name}: generated and staged`);
}
console.log("done");
