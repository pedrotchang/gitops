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
 *   Prowlarr     AnimeTosho indexer + full-sync applications to Sonarr/Radarr
 *   Bazarr       English-everywhere language profile, Sonarr/Radarr link
 *   Jellyfin     startup wizard, libraries, SSO plugin (authentik OIDC)
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

const CF_SCORES: Record<string, number> = {
  "Dubs Only": -10000,
  "Anime Raws": -10000,
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
  const profiles = await api.get<QualityProfile[]>("/qualityprofile");
  for (const profile of profiles) {
    let changed = false;
    for (const item of profile.formatItems) {
      const wanted = CF_SCORES[item.name];
      if (wanted !== undefined && item.score !== wanted) {
        item.score = wanted;
        changed = true;
      }
    }
    if (changed) {
      await api.put(`/qualityprofile/${profile.id}`, profile);
      console.log(`[${app}] profile "${profile.name}": CF scores updated (no-dub enforced)`);
    } else {
      console.log(`[${app}] profile "${profile.name}": CF scores already correct`);
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

async function ensureDownloadClient(app: string, api: ReturnType<typeof servarr>, category: string) {
  const clients = await api.get<Array<{ name: string }>>("/downloadclient");
  if (clients.some((c) => c.name === "qBittorrent")) {
    console.log(`[${app}] download client qBittorrent: exists, skipping`);
    return;
  }
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
      { name: "category", value: category },
    ],
  });
  console.log(`[${app}] download client qBittorrent (category ${category}): created`);
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

// ── Sonarr ─────────────────────────────────────────────────────────────────

async function provisionSonarr() {
  const api = servarr(URLS.sonarr, "v3", env("SONARR_API_KEY"));
  await waitFor("sonarr", `${URLS.sonarr}/ping`);
  await ensureRootFolder("sonarr", api, "/data/tv");
  await ensureDownloadClient("sonarr", api, "tv");
  const cfIds = await ensureCustomFormats("sonarr", api, [CF_DUBS_ONLY, CF_ANIME_RAWS, CF_ANIME_TIER_04, CF_ANIME_TIER_05]);

  // Ensure every profile carries the anime CF scores (formatItems are global
  // across profiles in v4 — new CFs appear with score 0 until set).
  await scoreFormatsInAllProfiles("sonarr", api, cfIds);
}

// ── Radarr ─────────────────────────────────────────────────────────────────

async function provisionRadarr() {
  const api = servarr(URLS.radarr, "v3", env("RADARR_API_KEY"));
  await waitFor("radarr", `${URLS.radarr}/ping`);
  await ensureRootFolder("radarr", api, "/data/movies");
  await ensureDownloadClient("radarr", api, "movies");
  const cfIds = await ensureCustomFormats("radarr", api, [CF_DUBS_ONLY, CF_ANIME_RAWS]);
  await scoreFormatsInAllProfiles("radarr", api, cfIds);
}

// ── Prowlarr ───────────────────────────────────────────────────────────────

async function provisionProwlarr() {
  const api = servarr(URLS.prowlarr, "v1", env("PROWLARR_API_KEY"));
  await waitFor("prowlarr", `${URLS.prowlarr}/ping`);

  // AnimeTosho — automation-friendly anime indexer (Nyaa.si blocks automation)
  const indexers = await api.get<Array<{ name: string }>>("/indexer");
  if (indexers.some((i) => /anime.?tosho/i.test(i.name))) {
    console.log(`[prowlarr] indexer Anime Tosho: exists, skipping`);
  } else {
    const schemas = await api.get<Array<{ name: string; protocol: string; fields: Array<{ name: string; value?: unknown }> }>>(
      "/indexer/schema",
    );
    const schema = schemas.find((s) => /anime.?tosho/i.test(s.name) && s.protocol === "torrent");
    if (!schema) {
      warnings.push("prowlarr: Anime Tosho schema not found — add manually");
      console.warn(`[prowlarr] Anime Tosho schema not found in ${schemas.length} definitions`);
    } else {
      // Historically classified private with a mandatory apiKey field; any value works.
      for (const f of schema.fields) {
        if (/apikey/i.test(f.name) && (f.value === undefined || f.value === "")) f.value = "0";
      }
      // Prowlarr connectivity-tests the indexer on add; AnimeTosho can answer
      // Forbidden to the test from a fresh IP. Non-fatal — the app sync and
      // everything else must still land; add the indexer via UI if this warns.
      try {
        await api.post("/indexer?forceSave=true", { ...schema, enable: true, appProfileId: 1, priority: 25 });
        console.log(`[prowlarr] indexer Anime Tosho: created`);
      } catch (e) {
        warnings.push(`prowlarr: Anime Tosho add failed (${String(e).slice(0, 120)}) — add via UI per runbook`);
        console.warn(`[prowlarr] Anime Tosho add failed, continuing: ${e}`);
      }
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

  // English-everywhere: one language profile, default for series AND movies.
  const profile = {
    profileId: 1,
    name: "English",
    cutoff: null,
    items: [{ id: 1, language: "en", audio_exclude: "False", hi: "False", forced: "False" }],
    mustContain: [],
    mustNotContain: [],
    originalFormat: false,
  };
  const form = new URLSearchParams();
  form.set("languages-enabled", JSON.stringify(["en"]));
  form.set("languages-profiles", JSON.stringify([profile]));
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
  // Embedded subs work credential-free; opensubtitles/subdl accounts are
  // click-ops (see runbook) — enabling here is best-effort.
  form.set("settings-general-enabled_providers", JSON.stringify(["embeddedsubtitles", "opensubtitlescom", "subdl"]));

  const r = await req(`${URLS.bazarr}/api/system/settings`, { method: "POST", headers: h, body: form });
  if (!r.ok) {
    const text = await r.text();
    if (r.status === 422 || r.status === 400) {
      warnings.push(`bazarr: settings partially rejected (${r.status}) — check provider list in UI`);
      console.warn(`[bazarr] settings POST ${r.status}: ${text.slice(0, 300)}`);
    } else {
      throw new Error(`bazarr settings -> ${r.status}: ${text.slice(0, 300)}`);
    }
  } else {
    console.log(`[bazarr] settings asserted: English profile default everywhere, Sonarr+Radarr linked`);
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
      `jellyfin: server-generated API key differs from KV media-jellyfin-api-key — copy this into KV: ${provKey}`,
    );
    console.warn(`[jellyfin] ACTION: az keyvault secret set --vault-name seyzahl --name media-jellyfin-api-key --value '${provKey}'`);
  }

  // SSO plugin (authentik OIDC) — tolerant: plugin may need a restart between
  // install and configuration; rerun the Job to converge.
  try {
    const repos = (await (await req(`${URLS.jellyfin}/Repositories`, { headers: jh })).json()) as Array<{ Name: string }>;
    if (!repos.some((r) => r.Name === "jellyfin-plugin-sso")) {
      await req(`${URLS.jellyfin}/Repositories`, {
        method: "POST",
        headers: jh,
        body: JSON.stringify([
          ...repos,
          { Name: "jellyfin-plugin-sso", Url: "https://raw.githubusercontent.com/9p4/jellyfin-plugin-sso/manifest-release/manifest.json", Enabled: true },
        ]),
      });
      console.log(`[jellyfin] plugin repo jellyfin-plugin-sso: added`);
    }
    const plugins = (await (await req(`${URLS.jellyfin}/Plugins`, { headers: jh })).json()) as Array<{ Name: string; Id: string }>;
    let sso = plugins.find((p) => /sso/i.test(p.Name));
    if (!sso) {
      const inst = await req(`${URLS.jellyfin}/Packages/Installed/${encodeURIComponent("SSO Authentication")}`, {
        method: "POST",
        headers: jh,
      });
      if (!inst.ok) throw new Error(`plugin install -> ${inst.status}`);
      warnings.push("jellyfin: SSO plugin installed — restart jellyfin, then rerun the provisioner to configure it");
      console.warn(`[jellyfin] SSO plugin installed; restart + rerun needed to configure`);
      return;
    }
    const cfg = {
      OidConfigs: {
        authentik: {
          OidEndpoint: "https://auth.seyzahl.com/application/o/jellyfin/",
          OidClientId: "jellyfin-media-sso",
          OidSecret: env("JELLYFIN_OIDC_CLIENT_SECRET"),
          Enabled: true,
          EnableAuthorization: true,
          EnableAllFolders: true,
          RoleClaim: "groups",
          EnabledForAdmins: true,
        },
      },
    };
    const cfgRes = await req(`${URLS.jellyfin}/Plugins/${sso.Id}/Configuration`, {
      method: "POST",
      headers: jh,
      body: JSON.stringify(cfg),
    });
    if (!cfgRes.ok) throw new Error(`plugin config -> ${cfgRes.status}`);
    console.log(`[jellyfin] SSO plugin configured against authentik (client jellyfin-media-sso)`);
  } catch (err) {
    warnings.push(`jellyfin: SSO plugin configuration incomplete (${err}) — finish via UI per runbook or rerun Job`);
    console.warn(`[jellyfin] SSO plugin step failed: ${err}`);
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

  let cookie = "";
  // Seerr expects the Jellyfin base as a full URL in `hostname` (scheme+host),
  // not a bare host — a bare host returns 404 INVALID_URL.
  const login = await req(`${URLS.seerr}/api/v1/auth/jellyfin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hostname: "http://jellyfin.media.svc.cluster.local:8096",
      username: "admin",
      password: env("JELLYFIN_ADMIN_PASSWORD"),
      email: "admin@seyzahl.com",
    }),
  });
  if (!login.ok) throw new Error(`seerr jellyfin auth -> ${login.status}: ${(await login.text()).slice(0, 200)}`);
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const sh = { "Content-Type": "application/json", Cookie: cookie };
  console.log(`[seerr] authenticated via Jellyfin admin${pub.initialized ? " (already initialized)" : ""}`);

  if (!pub.initialized) {
    const sync = await req(`${URLS.seerr}/api/v1/settings/jellyfin/sync`, { method: "POST", headers: sh });
    if (!sync.ok) warnings.push(`seerr: library sync -> ${sync.status}`);
    const init = await req(`${URLS.seerr}/api/v1/settings/initialize`, { method: "POST", headers: sh });
    if (!init.ok) warnings.push(`seerr: initialize -> ${init.status}`);
    console.log(`[seerr] initialized + libraries synced`);
  }

  // Surface the generated API key so it can be copied to KV
  const main = (await (await req(`${URLS.seerr}/api/v1/settings/main`, { headers: sh })).json()) as { apiKey: string };
  if (main.apiKey && main.apiKey !== process.env.JELLYSEERR_API_KEY) {
    warnings.push(`seerr: generated API key differs from KV media-jellyseerr-api-key — copy into KV`);
    console.warn(`[seerr] ACTION: az keyvault secret set --vault-name seyzahl --name media-jellyseerr-api-key --value '${main.apiKey}'`);
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
