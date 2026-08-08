(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.PDBPancakeAutomationPayload = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const BLOCKED_RESULT_KEY = '__PDB_AUTOMATION_BLOCKED__';

  function requireCode(value, label) {
    const code = String(value || '');
    if (!code.trim()) throw new TypeError(`${label} code is required`);
    return code;
  }

  function pageStateExpression() {
    return 'window.PDBPancakeDom.classifyPancakePage(document, location.href)';
  }

  function buildProbePayload({ policyCode, domCode } = {}) {
    const policy = requireCode(policyCode, 'URL policy');
    const dom = requireCode(domCode, 'Pancake DOM');
    return `(function () {\n${policy}\n${dom}\nreturn ${pageStateExpression()};\n})()`;
  }

  function buildAdapterPayload({ policyCode, domCode, adapterCode } = {}) {
    const policy = requireCode(policyCode, 'URL policy');
    const dom = requireCode(domCode, 'Pancake DOM');
    const adapter = requireCode(adapterCode, 'Automation adapter');
    return `(function () {\n${policy}\n${dom}\nconst pageState = ${pageStateExpression()};\nif (pageState?.kind !== 'chat' || pageState?.isChatPage !== true) {\n  return { ${JSON.stringify(BLOCKED_RESULT_KEY)}: pageState };\n}\n${adapter}\nreturn true;\n})()`;
  }

  function isBlockedResult(result) {
    return Boolean(result && typeof result === 'object' && result[BLOCKED_RESULT_KEY]);
  }

  function canCommitAdapterResult(result, { expectedGeneration, currentGeneration, loaded } = {}) {
    return !isBlockedResult(result)
      && Number.isInteger(expectedGeneration)
      && currentGeneration === expectedGeneration
      && loaded === true;
  }

  return Object.freeze({
    BLOCKED_RESULT_KEY,
    buildProbePayload,
    buildAdapterPayload,
    isBlockedResult,
    canCommitAdapterResult
  });
});
