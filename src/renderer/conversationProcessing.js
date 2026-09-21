(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.PDBConversationProcessing = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function createConversationProcessingCoordinator(dependencies = {}) {
    const {
      claims,
      isProcessed = () => false,
      commitProcessed = () => {},
      isConversationBlocked = () => false,
      blockConversation = () => {},
      claimRefreshIntervalMs = 20000,
      setIntervalFn = setInterval,
      clearIntervalFn = clearInterval
    } = dependencies;

    if (!claims?.claimConversation || !claims?.releaseConversationClaim) {
      throw new TypeError('Conversation processing requires a claims registry');
    }

    const deferredLeases = new Map();

    function stopDeferredLease(key) {
      const lease = deferredLeases.get(key);
      if (!lease) return null;
      deferredLeases.delete(key);
      clearIntervalFn(lease.timer);
      return lease;
    }

    function refreshDeferred(job = {}) {
      const key = String(job.key || '').trim();
      const lease = deferredLeases.get(key);
      if (!key || !lease || lease.runtime !== job.runtime || lease.lost) return false;
      if (claims.claimConversation(key, job.runtime)) return true;
      lease.lost = true;
      stopDeferredLease(key);
      return false;
    }

    function startDeferredLease(job) {
      const key = String(job.key || '').trim();
      stopDeferredLease(key);
      const lease = { runtime: job.runtime, lost: false, timer: null };
      deferredLeases.set(key, lease);
      lease.timer = setIntervalFn(() => refreshDeferred(job), Math.max(1000, claimRefreshIntervalMs));
      if (typeof lease.timer?.unref === 'function') lease.timer.unref();
    }

    async function uncertainResult(job, actionResult) {
      blockConversation(job.key);
      return { ok: false, code: 'UNCERTAIN', uncertain: true };
    }

    async function process(job = {}) {
      const key = String(job.key || '').trim();
      if (!key || !job.runtime || typeof job.performAction !== 'function') {
        return { ok: false, code: 'INVALID_JOB' };
      }
      if (isConversationBlocked(key)) return { ok: false, code: 'CONVERSATION_BLOCKED' };
      if (isProcessed(key, job.runtime)) return { ok: false, code: 'ALREADY_PROCESSED' };
      if (!claims.claimConversation(key, job.runtime)) return { ok: false, code: 'CLAIM_REJECTED' };

      let keepClaim = false;
      try {
        const result = await job.performAction();
        if (result?.uncertain || (result?.dispatched && result?.ok === false)) {
          return await uncertainResult(job, result);
        }
        if (!result?.ok) {
          return { ok: false, code: String(result?.code || 'ACTION_FAILED') };
        }
        if (job.deferCompletion) {
          keepClaim = true;
          startDeferredLease(job);
          return { ...result, ok: true, deferred: true };
        }
        commitProcessed(key, job.runtime);
        return { ...result, ok: true };
      } catch (error) {
        if (error?.uncertain || error?.dispatched) return await uncertainResult(job, error);
        throw error;
      } finally {
        if (!keepClaim) claims.releaseConversationClaim(key, job.runtime);
      }
    }

    function completeDeferred(job = {}, options = {}) {
      const key = String(job.key || '').trim();
      if (!key || !job.runtime) return false;
      const lease = deferredLeases.get(key);
      if (!lease || lease.runtime !== job.runtime || lease.lost) return false;
      stopDeferredLease(key);
      const released = claims.releaseConversationClaim(key, job.runtime);
      if (released && options.commit) commitProcessed(key, job.runtime);
      return released;
    }

    async function failDeferred(job = {}, actionResult = {}) {
      const key = String(job.key || '').trim();
      if (!key || !job.runtime) return { ok: false, code: 'INVALID_JOB' };
      stopDeferredLease(key);
      try {
        return await uncertainResult(job, actionResult);
      } finally {
        claims.releaseConversationClaim(key, job.runtime);
      }
    }

    return { process, refreshDeferred, completeDeferred, failDeferred };
  }

  return { createConversationProcessingCoordinator };
});
