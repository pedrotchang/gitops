#!/usr/bin/env bun
/**
 * provision.ts — idempotent in-cluster provisioning for the media namespace.
 *
 * Runs as the media-provisioner Job. Reads API keys from env (ESO-synced
 * Secret media-app-secrets — Key Vault is the source of truth) and configures
 * every app via its API so a rebuild comes up fully wired with zero clicks:
 *
 *   qBittorrent  categories/paths (+password), API reachable via subnet whitelist
 *   Sonarr       root folder, download client, TRaSH anime no-dub custom formats
 *   Radarr       root folder, download client, dub-reject custom format
 *   Prowlarr     public indexers (YTS/Knaben/Tokyo Toshokan) + full-sync apps
 *   Bazarr       English-everywhere language profile, Sonarr/Radarr link
 *   Jellyfin     startup wizard, libraries, API key, KnownProxies, SSO plugin
 *                config (plugin binaries are seeded onto the config PVC by the
 *                seed-sso initContainer — carrier image jellyfin-sso-plugin —
 *                so it is loaded from first boot; no install/restart dance)
 *   Seerr        Jellyfin link + library sync + Sonarr/Radarr servers
 *
 * Every step GETs current state first and only creates/updates on drift.
 */

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const URLS = {
  qbit: "http://qbittorrent.media.svc.cluster.local:8080",
  sonarr: "http://sonarr.media.svc.cluster.local:8989",
  radarr: "http://radarr.media.svc.cluster.local:7878",
  prowlarr: "http://prowlarr.media.svc.cluster.local:9696",
  bazarr: "http://bazarr.media.svc.cluster.local:6767",
  jellyfin: "http://jellyfin.media.svc.cluster.local:8096",
  seerr: "http://jellyseerr.media.svc.cluster.local:5055",
};

const hardFailures: string[] = [];
const warnings: string[] = [];

// ── helpers ────────────────────────────────────────────────────────────────

async function req(
  url: string,
  init: RequestInit = {},
  attempts = 3,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      await Bun.sleep(5000);
    }
  }
  throw new Error(`fetch ${url} failed after ${attempts} attempts: ${lastErr}`);
}

async function waitFor(name: string, url: string, headers: Record<string, string> = {}, timeoutMs = 300_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { headers });
      if (r.status < 500) {
        console.log(`[${name}] ready (${r.status} from ${url})`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(5000);
  }
  throw new Error(`[${name}] not ready after ${timeoutMs / 1000}s (${url})`);
}

// Generic Servarr (Sonarr/Radarr/Prowlarr) client
function servarr(base: string, apiVersion: string, apiKey: string) {
  const h = { "X-Api-Key": apiKey, "Content-Type": "application/json" };
  return {
    async get<T>(path: string): Promise<T> {
      const r = await req(`${base}/api/${apiVersion}${path}`, { headers: h });
      if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
      return (await r.json()) as T;
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      const r = await req(`${base}/api/${apiVersion}${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`POST ${path} -> ${r.status}: ${await r.text()}`);
      return (await r.json()) as T;
    },
    async put<T>(path: string, body: unknown): Promise<T> {
      const r = await req(`${base}/api/${apiVersion}${path}`, { method: "PUT", headers: h, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`PUT ${path} -> ${r.status}: ${await r.text()}`);
      return (await r.json()) as T;
    },
  };
}

// TRaSH-guides-derived custom format definitions (release-title/group regexes)
function releaseTitleSpec(name: string, regex: string) {
  return {
    name,
    implementation: "ReleaseTitleSpecification",
    negate: false,
    required: false,
    fields: [{ name: "value", value: regex }],
  };
}
function releaseGroupSpec(name: string, regex: string) {
  return {
    name,
    implementation: "ReleaseGroupSpecification",
    negate: false,
    required: false,
    fields: [{ name: "value", value: regex }],
  };
}

const CF_DUBS_ONLY = {
  name: "Dubs Only",
  includeCustomFormatWhenRenaming: false,
  specifications: [
    releaseTitleSpec("dub-terms", "\\b(dub(bed)?|funi_dub|eng_dub)\\b(?!.*\\b(dual[ ._-]?audio)\\b)"),
    releaseGroupSpec("dub-groups", "(Golumpa|KaiDubs|KamiFS|torenter69|Yameii)"),
  ],
};
const CF_ANIME_RAWS = {
  name: "Anime Raws",
  includeCustomFormatWhenRenaming: false,
  specifications: [
    releaseGroupSpec("raw-groups", "(Beatrice-Raws|Moozzi2|ReinForce|Ohys|neko-raws|SCY|Vodes|LYS1TH3A|OZR|Datte13|Arukoru)"),
  ],
};
const CF_ANIME_TIER_04 = {
  name: "Anime Web Tier 04 (Official Subs)",
  includeCustomFormatWhenRenaming: false,
  specifications: [releaseGroupSpec("tier04-groups", "(Erai-raws|ToonsHub|VARYG)")],
};
const CF_ANIME_TIER_05 = {
  name: "Anime Web Tier 05 (FanSubs)",
  includeCustomFormatWhenRenaming: false,
  specifications: [releaseGroupSpec("tier05-groups", "(SubsPlease|HorribleSubs|SobsPlease|NanDesuKa)")],
};
// French-scene releases: "MULTi" there means French+original audio with
// FRENCH-ONLY subs — no English. Bit us live: Yomi no Tsugai E01–E03 grabbed
// from Tsundere-Raws/KAF had jpn audio but only fra subtitles, violating the
// English-subs-everywhere rule. Not covered by "Dubs Only" (nothing dubbed).
const CF_FRENCH_SCENE = {
  name: "French Scene (no English subs)",
  includeCustomFormatWhenRenaming: false,
  specifications: [
    releaseTitleSpec("french-terms", "\\b(VOSTFR|SUBFRENCH|FRENCH|VFF?|VF2?)\\b"),
    releaseGroupSpec("french-groups", "(Tsundere-Raws|KAF|Wawacity|FW)"),
  ],
};

const CF_SCORES: Record<string, number> = {
  "Dubs Only": -10000,
  "Anime Raws": -10000,
  "French Scene (no English subs)": -10000,
  "Anime Web Tier 04 (Official Subs)": 500,
  "Anime Web Tier 05 (FanSubs)": 400,
};

type CustomFormat = { id: number; name: string };
type QualityProfile = {
  id: number;
  name: string;
  formatItems: Array<{ format: number; name: string; score: number }>;
  minFormatScore: number;
  cutoffFormatScore: number;
  upgradeAllowed: boolean;
  [k: string]: unknown;
};

async function ensureCustomFormats(
  app: "sonarr" | "radarr",
  api: ReturnType<typeof servarr>,
  formats: Array<typeof CF_DUBS_ONLY>,
): Promise<Map<string, number>> {
  const existing = await api.get<CustomFormat[]>("/customformat");
  const ids = new Map(existing.map((cf) => [cf.name, cf.id]));
  for (const cf of formats) {
    if (ids.has(cf.name)) {
      console.log(`[${app}] custom format "${cf.name}": exists, skipping`);
      continue;
    }
    const created = await api.post<CustomFormat>("/customformat", cf);
    ids.set(created.name, created.id);
    console.log(`[${app}] custom format "${cf.name}": created (id ${created.id})`);
  }
  return ids;
}

async function scoreFormatsInAllProfiles(
  app: "sonarr" | "radarr",
  api: ReturnType<typeof servarr>,
  cfIds: Map<string, number>,
) {
  // Map desired scores by CF *id* — matching by name breaks silently if a
  // Sonarr version returns formatItems keyed only by format id. Getting this
  // wrong means dubs are NOT rejected (requirement violation), so key on id.
  const wantById = new Map<number, number>();
  for (const [name, score] of Object.entries(CF_SCORES)) {
    const id = cfIds.get(name);
    if (id !== undefined) wantById.set(id, score);
  }
  const profiles = await api.get<QualityProfile[]>("/qualityprofile");
  for (const profile of profiles) {
    let changed = false;
    for (const item of profile.formatItems) {
      const wanted = wantById.get(item.format);
      if (wanted !== undefined && item.score !== wanted) {
        item.score = wanted;
        changed = true;
      }
    }
    // upgradeAllowed defaults to FALSE upstream, which freezes whatever file
    // landed first — a bad grab (e.g. a French-only-subs release) could never
    // be replaced even at CF -10000, and every better release was rejected
    // with "profile does not allow upgrade" (bit us live on Yomi no Tsugai
    // E01–E03). cutoffFormatScore=500 stops the upgrade chase once an
    // official-subs tier (+500) release is on disk.
    if (profile.upgradeAllowed !== true || profile.cutoffFormatScore !== 500) {
      profile.upgradeAllowed = true;
      profile.cutoffFormatScore = 500;
      changed = true;
    }
    if (changed) {
      await api.put(`/qualityprofile/${profile.id}`, profile);
      console.log(`[${app}] profile "${profile.name}": CF scores + upgrade policy updated`);
    } else {
      console.log(`[${app}] profile "${profile.name}": CF scores + upgrade policy already correct`);
    }
  }
}

async function ensureRootFolder(app: string, api: ReturnType<typeof servarr>, path: string) {
  const folders = await api.get<Array<{ path: string }>>("/rootfolder");
  if (folders.some((f) => f.path === path)) {
    console.log(`[${app}] root folder ${path}: exists, skipping`);
    return;
  }
  await api.post("/rootfolder", { path });
  console.log(`[${app}] root folder ${path}: created`);
}

// categoryField: Servarr apps name it differently — Sonarr "tvCategory",
// Radarr "movieCategory". A generic "category" field is SILENTLY IGNORED by
// both create and update (unknown provider fields don't error), which is how
// the clients ended up on the apps' internal defaults (tv-sonarr / radarr).
async function ensureDownloadClient(app: string, api: ReturnType<typeof servarr>, category: string, categoryField: string) {
  type Client = { id: number; name: string; fields: Array<{ name: string; value?: unknown }> } & Record<string, unknown>;
  const clients = await api.get<Client[]>("/downloadclient");
  const existing = clients.find((c) => c.name === "qBittorrent");
  if (!existing) {
    await api.post("/downloadclient", {
      name: "qBittorrent",
      implementation: "QBittorrent",
      implementationName: "qBittorrent",
      configContract: "QBittorrentSettings",
      protocol: "torrent",
      enable: true,
      priority: 1,
      fields: [
        { name: "host", value: "qbittorrent.media.svc.cluster.local" },
        { name: "port", value: 8080 },
        { name: "useSsl", value: false },
        { name: "username", value: "admin" },
        { name: "password", value: env("QBITTORRENT_PASSWORD") },
        { name: categoryField, value: category },
      ],
    });
    console.log(`[${app}] download client qBittorrent (${categoryField}=${category}): created`);
    return;
  }
  // Exists — assert the category field too. A client left on the app default
  // (tv-sonarr / radarr) bypasses the qBittorrent category save paths
  // (/data/downloads/{tv,movies}) and dumps downloads at /data/downloads root.
  // PUTting the GET body back is safe: Servarr keeps secrets when the value
  // is the '********' mask.
  const catField = existing.fields.find((f) => f.name === categoryField);
  if (!catField) throw new Error(`${app}: field ${categoryField} not in qBittorrent client schema`);
  if (catField.value === category) {
    console.log(`[${app}] download client qBittorrent: ${categoryField}=${category}, skipping`);
    return;
  }
  catField.value = category;
  await api.put(`/downloadclient/${existing.id}`, existing);
  console.log(`[${app}] download client qBittorrent: ${categoryField} asserted -> ${category}`);
}

// ── qBittorrent ────────────────────────────────────────────────────────────
// In-cluster calls skip auth via WebUI\AuthSubnetWhitelist (pod CIDR), seeded
// by the qbittorrent-init script. The UI hostname is still behind authentik.

async function provisionQbittorrent() {
  await waitFor("qbit", `${URLS.qbit}/api/v2/app/version`);
  const prefsRes = await req(`${URLS.qbit}/api/v2/app/preferences`);
  if (!prefsRes.ok) throw new Error(`qbit preferences -> ${prefsRes.status} (subnet whitelist not active?)`);
  const prefs = (await prefsRes.json()) as Record<string, unknown>;

  const desired: Record<string, unknown> = {
    save_path: "/data/downloads",
    temp_path_enabled: false,
    max_ratio_enabled: true,
    max_ratio: 2,
    web_ui_password: env("QBITTORRENT_PASSWORD"), // hash not readable back; harmless to reassert
  };
  const drift = Object.keys(desired).filter((k) => k !== "web_ui_password" && prefs[k] !== desired[k]);
  const form = new URLSearchParams({ json: JSON.stringify(desired) });
  const set = await req(`${URLS.qbit}/api/v2/app/setPreferences`, { method: "POST", body: form });
  if (!set.ok) throw new Error(`qbit setPreferences -> ${set.status}`);
  console.log(`[qbit] preferences asserted (${drift.length ? `drift on: ${drift.join(", ")}` : "no drift"}; password reasserted)`);

  const catRes = await req(`${URLS.qbit}/api/v2/torrents/categories`);
  const cats = (await catRes.json()) as Record<string, { name: string; savePath: string }>;
  for (const [name, savePath] of [
    ["tv", "/data/downloads/tv"],
    ["movies", "/data/downloads/movies"],
  ] as const) {
    if (cats[name]?.savePath === savePath) {
      console.log(`[qbit] category ${name}: exists, skipping`);
      continue;
    }
    const endpoint = cats[name] ? "editCategory" : "createCategory";
    const r = await req(`${URLS.qbit}/api/v2/torrents/${endpoint}`, {
      method: "POST",
      body: new URLSearchParams({ category: name, savePath }),
    });
    if (!r.ok) throw new Error(`qbit ${endpoint} ${name} -> ${r.status}`);
    console.log(`[qbit] category ${name} -> ${savePath}: ${cats[name] ? "updated" : "created"}`);
  }
}

// Import companion subtitle files alongside episodes/movies. OFF by default
// upstream, which strands the .srt files that "ESubs" releases ship next to
// their videos (bit us live with Shrinking S2 — video imported, subs left in
// /data/downloads). With Bazarr limited to credential-free providers, these
// release-shipped subs are the primary subtitle source.
async function ensureExtraFileImport(app: string, api: ReturnType<typeof servarr>) {
  const cfg = await api.get<Record<string, unknown>>("/config/mediamanagement");
  if (cfg.importExtraFiles === true && cfg.extraFileExtensions === "srt,ass") {
    console.log(`[${app}] importExtraFiles srt,ass: already set, skipping`);
    return;
  }
  await api.put(`/config/mediamanagement`, { ...cfg, importExtraFiles: true, extraFileExtensions: "srt,ass" });
  const check = await api.get<Record<string, unknown>>("/config/mediamanagement");
  if (check.importExtraFiles !== true) throw new Error(`${app}: importExtraFiles did not persist`);
  console.log(`[${app}] importExtraFiles srt,ass: asserted`);
}

// ── Sonarr ─────────────────────────────────────────────────────────────────

async function provisionSonarr() {
  const api = servarr(URLS.sonarr, "v3", env("SONARR_API_KEY"));
  await waitFor("sonarr", `${URLS.sonarr}/ping`);
  await ensureRootFolder("sonarr", api, "/data/tv");
  await ensureDownloadClient("sonarr", api, "tv", "tvCategory");
  await ensureExtraFileImport("sonarr", api);
  const cfIds = await ensureCustomFormats("sonarr", api, [CF_DUBS_ONLY, CF_ANIME_RAWS, CF_FRENCH_SCENE, CF_ANIME_TIER_04, CF_ANIME_TIER_05]);

  // Ensure every profile carries the anime CF scores (formatItems are global
  // across profiles in v4 — new CFs appear with score 0 until set).
  await scoreFormatsInAllProfiles("sonarr", api, cfIds);
}

// ── Radarr ─────────────────────────────────────────────────────────────────

async function provisionRadarr() {
  const api = servarr(URLS.radarr, "v3", env("RADARR_API_KEY"));
  await waitFor("radarr", `${URLS.radarr}/ping`);
  await ensureRootFolder("radarr", api, "/data/movies");
  await ensureDownloadClient("radarr", api, "movies", "movieCategory");
  await ensureExtraFileImport("radarr", api);
  const cfIds = await ensureCustomFormats("radarr", api, [CF_DUBS_ONLY, CF_ANIME_RAWS, CF_FRENCH_SCENE]);
  await scoreFormatsInAllProfiles("radarr", api, cfIds);
}

// ── Prowlarr ───────────────────────────────────────────────────────────────

async function provisionProwlarr() {
  const api = servarr(URLS.prowlarr, "v1", env("PROWLARR_API_KEY"));
  await waitFor("prowlarr", `${URLS.prowlarr}/ping`);

  // Public, credential-free indexers. Each is added with a connectivity test;
  // some (Anime Tosho, 1337x) sit behind Cloudflare and answer Forbidden from a
  // datacenter IP — those are tried but non-fatal (add via UI per runbook).
  //   movies: YTS + Knaben (meta-search, wide coverage)
  //   anime:  Tokyo Toshokan (automation-friendly; Nyaa.si is deliberately NOT
  //           used — it blocks automation. Anime Tosho is Cloudflare-gated here.)
  const WANT = ["YTS", "Knaben", "Tokyo Toshokan", "Anime Tosho"];
  const indexers = await api.get<Array<{ name: string }>>("/indexer");
  const have = new Set(indexers.map((i) => i.name));
  const schemas = await api.get<Array<{ name: string; protocol: string; fields: Array<{ name: string; value?: unknown }> }>>(
    "/indexer/schema",
  );
  for (const want of WANT) {
    if ([...have].some((n) => n.toLowerCase() === want.toLowerCase())) {
      console.log(`[prowlarr] indexer ${want}: exists, skipping`);
      continue;
    }
    const schema = schemas.find((s) => s.name.toLowerCase() === want.toLowerCase() && s.protocol === "torrent");
    if (!schema) {
      console.warn(`[prowlarr] indexer ${want}: schema not found, skipping`);
      continue;
    }
    for (const f of schema.fields) {
      if (/apikey/i.test(f.name) && (f.value === undefined || f.value === "")) f.value = "0";
    }
    try {
      await api.post("/indexer?forceSave=true", { ...schema, enable: true, appProfileId: 1, priority: 25 });
      console.log(`[prowlarr] indexer ${want}: created`);
    } catch (e) {
      warnings.push(`prowlarr: ${want} add failed (likely Cloudflare-gated) — add via UI per runbook`);
      console.warn(`[prowlarr] ${want} add failed, continuing: ${String(e).slice(0, 100)}`);
    }
  }

  // Full-sync applications → Sonarr/Radarr (Prowlarr pushes indexers to them)
  const apps = await api.get<Array<{ name: string }>>("/applications");
  const wanted = [
    { impl: "Sonarr", base: URLS.sonarr, key: env("SONARR_API_KEY") },
    { impl: "Radarr", base: URLS.radarr, key: env("RADARR_API_KEY") },
  ];
  for (const w of wanted) {
    if (apps.some((a) => a.name === w.impl)) {
      console.log(`[prowlarr] application ${w.impl}: exists, skipping`);
      continue;
    }
    await api.post("/applications", {
      name: w.impl,
      implementation: w.impl,
      implementationName: w.impl,
      configContract: `${w.impl}Settings`,
      syncLevel: "fullSync",
      fields: [
        { name: "prowlarrUrl", value: URLS.prowlarr },
        { name: "baseUrl", value: w.base },
        { name: "apiKey", value: w.key },
      ],
    });
    console.log(`[prowlarr] application ${w.impl}: created (fullSync)`);
  }
}

// ── Bazarr ─────────────────────────────────────────────────────────────────

async function provisionBazarr() {
  const h = { "X-API-KEY": env("BAZARR_API_KEY") };
  await waitFor("bazarr", `${URLS.bazarr}/api/system/status`, h);

  // Bazarr's settings POST is NOT idempotent: re-submitting an existing language
  // profile returns 500 (only the first create succeeds). So GET first — like
  // every other step — and never resend a profile that already exists.
  type Profile = { items?: Array<{ language: string }> };
  const hasEnglish = async () =>
    ((await (await req(`${URLS.bazarr}/api/system/languages/profiles`, { headers: h })).json()) as Profile[]).some(
      (p) => p.items?.some((i) => i.language === "en"),
    );
  const gen =
    ((await (await req(`${URLS.bazarr}/api/system/settings`, { headers: h })).json()) as { general?: Record<string, unknown> })
      .general ?? {};
  const englishExists = await hasEnglish();
  if (englishExists && gen.serie_default_enabled && gen.movie_default_enabled && gen.use_sonarr && gen.use_radarr) {
    console.log(`[bazarr] English default + Sonarr/Radarr already wired: skipping`);
    return;
  }

  const form = new URLSearchParams();
  if (!englishExists) {
    // English-everywhere profile — created only when missing (resend 500s).
    form.set("languages-enabled", JSON.stringify(["en"]));
    form.set(
      "languages-profiles",
      JSON.stringify([
        {
          profileId: 1,
          name: "English",
          cutoff: null,
          items: [{ id: 1, language: "en", audio_exclude: "False", hi: "False", forced: "False" }],
          mustContain: [],
          mustNotContain: [],
          originalFormat: false,
        },
      ]),
    );
  }
  form.set("settings-general-serie_default_enabled", "true");
  form.set("settings-general-serie_default_profile", "1");
  form.set("settings-general-movie_default_enabled", "true");
  form.set("settings-general-movie_default_profile", "1");
  form.set("settings-general-use_sonarr", "true");
  form.set("settings-sonarr-ip", "sonarr.media.svc.cluster.local");
  form.set("settings-sonarr-port", "8989");
  form.set("settings-sonarr-base_url", "/");
  form.set("settings-sonarr-ssl", "false");
  form.set("settings-sonarr-apikey", env("SONARR_API_KEY"));
  form.set("settings-general-use_radarr", "true");
  form.set("settings-radarr-ip", "radarr.media.svc.cluster.local");
  form.set("settings-radarr-port", "7878");
  form.set("settings-radarr-base_url", "/");
  form.set("settings-radarr-ssl", "false");
  form.set("settings-radarr-apikey", env("RADARR_API_KEY"));
  form.set("settings-general-upgrade_subs", "true");
  // Credential-free provider only; opensubtitles.com / SubDL need accounts and are
  // enabled by a human in the UI (runbook click-ops) — don't clobber that on rerun.
  form.set("settings-general-enabled_providers", JSON.stringify(["embeddedsubtitles"]));

  const r = await req(`${URLS.bazarr}/api/system/settings`, { method: "POST", headers: h, body: form });
  // Bazarr's settings endpoint is finicky; confirm by GET rather than trusting the
  // status, and keep this best-effort — subtitles are off the request→playback path.
  if (await hasEnglish()) {
    console.log(`[bazarr] settings asserted: English profile default everywhere, Sonarr+Radarr linked`);
  } else {
    warnings.push(`bazarr: English profile not confirmed after settings POST (${r.status}) — set it via UI per runbook`);
    console.warn(`[bazarr] settings POST ${r.status}: English profile absent after save`);
  }
}

// ── Jellyfin ───────────────────────────────────────────────────────────────

async function provisionJellyfin() {
  await waitFor("jellyfin", `${URLS.jellyfin}/health`);
  const authHeader =
    'MediaBrowser Client="provisioner", Device="media-provisioner", DeviceId="media-provisioner", Version="1.0"';

  // Startup wizard (fresh install only)
  const pub = await req(`${URLS.jellyfin}/Users/Public`);
  const wizardProbe = await req(`${URLS.jellyfin}/Startup/Configuration`, {
    headers: { "X-Emby-Authorization": authHeader },
  });
  if (wizardProbe.ok) {
    console.log(`[jellyfin] fresh install — completing startup wizard`);
    const jh = { "X-Emby-Authorization": authHeader, "Content-Type": "application/json" };
    await req(`${URLS.jellyfin}/Startup/Configuration`, {
      method: "POST",
      headers: jh,
      body: JSON.stringify({ UICulture: "en-US", MetadataCountryCode: "US", PreferredMetadataLanguage: "en" }),
    });
    await req(`${URLS.jellyfin}/Startup/User`, { headers: jh }); // must GET before POST (jellyfin quirk)
    await req(`${URLS.jellyfin}/Startup/User`, {
      method: "POST",
      headers: jh,
      body: JSON.stringify({ Name: "admin", Password: env("JELLYFIN_ADMIN_PASSWORD") }),
    });
    await req(`${URLS.jellyfin}/Startup/Complete`, { method: "POST", headers: jh });
    console.log(`[jellyfin] wizard complete (admin user created)`);
  } else {
    console.log(`[jellyfin] already initialized (wizard locked, ${pub.status} from /Users/Public)`);
  }

  // Authenticate as admin
  const login = await req(`${URLS.jellyfin}/Users/AuthenticateByName`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Emby-Authorization": authHeader },
    body: JSON.stringify({ Username: "admin", Pw: env("JELLYFIN_ADMIN_PASSWORD") }),
  });
  if (!login.ok) throw new Error(`jellyfin admin login -> ${login.status}`);
  const { AccessToken } = (await login.json()) as { AccessToken: string };
  const jh = { "X-Emby-Token": AccessToken, "Content-Type": "application/json" };

  // Libraries
  const libs = (await (await req(`${URLS.jellyfin}/Library/VirtualFolders`, { headers: jh })).json()) as Array<{ Name: string }>;
  for (const [name, type, path] of [
    ["TV", "tvshows", "/data/tv"],
    ["Movies", "movies", "/data/movies"],
  ] as const) {
    if (libs.some((l) => l.Name === name)) {
      console.log(`[jellyfin] library ${name}: exists, skipping`);
      continue;
    }
    const r = await req(
      `${URLS.jellyfin}/Library/VirtualFolders?name=${name}&collectionType=${type}&paths=${encodeURIComponent(path)}&refreshLibrary=true`,
      { method: "POST", headers: jh },
    );
    if (!r.ok) throw new Error(`jellyfin library ${name} -> ${r.status}`);
    console.log(`[jellyfin] library ${name} -> ${path}: created`);
  }

  // API key for Seerr / external automation
  const keys = (await (await req(`${URLS.jellyfin}/Auth/Keys`, { headers: jh })).json()) as { Items: Array<{ AppName: string; AccessToken: string }> };
  let provKey = keys.Items.find((k) => k.AppName === "provisioner")?.AccessToken;
  if (!provKey) {
    await req(`${URLS.jellyfin}/Auth/Keys?App=provisioner`, { method: "POST", headers: jh });
    const again = (await (await req(`${URLS.jellyfin}/Auth/Keys`, { headers: jh })).json()) as typeof keys;
    provKey = again.Items.find((k) => k.AppName === "provisioner")?.AccessToken;
    console.log(`[jellyfin] API key "provisioner": created`);
  }
  if (provKey && provKey !== process.env.JELLYFIN_API_KEY) {
    warnings.push(
      `jellyfin: server-generated API key differs from KV media-jellyfin-api-key — read it from the Jellyfin dashboard (API Keys) and stage into KV; value withheld from logs`,
    );
    console.warn(`[jellyfin] ACTION: stage the generated key into KV media-jellyfin-api-key (value redacted from logs; see warnings summary once, then rotate)`);
  }

  // Reverse-proxy trust — the gateway terminates TLS and forwards plain http
  // with X-Forwarded-Proto; with an empty KnownProxies Jellyfin ignores those
  // headers and builds http:// URLs, so the SSO plugin's redirect_uri fails
  // authentik's strict https match. CIDRs cover the Envoy/gateway hops (pod
  // CIDR + node LAN). Applies on next restart — the manual SSO plugin step
  // (runbook) includes one, so a fresh rebuild converges without extra action.
  const KNOWN_PROXIES = ["10.244.0.0/16", "192.168.7.0/24"];
  const netCfg = (await (await req(`${URLS.jellyfin}/System/Configuration/network`, { headers: jh })).json()) as Record<
    string,
    unknown
  > & { KnownProxies?: string[] };
  const currentProxies = netCfg.KnownProxies ?? [];
  if (KNOWN_PROXIES.some((p) => !currentProxies.includes(p))) {
    const r = await req(`${URLS.jellyfin}/System/Configuration/network`, {
      method: "POST",
      headers: jh,
      body: JSON.stringify({ ...netCfg, KnownProxies: [...new Set([...currentProxies, ...KNOWN_PROXIES])] }),
    });
    if (!r.ok) throw new Error(`jellyfin network config -> ${r.status}`);
    warnings.push("jellyfin: KnownProxies updated — takes effect on the next Jellyfin restart (the SSO runbook step includes one)");
    console.log(`[jellyfin] KnownProxies asserted: ${KNOWN_PROXIES.join(", ")} (restart required to apply)`);
  } else {
    console.log(`[jellyfin] KnownProxies already cover gateway CIDRs: skipping`);
  }

  // SSO plugin config (authentik OIDC). The plugin binaries are seeded onto
  // the config PVC by the seed-sso initContainer, so the plugin is loaded from
  // first boot and config can be asserted here — no install/restart dance.
  // Config POSTs to an Active plugin apply immediately (verified live).
  const plugins = (await (await req(`${URLS.jellyfin}/Plugins`, { headers: jh })).json()) as Array<{
    Name: string;
    Id: string;
    Status: string;
  }>;
  const sso = plugins.find((p) => /sso/i.test(p.Name));
  if (!sso || sso.Status !== "Active") {
    warnings.push(
      `jellyfin: SSO plugin ${sso ? `status=${sso.Status}` : "not loaded"} — check the seed-sso initContainer (runbook: Jellyfin SSO)`,
    );
    console.warn(`[jellyfin] SSO plugin ${sso ? sso.Status : "absent"}; skipping OIDC config`);
    return;
  }
  const desiredOid: Record<string, unknown> = {
    OidEndpoint: "https://auth.seyzahl.com/application/o/jellyfin/",
    OidClientId: "jellyfin-media-sso",
    OidSecret: env("JELLYFIN_OIDC_CLIENT_SECRET"),
    Enabled: true,
    EnableAuthorization: true,
    EnableAllFolders: true,
    RoleClaim: "groups",
    // NB: no "EnabledForAdmins" — that key is not in the plugin's config
    // schema (never stored, so comparing it re-POSTs on every run).
    OidScopes: ["openid", "profile", "email"],
  };
  const ssoCfg = (await (await req(`${URLS.jellyfin}/Plugins/${sso.Id}/Configuration`, { headers: jh })).json()) as {
    OidConfigs?: Record<string, Record<string, unknown>>;
  };
  const currentOid = ssoCfg.OidConfigs?.authentik ?? {};
  const oidDrift = Object.entries(desiredOid).some(([k, v]) => JSON.stringify(currentOid[k]) !== JSON.stringify(v));
  if (!oidDrift) {
    console.log(`[jellyfin] SSO plugin OIDC config: already correct, skipping`);
  } else {
    // Merge over the full config object so non-OIDC plugin settings survive.
    const r = await req(`${URLS.jellyfin}/Plugins/${sso.Id}/Configuration`, {
      method: "POST",
      headers: jh,
      body: JSON.stringify({
        ...ssoCfg,
        OidConfigs: { ...(ssoCfg.OidConfigs ?? {}), authentik: { ...currentOid, ...desiredOid } },
      }),
    });
    if (!r.ok) throw new Error(`jellyfin SSO plugin config -> ${r.status}`);
    console.log(`[jellyfin] SSO plugin configured against authentik (client jellyfin-media-sso)`);
  }

  // Login-page SSO button — the plugin does NOT add one; without it SSO only
  // works by typing /sso/OID/start/authentik by hand. The documented pattern
  // (9p4 README) is a form in the branding LoginDisclaimer.
  const desiredBranding = {
    LoginDisclaimer:
      '<form action="/sso/OID/start/authentik"><button class="raised block emby-button button-submit">Sign in with Seyzahl SSO</button></form>',
    CustomCss:
      ".disclaimerContainer { display: block; } .loginDisclaimer { width: 100%; } .loginDisclaimer form { width: 100%; }",
    SplashscreenEnabled: false,
  };
  const branding = (await (await req(`${URLS.jellyfin}/System/Configuration/branding`, { headers: jh })).json()) as Record<
    string,
    unknown
  >;
  const brandingDrift = Object.entries(desiredBranding).some(([k, v]) => branding[k] !== v);
  if (!brandingDrift) {
    console.log(`[jellyfin] SSO login button (branding): already set, skipping`);
  } else {
    const r = await req(`${URLS.jellyfin}/System/Configuration/branding`, {
      method: "POST",
      headers: jh,
      body: JSON.stringify({ ...branding, ...desiredBranding }),
    });
    if (!r.ok) throw new Error(`jellyfin branding -> ${r.status}`);
    console.log(`[jellyfin] SSO login button (branding): asserted`);
  }
}

// ── Seerr (Jellyseerr successor) ───────────────────────────────────────────

async function provisionSeerr() {
  // Seerr v3 (just forked from Jellyseerr) has an in-flux auth API; its OIDC is
  // preview-only. The whole first-run link can need the UI once. Keep this step
  // best-effort so it never fails the Job — the runbook covers manual setup.
  try {
    await provisionSeerrInner();
  } catch (e) {
    warnings.push(`seerr: automated wiring incomplete (${String(e).slice(0, 140)}) — complete first-run link via UI per runbook`);
    console.warn(`[seerr] wiring incomplete, continuing: ${e}`);
  }
}

async function provisionSeerrInner() {
  await waitFor("seerr", `${URLS.seerr}/api/v1/status`);
  const pub = (await (await req(`${URLS.seerr}/api/v1/settings/public`)).json()) as { initialized: boolean };

  // POST /api/v1/auth/jellyfin serves BOTH create-owner and login (Seerr v3
  // source, commit 703faf9). Verified specifics that bit us:
  //   - hostname must be BARE host (Seerr prepends the scheme); a full URL
  //     yields http://http://... which is unreachable -> 404 INVALID_URL.
  //   - serverType is REQUIRED and numeric: 2 = Jellyfin (3 = Emby). Omitting
  //     it -> 500 NO_ADMIN_USER even for a real Jellyfin admin.
  //   - once the owner exists, re-sending the server details -> 500
  //     "hostname already configured"; log in with credentials-only instead.
  let login: Response;
  if (pub.initialized) {
    login = await req(`${URLS.seerr}/api/v1/auth/jellyfin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: env("JELLYFIN_ADMIN_PASSWORD"), serverType: 2 }),
    });
  } else {
    login = await req(`${URLS.seerr}/api/v1/auth/jellyfin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: env("JELLYFIN_ADMIN_PASSWORD"),
        hostname: "jellyfin.media.svc.cluster.local",
        port: 8096,
        useSsl: false,
        urlBase: "",
        serverType: 2,
        email: "admin@seyzahl.com",
      }),
    });
  }
  if (!login.ok) throw new Error(`seerr jellyfin auth -> ${login.status}: ${(await login.text()).slice(0, 200)}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const sh = { "Content-Type": "application/json", Cookie: cookie };
  console.log(`[seerr] authenticated via Jellyfin admin${pub.initialized ? " (existing owner)" : " (owner created)"}`);

  // Import Jellyfin libraries: discover (?sync=true) then enable all ids.
  const libs = (await (await req(`${URLS.seerr}/api/v1/settings/jellyfin/library?sync=true`, { headers: sh })).json()) as Array<{ id: string }>;
  const ids = libs.map((l) => l.id).filter(Boolean).join(",");
  if (ids) {
    await req(`${URLS.seerr}/api/v1/settings/jellyfin/library?enable=${ids}`, { headers: sh });
    console.log(`[seerr] enabled ${libs.length} Jellyfin libraries`);
  }

  // Surface the generated API key so it can be copied to KV
  const main = (await (await req(`${URLS.seerr}/api/v1/settings/main`, { headers: sh })).json()) as { apiKey: string };
  if (main.apiKey && main.apiKey !== process.env.JELLYSEERR_API_KEY) {
    warnings.push(`seerr: generated API key differs from KV media-jellyseerr-api-key — stage it (set API_KEY env for determinism)`);
    console.warn(`[seerr] ACTION: stage Seerr's API key into KV media-jellyseerr-api-key (value redacted; or set API_KEY env)`);
  }

  // Sonarr/Radarr servers — resolve default profile ids from the apps directly
  const sonarrApi = servarr(URLS.sonarr, "v3", env("SONARR_API_KEY"));
  const radarrApi = servarr(URLS.radarr, "v3", env("RADARR_API_KEY"));
  const sonarrProfiles = await sonarrApi.get<Array<{ id: number; name: string }>>("/qualityprofile");
  const radarrProfiles = await radarrApi.get<Array<{ id: number; name: string }>>("/qualityprofile");

  const existingSonarr = (await (await req(`${URLS.seerr}/api/v1/settings/sonarr`, { headers: sh })).json()) as Array<{ hostname: string }>;
  if (!existingSonarr.some((s) => s.hostname === "sonarr.media.svc.cluster.local")) {
    const p = sonarrProfiles[0];
    const r = await req(`${URLS.seerr}/api/v1/settings/sonarr`, {
      method: "POST",
      headers: sh,
      body: JSON.stringify({
        name: "Sonarr",
        hostname: "sonarr.media.svc.cluster.local",
        port: 8989,
        apiKey: env("SONARR_API_KEY"),
        useSsl: false,
        baseUrl: "",
        activeProfileId: p.id,
        activeProfileName: p.name,
        activeDirectory: "/data/tv",
        activeAnimeProfileId: sonarrProfiles.find((x) => /anime/i.test(x.name))?.id,
        activeAnimeDirectory: "/data/tv",
        is4k: false,
        isDefault: true,
        enableSeasonFolders: true,
        syncEnabled: true,
      }),
    });
    if (!r.ok) throw new Error(`seerr sonarr settings -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    console.log(`[seerr] Sonarr server: created (profile ${p.name})`);
  } else {
    console.log(`[seerr] Sonarr server: exists, skipping`);
  }

  const existingRadarr = (await (await req(`${URLS.seerr}/api/v1/settings/radarr`, { headers: sh })).json()) as Array<{ hostname: string }>;
  if (!existingRadarr.some((s) => s.hostname === "radarr.media.svc.cluster.local")) {
    const p = radarrProfiles[0];
    const r = await req(`${URLS.seerr}/api/v1/settings/radarr`, {
      method: "POST",
      headers: sh,
      body: JSON.stringify({
        name: "Radarr",
        hostname: "radarr.media.svc.cluster.local",
        port: 7878,
        apiKey: env("RADARR_API_KEY"),
        useSsl: false,
        baseUrl: "",
        activeProfileId: p.id,
        activeProfileName: p.name,
        activeDirectory: "/data/movies",
        is4k: false,
        isDefault: true,
        minimumAvailability: "released",
        syncEnabled: true,
      }),
    });
    if (!r.ok) throw new Error(`seerr radarr settings -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    console.log(`[seerr] Radarr server: created (profile ${p.name})`);
  } else {
    console.log(`[seerr] Radarr server: exists, skipping`);
  }
}

// ── main ───────────────────────────────────────────────────────────────────

const steps: Array<[string, () => Promise<void>]> = [
  ["qbittorrent", provisionQbittorrent],
  ["sonarr", provisionSonarr],
  ["radarr", provisionRadarr],
  ["prowlarr", provisionProwlarr],
  ["bazarr", provisionBazarr],
  ["jellyfin", provisionJellyfin],
  ["seerr", provisionSeerr],
];

for (const [name, fn] of steps) {
  console.log(`\n━━━ provisioning ${name} ━━━`);
  try {
    await fn();
  } catch (err) {
    hardFailures.push(`${name}: ${err}`);
    console.error(`[${name}] FAILED: ${err}`);
  }
}

console.log(`\n── provisioning summary ${"─".repeat(40)}`);
console.log(`  hard failures: ${hardFailures.length ? hardFailures.join(" | ") : "none"}`);
console.log(`  warnings: ${warnings.length ? "" : "none"}`);
for (const w of warnings) console.log(`   ⚠ ${w}`);
process.exit(hardFailures.length > 0 ? 1 : 0);
