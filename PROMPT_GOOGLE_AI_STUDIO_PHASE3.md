Bạn là chuyên gia Electron Desktop App, Microsoft Edge/Chrome Extension Manifest V3, Node.js localhost server, DOM Automation Pancake/pages.fm, Gemini API và UI/UX SaaS dashboard.

Hãy xây dựng phiên bản GIAI ĐOẠN 3 của hệ thống Pancake Local AI Shortcut Bot theo hướng DESKTOP APP, không cần VPS và không cần mở Edge riêng.

MỤC TIÊU:
Tạo app desktop chạy local trên Windows bằng Electron. App mở Pancake/pages.fm bên trong cửa sổ desktop bằng webview, có panel điều khiển bên phải, server Node.js localhost chạy cùng app, upload Excel shortcut, AI phân tích tin nhắn khách hàng, gợi ý Best Shortcut + Top 3 shortcut phù hợp, và chỉ nhập/gửi shortcut dạng /n.

KIẾN TRÚC:
- Electron main process khởi động Express server tại http://localhost:8787.
- Renderer tạo layout 2 cột: bên trái là webview Pancake, bên phải là control panel.
- Webview dùng partition persist:pancake để giữ đăng nhập Pancake.
- Renderer inject automation.js vào webview để thao tác DOM Pancake.
- Server giữ GEMINI_API_KEY trong .env, không lưu secret trong UI.

CẤU TRÚC:
pancake-desktop-ai-shortcut-bot-v3/
├── package.json
├── .env.example
├── start-desktop.bat
├── src/
│   ├── main.js
│   ├── preload.js
│   ├── renderer/
│   │   ├── index.html
│   │   ├── style.css
│   │   ├── app.js
│   │   └── automation.js
│   └── server/
│       ├── index.js
│       ├── ai.js
│       ├── rules.js
│       ├── shortcutImporter.js
│       ├── shortcutMatcher.js
│       ├── store.js
│       └── validators.js
├── server/data/
│   ├── settings.json
│   ├── shortcuts.json
│   ├── logs.json
│   ├── queue.json
│   └── knowledge.json
└── README.md

YÊU CẦU AI:
AI không được tự viết tin nhắn. AI chỉ phân tích tin nhắn khách và chọn shortcut /n có trong Excel.
Endpoint bắt buộc:
POST /api/ai/analyze-message
Input:
{
  "customerMessage":"giá bao nhiêu em",
  "customerName":"Nguyễn Văn A",
  "currentTags":[],
  "context":{}
}
Output:
{
  "intent":"PRICE_QUESTION",
  "action":"SUGGEST_SHORTCUT",
  "bestShortcut":"/2",
  "confidence":0.92,
  "reason":"Khách hỏi giá",
  "topSuggestions":[
    {"shortcut":"/2","topic":"báo giá","confidence":0.92,"reason":"Phù hợp nhất"},
    {"shortcut":"/7","topic":"combo","confidence":0.71,"reason":"Có thể tư vấn combo"},
    {"shortcut":"/3","topic":"xin SĐT","confidence":0.45,"reason":"Nếu khách muốn mua"}
  ],
  "shouldSend":false,
  "shouldEscalate":false
}

Nếu khách gửi số điện thoại hoặc địa chỉ:
{
  "intent":"BUY_INTENT_HIGH",
  "action":"TAG_BUY_AND_MARK_UNREAD",
  "bestShortcut":null,
  "confidence":1,
  "reason":"Khách gửi SĐT/địa chỉ, cần chủ shop xử lý",
  "topSuggestions":[],
  "shouldSend":false,
  "shouldEscalate":true
}

INTENT:
GREETING, PRICE_QUESTION, PRODUCT_QUESTION, SHIPPING_QUESTION, USAGE_QUESTION, BUY_INTENT_LOW, BUY_INTENT_HIGH, PHONE_DETECTED, ADDRESS_DETECTED, REFUSAL, COMPLAINT, OUT_OF_SCOPE, UNKNOWN.

DOM PANCAKE SELECTOR:
- Khách chưa đọc: .conversation-list-item.unread
- Tên khách: .name-text
- Snippet: .snippet-text
- Tag hiện có: .list-tags-conv .conversation_tags_item
- List tag: #listShowTags
- Button tag: #listShowTags .btn-tag-item
- Ô nhập: textarea#replyBoxComposer
- Nút gửi: icon máy bay màu xanh trong reply_box
- Nút mark unread: .conv-action-btn có icon phong bì/thư

SAFETY RULE:
Bắt buộc có hàm trong automation.js:
function sanitizeOutgoingText(text) {
  const cleaned = String(text || '').trim()
  if (!/^\/\d+$/.test(cleaned)) {
    throw new Error('Blocked non-shortcut outgoing text: ' + cleaned)
  }
  return cleaned
}
Mọi nơi trước khi nhập vào textarea phải gọi sanitizeOutgoingText.
Không được setReplyText bằng câu trả lời tự do.
Chỉ được setReplyText('/1'), setReplyText('/2'), setReplyText(result.bestShortcut).

EXCEL:
Upload .xlsx/.xls với cột:
Shortcut | topic | quickReply | message | photos | folders | files
Server parse, preview lỗi, import vào server/data/shortcuts.json.

UI DESKTOP:
Giao diện đẹp, xịn, hiện đại:
- Bên trái webview Pancake.
- Bên phải panel control.
- Tabs: Tổng quan, Bot, Excel, Gợi ý, DOM Test, Logs.
- Cards bo góc 16px, shadow nhẹ, màu xanh lá/trắng/xanh dương.
- Có badge Server Online/Offline.
- Có card số khách chưa đọc, số shortcuts, trạng thái Bot/Auto Send.
- AI Matching hiển thị Best Shortcut, Intent, Confidence, Reason, Top 3 gợi ý, nút điền shortcut.
- DOM Test có nút tìm khách unread, nhập /1, tìm nút gửi, gắn tag KHÁCH MỚI, gắn tag Mua hàng, mark unread.
- Emergency Stop dừng ngay bot loop.

BOT LOOP:
1. Quét unread.
2. Click khách đầu tiên.
3. Đọc snippet/tag.
4. Gọi /api/ai/analyze-message.
5. Nếu BUY_INTENT_HIGH/PHONE/ADDRESS: gắn Mua hàng, mark unread, không gửi.
6. Nếu khách chưa có tag: gắn KHÁCH MỚI, nhập /1, autoSend thì gửi.
7. Nếu khách có tag: nhập bestShortcut, autoSend thì gửi nếu confidence đủ.
8. Không bỏ sót khách, mỗi lần xử lý 1 khách, delay 3 giây, lỗi thì log và next.

README tiếng Việt đầy đủ: cách cài Node.js, copy .env, lấy Gemini key, npm install, npm start, đăng nhập Pancake trong app, upload Excel, test DOM, bật bán tự động, bật auto send, emergency stop, lỗi thường gặp.

Hãy tạo mã nguồn đầy đủ, không chỉ giải thích.
