(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PDBAutoReplyPreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ERROR_CODES = Object.freeze({
    PREVIEW_OPEN_FAILED: 'PREVIEW_OPEN_FAILED',
    PREVIEW_SEND_UNVERIFIED: 'PREVIEW_SEND_UNVERIFIED',
    PREVIEW_NOT_ACTIONABLE: 'PREVIEW_NOT_ACTIONABLE',
    OUTSIDE_REPLY_NOT_STABLE: 'OUTSIDE_REPLY_NOT_STABLE',
    AUTOMATION_BUSY: 'AUTOMATION_BUSY'
  });
  const DEFAULTS = Object.freeze({
    replyText: '/2', waitAfterConversationClickMs: 2000,
    waitBeforePreviewSendMs: 2000, waitBeforeOuterReplyMs: 6000,
    loopDelayMs: 1000, selectorTimeoutMs: 15000
  });
  const SELECTORS = Object.freeze({ unread: '.media.conversation-list-item.unread', preview: '#previewReplyInput', outer: '#replyBoxComposer', action: 'svg.message-action' });
  const MESSAGE_PATH_PREFIX = 'm14.3 20q0 1.2-0.9 2t-2 0.9';

  function abortError() { const error = new Error('Preview Reply stopped'); error.name = 'AbortError'; return error; }
  function sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(abortError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  function normalizeSettings(raw = {}) {
    const number = (key, min, max) => {
      const value = Number(raw[key]);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : DEFAULTS[key];
    };
    const replyText = String(raw.replyText ?? DEFAULTS.replyText).trim();
    if (!/^\/\d+$/.test(replyText)) throw new TypeError('Shortcut phải có dạng /number');
    return { replyText, waitAfterConversationClickMs: number('waitAfterConversationClickMs', 250, 60000), waitBeforePreviewSendMs: number('waitBeforePreviewSendMs', 250, 60000), waitBeforeOuterReplyMs: number('waitBeforeOuterReplyMs', 250, 60000), loopDelayMs: number('loopDelayMs', 250, 60000), selectorTimeoutMs: number('selectorTimeoutMs', 1000, 120000) };
  }
  function visible(element, getComputedStyleRef) {
    if (!element || !element.isConnected) return false;
    if (typeof element.getClientRects === 'function' && !element.getClientRects().length) return false;
    const style = getComputedStyleRef?.(element);
    return !style || (style.display !== 'none' && style.visibility !== 'hidden');
  }
  function actionable(element, documentRef, getComputedStyleRef) {
    return visible(element, getComputedStyleRef) && !element.disabled && !element.readOnly && element.getAttribute?.('aria-disabled') !== 'true' && documentRef.activeElement === element;
  }
  function getConversationId(item) { return String(item?.id || item?.parentElement?.id || '').replace(/__\d+$/, ''); }
  function findUnread(documentRef, processed) {
    return Array.from(documentRef.querySelectorAll(SELECTORS.unread)).find((item) => visible(item, documentRef.defaultView?.getComputedStyle) && !processed.has(getConversationId(item)));
  }
  function setValue(element, value, windowRef) {
    const proto = element instanceof windowRef.HTMLTextAreaElement ? windowRef.HTMLTextAreaElement.prototype : windowRef.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(element, value); else element.value = value;
    element.dispatchEvent(new windowRef.Event('input', { bubbles: true }));
    element.dispatchEvent(new windowRef.Event('change', { bubbles: true }));
  }
  async function waitForPreview(documentRef, timeoutMs, signal) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) throw abortError();
      const element = documentRef.querySelector(SELECTORS.preview);
      if (element && visible(element, documentRef.defaultView?.getComputedStyle)) return element;
      await sleep(25, signal);
    }
    return null;
  }
  function pressEnter(element, windowRef) {
    element.dispatchEvent(new windowRef.KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
  }
  async function openPreview({ documentRef, windowRef, timeoutMs, signal }) {
    const event = new windowRef.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'b', code: 'KeyB', altKey: true });
    documentRef.dispatchEvent(event);
    if (typeof windowRef.dispatchEvent === 'function') windowRef.dispatchEvent(event);
    if (await waitForPreview(documentRef, timeoutMs, signal)) return { ok: true, method: 'alt-b' };
    const selectors = ['.media-current-customer svg.message-action', '#message-col-list svg.message-action', SELECTORS.action];
    let action = null;
    for (const selector of selectors) {
      action = Array.from(documentRef.querySelectorAll(selector)).reverse().find((node) => visible(node, documentRef.defaultView?.getComputedStyle) && node.querySelector('path')?.getAttribute('d')?.trim().startsWith(MESSAGE_PATH_PREFIX));
      if (action) break;
    }
    if (action) {
      action.dispatchEvent(new windowRef.MouseEvent('click', { bubbles: true, cancelable: true }));
      if (await waitForPreview(documentRef, timeoutMs, signal)) return { ok: true, method: 'dom-fallback' };
    }
    const error = new Error('Không mở được preview'); error.code = ERROR_CODES.PREVIEW_OPEN_FAILED; throw error;
  }
  async function sendPreview({ documentRef, windowRef, settings, signal }) {
    await sleep(settings.waitBeforePreviewSendMs, signal);
    let input = await waitForPreview(documentRef, settings.selectorTimeoutMs, signal);
    if (!input) { const error = new Error('Preview không tồn tại'); error.code = ERROR_CODES.PREVIEW_NOT_ACTIONABLE; throw error; }
    input.focus();
    if (!actionable(input, documentRef, documentRef.defaultView?.getComputedStyle)) { const error = new Error('Preview không actionable'); error.code = ERROR_CODES.PREVIEW_NOT_ACTIONABLE; throw error; }
    setValue(input, settings.replyText, windowRef); pressEnter(input, windowRef);
    await sleep(2000, signal);
    input = visible(documentRef.querySelector(SELECTORS.preview), documentRef.defaultView?.getComputedStyle)
      ? documentRef.querySelector(SELECTORS.preview) : null;
    if (input && visible(input, documentRef.defaultView?.getComputedStyle)) {
      input.focus();
      if (!actionable(input, documentRef, documentRef.defaultView?.getComputedStyle)) { const error = new Error('Preview không actionable'); error.code = ERROR_CODES.PREVIEW_NOT_ACTIONABLE; throw error; }
      setValue(input, settings.replyText, windowRef); pressEnter(input, windowRef);
    }
    const started = Date.now();
    while (Date.now() - started < settings.waitBeforeOuterReplyMs) {
      if (signal?.aborted) throw abortError();
      if (!visible(documentRef.querySelector(SELECTORS.preview), documentRef.defaultView?.getComputedStyle)) return true;
      await sleep(50, signal);
    }
    const error = new Error('Không xác minh được preview đã gửi'); error.code = ERROR_CODES.PREVIEW_SEND_UNVERIFIED; throw error;
  }
  async function sendOuter({ documentRef, windowRef, settings, signal }) {
    const started = Date.now(); let input;
    while (Date.now() - started < settings.selectorTimeoutMs) {
      if (signal?.aborted) return false;
      input = documentRef.querySelector(SELECTORS.outer);
      if (visible(input, documentRef.defaultView?.getComputedStyle) && !input.disabled && !input.readOnly && input.getAttribute?.('aria-disabled') !== 'true') {
        input.focus();
        if (actionable(input, documentRef, documentRef.defaultView?.getComputedStyle)) break;
      }
      await sleep(25, signal);
    }
    if (!actionable(input, documentRef, documentRef.defaultView?.getComputedStyle)) { const error = new Error('Ô trả lời ngoài không ổn định'); error.code = ERROR_CODES.OUTSIDE_REPLY_NOT_STABLE; throw error; }
    setValue(input, settings.replyText, windowRef); pressEnter(input, windowRef); await sleep(250, signal);
    if (!signal?.aborted) {
      input = documentRef.querySelector(SELECTORS.outer);
      if (!visible(input, documentRef.defaultView?.getComputedStyle) || input.disabled || input.readOnly) { const error = new Error('Ô trả lời ngoài không actionable'); error.code = ERROR_CODES.OUTSIDE_REPLY_NOT_STABLE; throw error; }
      input.focus();
      if (actionable(input, documentRef, documentRef.defaultView?.getComputedStyle)) pressEnter(input, windowRef);
    }
    return true;
  }
  function createController({ documentRef, windowRef }) {
    let status = { state: 'idle', phase: 'idle', processedCount: 0, attemptedCount: 0, failedCount: 0, lastError: '', lastErrorCode: '' };
    let abortController = null; let promise = null;
    const getStatus = () => ({ ...status });
    async function run(settings) {
      const attempted = new Set();
      try { while (!abortController.signal.aborted) {
        const item = findUnread(documentRef, attempted); if (!item) { status = { ...status, phase: 'waiting_unread' }; await sleep(settings.loopDelayMs, abortController.signal); continue; }
        const id = getConversationId(item); attempted.add(id); status = { ...status, phase: 'opening_preview', attemptedCount: status.attemptedCount + 1 };
        try { item.click(); await sleep(settings.waitAfterConversationClickMs, abortController.signal); await openPreview({ documentRef, windowRef, timeoutMs: settings.selectorTimeoutMs, signal: abortController.signal }); status = { ...status, phase: 'sending_preview' }; await sendPreview({ documentRef, windowRef, settings, signal: abortController.signal }); status = { ...status, phase: 'sending_outer_reply' }; await sendOuter({ documentRef, windowRef, settings, signal: abortController.signal }); status = { ...status, phase: 'completed_customer', processedCount: status.processedCount + 1 }; }
        catch (error) { status = { ...status, phase: error.code === ERROR_CODES.PREVIEW_SEND_UNVERIFIED ? 'failed' : 'customer_failed', failedCount: status.failedCount + 1, lastError: String(error.message || error), lastErrorCode: error.code || '' }; if (error.code === ERROR_CODES.PREVIEW_SEND_UNVERIFIED) break; }
        await sleep(settings.loopDelayMs, abortController.signal);
      } } catch (error) {
        if (error.name !== 'AbortError') status = { ...status, state: 'failed', phase: 'failed', failedCount: status.failedCount + 1, lastError: 'Preview Reply failed', lastErrorCode: error.code || 'PREVIEW_SEND_UNVERIFIED' };
      }
      status = { ...status, state: abortController.signal.aborted ? 'stopped' : status.phase === 'failed' ? 'failed' : 'stopped', phase: abortController.signal.aborted ? 'stopped' : status.phase };
    }
    return { getStatus, start(raw) { if (promise) return getStatus(); const settings = normalizeSettings(raw); abortController = new AbortController(); status = { state: 'running', phase: 'starting', processedCount: 0, attemptedCount: 0, failedCount: 0, lastError: '', lastErrorCode: '' }; promise = run(settings).finally(() => { promise = null; abortController = null; }); return getStatus(); }, stop() { if (abortController) { status = { ...status, state: 'stopping', phase: 'stopping' }; abortController.abort(); } return getStatus(); }, get promise() { return promise; } };
  }
  const api = Object.freeze({ ERROR_CODES, DEFAULTS, SELECTORS, MESSAGE_PATH_PREFIX, normalizeSettings, visible, actionable, getConversationId, findUnread, setValue, openPreview, sendPreview, sendOuter, createController });
  const globalScope = typeof globalThis !== 'undefined' ? globalThis : this;
  if (typeof module === 'undefined' && globalScope?.document) globalScope.PDBAutoReplyPreviewController = createController({ documentRef: globalScope.document, windowRef: globalScope });
  return api;
});
