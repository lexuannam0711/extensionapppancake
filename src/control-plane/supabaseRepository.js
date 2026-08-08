function createSupabaseRepository({ url, serviceKey, fetchImpl = global.fetch }) {
  if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const parsedUrl = new URL(String(url));
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || parsedUrl.port) throw new Error('SUPABASE_URL must use HTTPS without credentials or custom port');
  const baseUrl = parsedUrl.toString().replace(/\/$/, '');
  async function request(table, { method = 'GET', query = '', body, allowEmpty = false } = {}) {
    const response = await fetchImpl(`${baseUrl}/rest/v1/${table}${query}`, {
      method,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Supabase request failed: ${response.status}`);
    if (allowEmpty || response.status === 204) return [];
    return response.json();
  }
  return {
    async ensureUser(claims) {
      const id = String(claims.sub);
      const existing = (await request('profiles', { query: `?id=eq.${encodeURIComponent(id)}&select=id,email,role,active,created_at,updated_at` }))[0];
      if (existing) return { id: existing.id, email: existing.email || '', role: existing.role, active: existing.active, createdAt: existing.created_at, updatedAt: existing.updated_at };
      const created = (await request('profiles', { method: 'POST', body: { id, email: String(claims.email || ''), role: 'operator', active: false } }))[0];
      return { id: created.id, email: created.email || '', role: created.role, active: created.active, createdAt: created.created_at, updatedAt: created.updated_at };
    },
    async getUser(id) {
      const item = (await request('profiles', { query: `?id=eq.${encodeURIComponent(id)}&select=id,email,role,active,created_at,updated_at` }))[0];
      return item ? { id: item.id, email: item.email || '', role: item.role, active: item.active, createdAt: item.created_at, updatedAt: item.updated_at } : null;
    },
    async listUsers() {
      const rows = await request('profiles', { query: '?select=id,email,role,active,created_at,updated_at&order=email.asc' });
      return rows.map((item) => ({ id: item.id, email: item.email || '', role: item.role, active: item.active, createdAt: item.created_at, updatedAt: item.updated_at }));
    },
    async listDevices() {
      const rows = await request('devices', { query: '?select=*&order=last_seen_at.desc' });
      return rows.map(mapDevice);
    },
    async getDevice(deviceId) {
      const row = (await request('devices', { query: `?device_id=eq.${encodeURIComponent(deviceId)}&select=*` }))[0];
      return row ? mapDevice(row) : null;
    },
    async upsertDevice(input) {
      const existing = (await request('devices', { query: `?device_id=eq.${encodeURIComponent(input.deviceId)}&select=*` }))[0];
      if (existing && existing.user_id !== input.userId) throw new Error('Device belongs to another user');
      if (existing?.revoked) throw new Error('Device is revoked');
      const row = existing
        ? (await request('devices', { method: 'PATCH', query: `?device_id=eq.${encodeURIComponent(input.deviceId)}`, body: toDeviceRow(input) }))[0]
        : (await request('devices', { method: 'POST', query: '?select=*', body: toDeviceRow(input) }))[0];
      return mapDevice(row);
    },
    async heartbeat(deviceId, input) {
      const row = (await request('devices', { method: 'PATCH', query: `?device_id=eq.${encodeURIComponent(deviceId)}`, body: { app_version: input.appVersion, online: input.online, last_update_status: input.lastUpdateStatus, updater_error: input.updaterError, last_seen_at: new Date().toISOString() } }))[0];
      return row ? mapDevice(row) : null;
    },
    async disableUser(id) {
      const row = (await request('profiles', { method: 'PATCH', query: `?id=eq.${encodeURIComponent(id)}`, body: { active: false } }))[0];
      return row ? { id: row.id, email: row.email || '', role: row.role, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at } : null;
    },
    async revokeDevice(id) {
      const row = (await request('devices', { method: 'PATCH', query: `?device_id=eq.${encodeURIComponent(id)}`, body: { revoked: true } }))[0];
      return row ? mapDevice(row) : null;
    },
    async blockRelease(version, reason) {
      const row = (await request('release_policies', { method: 'POST', query: '?on_conflict=version', body: { version, blocked: true, reason: String(reason || '') } }))[0];
      return { version: row.version, reason: row.reason || '', blockedAt: row.updated_at || row.created_at };
    },
    async isVersionBlocked(version) {
      const rows = await request('release_policies', { query: `?version=eq.${encodeURIComponent(version)}&blocked=is.true&select=version` });
      return rows.length > 0;
    },
    async addAuditEvent(event) {
      const row = (await request('audit_events', { method: 'POST', body: { actor_id: event.actorId, action: event.action, target: event.target, data: event.data || {} } }))[0];
      return row;
    },
    async listAuditEvents() { return request('audit_events', { query: '?select=*&order=created_at.desc&limit=1000' }); }
  };
}

function toDeviceRow(input) {
  return {
    device_id: input.deviceId,
    user_id: input.userId,
    os: input.os,
    channel: input.channel,
    app_version: input.appVersion,
    last_seen_at: input.lastSeenAt,
    online: input.online !== false,
    last_update_status: input.lastUpdateStatus || 'registered',
    updater_error: input.updaterError || '',
    device_token_hash: input.deviceTokenHash || '',
    revoked: input.revoked === true
  };
}

function mapDevice(row) {
  return {
    deviceId: row.device_id,
    userId: row.user_id,
    os: row.os,
    channel: row.channel,
    appVersion: row.app_version,
    lastSeenAt: row.last_seen_at,
    online: row.online,
    lastUpdateStatus: row.last_update_status,
    updaterError: row.updater_error,
    deviceTokenHash: row.device_token_hash,
    revoked: row.revoked,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = { createSupabaseRepository };