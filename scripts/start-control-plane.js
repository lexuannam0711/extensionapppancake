require('dotenv').config();
const fs = require('fs');
const { createControlPlaneApp, createInMemoryRepository, createReleaseProvider } = require('../src/control-plane/server');
const { createSupabaseRepository } = require('../src/control-plane/supabaseRepository');

function loadManifest(filePath) {
  if (!filePath) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function fetchManifest(source, allowedHosts) {
  if (!source) return null;
  if (!/^https:\/\//i.test(source)) return loadManifest(source);
  const url = new URL(source);
  if (!allowedHosts.includes(url.hostname.toLowerCase())) throw new Error('Manifest source host is not allowed');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Manifest source request failed: ${response.status}`);
  if (response.url && !allowedHosts.includes(new URL(response.url).hostname.toLowerCase())) throw new Error('Manifest source redirect host is not allowed');
  return response.json();
}

const hasSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const devMode = process.env.CONTROL_PLANE_DEV_MODE === 'true';
if (!hasSupabase && !devMode) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required outside CONTROL_PLANE_DEV_MODE');
if (!process.env.SUPABASE_JWT_SECRET) throw new Error('SUPABASE_JWT_SECRET is required');

const repository = hasSupabase
  ? createSupabaseRepository({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY })
  : createInMemoryRepository();
const allowedHosts = String(process.env.UPDATE_ALLOWED_HOSTS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
const publicKey = String(process.env.UPDATE_PUBLIC_KEY || '');
const manifestSources = {
  modern: process.env.UPDATE_MANIFEST_MODERN_URL || process.env.UPDATE_MANIFEST_MODERN_PATH || '',
  win7: process.env.UPDATE_MANIFEST_WIN7_URL || process.env.UPDATE_MANIFEST_WIN7_PATH || ''
};
const manifests = {
  modern: manifestSources.modern && !/^https:\/\//i.test(manifestSources.modern) ? loadManifest(manifestSources.modern) : null,
  win7: manifestSources.win7 && !/^https:\/\//i.test(manifestSources.win7) ? loadManifest(manifestSources.win7) : null
};
if ((Object.values(manifests).some(Boolean) || Object.values(manifestSources).some(Boolean)) && !publicKey) throw new Error('UPDATE_PUBLIC_KEY is required when release manifests are configured');
const releaseProvider = createReleaseProvider(manifests, { publicKey, allowedHosts });
const expectedIssuer = process.env.SUPABASE_JWT_ISSUER || `${String(process.env.SUPABASE_URL || '').replace(/\/$/, '')}/auth/v1`;
const app = createControlPlaneApp({
  repository,
  releaseProvider,
  jwtSecret: process.env.SUPABASE_JWT_SECRET,
  expectedIssuer,
  expectedAudience: process.env.SUPABASE_JWT_AUDIENCE || 'authenticated',
  enforceHttps: process.env.CONTROL_PLANE_ENFORCE_HTTPS !== 'false',
  trustProxy: process.env.CONTROL_PLANE_TRUST_PROXY === 'true'
});
const port = Number(process.env.CONTROL_PLANE_PORT || process.env.PORT || 8788);
const host = process.env.CONTROL_PLANE_HOST || '127.0.0.1';

async function refreshManifests() {
  for (const channel of ['modern', 'win7']) {
    const source = manifestSources[channel];
    if (!source || !/^https:\/\//i.test(source)) continue;
    manifests[channel] = await fetchManifest(source, allowedHosts);
  }
}

refreshManifests().catch((error) => console.error(`[control-plane] initial manifest refresh failed: ${error.message}`)).finally(() => {
  app.listen(port, host, () => console.log(`[control-plane] listening on ${host}:${port}`));
});
const refreshTimer = setInterval(() => refreshManifests().catch((error) => console.error(`[control-plane] manifest refresh failed: ${error.message}`)), 5 * 60 * 1000);
refreshTimer.unref?.();
