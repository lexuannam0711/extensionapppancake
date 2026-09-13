const path = require('path');

const MAX_EXCEL_BYTES = 5 * 1024 * 1024;
const EXCEL_MIME_TYPES = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);
const EXCEL_EXTENSIONS = new Set(['.xls', '.xlsx']);

function isAllowedExcelUpload(file = {}) {
  const extension = path.extname(String(file.originalname || '')).toLowerCase();
  return EXCEL_EXTENSIONS.has(extension)
    && EXCEL_MIME_TYPES.has(String(file.mimetype || '').toLowerCase());
}

module.exports = { MAX_EXCEL_BYTES, isAllowedExcelUpload };
