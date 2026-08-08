'use strict';

const http = require('node:http');
const https = require('node:https');

function createHttpError(message, cause) {
  const error = new Error(message);
  error.code = 'HTTP_REQUEST_FAILED';
  if (cause) error.cause = cause;
  return error;
}

function createResponse(status, statusMessage, headers, body) {
  const textBody = body.toString('utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusMessage || '',
    headers,
    async text() { return textBody; },
    async json() { return JSON.parse(textBody); }
  };
}

function requestWithNode(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (error) {
    return Promise.reject(createHttpError('URL AI không hợp lệ', error));
  }

  const transport = parsed.protocol === 'https:'
    ? https
    : parsed.protocol === 'http:' ? http : null;
  if (!transport) return Promise.reject(createHttpError(`Giao thức HTTP không được hỗ trợ: ${parsed.protocol}`));

  const timeoutMs = Number(options.timeoutMs || 30000);
  const requestOptions = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || undefined,
    path: `${parsed.pathname}${parsed.search}`,
    method: options.method || 'GET',
    headers: options.headers || {}
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(createHttpError(error?.message || 'Không thể kết nối AI', error));
    };
    const request = transport.request(requestOptions, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(createResponse(
          response.statusCode || 0,
          response.statusMessage,
          response.headers,
          Buffer.concat(chunks)
        ));
      });
      response.on('error', fail);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Kết nối AI quá thời gian ${timeoutMs}ms`)));
    request.on('error', fail);
    if (options.body != null) request.write(options.body);
    request.end();
  });
}

async function requestJsonCompat(url, options = {}, runtime = {}) {
  const hasFetchOverride = Object.prototype.hasOwnProperty.call(runtime, 'fetchImpl');
  const fetchImpl = hasFetchOverride ? runtime.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl === 'function') {
    const { timeoutMs = 30000, ...fetchOptions } = options;
    if (typeof AbortController !== 'function') return fetchImpl(url, fetchOptions);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs));
    fetchOptions.signal = fetchOptions.signal || controller.signal;
    try {
      return await fetchImpl(url, fetchOptions);
    } finally {
      clearTimeout(timer);
    }
  }
  return requestWithNode(url, options);
}

module.exports = { requestJsonCompat, requestWithNode };
