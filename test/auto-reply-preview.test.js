'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Preview = require('../src/renderer/autoReplyPreview.js');

test('normalizes isolated settings and validates shortcut', () => {
  assert.equal(Preview.normalizeSettings({ replyText: '/2' }).replyText, '/2');
  assert.throws(() => Preview.normalizeSettings({ replyText: 'hello' }), /Shortcut/);
});

test('findUnread selects first visible unprocessed conversation', () => {
  const hidden = { isConnected: true, parentElement: { id: 'hidden' }, getClientRects: () => [], id: '' };
  const visible = { isConnected: true, parentElement: { id: 'ready' }, getClientRects: () => [1], id: '' };
  const documentRef = { querySelectorAll: () => [hidden, visible] };
  assert.equal(Preview.findUnread(documentRef, new Set()) , visible);
});

test('preview path matcher uses Pancake message action path', async () => {
  const path = { getAttribute: () => `${Preview.MESSAGE_PATH_PREFIX} extra` };
  const action = { querySelector: () => path, dispatchEvent: () => true };
  const documentRef = { dispatchEvent: () => true, querySelector: () => null, querySelectorAll: () => [action] };
  const windowRef = { KeyboardEvent: class {}, MouseEvent: class {}, setTimeout };
  await assert.rejects(Preview.openPreview({ documentRef, windowRef, timeoutMs: 1 }), (error) => error.code === Preview.ERROR_CODES.PREVIEW_OPEN_FAILED);
});

test('controller stop aborts an idle wait immediately', async () => {
  const documentRef = { querySelectorAll: () => [], defaultView: undefined };
  const controller = Preview.createController({ documentRef, windowRef: {} });
  controller.start({ loopDelayMs: 60000 });
  controller.stop();
  await controller.promise;
  assert.equal(controller.getStatus().state, 'stopped');
});

test('hidden preview is treated as closed during confirmation', async () => {
  let visiblePreview = true;
  let currentInput;
  class FakeEvent { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  class FakeTextarea {
    constructor() { this.isConnected = true; this.disabled = false; this.readOnly = false; this.value = ''; }
    getClientRects() { return visiblePreview ? [1] : []; }
    focus() { documentRef.activeElement = this; }
    getAttribute() { return null; }
    dispatchEvent(event) { if (event.type === 'keydown') visiblePreview = false; return true; }
  }
  const windowRef = { HTMLTextAreaElement: FakeTextarea, HTMLInputElement: FakeTextarea, Event: FakeEvent, KeyboardEvent: FakeEvent };
  const documentRef = { activeElement: null, defaultView: undefined, querySelector(selector) { if (selector === '#previewReplyInput') return visiblePreview ? (currentInput ||= new FakeTextarea()) : currentInput; return null; } };
  const result = await Preview.sendPreview({ documentRef, windowRef, settings: { replyText: '/2', waitBeforePreviewSendMs: 1, selectorTimeoutMs: 20, waitBeforeOuterReplyMs: 20 }, signal: new AbortController().signal });
  assert.equal(result, true);
});
