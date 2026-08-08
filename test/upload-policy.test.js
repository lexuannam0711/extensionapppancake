const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_EXCEL_BYTES, isAllowedExcelUpload } = require('../src/server/uploadPolicy');

test('Excel upload policy accepts only bounded xls/xlsx metadata', () => {
  assert.equal(isAllowedExcelUpload({ originalname: 'shortcuts.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), true);
  assert.equal(isAllowedExcelUpload({ originalname: 'shortcuts.xls', mimetype: 'application/vnd.ms-excel' }), true);
  assert.equal(MAX_EXCEL_BYTES, 5 * 1024 * 1024);
});

test('Excel upload policy rejects misleading extensions and MIME types', () => {
  assert.equal(isAllowedExcelUpload({ originalname: 'payload.exe', mimetype: 'application/vnd.ms-excel' }), false);
  assert.equal(isAllowedExcelUpload({ originalname: 'payload.xlsx.exe', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), false);
  assert.equal(isAllowedExcelUpload({ originalname: 'shortcuts.xlsx', mimetype: 'application/octet-stream' }), false);
  assert.equal(isAllowedExcelUpload({ originalname: 'shortcuts.xlsx', mimetype: 'text/html' }), false);
});
