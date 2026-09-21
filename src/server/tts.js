const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const DEFAULT_TTS_MODEL = 'google-tts/vi';
const DEFAULT_TTS_TIMEOUT_MS = 15000;
const DEFAULT_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const SPEECH_PATH = '/v1/audio/speech';

class TtsError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    if (options.statusCode != null) this.statusCode = options.statusCode;
    if (options.details) this.details = options.details;
    if (options.cause) this.cause = options.cause;
  }
}

function normalizeTtsEndpoint(value = process.env.TTS_API_URL) {
  const raw = String(value || '').trim();
  if (!raw) throw new TtsError('TTS_CONFIG_ERROR', 'TTS_API_URL is required');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new TtsError('TTS_CONFIG_ERROR', 'TTS_API_URL must be a valid URL', { cause: error });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TtsError('TTS_CONFIG_ERROR', 'TTS_API_URL must use http or https');
  }
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new TtsError('TTS_CONFIG_ERROR', 'TTS_API_URL must use HTTPS outside localhost');
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname.endsWith(SPEECH_PATH)) parsed.pathname = pathname;
  else if (pathname.endsWith('/v1')) parsed.pathname = `${pathname}/audio/speech`;
  else parsed.pathname = `${pathname}${SPEECH_PATH}`;
  parsed.hash = '';
  return parsed.toString();
}

function readPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function getAudioContentType(format = 'mp3') {
  const value = String(format || 'mp3').trim().toLowerCase();
  if (value === 'wav') return 'audio/wav';
  if (value === 'ogg' || value === 'opus') return 'audio/ogg';
  return 'audio/mpeg';
}

function requestAudio(endpoint, body, { apiKey, timeoutMs, maxAudioBytes }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(endpoint);
    const transport = parsed.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
          'Content-Length': payload.length
        }
      },
      (response) => {
        const chunks = [];
        let size = 0;
        let settled = false;

        const fail = (error) => {
          if (settled) return;
          settled = true;
          response.destroy();
          reject(error);
        };

        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxAudioBytes) {
            fail(new TtsError('TTS_RESPONSE_TOO_LARGE', `TTS response exceeds ${maxAudioBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => {
          fail(new TtsError('TTS_NETWORK_ERROR', 'TTS response stream failed', { cause: error }));
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          const audio = Buffer.concat(chunks);
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const details = audio.toString('utf8', 0, 512).trim();
            reject(new TtsError(
              'TTS_HTTP_ERROR',
              `TTS provider returned HTTP ${response.statusCode}`,
              { statusCode: response.statusCode, details }
            ));
            return;
          }
          if (!audio.length) {
            reject(new TtsError('TTS_INVALID_RESPONSE', 'TTS provider returned empty audio'));
            return;
          }
          resolve(audio);
        });
      }
    );

    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.setTimeout(timeoutMs, () => {
      const error = new TtsError('TTS_TIMEOUT', `TTS request timed out after ${timeoutMs}ms`);
      request.destroy();
      fail(error);
    });
    request.on('error', (error) => {
      if (error.code === 'ECONNRESET' && settled) return;
      fail(error instanceof TtsError
        ? error
        : new TtsError('TTS_NETWORK_ERROR', 'TTS request failed', { cause: error }));
    });
    request.write(payload);
    request.end();
  });
}

async function synthesizeSpeech(text, options = {}) {
  const input = String(text || '').trim();
  if (!input) throw new TtsError('TTS_INPUT_ERROR', 'TTS text is required');

  const apiKey = String(process.env.TTS_API_KEY || '').trim();
  if (!apiKey) throw new TtsError('TTS_CONFIG_ERROR', 'TTS_API_KEY is required');

  const endpoint = normalizeTtsEndpoint(options.endpoint || process.env.TTS_API_URL);
  const model = String(options.model || process.env.TTS_MODEL || DEFAULT_TTS_MODEL).trim();
  if (!model) throw new TtsError('TTS_CONFIG_ERROR', 'TTS_MODEL is required');

  const responseFormat = String(
    options.responseFormat || process.env.TTS_RESPONSE_FORMAT || 'mp3'
  ).trim();
  const body = { model, input, response_format: responseFormat };
  if (options.voice) body.voice = String(options.voice);
  if (options.speed != null) body.speed = Number(options.speed);

  return requestAudio(endpoint, body, {
    apiKey,
    timeoutMs: readPositiveInteger(options.timeoutMs, DEFAULT_TTS_TIMEOUT_MS),
    maxAudioBytes: readPositiveInteger(options.maxAudioBytes, DEFAULT_MAX_AUDIO_BYTES)
  });
}

async function testTtsConnection(options = {}) {
  const audio = await synthesizeSpeech('Kiểm tra kết nối TTS', options);
  return Boolean(audio?.length);
}

module.exports = {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_TIMEOUT_MS,
  DEFAULT_MAX_AUDIO_BYTES,
  TtsError,
  normalizeTtsEndpoint,
  getAudioContentType,
  synthesizeSpeech,
  testTtsConnection
};
