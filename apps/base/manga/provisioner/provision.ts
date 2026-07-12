#!/usr/bin/env bun
/**
 * provision.ts — idempotent API-first bootstrap for the manga stack.
 * Runs in-cluster as the manga-provisioner Job (media-provisioner pattern).
 * Every step is check-then-act; rerunning causes no duplicates or errors.
 *
 * Komga (REST):
 *   1. claim the server as admin (seed password from Key Vault via ESO)
 *   2. ensure the komf@ service user (komf 1.7.1 needs user/password auth)
 *   3. ensure an "ops-bootstrap" API key (validated if already minted)
 *   4. ensure the "Manga" library rooted at /library (ComicInfo import on)
 * Suwayomi (GraphQL):
 *   5. setSettings — CBZ downloads, downloadsPath=/library, auto-download new
 *      chapters, intelligent/partial update exclusions all OFF, WebUI pinned
 *      to BUNDLED (PR #120 lesson)
 *   6. ensure the Keiyoushi extension store (addExtensionStore fetches live)
 *   7. install the pinned non-NSFW source list (nothing else ever installed)
 * Secrets:
 *   8. write minted credentials to the manga-generated-credentials Secret via
 *      the kube API; the PushSecret in secrets.yaml mirrors them to Key Vault
 * Komf (REST):
 *   9. trigger an initial full metadata match of the library
 *
 * Disaster-rebuild path: if the generated Secret is gone but Komga's config
 * PVC survived, the admin seed password still works — the komf user's
 * password is re-minted and PATCHed, so state reconverges without KV reads.
 */

const KOMGA = env("KOMGA_BASE");
const SUWAYOMI = env("SUWAYOMI_BASE");
const KOMF = env("KOMF_BASE");
const ADMIN_EMAIL = env("KOMGA_ADMIN_EMAIL");
const ADMIN_PASSWORD = env("KOMGA_ADMIN_PASSWORD");
const KOMF_EMAIL = env("KOMF_USER_EMAIL");
const NAMESPACE = env("POD_NAMESPACE");
const GEN_SECRET = env("GEN_SECRET_NAME");

const LIBRARY_NAME = "Manga";
const LIBRARY_ROOT = "/library";
const API_KEY_COMMENT = "ops-bootstrap";
const KEIYOUSHI_INDEX = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json";
// Curated non-NSFW source list (Pedro, 2026-07-12). All nsfw=0 in the
// Keiyoushi index. Bato.to no longer exists in the repo (site shut down).
const EXTENSIONS = [
  "eu.kanade.tachiyomi.extension.all.mangadex", // MangaDex
  "eu.kanade.tachiyomi.extension.all.comicklive", // Comick (Unoriginal)
  "eu.kanade.tachiyomi.extension.en.weebcentral", // Weeb Central
  "eu.kanade.tachiyomi.extension.en.asurascans", // Asura Scans
  "eu.kanade.tachiyomi.extension.en.thunderscans", // Thunder Scans
];

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;
const adminAuth = () => ({ Authorization: basic(ADMIN_EMAIL, ADMIN_PASSWORD) });

function log(msg: string) {
  console.log(`[provision] ${msg}`);
}

async function waitFor(label: string, probe: () => Promise<boolean>, timeoutMs = 900_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await probe()) {
        log(`${label}: up`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(5000);
  }
  throw new Error(`${label}: not up after ${timeoutMs / 1000}s`);
}

async function jfetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function randomAlnum(len: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => alphabet[b % alphabet.length]).join("");
}

// ---------- kube API (SA token; CA trusted via NODE_EXTRA_CA_CERTS) ----------

const KUBE = "https://kubernetes.default.svc";
const saToken = await Bun.file("/var/run/secrets/kubernetes.io/serviceaccount/token").text();
const kubeHeaders = { Authorization: `Bearer ${saToken}` };
const secretUrl = `${KUBE}/api/v1/namespaces/${NAMESPACE}/secrets`;

async function readGeneratedSecret(): Promise<Record<string, string> | null> {
  const res = await jfetch(`${secretUrl}/${GEN_SECRET}`, { headers: kubeHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`kube GET secret: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data?: Record<string, string> };
  return Object.fromEntries(
    Object.entries(body.data ?? {}).map(([k, v]) => [k, Buffer.from(v, "base64").toString()]),
  );
}

async function writeGeneratedSecret(data: Record<string, string>) {
  const encoded = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString("base64")]),
  );
  const manifest = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: GEN_SECRET, namespace: NAMESPACE },
    type: "Opaque",
    data: encoded,
  };
  const create = await jfetch(secretUrl, {
    method: "POST",
    headers: kubeHeaders,
    body: JSON.stringify(manifest),
  });
  if (create.status === 409) {
    const patch = await jfetch(`${secretUrl}/${GEN_SECRET}`, {
      method: "PATCH",
      headers: { ...kubeHeaders, "Content-Type": "application/strategic-merge-patch+json" },
      body: JSON.stringify({ data: encoded }),
    });
    if (!patch.ok) throw new Error(`kube PATCH secret: ${patch.status} ${await patch.text()}`);
    log(`secret ${GEN_SECRET}: patched`);
  } else if (create.ok) {
    log(`secret ${GEN_SECRET}: created`);
  } else {
    throw new Error(`kube POST secret: ${create.status} ${await create.text()}`);
  }
}

// ------------------------------- Komga -------------------------------------

async function komgaClaim() {
  const status = await jfetch(`${KOMGA}/api/v1/claim`);
  if (!status.ok) throw new Error(`claim status: ${status.status}`);
  const { isClaimed } = (await status.json()) as { isClaimed: boolean };
  if (!isClaimed) {
    const res = await jfetch(`${KOMGA}/api/v1/claim`, {
      method: "POST",
      headers: { "X-Komga-Email": ADMIN_EMAIL, "X-Komga-Password": ADMIN_PASSWORD },
    });
    if (!res.ok) throw new Error(`claim: ${res.status} ${await res.text()}`);
    log(`komga: claimed by ${ADMIN_EMAIL}`);
  } else {
    log("komga: already claimed");
  }
  // Either way the seed admin credentials MUST work — anything else means the
  // server was claimed out-of-band or KV drifted. Fail loudly.
  const me = await jfetch(`${KOMGA}/api/v2/users/me`, { headers: adminAuth() });
  if (!me.ok) {
    throw new Error(
      `komga admin login failed (${me.status}) — server claimed with different credentials than KV seed?`,
    );
  }
}

async function komgaEnsureKomfUser(komfPassword: string) {
  const login = await jfetch(`${KOMGA}/api/v2/users/me`, {
    headers: { Authorization: basic(KOMF_EMAIL, komfPassword) },
  });
  if (login.ok) {
    log(`komga: komf user ok (${KOMF_EMAIL})`);
    return;
  }
  const usersRes = await jfetch(`${KOMGA}/api/v2/users`, { headers: adminAuth() });
  if (!usersRes.ok) throw new Error(`list users: ${usersRes.status}`);
  const users = (await usersRes.json()) as Array<{ id: string; email: string }>;
  const existing = users.find((u) => u.email === KOMF_EMAIL);
  if (existing) {
    // User exists but the minted password doesn't match (e.g. Secret was lost
    // and re-minted) — converge by resetting it as admin.
    const res = await jfetch(`${KOMGA}/api/v2/users/${existing.id}/password`, {
      method: "PATCH",
      headers: adminAuth(),
      body: JSON.stringify({ password: komfPassword }),
    });
    if (!res.ok) throw new Error(`reset komf password: ${res.status} ${await res.text()}`);
    log("komga: komf user password reconverged");
  } else {
    const res = await jfetch(`${KOMGA}/api/v2/users`, {
      method: "POST",
      headers: adminAuth(),
      body: JSON.stringify({
        email: KOMF_EMAIL,
        password: komfPassword,
        roles: ["ADMIN", "FILE_DOWNLOAD", "PAGE_STREAMING"],
      }),
    });
    if (!res.ok) throw new Error(`create komf user: ${res.status} ${await res.text()}`);
    log(`komga: komf user created (${KOMF_EMAIL})`);
  }
}

async function komgaEnsureApiKey(current: string | undefined): Promise<string> {
  if (current) {
    const check = await jfetch(`${KOMGA}/api/v2/users/me`, { headers: { "X-API-Key": current } });
    if (check.ok) {
      log("komga: existing api key valid");
      return current;
    }
    log("komga: stored api key invalid — reminting");
  }
  // Drop stale keys with our comment, then mint fresh (the key value is only
  // returned at creation time).
  const listRes = await jfetch(`${KOMGA}/api/v2/users/me/api-keys`, { headers: adminAuth() });
  if (listRes.ok) {
    const keys = (await listRes.json()) as Array<{ id: string; comment: string }>;
    for (const k of keys.filter((k) => k.comment === API_KEY_COMMENT)) {
      await jfetch(`${KOMGA}/api/v2/users/me/api-keys/${k.id}`, {
        method: "DELETE",
        headers: adminAuth(),
      });
      log(`komga: deleted stale api key ${k.id}`);
    }
  }
  const res = await jfetch(`${KOMGA}/api/v2/users/me/api-keys`, {
    method: "POST",
    headers: adminAuth(),
    body: JSON.stringify({ comment: API_KEY_COMMENT }),
  });
  if (!res.ok) throw new Error(`create api key: ${res.status} ${await res.text()}`);
  const { key } = (await res.json()) as { key: string };
  log("komga: api key minted");
  return key;
}

async function komgaEnsureLibrary(): Promise<string> {
  const listRes = await jfetch(`${KOMGA}/api/v1/libraries`, { headers: adminAuth() });
  if (!listRes.ok) throw new Error(`list libraries: ${listRes.status}`);
  const libs = (await listRes.json()) as Array<{ id: string; name: string }>;
  const existing = libs.find((l) => l.name === LIBRARY_NAME);
  if (existing) {
    log(`komga: library "${LIBRARY_NAME}" exists (${existing.id})`);
    return existing.id;
  }
  const res = await jfetch(`${KOMGA}/api/v1/libraries`, {
    method: "POST",
    headers: adminAuth(),
    body: JSON.stringify({
      name: LIBRARY_NAME,
      root: LIBRARY_ROOT,
      // Suwayomi writes ComicInfo.xml into each CBZ — import everything.
      importComicInfoBook: true,
      importComicInfoSeries: true,
      importComicInfoCollection: true,
      importComicInfoReadList: true,
      importComicInfoSeriesAppendVolume: false,
      importEpubBook: false,
      importEpubSeries: false,
      importMylarSeries: false,
      importLocalArtwork: true,
      importBarcodeIsbn: false,
      scanForceModifiedTime: false,
      scanInterval: "EVERY_6H",
      scanOnStartup: true,
      scanCbx: true,
      scanPdf: false,
      scanEpub: false,
      scanDirectoryExclusions: [],
      repairExtensions: false,
      convertToCbz: false,
      emptyTrashAfterScan: false,
      seriesCover: "FIRST",
      hashFiles: true,
      hashPages: false,
      hashKoreader: false,
      analyzeDimensions: true,
    }),
  });
  if (!res.ok) throw new Error(`create library: ${res.status} ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  log(`komga: library "${LIBRARY_NAME}" created (${id})`);
  return id;
}

// ------------------------------ Suwayomi -----------------------------------

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await jfetch(`${SUWAYOMI}/api/graphql`, {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (!res.ok || body.errors?.length) {
    throw new Error(`graphql: ${res.status} ${JSON.stringify(body.errors ?? "")} for ${query.slice(0, 80)}`);
  }
  return body.data as T;
}

async function suwayomiConfigure() {
  await gql(
    `mutation Configure($settings: PartialSettingsTypeInput!) {
       setSettings(input: { settings: $settings }) {
         settings { downloadAsCbz downloadsPath autoDownloadNewChapters }
       }
     }`,
    {
      settings: {
        // CBZ into the shared library, auto-download everything new.
        downloadAsCbz: true,
        downloadsPath: LIBRARY_ROOT,
        autoDownloadNewChapters: true,
        autoDownloadIgnoreReUploads: true,
        // Intelligent/partial updates OFF — they break bulk updating.
        excludeEntryWithUnreadChapters: false,
        excludeUnreadChapters: false,
        excludeNotStarted: false,
        excludeCompleted: false,
        // WebUI pinned to the image-bundled build (PR #120 lesson); mirrors
        // the env pin in the deployment so the setting survives either path.
        webUIChannel: "BUNDLED",
        webUIUpdateCheckInterval: 0,
      },
    },
  );
  log("suwayomi: settings applied");
}

async function suwayomiEnsureStore() {
  const data = await gql<{ extensionStores: { nodes: Array<{ indexUrl: string }> } }>(
    `{ extensionStores { nodes { indexUrl } } }`,
  );
  if (data.extensionStores.nodes.some((s) => s.indexUrl === KEIYOUSHI_INDEX)) {
    log("suwayomi: keiyoushi store present");
    return;
  }
  await gql(
    `mutation AddStore($url: String!) {
       addExtensionStore(input: { indexUrl: $url }) { extensionStore { name } }
     }`,
    { url: KEIYOUSHI_INDEX },
  );
  log("suwayomi: keiyoushi store added");
}

async function suwayomiInstallExtensions() {
  await gql(`mutation { fetchExtensions(input: {}) { clientMutationId } }`);
  const data = await gql<{
    extensions: { nodes: Array<{ pkgName: string; isInstalled: boolean }> };
  }>(`{ extensions { nodes { pkgName isInstalled } } }`);
  const byPkg = new Map(data.extensions.nodes.map((e) => [e.pkgName, e]));
  const missingFromIndex = EXTENSIONS.filter((p) => !byPkg.has(p));
  if (missingFromIndex.length) {
    throw new Error(`extensions not in store index (renamed upstream?): ${missingFromIndex.join(", ")}`);
  }
  for (const pkg of EXTENSIONS) {
    if (byPkg.get(pkg)!.isInstalled) {
      log(`suwayomi: ${pkg} already installed`);
      continue;
    }
    await gql(
      `mutation Install($id: String!) {
         updateExtension(input: { id: $id, patch: { install: true } }) {
           extension { pkgName isInstalled }
         }
       }`,
      { id: pkg },
    );
    log(`suwayomi: installed ${pkg}`);
  }
}

// -------------------------------- main --------------------------------------

log("waiting for komga");
await waitFor("komga", async () => (await fetch(`${KOMGA}/api/v1/claim`)).ok);
await komgaClaim();

const stored = (await readGeneratedSecret()) ?? {};
const komfPassword = stored.komfPassword ?? randomAlnum(24);
await komgaEnsureKomfUser(komfPassword);
const komgaApiKey = await komgaEnsureApiKey(stored.komgaApiKey);
const libraryId = await komgaEnsureLibrary();

log("waiting for suwayomi");
await waitFor("suwayomi", async () => {
  const res = await jfetch(`${SUWAYOMI}/api/graphql`, {
    method: "POST",
    body: JSON.stringify({ query: "{ __typename }" }),
  });
  return res.ok;
});
await suwayomiConfigure();
await suwayomiEnsureStore();
await suwayomiInstallExtensions();

// Persist minted credentials BEFORE waiting on komf — komf's pod can only
// start once this Secret exists. PushSecret mirrors both values to Key Vault.
await writeGeneratedSecret({ komfPassword, komgaApiKey });

log("waiting for komf");
await waitFor("komf", async () => {
  const res = await fetch(KOMF);
  return res.status < 500;
});
const match = await fetch(`${KOMF}/komga/match/library/${libraryId}`, { method: "POST" });
if (!match.ok) throw new Error(`komf initial match: ${match.status} ${await match.text()}`);
log("komf: initial library match triggered");

// Kick a scan so a fresh install shows life immediately (idempotent — scans
// are queued/merged by komga).
await jfetch(`${KOMGA}/api/v1/libraries/${libraryId}/scan`, {
  method: "POST",
  headers: { "X-API-Key": komgaApiKey },
});
log("done — stack is wired");
