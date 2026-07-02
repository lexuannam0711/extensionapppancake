const XLSX = require('xlsx');
const { isShortcut } = require('./validators');

const requiredHeaders = ['Shortcut', 'topic', 'quickReply', 'message', 'photos', 'folders', 'files'];

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase();
}

function getCell(row, header) {
  const key = Object.keys(row).find((k) => normalizeHeader(k) === normalizeHeader(header));
  return key ? String(row[key] ?? '').trim() : '';
}

function parseExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const validRows = [];
  const errors = [];

  rows.forEach((row, index) => {
    const line = index + 2;
    const item = {
      shortcut: getCell(row, 'Shortcut'),
      topic: getCell(row, 'topic'),
      quickReply: getCell(row, 'quickReply'),
      message: getCell(row, 'message'),
      photos: getCell(row, 'photos'),
      folders: getCell(row, 'folders'),
      files: getCell(row, 'files')
    };
    const isEmpty = Object.values(item).every((v) => !String(v || '').trim());
    if (isEmpty) return;
    if (!item.shortcut) {
      errors.push({ line, error: 'Thiếu Shortcut', item });
      return;
    }
    if (!isShortcut(item.shortcut)) {
      errors.push({ line, error: 'Shortcut phải có dạng /n, ví dụ /1', item });
      return;
    }
    if (!item.topic && !item.quickReply && !item.message) {
      errors.push({ line, error: 'Nên có ít nhất topic, quickReply hoặc message', item });
      return;
    }
    const now = new Date().toISOString();
    validRows.push({ ...item, createdAt: now, updatedAt: now });
  });

  return { sheetName, headers: requiredHeaders, validRows, errors, totalRows: rows.length };
}

function createTemplateBuffer() {
  const rows = [
    ['Shortcut', 'topic', 'quickReply', 'message', 'photos', 'folders', 'files'],
    ['/1', 'chào khách mới', 'chào khách', 'dạ em chào anh/chị ạ', '', 'khách mới', ''],
    ['/2', 'báo giá', 'giá bao nhiêu combo báo giá', 'dạ em gửi bảng giá cho mình tham khảo ạ', '', 'giá', ''],
    ['/3', 'xin số điện thoại', 'muốn mua đặt hàng xin sđt', 'dạ anh/chị cho em xin số điện thoại để shop lên đơn ạ', '', 'mua hàng', ''],
    ['/4', 'ship vận chuyển', 'ship giao hàng phí ship cod', 'dạ shop có hỗ trợ giao hàng toàn quốc ạ', '', 'ship', '']
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'shortcuts');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { parseExcel, createTemplateBuffer };
