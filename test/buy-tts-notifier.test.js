const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  BUY_TTS_FULL_CONTACT_TEXT,
  BUY_TTS_NEW_CUSTOMER_TEXT,
  hasFullContact,
  buildSingleBuySpeech,
  buildGroupedBuySpeech,
  createBuyTtsNotifier
} = require('../src/renderer/buyTtsNotifier');

const APPROVED_FULL_CONTACT_SPEECH = 'Khách mua hàng, địa chỉ và số điện thoại đầy đủ';
const APPROVED_NEW_CUSTOMER_SPEECH = 'Khách mua hàng mới';
const APPROVED_GROUPED_SPEECH_FOR_TWO = 'Có 2 khách mua hàng';
const APPROVED_GROUPED_SPEECH_FOR_FIVE = 'Có 5 khách mua hàng';

function createClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map();

  function runDueTimers() {
    let ran = true;
    while (ran) {
      ran = false;
      for (const [id, timer] of Array.from(timers.entries())) {
        if (timer.at <= current) {
          timers.delete(id);
          timer.fn();
          ran = true;
        }
      }
    }
  }

  return {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: current + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick(ms) {
      current += ms;
      runDueTimers();
    }
  };
}

function createSpeechMock() {
  const spoken = [];
  function Utterance(text) {
    this.text = text;
  }
  return {
    spoken,
    Utterance,
    speechSynthesis: {
      getVoices: () => [{ lang: 'vi-VN', name: 'Vietnamese' }],
      speak: (utterance) => spoken.push({
        text: utterance.text,
        lang: utterance.lang,
        volume: utterance.volume,
        voiceLang: utterance.voice ? utterance.voice.lang : ''
      })
    }
  };
}

test('buy tts: exports approved Vietnamese speech literals', () => {
  assert.equal(BUY_TTS_FULL_CONTACT_TEXT, APPROVED_FULL_CONTACT_SPEECH);
  assert.equal(BUY_TTS_NEW_CUSTOMER_TEXT, APPROVED_NEW_CUSTOMER_SPEECH);
});

test('buy tts: source contains approved UTF-8 Vietnamese literals', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'buyTtsNotifier.js'), 'utf8');

  assert.equal(source.includes(`const BUY_TTS_FULL_CONTACT_TEXT = '${APPROVED_FULL_CONTACT_SPEECH}';`), true);
  assert.equal(source.includes(`const BUY_TTS_NEW_CUSTOMER_TEXT = '${APPROVED_NEW_CUSTOMER_SPEECH}';`), true);
  assert.equal(source.includes('return `Có ${Number(count) || 0} khách mua hàng`;'), true);
});

test('buy tts: chooses full-contact speech only when phone and address are present', () => {
  assert.equal(hasFullContact({ phone: '0912345678', address: '12 Nguyễn Trãi' }), true);
  assert.equal(hasFullContact({ phone: '0912345678', address: '' }), false);
  assert.equal(hasFullContact({ phone: '', address: '12 Nguyễn Trãi' }), false);
  assert.equal(hasFullContact({}), false);

  assert.equal(
    buildSingleBuySpeech({ phone: '0912345678', address: '12 Nguyễn Trãi' }),
    APPROVED_FULL_CONTACT_SPEECH
  );
  assert.equal(buildSingleBuySpeech({ phone: '0912345678' }), APPROVED_NEW_CUSTOMER_SPEECH);
  assert.equal(buildSingleBuySpeech({ address: '12 Nguyễn Trãi' }), APPROVED_NEW_CUSTOMER_SPEECH);
});

test('buy tts: builds grouped speech with customer count', () => {
  assert.equal(buildGroupedBuySpeech(2), APPROVED_GROUPED_SPEECH_FOR_TWO);
  assert.equal(buildGroupedBuySpeech(5), APPROVED_GROUPED_SPEECH_FOR_FIVE);
});

test('buy tts: speaks one full-contact event after debounce window', () => {
  const clock = createClock();
  const speech = createSpeechMock();
  const notifier = createBuyTtsNotifier({
    speechSynthesis: speech.speechSynthesis,
    SpeechSynthesisUtterance: speech.Utterance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    debounceMs: 1500
  });

  assert.equal(notifier.notifyBuyCustomer({ phone: '0912345678', address: '12 Nguyễn Trãi' }), true);
  clock.tick(1499);
  assert.equal(speech.spoken.length, 0);
  clock.tick(1);

  assert.equal(speech.spoken.length, 1);
  assert.equal(speech.spoken[0].text, APPROVED_FULL_CONTACT_SPEECH);
  assert.equal(speech.spoken[0].lang, 'vi-VN');
  assert.equal(speech.spoken[0].volume, 1);
  assert.equal(speech.spoken[0].voiceLang, 'vi-VN');
});

test('buy tts: groups two buy events that arrive inside one debounce window', () => {
  const clock = createClock();
  const speech = createSpeechMock();
  const notifier = createBuyTtsNotifier({
    speechSynthesis: speech.speechSynthesis,
    SpeechSynthesisUtterance: speech.Utterance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    debounceMs: 1500
  });

  assert.equal(notifier.notifyBuyCustomer({ customerName: 'A', message: 'mua 1' }), true);
  clock.tick(500);
  assert.equal(notifier.notifyBuyCustomer({ customerName: 'B', message: 'mua 2' }), true);
  clock.tick(1499);
  assert.equal(speech.spoken.length, 0);
  clock.tick(1);

  assert.equal(speech.spoken.length, 1);
  assert.equal(speech.spoken[0].text, APPROVED_GROUPED_SPEECH_FOR_TWO);
});

test('buy tts: separated events outside debounce become separate speech messages', () => {
  const clock = createClock();
  const speech = createSpeechMock();
  const notifier = createBuyTtsNotifier({
    speechSynthesis: speech.speechSynthesis,
    SpeechSynthesisUtterance: speech.Utterance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    debounceMs: 1500
  });

  assert.equal(notifier.notifyBuyCustomer({ customerName: 'A', message: 'mua 1' }), true);
  clock.tick(1500);
  assert.equal(notifier.notifyBuyCustomer({ customerName: 'B', message: 'mua 2' }), true);
  clock.tick(1500);

  assert.deepEqual(speech.spoken.map((item) => item.text), [
    APPROVED_NEW_CUSTOMER_SPEECH,
    APPROVED_NEW_CUSTOMER_SPEECH
  ]);
});

test('buy tts: dedupes the same event inside ttl', () => {
  const clock = createClock();
  const speech = createSpeechMock();
  const notifier = createBuyTtsNotifier({
    speechSynthesis: speech.speechSynthesis,
    SpeechSynthesisUtterance: speech.Utterance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    debounceMs: 1500,
    dedupeTtlMs: 60000
  });
  const event = {
    customerName: 'Khách A',
    phone: '0912345678',
    address: '12 Nguyễn Trãi',
    message: 'mua hàng giao em'
  };

  assert.equal(notifier.notifyBuyCustomer(event), true);
  assert.equal(notifier.notifyBuyCustomer(event), false);
  clock.tick(1500);

  assert.equal(speech.spoken.length, 1);
  assert.equal(speech.spoken[0].text, APPROVED_FULL_CONTACT_SPEECH);
});

test('buy tts: disabled setting prevents queueing and speaking', () => {
  const clock = createClock();
  const speech = createSpeechMock();
  const notifier = createBuyTtsNotifier({
    speechSynthesis: speech.speechSynthesis,
    SpeechSynthesisUtterance: speech.Utterance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    debounceMs: 1500
  });

  assert.equal(notifier.notifyBuyCustomer({ customerName: 'A' }, { buyTtsEnabled: false }), false);
  clock.tick(1500);

  assert.equal(speech.spoken.length, 0);
});

test('buy tts: missing speech support fails softly', () => {
  const clock = createClock();
  const notifier = createBuyTtsNotifier({
    speechSynthesis: null,
    SpeechSynthesisUtterance: null,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    debounceMs: 1500
  });

  assert.equal(notifier.notifyBuyCustomer({ customerName: 'A' }), true);
  clock.tick(1500);

  assert.equal(notifier.getLastSpokenText(), '');
});
