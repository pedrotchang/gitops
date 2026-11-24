/**
 * Nightly: turn every Immich duplicate group into a stack.
 *
 * Immich's duplicate detection (CLIP, on upload) groups look-alike photos but
 * only shows them on Utilities -> Duplicates. This job stacks each group
 * behind one cover and clears the group, so the timeline shows one photo per
 * set. Nothing is trashed or deleted: unstacking in the UI undoes it.
 *
 * Cover = Immich's own "keep" suggestion (largest file, then most EXIF),
 * with Immich uploads preferred over external-library copies on a tie.
 *
 * Skipped (left on the Duplicates page for a human): groups with a trashed or
 * offline asset leaving fewer than 2, mixed visibility (archive + timeline),
 * locked/hidden assets, or an asset already in another stack.
 *
 * Env: IMMICH_API_KEYS (comma-separated, one per user), IMMICH_URL,
 * DRY_RUN=1 (log only), MAX_GROUPS (per user per run).
 */

type Asset = {
  id: string;
  libraryId?: string | null;
  isTrashed?: boolean;
  isOffline?: boolean;
  visibility?: string;
  stack?: { id: string } | null;
  exifInfo?: Record<string, unknown> & { fileSizeInByte?: number | null };
};
type Group = { duplicateId: string; assets: Asset[] };

const BASE = (process.env.IMMICH_URL ?? "http://immich-server.immich.svc.cluster.local:2283").replace(/\/$/, "") + "/api";
const KEYS = (process.env.IMMICH_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
const DRY = process.env.DRY_RUN === "1";
const MAX = Number(process.env.MAX_GROUPS ?? "5000");

async function api<T>(key: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method,
    headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const size = (a: Asset) => Number(a.exifInfo?.fileSizeInByte ?? 0);
const exifCount = (a: Asset) => Object.values(a.exifInfo ?? {}).filter(Boolean).length;
const isUpload = (a: Asset) => (a.libraryId ? 0 : 1);

function pickCover(assets: Asset[]): Asset {
  return [...assets].sort(
    (a, b) => size(b) - size(a) || exifCount(b) - exifCount(a) || isUpload(b) - isUpload(a) || a.id.localeCompare(b.id),
  )[0];
}

function skipReason(live: Asset[]): string | null {
  if (live.length < 2) return "fewer than 2 live assets";
  const vis = new Set(live.map((a) => a.visibility ?? "timeline"));
  if ([...vis].some((v) => v !== "timeline" && v !== "archive")) return "locked or hidden asset";
  if (vis.size > 1) return "mixed archive/timeline";
  if (live.some((a) => a.stack)) return "asset already in a stack";
  return null;
}

let failed = 0;
if (KEYS.length === 0) {
  console.error("IMMICH_API_KEYS is empty");
  process.exit(1);
}

for (const key of KEYS) {
  let who = "?";
  try {
    who = (await api<{ name: string }>(key, "GET", "/users/me")).name;
    const groups = await api<Group[]>(key, "GET", "/duplicates");
    const skipped = new Map<string, number>();
    let stacked = 0;
    let assets = 0;
    for (const g of groups) {
      if (stacked >= MAX) break;
      const live = g.assets.filter((a) => !a.isTrashed && !a.isOffline);
      const why = skipReason(live);
      if (why) {
        skipped.set(why, (skipped.get(why) ?? 0) + 1);
        continue;
      }
      const cover = pickCover(live);
      const ids = [cover.id, ...live.filter((a) => a.id !== cover.id).map((a) => a.id)];
      if (!DRY) {
        try {
          await api(key, "POST", "/stacks", { assetIds: ids });
          await api(key, "PUT", "/assets", { ids, duplicateId: null });
        } catch (e) {
          failed++;
          console.error(`[${who}] group ${g.duplicateId}: ${(e as Error).message}`);
          continue;
        }
      }
      stacked++;
      assets += ids.length;
    }
    const skips = [...skipped].map(([k, v]) => `${k}: ${v}`).join(", ") || "none";
    console.log(`[${who}] ${groups.length} groups; ${DRY ? "would stack" : "stacked"} ${stacked} (${assets} assets); skipped ${skips}`);
  } catch (e) {
    failed++;
    console.error(`[${who}] ${(e as Error).message}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
