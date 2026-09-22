# 🥞 Pancake Desktop AI Shortcut Bot v3

> **Desktop automation tool for Pancake.vn**  
> Electron + Node.js + OpenAI + Excel Shortcut

Pancake Desktop AI Shortcut Bot v3 là ứng dụng desktop chạy trên **Electron**, cho phép thao tác trực tiếp với Pancake.vn thông qua WebView, kết hợp **AI phân tích tin nhắn khách hàng** và hệ thống **Shortcut `/n`** để hỗ trợ tự động hóa quá trình chăm sóc khách hàng.

Ứng dụng được thiết kế theo hướng **local-first**: server chạy trực tiếp trên máy tính, không yêu cầu VPS hay server bên ngoài.

---

## ✨ Tính năng chính

| Tính năng | Mô tả |
|---|---|
| 🖥️ Electron Desktop | Chạy Pancake trực tiếp trong ứng dụng desktop |
| 🌐 Pancake WebView | Không cần mở Edge/Chrome riêng |
| 🚀 Local Server | Node.js server chạy tại `localhost:8787` |
| 🤖 AI Analysis | AI phân tích nội dung tin nhắn khách hàng |
| ⚡ Shortcut `/n` | Bot chỉ thao tác với shortcut được cấu hình |
| 📊 Excel Import | Import hàng loạt shortcut từ file `.xlsx` |
| 🏷️ Auto Tag | Tự động xử lý tag khách hàng |
| 🔄 Mark Unread | Đánh dấu lại hội thoại để nhân viên xử lý |
| 🛑 Emergency Stop | Dừng bot ngay lập tức |
| 🧪 DOM Test | Kiểm tra từng thao tác trước khi bật automation |
| 🔐 Safe Mode | Mặc định tắt bot và auto-send |

---

# 🏗️ Kiến trúc hệ thống

```text
┌──────────────────────────────────────────────┐
│           Pancake Desktop Electron           │
│                                              │
│  ┌──────────────┐      ┌─────────────────┐  │
│  │ Pancake      │      │ Bot Control     │  │
│  │ WebView      │      │ Panel           │  │
│  └──────┬───────┘      └────────┬────────┘  │
│         │                        │           │
│         └────────────┬───────────┘           │
│                      │                       │
│              ┌───────▼────────┐              │
│              │ Node.js Server │              │
│              │ localhost:8787  │              │
│              └───────┬────────┘              │
│                      │                       │
│          ┌───────────┼────────────┐          │
│          │           │            │          │
│     ┌────▼────┐ ┌────▼─────┐ ┌───▼──────┐  │
│     │ Shortcut│ │ AI Engine│ │ Settings  │  │
│     │  Excel  │ │ OpenAI   │ │ & Logs    │  │
│     └─────────┘ └──────────┘ └───────────┘  │
│                                              │
└──────────────────────────────────────────────┘
```

### Nguyên tắc hoạt động

- Pancake được mở trực tiếp trong Electron.
- Node.js server chạy nội bộ tại `localhost:8787`.
- Shortcut được quản lý từ Excel.
- AI chỉ lựa chọn shortcut có sẵn.
- Bot chỉ được phép nhập nội dung theo format `/n`.
- Các trường hợp nhạy cảm như **SĐT / địa chỉ** sẽ không tự gửi tin nhắn.
- `botEnabled` và `autoSend` mặc định `false`.

---

# 📋 Yêu cầu hệ thống

### Phần mềm

- Windows 10/11
- Node.js LTS
- npm
- Kết nối Internet
- Tài khoản Pancake.vn

### Không yêu cầu

- ❌ VPS
- ❌ Docker
- ❌ Server riêng
- ❌ Edge/Chrome chạy riêng
- ❌ Pancake API server riêng

---

# 🚀 Cài đặt

## 1. Cài Node.js

Cài phiên bản **Node.js LTS**.

Kiểm tra:

```bat
node -v
npm -v
```

---

## 2. Cài đặt project

Giải nén source code và mở terminal tại thư mục project.

```bat
npm install
```

---

## 3. Tạo file `.env`

Copy file mẫu:

```bat
copy .env.example .env
```

Sau đó mở `.env` và cấu hình AI.

```env
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=sk-xxxxxxxxxxxxxxxx
AI_MODEL=gpt-5-mini
```

> Nếu không sử dụng AI, có thể để phần AI configuration trống tùy theo cấu hình của project.

---

# ▶️ Chạy ứng dụng

### Cách 1 — npm

```bat
npm start
```

### Cách 2 — Windows Batch

```bat
start-desktop.bat
```

Sau khi khởi động, Electron sẽ mở ứng dụng desktop và Node.js server sẽ chạy nội bộ:

```text
http://localhost:8787
```

---

# 🔐 Đăng nhập Pancake

Ứng dụng mở Pancake:

```text
https://pancake.vn/multi_pages
```

Đăng nhập Pancake như bình thường.

Electron sử dụng persistent session:

```text
partition="persist:pancake"
```

Do đó phiên đăng nhập sẽ được giữ lại giữa các lần mở ứng dụng nếu Electron/Pancake cho phép lưu session.

---

# 📊 Quản lý Shortcut bằng Excel

Vào tab:

```text
Excel
```

Upload file:

```text
.xlsx
```

File Excel cần có các cột:

```text
Shortcut
topic
quickReply
message
photos
folders
files
```

## Ví dụ

| Shortcut | topic | quickReply | message | photos | folders | files |
|---|---|---|---|---|---|---|
| `/1` | chào khách mới | chào khách | dạ em chào anh/chị ạ | | khách mới | |
| `/2` | báo giá | giá bao nhiêu combo | dạ em gửi bảng giá cho mình ạ | | giá | |
| `/3` | xin số điện thoại | muốn mua đặt hàng | dạ anh/chị cho em xin SĐT ạ | | mua hàng | |

### Quy tắc Shortcut

Shortcut bắt buộc phải có format:

```text
/n
```

Ví dụ hợp lệ:

```text
/1
/2
/10
/25
```

Ví dụ không hợp lệ:

```text
hello
xin chào
giá sản phẩm
/abc
shortcut1
```

Bot không được tự tạo shortcut mới ngoài dữ liệu đã được cấu hình.

---

# 🤖 AI Shortcut Engine

AI nhận thông tin liên quan đến hội thoại khách hàng và xác định shortcut phù hợp từ danh sách Shortcut hiện có.

Luồng tổng quát:

```text
Customer Message
       │
       ▼
Conversation Context
       │
       ▼
AI Analysis
       │
       ▼
Best Shortcut
       │
       ├── /1
       ├── /2
       └── /3
```

AI có thể trả về:

- Best Shortcut
- Top 3 Shortcut
- Lý do lựa chọn nội bộ
- Mức độ phù hợp tùy theo implementation

Tuy nhiên, khi bot thao tác với Pancake, output cuối cùng cần tuân thủ quy tắc:

```text
/n
```

Không gửi nội dung AI phân tích trực tiếp cho khách.

---

# 🏷️ Quy tắc xử lý khách hàng

## Trường hợp 1 — Khách gửi SĐT hoặc địa chỉ

Nếu phát hiện khách gửi:

- Số điện thoại
- Địa chỉ
- Thông tin đặt hàng

Bot sẽ:

```text
Customer
   │
   ▼
Phát hiện SĐT / Địa chỉ
   │
   ├── Add tag: Mua hàng
   │
   ├── Mark unread
   │
   └── Không gửi tin nhắn
```

Mục đích là chuyển khách cho nhân viên xử lý thủ công.

---

## Trường hợp 2 — Khách chưa có tag

Nếu hội thoại chưa có tag phù hợp:

```text
Customer
   │
   ▼
Chưa có tag
   │
   ├── Add tag: KHÁCH MỚI
   │
   └── Nhập shortcut: /1
```

---

## Trường hợp 3 — Khách đã có tag

Nếu khách đã được phân loại:

```text
Customer Message
       │
       ▼
Check Tag + Context
       │
       ▼
AI Analyze
       │
       ▼
Select Shortcut
       │
       ▼
Input /n
```

Bot chỉ nhập shortcut đã tồn tại trong Excel.

---

# 🔄 Bot Loop

Vào tab:

```text
Bot
```

Các control chính:

```text
[ ] Bật bot loop
[ ] Auto Send shortcut

[ Start ]
[ Emergency Stop ]
```

### Khuyến nghị

Ban đầu nên để:

```text
Bật bot loop     = OFF
Auto Send        = OFF
```

Sau khi test ổn định mới bật từng chức năng.

---

# 🔁 Quy trình Bot Loop

Bot thực hiện tuần tự:

```text
1. Scan unread conversations
          ↓
2. Find first unread customer
          ↓
3. Open conversation
          ↓
4. Read snippet + tag + context
          ↓
5. Analyze customer message
          ↓
6. Detect phone/address
          ↓
       ┌───────────────┐
       │               │
      YES              NO
       │               │
       ▼               ▼
   Add "Mua hàng"   Check customer tag
       │               │
       ▼               ▼
   Mark unread      ┌──────────────┐
       │             │              │
       ▼            None          Existing
   STOP SEND         │              │
                     ▼              ▼
                Add KHÁCH MỚI    AI Select
                     │              │
                     ▼              ▼
                    /1             /n
```

---

# 🧪 DOM Test

Trước khi bật Auto Send, hãy kiểm tra từng thao tác trong:

```text
DOM Test
```

## Test cơ bản

### 1. Test trạng thái

```text
Test trạng thái
```

### 2. Tìm khách chưa đọc

```text
Tìm khách chưa đọc
```

Selector hiện tại:

```css
.conversation-list-item.unread
```

### 3. Test nhập shortcut

```text
Nhập /1
```

### 4. Tìm nút gửi

```text
Tìm nút gửi
```

### 5. Test tag

Kiểm tra:

```text
KHÁCH MỚI
Mua hàng
```

### 6. Test Mark Unread

Đảm bảo hội thoại được đánh dấu unread chính xác.

---

# 🛡️ Safe Mode

Ứng dụng mặc định:

```text
botEnabled = false
autoSend = false
```

Điều này giúp tránh trường hợp vừa mở ứng dụng đã tự động gửi tin nhắn.

### Chế độ khuyến nghị

```text
┌────────────────────────────┐
│        SAFE MODE            │
├────────────────────────────┤
│ Bot Loop      : OFF         │
│ Auto Send     : OFF         │
│ AI Analysis   : ON/OFF      │
│ DOM Test      : ON          │
└────────────────────────────┘
```

Sau khi xác nhận toàn bộ flow hoạt động chính xác mới bật Auto Send.

---

# 🔌 API Server

Local server chạy tại:

```text
http://localhost:8787
```

## Health

```http
GET /health
```

## Settings

```http
GET /api/settings
POST /api/settings
```

## Shortcuts

```http
GET /api/shortcuts
POST /api/shortcuts
DELETE /api/shortcuts/:shortcut
```

## Excel

```http
POST /api/shortcuts/import-excel
POST /api/shortcuts/commit-import
GET /api/shortcuts/template
```

## AI

```http
POST /api/ai/analyze-message
```

## Logs

```http
GET /api/logs
POST /api/logs/clear
```

---

# 📝 Logs

Tab Logs dùng để theo dõi hoạt động của bot.

Có thể sử dụng log để kiểm tra:

```text
Bot started
Customer detected
Conversation opened
Tag detected
AI analysis completed
Shortcut selected
Shortcut inserted
Message sent
Customer marked unread
Emergency stop
```

Khi xảy ra lỗi, nên kiểm tra Logs trước khi thay đổi code.

---

# 🐛 Troubleshooting

## Server Offline

Thử chạy lại:

```bat
npm start
```

Kiểm tra:

```text
http://localhost:8787/health
```

---

## Không tìm thấy khách chưa đọc

Selector hiện tại:

```css
.conversation-list-item.unread
```

Nguyên nhân có thể:

- Pancake thay đổi DOM.
- Đang ở sai trang.
- Hội thoại không thực sự có trạng thái `unread`.
- WebView chưa load hoàn tất.

---

## Không tìm thấy ô nhập

Selector hiện tại:

```css
textarea#replyBoxComposer
```

Kiểm tra DOM thực tế của Pancake nếu giao diện đã thay đổi.

---

## Blocked non-shortcut outgoing text

Nếu xuất hiện lỗi:

```text
Blocked non-shortcut outgoing text
```

Đây là cơ chế bảo vệ.

Bot chỉ được phép gửi:

```text
/n
```

Ví dụ:

```text
/1
/2
/15
```

Không được gửi trực tiếp:

```text
Xin chào anh/chị
Dạ giá sản phẩm là...
Em gửi thông tin cho anh/chị
```

Hãy kiểm tra:

1. Shortcut Excel.
2. AI response.
3. Shortcut parser.
4. Logic send message.

---

## Không tìm thấy Tag

Kiểm tra chính xác tên tag trong Pancake:

```text
KHÁCH MỚI
Mua hàng
```

Tên tag phải khớp với cấu hình mà bot đang sử dụng.

---

## Không gửi được Shortcut

Thử theo thứ tự:

```text
1. Nhập /1
2. Kiểm tra textarea
3. Tìm nút Send
4. Click Send
5. Kiểm tra conversation
```

Nút gửi có thể chỉ xuất hiện sau khi textarea có nội dung.

---

# ⚠️ Lưu ý quan trọng

Ứng dụng sử dụng **DOM automation** trên giao diện Pancake.

Do đó, bot phụ thuộc vào:

- HTML structure
- CSS selector
- Button structure
- Text content
- DOM event
- UI flow của Pancake

Nếu Pancake thay đổi giao diện, một hoặc nhiều automation có thể ngừng hoạt động.

### Không nên hard-code API chưa được xác minh

Nếu một API Pancake chưa được xác minh từ tài liệu hoặc DevTools thực tế, không nên tự suy đoán endpoint.

Ưu tiên:

```text
Verified API
     ↓
DOM automation
     ↓
TODO / Adapter
```

thay vì tự tạo endpoint giả định.

---

# 🧪 Quy trình triển khai an toàn

Khuyến nghị triển khai theo từng giai đoạn:

### Phase 1 — Manual Test

```text
DOM Test
   ↓
Test từng action
```

### Phase 2 — Semi Auto

```text
Bot Loop ON
Auto Send OFF
```

Bot có thể tìm và phân tích khách nhưng chưa tự gửi.

### Phase 3 — Controlled Auto

```text
Bot Loop ON
Auto Send ON
```

Chỉ bật sau khi xác nhận toàn bộ flow.

### Phase 4 — Production

Theo dõi:

```text
Logs
↓
Failed actions
↓
DOM changes
↓
AI shortcut accuracy
```

---

# 🔒 Nguyên tắc an toàn của Bot

Bot phải tuân thủ các nguyên tắc:

```text
1. Không tự tạo Shortcut.
2. Không gửi text ngoài format /n.
3. Không gửi khi phát hiện SĐT/địa chỉ.
4. Không bỏ qua unread customer.
5. Không tự bật Auto Send khi khởi động.
6. Có Emergency Stop.
7. Mọi automation quan trọng phải có log.
8. Không tự suy đoán Pancake API chưa được xác minh.
```

---

# 📁 Cấu trúc chức năng

```text
Pancake Desktop
│
├── Electron
│   ├── Main Process
│   ├── WebView
│   └── Desktop UI
│
├── Local Server
│   ├── Settings API
│   ├── Shortcut API
│   ├── Excel Import
│   ├── AI API
│   └── Logs API
│
├── Bot Engine
│   ├── Unread Scanner
│   ├── Customer Analyzer
│   ├── Tag Handler
│   ├── Shortcut Selector
│   ├── Message Sender
│   └── Emergency Stop
│
└── Data
    ├── Settings
    ├── Shortcuts
    └── Logs
```

---

# 🎯 Mục tiêu của v3

Pancake Desktop AI Shortcut Bot v3 hướng tới một workflow:

```text
Pancake
   ↓
Unread Customer
   ↓
Analyze
   ↓
Detect Customer State
   ↓
┌──────────────────────┐
│                      │
│ SĐT / Địa chỉ        │
│        ↓             │
│ Mua hàng + Unread    │
│        ↓             │
│ Không gửi            │
│                      │
├──────────────────────┤
│                      │
│ Khách mới            │
│        ↓             │
│ KHÁCH MỚI + /1       │
│                      │
├──────────────────────┤
│                      │
│ Khách đã phân loại   │
│        ↓             │
│ AI                    │
│        ↓             │
│ Best Shortcut        │
│        ↓             │
│ /n                    │
└──────────────────────┘
```

---

# 📌 Development Notes

Khi phát triển hoặc sửa bot:

> **Không thay đổi flow automation chỉ để "làm cho chạy".**

Mọi thay đổi DOM selector, logic AI, tag hoặc send message nên được test riêng trước khi đưa vào Bot Loop.

Ưu tiên:

```text
Correctness
    ↓
Safety
    ↓
Stability
    ↓
Performance
    ↓
UI / UX
```

---

# 📄 License

Private / Internal Project.

Không sử dụng lại hoặc phân phối source code nếu chưa được chủ sở hữu cho phép.
