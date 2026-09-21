const BUY_TTS_FULL_CONTACT_TEXT = 'Khách mua hàng, địa chỉ và số điện thoại đầy đủ';
const BUY_TTS_NEW_CUSTOMER_TEXT = 'Khách mua hàng mới';
const BUY_TTS_DEFAULT_DEBOUNCE_MS = 1500;
const BUY_TTS_DEDUPE_TTL_MS = 60000;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeKeyPart(value) {
  return normalizeText(value).toLowerCase();
}

function hasFullContact(event = {}) {
  return Boolean(normalizeText(event.phone) && normalizeText(event.address));
}

function buildSingleBuySpeech(event = {}) {
  return hasFullContact(event) ? BUY_TTS_FULL_CONTACT_TEXT : BUY_TTS_NEW_CUSTOMER_TEXT;
}

function buildGroupedBuySpeech(count) {
  return `Có ${Number(count) || 0} khách mua hàng`;
}

function makeBuyEventKey(event = {}) {
  const message = normalizeKeyPart(event.message).slice(0, 120);
  const key = [
    event.conversationId,
    event.customerName,
    event.phone,
    event.address,
    message
  ].map(normalizeKeyPart).join('|');
  return key.replace(/\|/g, '') ? key : '';
}

function pruneSeen(seen, now, ttlMs) {
  for (const [key, timestamp] of seen.entries()) {
    if (now - timestamp > ttlMs) seen.delete(key);
  }
}

function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(0, Math.min(1, number));
}

function resolveVietnameseVoice(speechSynthesis) {
  try {
    const voices = typeof speechSynthesis?.getVoices === 'function' ? speechSynthesis.getVoices() : [];
    return voices.find((voice) => /^vi\b/i.test(voice.lang || ''))
      || voices.find((voice) => /vietnam/i.test(`${voice.lang || ''} ${voice.name || ''}`))
      || null;
  } catch (_) {
    return null;
  }
}

function createBuyTtsNotifier(options = {}) {
  const getSpeechSynthesis = options.getSpeechSynthesis || (() => (
    options.speechSynthesis || (typeof window !== 'undefined' ? window.speechSynthesis : null)
  ));
  const getUtteranceCtor = options.getSpeechSynthesisUtterance || (() => (
    options.SpeechSynthesisUtterance || (typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null)
  ));
  const setTimer = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeout || ((id) => clearTimeout(id));
  const now = options.now || (() => Date.now());
  const defaultDebounceMs = readPositiveNumber(options.debounceMs, BUY_TTS_DEFAULT_DEBOUNCE_MS);
  const dedupeTtlMs = readPositiveNumber(options.dedupeTtlMs, BUY_TTS_DEDUPE_TTL_MS);
  const lang = options.lang || 'vi-VN';
  const rate = Number.isFinite(Number(options.rate)) ? Number(options.rate) : 1;
  const pitch = Number.isFinite(Number(options.pitch)) ? Number(options.pitch) : 1;
  const volume = clampVolume(options.volume);
  const getFetch = options.getFetch || (() => (
    options.fetch || (typeof window !== 'undefined' ? window.fetch.bind(window) : globalThis.fetch)
  ));
  const getAudio = options.getAudio || (() => options.Audio || (typeof window !== 'undefined' ? window.Audio : null));
  const getObjectUrl = options.getObjectUrl || (() => (typeof URL !== 'undefined' ? URL.createObjectURL.bind(URL) : null));

  let timer = null;
  let queue = [];
  let pendingSettings = {};
  let lastSpokenText = '';
  const seen = new Map();

  function notifyBuyCustomer(event = {}, settings = {}) {
    try {
      if (settings.buyTtsEnabled === false) return false;
      const timestamp = now();
      pruneSeen(seen, timestamp, dedupeTtlMs);

      const key = makeBuyEventKey(event);
      if (key && seen.has(key)) return false;
      if (key) seen.set(key, timestamp);

      queue.push({ ...event, timestamp: event.timestamp || timestamp });
      pendingSettings = { ...pendingSettings, ...settings };
      if (timer) clearTimer(timer);
      const debounceMs = readPositiveNumber(settings.buyTtsDebounceMs, defaultDebounceMs);
      timer = setTimer(flush, debounceMs);
      return true;
    } catch (_) {
      return false;
    }
  }

  function flush() {
    try {
      const batch = queue.splice(0, queue.length);
      timer = null;
      if (!batch.length) return '';
      const text = batch.length > 1 ? buildGroupedBuySpeech(batch.length) : buildSingleBuySpeech(batch[0]);
      const speakSettings = pendingSettings;
      pendingSettings = {};
      void speak(text, speakSettings);
      return text;
    } catch (_) {
      return '';
    }
  }

  async function speakExternal(text, speakSettings = {}) {
    const fetchImpl = getFetch();
    const AudioCtor = getAudio();
    const createObjectUrl = getObjectUrl();
    if (typeof fetchImpl !== 'function' || typeof AudioCtor !== 'function' || typeof createObjectUrl !== 'function') return false;
    const headers = { 'Content-Type': 'application/json' };
    if (speakSettings.ttsApiToken) headers['x-local-api-token'] = String(speakSettings.ttsApiToken);
    const response = await fetchImpl(speakSettings.ttsEndpoint || '/api/tts/synthesize', {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: text })
    });
    if (!response?.ok) return false;
    const blob = await response.blob();
    if (!blob || !blob.size) return false;
    const url = createObjectUrl(blob);
    const audio = new AudioCtor(url);
    audio.volume = volume;
    await audio.play();
    lastSpokenText = text;
    return true;
  }

  async function speak(text, speakSettings = {}) {
    try {
      if (speakSettings.buyTtsExternalEnabled === true) {
        try {
          if (await speakExternal(text, speakSettings)) return true;
        } catch (_) {}
      }
      const speechSynthesis = getSpeechSynthesis();
      const Utterance = getUtteranceCtor();
      if (!speechSynthesis || typeof speechSynthesis.speak !== 'function' || typeof Utterance !== 'function') return false;

      const utterance = new Utterance(text);
      utterance.lang = lang;
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = volume;
      const voice = resolveVietnameseVoice(speechSynthesis);
      if (voice) utterance.voice = voice;

      speechSynthesis.speak(utterance);
      lastSpokenText = text;
      return true;
    } catch (_) {
      return false;
    }
  }

  function clear() {
    if (timer) clearTimer(timer);
    timer = null;
    queue = [];
    pendingSettings = {};
    seen.clear();
    lastSpokenText = '';
  }

  return {
    notifyBuyCustomer,
    flush,
    speak,
    speakExternal,
    clear,
    getQueueSize: () => queue.length,
    getLastSpokenText: () => lastSpokenText
  };
}

const defaultNotifier = createBuyTtsNotifier();

const PDBBuyTtsNotifier = {
  BUY_TTS_FULL_CONTACT_TEXT,
  BUY_TTS_NEW_CUSTOMER_TEXT,
  BUY_TTS_DEFAULT_DEBOUNCE_MS,
  BUY_TTS_DEDUPE_TTL_MS,
  normalizeText,
  hasFullContact,
  buildSingleBuySpeech,
  buildGroupedBuySpeech,
  makeBuyEventKey,
  createBuyTtsNotifier,
  notifyBuyCustomer: defaultNotifier.notifyBuyCustomer,
  flush: defaultNotifier.flush,
  speak: defaultNotifier.speak,
  speakExternal: defaultNotifier.speakExternal,
  clear: defaultNotifier.clear
};

if (typeof window !== 'undefined') window.PDBBuyTtsNotifier = PDBBuyTtsNotifier;
if (typeof module !== 'undefined' && module.exports) module.exports = PDBBuyTtsNotifier;
