const crypto = require('crypto');
const express = require('express');
const { parseManifest, parseVersion, compareVersions } = require('../update/manifest');

const CHANNELS = new Set(['modern']);
const ROLES = new Set(['admin', 'operator']);

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function createHs256Token(claims, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + 3600, ...claims };
  const encoded = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyHs256Token(token, secret, { issuer, audience, clockSkewSeconds = 30 } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !secret) throw new Error('Invalid JWT');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(decodeBase64Url(encodedHeader));
    payload = JSON.parse(decodeBase64Url(encodedPayload));
  } catch (_) {
    throw new Error('Invalid JWT');
  }
  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new Error('Unsupported JWT algorithm');
  const expected = crypto.createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest();
  const actual = Buffer.from(encodedSignature, 'base64url');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error('Invalid JWT signature');
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) < now - clockSkewSeconds) throw new Error('JWT expired');
  if (payload.nbf !== undefined && (!Number.isFinite(Number(payload.nbf)) || Number(payload.nbf) > now + clockSkewSeconds)) throw new Error('JWT not active');
  if (issuer && payload.iss !== issuer) throw new Error('JWT issuer is invalid');
  if (audience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) throw new Error('JWT audience is invalid');
  }
  if (!payload.sub) throw new Error('JWT subject is required');
  return payload;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function matchesDeviceToken(expectedHash, token) {
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  const actual = Buffer.from(hashDeviceToken(token), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function toPublicDevice(device) {
  if (!device) return device;
  const { deviceTokenHash, ...publicDevice } = device;
  return publicDevice;
}

function createRateLimitMiddleware({ windowMs = 60000, max = 120 } = {}) {
  let buckets = new Map();
  return (req, res, next) => {
    const key = String(req.ip || req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    const previous = buckets.get(key);
    const bucket = !previous || now - previous.startedAt >= windowMs ? { startedAt: now, count: 0 } : previous;
    bucket.count += 1;
    buckets = new Map(buckets).set(key, bucket);
    if (bucket.count > max) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}
function createInMemoryRepository() {
  let users = new Map();
  let devices = new Map();
  let auditEvents = [];
  let blockedVersions = new Map();
  return {
    async ensureUser(claims) {
      const id = String(claims.sub);
      const previous = users.get(id);
      const next = {
        id,
        email: String(claims.email || previous?.email || ''),
        role: ROLES.has(claims.role) ? claims.role : (previous?.role || 'operator'),
        active: previous?.active !== false,
        createdAt: previous?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      users = new Map(users).set(id, next);
      return clone(next);
    },
    async getUser(id) { return clone(users.get(String(id)) || null); },
    async listUsers() { return clone([...users.values()].sort((a, b) => a.email.localeCompare(b.email))); },
    async listDevices() { return clone([...devices.values()].sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))); },
    async getDevice(deviceId) { return clone(devices.get(String(deviceId)) || null); },
    async upsertDevice(input) {
      const id = String(input.deviceId);
      const previous = devices.get(id);
      if (previous && previous.userId !== input.userId) throw new Error('Device belongs to another user');
      const next = { ...previous, ...input, revoked: previous?.revoked === true, updatedAt: new Date().toISOString() };
      devices = new Map(devices).set(id, next);
      return clone(next);
    },
    async heartbeat(deviceId, input) {
      const previous = devices.get(String(deviceId));
      if (!previous) return null;
      const next = { ...previous, ...input, lastSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      devices = new Map(devices).set(String(deviceId), next);
      return clone(next);
    },
    async disableUser(id) {
      const previous = users.get(String(id));
      if (!previous) return null;
      const next = { ...previous, active: false, updatedAt: new Date().toISOString() };
      users = new Map(users).set(String(id), next);
      return clone(next);
    },
    async revokeDevice(id) {
      const previous = devices.get(String(id));
      if (!previous) return null;
      const next = { ...previous, revoked: true, updatedAt: new Date().toISOString() };
      devices = new Map(devices).set(String(id), next);
      return clone(next);
    },
    async blockRelease(version, reason) {
      const item = { version, reason: String(reason || ''), blockedAt: new Date().toISOString() };
      blockedVersions = new Map(blockedVersions).set(version, item);
      return clone(item);
    },
    async isVersionBlocked(version) { return blockedVersions.has(version); },
    async addAuditEvent(event) {
      auditEvents = [{ ...event, createdAt: new Date().toISOString() }, ...auditEvents].slice(0, 1000);
      return clone(auditEvents[0]);
    },
    async listAuditEvents() { return clone(auditEvents); }
  };
}

function normalizeDeviceInput(raw) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const deviceId = String(body.deviceId || '').trim();
  const channel = String(body.channel || '').trim();
  const os = String(body.os || '').trim();
  const appVersion = String(body.appVersion || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId)) throw new Error('Invalid deviceId');
  if (!CHANNELS.has(channel)) throw new Error('Invalid channel');
  if (!os || os.length > 40) throw new Error('Invalid os');
  parseVersion(appVersion);
  return { deviceId, channel, os, appVersion };
}

// Whitelist-only metadata to prevent DoS or accidental credential leaks
function sanitizeMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const allowed = { botActive: 'boolean', heapUsedMb: 'number', rssMb: 'number', uptimeSeconds: 'number' };
  const result = {};
  for (const [key, type] of Object.entries(allowed)) {
    if (raw[key] === undefined || typeof raw[key] !== type) continue;
    if (type === 'number' && (!Number.isFinite(raw[key]) || raw[key] < 0)) continue;
    result[key] = raw[key];
  }
  return JSON.stringify(result).length <= 512 ? result : {};
}

function normalizeHeartbeatInput(raw) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const appVersion = String(body.appVersion || '').trim();
  parseVersion(appVersion);
  return {
    appVersion,
    online: body.online !== false,
    lastUpdateStatus: String(body.lastUpdateStatus || 'unknown').slice(0, 80),
    updaterError: String(body.updaterError || '').slice(0, 2000),
    metadata: sanitizeMetadata(body.metadata)
  };
}

function createReleaseProvider(manifests = {}, { publicKey = '', allowedHosts = [] } = {}) {
  function parseConfiguredManifests() {
    const parsed = Object.fromEntries(Object.entries(manifests).filter(([, raw]) => raw).map(([name, raw]) => [name, parseManifest(raw, { allowedHosts })]));
    for (const [name, manifest] of Object.entries(parsed)) if (manifest.channel !== name) throw new Error('Release manifest channel does not match provider channel');
    return parsed;
  }

  parseConfiguredManifests();
  return Object.freeze({
    getManifest(channel) {
      const parsed = parseConfiguredManifests();
      const manifest = parsed[channel];
      if (!manifest) return null;
      if (publicKey) {
        const { canonicalManifestPayload } = require('../update/manifest');
        const { verifyEd25519 } = require('../update/integrity');
        if (!verifyEd25519(canonicalManifestPayload(manifest), manifest.signature, publicKey)) throw new Error('Release manifest signature is invalid');
      }
      return manifest;
    }
  });
}

const fsSync = require('fs');
const path = require('path');
const dashboardHtmlContent = fsSync.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

function dashboardHtml() {
  return dashboardHtmlContent;
}
async function verifyRemoteSupabaseToken(token, { url, apiKey }) {
  if (!url) throw new Error('SUPABASE_URL is required for remote token verification');
  const endpoint = `${String(url).replace(/\/$/, '')}/auth/v1/user`;
  const headers = { Authorization: `Bearer ${token}` };
  if (apiKey) headers.apikey = apiKey;
  const res = await fetch(endpoint, { headers });
  if (!res.ok) throw new Error('Remote token verification failed');
  const user = await res.json();
  return {
    sub: user.id,
    email: user.email || '',
    role: user.app_metadata?.role || 'operator'
  };
}

function createControlPlaneApp({ repository = createInMemoryRepository(), manifests = {}, releaseProvider = createReleaseProvider(manifests), jwtSecret = process.env.SUPABASE_JWT_SECRET, expectedIssuer, expectedAudience, enforceHttps = false, trustProxy = false, verifyToken, supabaseUrl = process.env.SUPABASE_URL, supabaseApiKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY } = {}) {
  const app = express();
  if (trustProxy) app.set('trust proxy', true);
  if (enforceHttps) app.use((req, res, next) => { if (req.secure) return next(); return res.status(400).json({ error: 'HTTPS is required' }); });
  app.use(createRateLimitMiddleware());
  app.use(express.json({ limit: '64kb' }));

  async function authenticate(req, res, next) {
    try {
      const authorization = String(req.headers.authorization || '');
      if (!authorization.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
      const token = authorization.slice(7).trim();
      let claims;
      if (verifyToken) {
        claims = await verifyToken(token);
      } else {
        // Detect token algorithm from header
        const [encodedHeader] = token.split('.');
        let header = {};
        try { header = JSON.parse(decodeBase64Url(encodedHeader)); } catch (_) {}
        if (header.alg === 'ES256' || header.alg === 'RS256') {
          claims = await verifyRemoteSupabaseToken(token, { url: supabaseUrl, apiKey: supabaseApiKey });
        } else {
          claims = verifyHs256Token(token, jwtSecret, { issuer: expectedIssuer, audience: expectedAudience });
        }
      }
      const user = await repository.ensureUser(claims);
      if (!user.active) return res.status(403).json({ error: 'User disabled' });
      req.user = user;
      req.claims = claims;
      next();
    } catch (_) {
      res.status(401).json({ error: 'Invalid authentication token' });
    }
  }

  function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
    next();
  }

  async function audit(req, action, target, data = {}) {
    await repository.addAuditEvent({ actorId: req.user.id, action, target, data });
  }

  app.get('/', (_req, res) => res.type('html').send(dashboardHtml()));
  app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  app.get('/v1/update-manifest', async (req, res) => {
    const channel = String(req.query.channel || '').trim();
    if (!CHANNELS.has(channel)) return res.status(400).json({ error: 'Invalid channel' });
    const requestedVersion = String(req.query.version || '').trim().replace(/^v/, '');
    if (requestedVersion) { try { parseVersion(requestedVersion); } catch (error) { return res.status(400).json({ error: error.message }); } }
    const manifest = releaseProvider.getManifest(channel);
    if (!manifest) return res.status(404).json({ error: 'Manifest not found' });
    if (await repository.isVersionBlocked(manifest.version)) return res.status(410).json({ error: 'Release blocked' });
    if (requestedVersion && compareVersions(requestedVersion, manifest.version) >= 0) return res.status(204).end();
    res.json(manifest);
  });

  app.post('/v1/devices/register', authenticate, async (req, res) => {
    try {
      const deviceToken = crypto.randomBytes(32).toString('base64url');
      const device = await repository.upsertDevice({ userId: req.user.id, ...normalizeDeviceInput(req.body), deviceTokenHash: hashDeviceToken(deviceToken), lastSeenAt: new Date().toISOString(), lastUpdateStatus: 'registered', updaterError: '' });
      await audit(req, 'device.register', device.deviceId, { channel: device.channel, os: device.os, appVersion: device.appVersion });
      res.json({ ok: true, device: toPublicDevice(device), deviceToken });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/v1/devices/heartbeat', authenticate, async (req, res) => {
    try {
      const deviceId = String(req.body?.deviceId || '').trim();
      const existing = await repository.getDevice(deviceId);
      const deviceToken = String(req.headers['x-device-token'] || '');
      if (!existing || existing.userId !== req.user.id || existing.revoked || !deviceToken || !matchesDeviceToken(existing.deviceTokenHash, deviceToken)) return res.status(403).json({ error: 'Device not allowed' });
      const device = await repository.heartbeat(deviceId, normalizeHeartbeatInput(req.body));
      res.json({ ok: true, device: toPublicDevice(device) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/v1/me', authenticate, async (req, res) => {
    const devices = (await repository.listDevices()).filter((device) => device.userId === req.user.id);
    res.json({ profile: req.user, devices: devices.map(toPublicDevice) });
  });

  app.use('/v1/admin', authenticate, requireAdmin);
  app.get('/v1/admin/users', async (_req, res) => res.json({ items: await repository.listUsers() }));
  app.get('/v1/admin/devices', async (_req, res) => {
    const [devices, users] = await Promise.all([repository.listDevices(), repository.listUsers()]);
    const userMap = new Map(users.map((u) => [u.id, u.email]));
    const enriched = devices.map((d) => ({
      ...toPublicDevice(d),
      userEmail: userMap.get(d.userId) || ''
    }));
    res.json({ items: enriched });
  });
  app.get('/v1/admin/audit', async (_req, res) => res.json({ items: await repository.listAuditEvents() }));
  app.post('/v1/admin/users/:id/disable', async (req, res) => {
    const user = await repository.disableUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await audit(req, 'user.disable', user.id);
    res.json({ ok: true, user });
  });
  app.post('/v1/admin/devices/:id/revoke', async (req, res) => {
    const device = await repository.revokeDevice(req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    await audit(req, 'device.revoke', device.deviceId);
    res.json({ ok: true, device: toPublicDevice(device) });
  });
  app.post('/v1/admin/releases/:version/block', async (req, res) => {
    try {
      parseVersion(req.params.version);
      const policy = await repository.blockRelease(req.params.version.replace(/^v/, ''), req.body?.reason);
      await audit(req, 'release.block', policy.version, { reason: policy.reason });
      res.json({ ok: true, policy });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.use((_error, _req, res, _next) => {
    if (res.headersSent) return;
    res.status(500).json({ error: 'Control plane internal error' });
  });
  return app;
}

module.exports = {
  createControlPlaneApp,
  createInMemoryRepository,
  createReleaseProvider,
  createHs256Token,
  verifyHs256Token,
  normalizeDeviceInput,
  normalizeHeartbeatInput,
  sanitizeMetadata
};
