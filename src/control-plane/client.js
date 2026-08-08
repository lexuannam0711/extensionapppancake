const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { createEncryptedTokenStore } = require('../auth/tokenStore');

function normalizeUrl(raw, name, { allowLocalHttp = false } = {}) {
  const value = String(raw || '').trim();
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  const localHttp = allowLocalHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error(`${name} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${name} cannot contain credentials`);
  return url.toString().replace(/\/$/, '');
}

function validateCredentials(email, password) {
  const normalizedEmail = String(email || '').trim();
  const normalizedPassword = String(password || '');
  if (!normalizedEmail || normalizedEmail.length > 256 || !normalizedEmail.includes('@')) throw new Error('Valid email is required');
  if (!normalizedPassword || normalizedPassword.length > 1024) throw new Error('Valid password is required');
  return { email: normalizedEmail, password: normalizedPassword };
}

function createResponseError(response, body) {
  const error = new Error(String(body?.error_description || body?.msg || body?.error || `Request failed: ${response.status}`));
  error.status = Number(response.status) || 0;
  error.body = body;
  return error;
}

async function readResponse(response) {
  let body = null;
  try { body = response.status === 204 ? null : await response.json(); } catch (_) { body = null; }
  if (!response.ok) throw createResponseError(response, body);
  return body;
}

async function loadOrCreateDeviceId(filePath) {
  try {
    const value = String(await fs.readFile(filePath, 'utf8')).trim();
    if (/^[A-Za-z0-9._:-]{1,128}$/.test(value)) return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const value = `device-${crypto.randomUUID()}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.rename(temporaryPath, filePath);
  return value;
}

function createControlPlaneClient({
  controlPlaneUrl = process.env.CONTROL_PLANE_URL,
  supabaseUrl = process.env.SUPABASE_URL,
  supabaseAnonKey = process.env.SUPABASE_ANON_KEY,
  safeStorage,
  userDataPath,
  channel = Number(String(process.versions?.electron || '0').split('.')[0]) <= 22 ? 'win7' : 'modern',
  appVersion = '0.0.0',
  os = process.platform,
  fetchImpl = global.fetch,
  refreshTokenStore,
  deviceTokenStore,
  deviceId
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  const configurationError = !controlPlaneUrl || !supabaseUrl || !supabaseAnonKey ? 'Control plane authentication is not configured' : '';
  const configured = !configurationError;
  const normalizedControlPlaneUrl = configured ? normalizeUrl(controlPlaneUrl, 'CONTROL_PLANE_URL', { allowLocalHttp: true }) : '';
  const normalizedSupabaseUrl = configured ? normalizeUrl(supabaseUrl, 'SUPABASE_URL', { allowLocalHttp: true }) : '';
  const tokenDirectory = userDataPath ? path.join(userDataPath, 'control-plane') : '';
  const refreshStore = refreshTokenStore || (configured ? createEncryptedTokenStore({ safeStorage, filePath: path.join(tokenDirectory, 'refresh-token.bin') }) : null);
  const storedDeviceToken = deviceTokenStore || (configured ? createEncryptedTokenStore({ safeStorage, filePath: path.join(tokenDirectory, 'device-token.bin') }) : null);
  const generatedDeviceIdPromise = deviceId
    ? Promise.resolve(String(deviceId))
    : (userDataPath ? loadOrCreateDeviceId(path.join(tokenDirectory, 'device-id')) : Promise.resolve(`device-${crypto.randomUUID()}`));
  let accessToken = '';
  let accessTokenExpiresAt = 0;
  let refreshToken = '';
  let deviceToken = '';
  let heartbeatTimer = null;
  let statusListener = null;
  let state = Object.freeze({
    configured,
    status: configured ? 'signed_out' : 'not_configured',
    profile: null,
    device: null,
    deviceId: deviceId ? String(deviceId) : '',
    channel,
    appVersion,
    os,
    lastUpdateStatus: 'unknown',
    updaterError: '',
    error: configurationError
  });

  function getStatus() {
    return JSON.parse(JSON.stringify(state));
  }

  function setState(patch) {
    state = Object.freeze({ ...state, ...patch });
    statusListener?.(getStatus());
    return getStatus();
  }

  async function getDeviceId() {
    if (!state.deviceId) setState({ deviceId: await generatedDeviceIdPromise });
    return state.deviceId;
  }

  async function supabaseTokenRequest(grantType, body) {
    const response = await fetchImpl(`${normalizedSupabaseUrl}/auth/v1/token?grant_type=${encodeURIComponent(grantType)}`, {
      method: 'POST',
      headers: {
        apikey: String(supabaseAnonKey),
        Authorization: `Bearer ${String(supabaseAnonKey)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return readResponse(response);
  }

  function storeSession(payload) {
    if (!payload?.access_token || !payload?.refresh_token) throw new Error('Supabase session is incomplete');
    accessToken = String(payload.access_token);
    refreshToken = String(payload.refresh_token);
    const expiresIn = Number(payload.expires_in);
    accessTokenExpiresAt = Date.now() + (Number.isFinite(expiresIn) ? Math.max(30, expiresIn - 60) * 1000 : 300000);
    return payload;
  }

  async function refreshSession(token = refreshToken) {
    if (!configured || !token) return false;
    try {
      const payload = storeSession(await supabaseTokenRequest('refresh_token', { refresh_token: token }));
      await refreshStore.save(refreshToken);
      setState({ status: 'authenticated', error: '' });
      return Boolean(payload);
    } catch (error) {
      accessToken = '';
      accessTokenExpiresAt = 0;
      refreshToken = '';
      await refreshStore.clear().catch(() => {});
      await storedDeviceToken.clear().catch(() => {});
      deviceToken = '';
      setState({ status: 'signed_out', profile: null, device: null, error: 'Session expired' });
      return false;
    }
  }

  async function ensureAccessToken() {
    if (accessToken && accessTokenExpiresAt > Date.now() + 30000) return accessToken;
    if (!refreshToken) refreshToken = String(await refreshStore.load() || '');
    if (!refreshToken || !(await refreshSession(refreshToken))) throw new Error('Authentication required');
    return accessToken;
  }

  async function controlRequest(route, options = {}, retry = true) {
    const token = await ensureAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    };
    const response = await fetchImpl(`${normalizedControlPlaneUrl}${route}`, { ...options, headers });
    if (response.status === 401 && retry) {
      if (await refreshSession()) return controlRequest(route, options, false);
    }
    return readResponse(response);
  }

  async function syncProfile() {
    const result = await controlRequest('/v1/me');
    setState({ status: 'authenticated', profile: result.profile || null, error: '' });
    return result;
  }

  async function registerDevice() {
    const id = await getDeviceId();
    const result = await controlRequest('/v1/devices/register', {
      method: 'POST',
      body: JSON.stringify({ deviceId: id, os, channel, appVersion })
    });
    if (!result?.deviceToken) throw new Error('Device registration response is incomplete');
    deviceToken = String(result.deviceToken);
    await storedDeviceToken.save(deviceToken);
    setState({ status: 'authenticated', device: result.device || null, error: '' });
    return result.device;
  }

  async function heartbeat({ online = true, lastUpdateStatus = state.lastUpdateStatus, updaterError = state.updaterError } = {}) {
    if (!configured || state.status === 'disabled' || state.status === 'revoked' || !refreshToken && !accessToken) return getStatus();
    try {
      const id = await getDeviceId();
      if (!deviceToken) deviceToken = String(await storedDeviceToken.load() || '');
      if (!deviceToken) await registerDevice();
      const result = await controlRequest('/v1/devices/heartbeat', {
        method: 'POST',
        headers: { 'X-Device-Token': deviceToken },
        body: JSON.stringify({ deviceId: id, appVersion, online, lastUpdateStatus, updaterError })
      });
      setState({ status: 'online', device: result.device || state.device, lastUpdateStatus, updaterError, error: '' });
    } catch (error) {
      const status = Number(error.status);
      const nextStatus = status === 403 && /disabled/i.test(error.message) ? 'disabled' : status === 403 ? 'revoked' : 'error';
      setState({ status: nextStatus, lastUpdateStatus, updaterError, error: error.message });
    }
    return getStatus();
  }

  async function login({ email, password } = {}) {
    if (!configured) throw new Error(configurationError);
    const credentials = validateCredentials(email, password);
    setState({ status: 'signing_in', error: '' });
    try {
      const payload = storeSession(await supabaseTokenRequest('password', credentials));
      await refreshStore.save(refreshToken);
      await registerDevice();
      await syncProfile();
      await heartbeat();
      return getStatus();
    } catch (error) {
      const status = Number(error.status);
      setState({ status: status === 403 ? 'disabled' : 'error', error: error.message });
      throw error;
    }
  }

  async function initialize() {
    if (!configured) return getStatus();
    try {
      refreshToken = String(await refreshStore.load() || '');
      deviceToken = String(await storedDeviceToken.load() || '');
      if (!refreshToken) return getStatus();
      if (!(await refreshSession(refreshToken))) return getStatus();
      if (!deviceToken) await registerDevice();
      await syncProfile();
      await heartbeat();
    } catch (error) {
      setState({ status: Number(error.status) === 403 ? 'disabled' : 'error', error: error.message });
    }
    return getStatus();
  }

  function startHeartbeat(intervalMs = 60000, listener) {
    statusListener = listener || statusListener;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => heartbeat(), intervalMs);
    heartbeatTimer.unref?.();
    return heartbeatTimer;
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  async function logout() {
    stopHeartbeat();
    accessToken = '';
    accessTokenExpiresAt = 0;
    refreshToken = '';
    deviceToken = '';
    if (refreshStore) await refreshStore.clear().catch(() => {});
    if (storedDeviceToken) await storedDeviceToken.clear().catch(() => {});
    return setState({ status: configured ? 'signed_out' : 'not_configured', profile: null, device: null, error: '' });
  }

  function setUpdateStatus(lastUpdateStatus, updaterError = '') {
    return setState({ lastUpdateStatus: String(lastUpdateStatus || 'unknown').slice(0, 80), updaterError: String(updaterError || '').slice(0, 2000) });
  }

  function dispose() { stopHeartbeat(); statusListener = null; }

  return Object.freeze({ getStatus, initialize, login, logout, heartbeat, startHeartbeat, stopHeartbeat, setUpdateStatus, dispose });
}

module.exports = { createControlPlaneClient, loadOrCreateDeviceId, normalizeUrl, validateCredentials };