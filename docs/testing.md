# Kiểm thử Ticket4T

## Kết luận kiểm định — 08/10/2026

Trước đợt này, `npm test` có 98 ca đạt nhưng trộn test API, database, component và helper. Chưa có thư mục/unit command riêng, coverage gate, báo cáo máy đọc, CI hoặc danh mục ca theo chức năng. `test-scenarios.md` chủ yếu hướng dẫn thử dữ liệu demo bằng tay. Vì vậy chưa thể gọi là bộ unit test đầy đủ cho từng chức năng.

Đã bổ sung 72 unit test độc lập và 32 ca tích hợp trên SQLite/HTTP/subprocess: tổng 202 ca đạt (72 unit, 130 integration/component), không skip/todo. Thêm 3 ca PostgreSQL chuyên biệt; cùng 49 ca backend/nâng cao/admin đã chạy trên PostgreSQL 18.4 thực, tổng 52 ca đạt. Sáu bộ UI đạt trên Chrome headless. Các tầng chồng lấn có chủ đích và không cộng 52 PostgreSQL vào 202 để báo số ca duy nhất.

Các ca hồi quy đã phát hiện và xác nhận sửa ba lỗi CSV (ký tự sau quote đóng, vượt 500 hàng thiếu newline cuối, đếm sai UTF8 bytes), đánh giá lọt qua khi hủy vé đang chờ, ngày ưu đãi không tồn tại bị tự chuyển ngày và email đã gửi nhưng trả `delivered:false` do cập nhật outbox lỗi. Tìm kiếm thêm ID cuối vào thứ tự sắp xếp để phân trang ổn định khi đồng hạng. Bốn browser script được sửa để lỗi launch vẫn đóng HTTP/DB và dọn fixture.

## Các tầng và lệnh chạy

Yêu cầu Node.js 24+, cài dependencies bằng `npm ci`.

```powershell
npm run test:unit         # tests/unit/**/*.test.js, không HTTP/DB/SMTP thật
npm run test:integration  # tests/*.test.js, SQLite/HTTP/API/component fixtures
npm test                  # cả hai tầng, discovery đệ quy
npm run test:cases        # kiểm tra danh mục và liên kết tới automation
npm run test:coverage     # toàn bộ backend, gate và báo cáo
npm run test:ci           # syntax + catalogue + coverage/test
npm run test:ui:all       # lần lượt 6 browser suites
```

`tests/unit/` kiểm tra các hàm thuần và ranh giới có mock: ngày/lịch/ghế, CSV, khoảng ngày báo cáo, VNPAY và checkout fingerprint, cấu hình feed, mailer, discovery và teardown. Mock được phục hồi sau từng ca. Các handler API có closure và SQL được kiểm tra qua HTTP/database, không giả gọi chúng là unit test. `tests/database.test.js` kiểm tra SQLite thật, transaction/rollback, queue sau lỗi, foreign key, legacy schema, session store và đóng DB.

API fixtures dùng database/temp directory riêng; ca mới trong `feature-contracts.test.js` tạo mới theo từng case. Kiểm thử cạnh tranh dùng Promise/gate và assertion về kết quả/số bản ghi, không dùng sleep để đoán race. Các bộ cũ chia sẻ fixture trong cùng file, nên file là đơn vị độc lập của chúng. HTTP chỉ bind loopback và dùng port tự cấp. Transport ví/partner/email đều được giả lập, không chuyển tiền hoặc gọi SMTP thật.

Lệnh thông thường bỏ `DATABASE_URL`, `TEST_DATABASE_URL`, `SQLITE_FILE`, `DATA_DIR` của shell khỏi môi trường con. `.env` ứng dụng không được dùng làm cấu hình database của fixture. PostgreSQL chỉ chạy bằng lệnh opt in riêng dưới đây.

## Báo cáo và ngưỡng chất lượng

`artifacts/tests/<mode>/results.json` chứa mỗi ca: ID, tên, file/dòng, status, thời gian và summary. Ca mới có ID `UT-*`/`IT-*`; ca cũ nhận ID `AUTO-*` ổn định theo file+tên. JUnit ở `junit.xml`; coverage thêm `lcov.info`. Không parse output `spec` để suy ra kết quả. Native Node test runner dùng structured events; format báo cáo dựa trên [tài liệu Node.js 24](https://nodejs.org/docs/latest-v24.x/api/test.html).

Coverage đo `index.js` và các file `server/**/*.js` được nạp. Ngưỡng toàn backend: **95% lines, 85% branches, 90% functions**; thấp hơn thì lệnh trả exit code khác 0. Không bỏ qua dòng/nhánh production để tăng số. Kết quả SQLite hiện tại: **97,04% lines, 87,18% branches, 94,70% functions**. Chi tiết theo module nằm trong JSON/LCOV; `database.js` vẫn gồm nhánh PostgreSQL chưa chạy trong lệnh SQLite này, và startup/CLI trong `index.js` còn chưa phủ hết.

Hai ca subprocess riêng xác minh runner thật trả exit code 1 khi assertion lỗi hoặc coverage dưới ngưỡng dù các assertion con đạt; JSON/JUnit/LCOV vẫn được sinh. Skip/todo của fixture âm tính được báo đúng và không tính `describe` thành test. Bộ chính vẫn không có skip/todo.

Số phần trăm này không bao gồm JavaScript browser, thư viện/node_modules, legacy routes/migrations không được mount, hoặc file chưa được nạp. Nó không chứng nhận mọi nhánh business hay toàn bộ dịch vụ ngoài đã đúng. UI được đánh giá bằng assertion hành vi và kích thước bố cục; screenshots phục vụ xem thủ công, chưa có so sánh visual baseline tự động.

Mỗi test file có timeout 60 giây. UI runner giới hạn 180 giây/suite; khi timeout hoặc ngắt thì dừng cây process (Windows) hoặc process group (POSIX), đánh dấu thất bại. Nếu bị kill cứng thì fixture temp có thể còn và cần dọn sau khi xác minh resource đã dừng. Report UI nằm tại `artifacts/tests/ui/results.json`, ảnh tại `artifacts/screenshots/`.

## PostgreSQL riêng

```powershell
$env:TEST_DATABASE_URL = 'postgresql://user:password@127.0.0.1:5432/ticket4t_test'
npm run test:postgres
Remove-Item Env:TEST_DATABASE_URL
```

Database phải có đoạn tên `test` riêng, như `ticket4t_test`; URL có `options` sẵn bị từ chối. Tài khoản cần quyền tạo/xóa schema. Runner lần lượt chạy `backend.test.js`, `advanced.test.js`, `admin.test.js`, `tests/postgres/*.test.js`; mỗi file có `search_path` riêng vào schema ngẫu nhiên, dọn trong `finally`. Các suite khác vẫn SQLite, không được báo là đã chạy PostgreSQL. Không dùng database đang bán vé dù runner có schema riêng.

Đợt này dùng cluster PostgreSQL 18.4 UTF8/locale C tạm riêng; 19+20+10+3 = 52 ca đạt. Cluster đã dừng và thư mục riêng đã dọn. Không thay cluster/database của người dùng. CI đặt PostgreSQL 16 để khớp Docker Compose; phiên CI đó chưa chạy trên GitHub trong đợt này.

## Ca kiểm thử và truy vết chức năng

[test-cases.json](test-cases.json) có 29 tình huống theo nhóm chức năng, mỗi tình huống có ID, priority, tiền điều kiện, đầu vào, bước thực hiện, kết quả mong đợi và file/ID automation. Danh sách **từng ca đã chạy** với status cụ thể được sinh từ test runner trong `results.json`; số test lấy từ summary, không đếm `describe` thành ca. [test-scenarios.md](test-scenarios.md) giữ hướng dẫn dữ liệu demo để thử bằng tay.

Khi thêm hành vi: bổ sung ca vào tầng phù hợp, kiểm tra đầu vào/biên/âm tính hoặc cạnh tranh liên quan; cập nhật mapping và chạy `test:ci`. Không viết test chỉ lặp lại chi tiết implementation. Với sửa lỗi, ca phải tái hiện được lỗi trước thay đổi và kiểm tra behavior mong đợi sau sửa. Không commit `.env`, database hoặc outbox khách trong fixture/report.

## CI và phần chưa kiểm chứng

[.github/workflows/tests.yml](../.github/workflows/tests.yml) có ba job: backend Node24 trên Ubuntu/Windows, PostgreSQL16 với service database test, Chromium cho sáu UI suites. Các job lưu báo cáo và ảnh kể cả khi lỗi. Workflow được thêm vào mã nguồn; cần push để có bằng chứng run GitHub thực. Không có lượt CI cloud nào được tuyên bố đạt trong báo cáo local.

`pendingExternalCases` trong catalogue ghi rõ bốn nhóm chưa chạy: merchant sandbox với webhook public và đối soát, SMTP/mailbox kiểm soát, API nhà xe thực/ghế đa kênh, staging proxy/multiworker/tải lớn/backup và CI cloud. Chưa có credentials/hợp đồng môi trường kiểm thử cho ba kết nối ngoài. Mock hiện tại kiểm chứng logic nội bộ, không chứng nhận integration partner thực. Accessibility mới có nhãn/keyboard/layout assertions ở luồng chính; chưa audit WCAG toàn bộ, kiểm thử tải lớn, penetration test hay xác minh visual baseline.
