# Ticket4T — đặt vé xe và vận hành kho chuyến

Dự án được hoàn thiện từ mã nguồn và bốn tài liệu bạn cung cấp. Bản 3 bổ sung đặt vé khứ hồi, giữ ghế trước thanh toán, ưu đãi có điều kiện, đổi chuyến, so sánh/lưu chuyến và danh sách hành khách cho nhà xe.

Đợt cập nhật 08/10/2026 bổ sung khôi phục đặt vé khi mất kết nối bằng Idempotency-Key, tiếp tục thanh toán, kiểm tra trạng thái thanh toán, adapter MoMo/ZaloPay và trang quản trị **Kết nối API**. Đồng bộ lịch nhà xe từ feed JSON có xem trước, kiểm tra lại khi áp dụng và cập nhật chuyến theo mã đối tác, không nhập trùng. Xem cấu hình và hợp đồng dữ liệu trong [API](docs/api.md).

**Nguồn dữ liệu:** bản kiểm thử có 22 nhà xe minh họa, 26 địa điểm, 60 tuyến hai chiều, 4 loại xe và 7.200 lượt khởi hành trên 30 ngày. Lịch được bổ sung theo ngày khi khởi động lại. Giờ, giá, tồn ghế và nhà xe mẫu không phải dữ liệu bán vé trực tiếp của Vexere. Khi có nhà xe hợp tác, nhập kho vé được xác nhận bằng CSV/JSON trong trang quản trị.

## Chạy ngay trên Windows

Cài **Node.js 24 LTS**, mở Terminal trong thư mục chứa `package.json`:

```powershell
npm install
npm start
```

Hoặc mở `start.bat`. Lần đầu chạy tự tạo SQLite và dữ liệu minh họa; không cần cài MongoDB/PostgreSQL để xem bản kiểm thử.

- Trang khách: [http://localhost:3000](http://localhost:3000)
- Trang vận hành: [http://localhost:3000/admin](http://localhost:3000/admin)
- Quản trị minh họa: `admin@ticket4t.vn` / `Admin@12345`
- Khách minh họa: `khach@ticket4t.vn` / `Khach@12345`
- Nhân viên An Việt mẫu: `operator@ticket4t.vn` / `Nhaxe@12345`

Tài khoản trên chỉ dùng phát triển. Khách cũng có thể đặt và tra cứu vé bằng mã vé cùng số điện thoại mà không cần đăng nhập.

Không cần sửa file `.env` cũ để xem bản kiểm thử. Nếu muốn cấu hình riêng, dùng `.env.example` làm mẫu, giữ lại cấu hình bạn cần và đặt khóa mới trong `.env`. Không đăng hoặc chia sẻ file `.env`.

## Chức năng đã triển khai

### Khách hàng

- Tìm chuyến theo tuyến/ngày; đảo chiều; lọc nhà xe, loại xe, giá ghế đang trống, khung giờ và còn chỗ; sắp xếp và phân trang. Từ khóa/điểm đón/trả nhận tiếng Việt có dấu, không dấu hoặc Unicode phân rã; ký tự `%`/`_` được tìm đúng theo nội dung.
- Tìm nhanh địa điểm có dấu/không dấu, tên quen gọi như Sài Gòn; lưu sáu địa điểm chọn gần đây trên trình duyệt. Hộp chọn hỗ trợ bàn phím và Escape.
- Bộ icon SVG cục bộ dùng chung cho trang khách và quản trị: xe, địa điểm, lịch, ghế/giường/cabin, tiện ích, ưu đãi, thanh toán và các thao tác quản lý.
- Xem hành trình, giờ đến qua ngày tiếp theo, tiện ích, chính sách, điểm đón/trả và hồ sơ nhà xe.
- Chọn nhiều ghế trên sơ đồ theo tầng; giá theo ghế nếu nhà xe cấu hình.
- Giữ ghế tối đa 5 phút trước khi hoàn thành thông tin; bộ đếm và kiểm tra tồn ghế ở máy chủ. Tìm kiếm, giữ ghế, báo giá và đặt vé cùng đóng bán trước khởi hành 30 phút; thời hạn giữ không vượt mốc đóng bán. Hết hạn cần chọn lại, không đặt tiếp bằng ghế cũ.
- Khôi phục giữ chỗ hết hạn theo từng chiều, giữ thông tin hành khách trong phiên và kiểm tra lại giá/ưu đãi trước khi xác nhận. Khi điều kiện chuyến hoặc tổng tiền đổi, khách cần xem và đồng ý lại; retry yêu cầu đã lưu vẫn dùng cùng khóa để tránh tạo vé trùng.
- Đặt vé khứ hồi bằng một lần gửi; hai lượt được lưu trong cùng giao dịch. Nếu một lượt không còn ghế, cả đơn không được tạo. Khứ hồi hiện hỗ trợ thanh toán tại nhà xe.
- Đổi chuyến kiểm tra phiên bản vé gốc và chuyến đích; thử lại yêu cầu chưa rõ kết quả bằng cùng mã để chỉ chuyển ghế/ghi lịch sử một lần. Bản nháp đổi chuyến gắn với đúng mã vé và được xóa khi đổi tài khoản.
- Mã giảm giá cố định/phần trăm, mức đơn tối thiểu, trần giảm, thời hạn, hạn mức tổng/theo số điện thoại, điều kiện tuyến/nhà xe/khứ hồi.
- So sánh tối đa ba chuyến và lưu chuyến yêu thích trên trình duyệt; giữ chiều đi/về, bộ lọc và lượt đi đang giữ ghế khi quay lại chọn chuyến khứ hồi. Đổi ngày trên cùng tuyến giữ bộ lọc và thứ tự sắp xếp.
- Đổi sang chuyến cùng nhà xe, tuyến và giá trước giờ đi ít nhất 2 giờ. Thay đổi mức giá cần nhà xe xử lý; lịch sử thao tác được lưu.
- Đặt chỗ với thông tin hành khách; giá tính ở máy chủ. Ghế được khóa trong giao dịch, có ràng buộc duy nhất để chống đặt trùng.
- Tra cứu bằng mã/số điện thoại, lịch sử của tài khoản, hủy theo điều kiện và in/lưu vé thành PDF bằng trình duyệt.
- Đăng ký, đăng nhập, đăng xuất, xác minh email, quên và đặt lại mật khẩu. Token dùng một lần, có thời hạn, lưu dưới dạng băm.
- Đánh giá từ tài khoản có đặt chỗ đã thanh toán và chuyến đã kết thúc; mỗi vé chỉ được đánh giá một lần.

### Quản trị và đối tác

- Tổng quan theo khoảng ngày Việt Nam: tiền đã thu, đã hoàn, thu ròng, chưa thu, đang chờ hoàn và tỷ lệ lấp đầy; biểu đồ thu tiền và thống kê theo ngày, nhà xe, tuyến, phương thức thanh toán.
- Bán vé tại quầy trên sơ đồ ghế theo tầng, chọn tối đa sáu ghế, kiểm tra tồn chỗ và giá trong giao dịch chung với đặt vé online. Thông tin người mua được tách khỏi tài khoản nhân viên; ghi phiếu thu riêng khi đã thu đủ tiền.
- Bán tại quầy xác nhận lịch/điểm đón/giá đã xem, khôi phục cùng yêu cầu sau mất phản hồi hoặc reload và không tạo thêm vé. Hủy vé yêu cầu kiểm tra lại nếu vé vừa đổi chuyến hoặc thu tiền; phản hồi cũ không ghi vào màn hình/tài khoản mới.
- Thêm/sửa/ngừng hoạt động nhà xe, tạo/sửa/ngừng mở bán/nhân bản chuyến.
- Nhập CSV/JSON, xem trước, kiểm tra toàn bộ trước khi lưu và ghi nguồn lịch từ đối tác.
- Tra cứu đặt chỗ theo ngày, nhà xe và trạng thái; xác nhận/hủy, ghi nhận phiếu thu hoặc hoàn đúng số tiền và mã chứng từ duy nhất.
- Nhật ký vận hành có người thực hiện, thời gian, đối tượng và nội dung thay đổi; lọc theo ngày, nhà xe, thao tác và từ khóa, phân trang theo phạm vi được cấp.
- Tạo/quản lý tài khoản khách và nhân viên nhà xe; quyền nhà xe chỉ truy cập dữ liệu thuộc nhà xe được giao. Thu hồi phiên khi đổi quyền hoặc khóa tài khoản; lịch sử vé và doanh thu giữ nhà xe đã bán sau khi chuyển chủ chuyến. Tài khoản quản trị cấp bằng cấu hình máy chủ.
- Quản lý mã ưu đãi, điều kiện áp dụng, thời hạn và số lượt sử dụng.
- Xem/in danh sách hành khách theo chuyến, ghế, điểm đón/trả và trạng thái thu tiền.
- Đổi chuyến tại cổng vận hành gửi phiên bản vé gốc/chuyến mới và khóa chống thực hiện trùng; yêu cầu chưa rõ kết quả có thể kiểm tra lại sau tải lại trang với đúng thông tin ban đầu.

### Thanh toán

Thanh toán tại nhà xe tạo đặt chỗ **chưa thanh toán**. Nhân viên ghi nhận phiếu thu sau khi đã thu đủ tiền.

VNPAY chỉ hiện khả dụng khi được cấu hình. Backend tạo URL có chữ ký HMAC-SHA512 và chỉ ghi nhận tiền qua IPN đã xác minh chữ ký, mã đơn, số tiền và trạng thái giao dịch. Không có nút thanh toán giả. Hủy vé đã thu tiền chuyển sang chờ hoàn tiền để đối soát.

MoMo (`captureWallet`) và ZaloPay có adapter tạo thanh toán, lưu mã đơn merchant/URL, kiểm tra callback HMAC và ghi nhận tiền trong giao dịch. Cổng chỉ hiện khi có cấu hình hợp lệ. Có thể tiếp tục thanh toán từ vé đang chờ; mất phản hồi cổng không tạo thêm đơn thu tiền. Mẫu cấu hình dùng sandbox chính thức; cần merchant thật và callback public trước khi vận hành. Đợt này kiểm thử bằng cổng giả lập, chưa giao dịch với merchant thực.

## Chạy với PostgreSQL và Docker

Điền `.env` theo `.env.example`, đặt `POSTGRES_PASSWORD` và `SESSION_SECRET` của bạn:

```powershell
docker compose up --build -d
```

Compose chạy Node 24 và PostgreSQL 16, có health check và volume dữ liệu bền vững. Bản Compose mặc định dùng chế độ phát triển để kiểm thử. Để bán thật, dùng cơ sở dữ liệu riêng và cấu hình production bên dưới.

Nếu bạn có PostgreSQL sẵn, đặt `DATABASE_URL=postgresql://user:password@host:5432/ticket4t` rồi `npm start`. Khi dùng dịch vụ cần TLS, đặt `PG_SSL=true` và giữ xác minh chứng chỉ bật.

## Chuẩn bị mở bán thực tế

Bạn đã chọn chuẩn bị hệ thống trước khi có đối tác nhà xe. Để đưa vào vận hành cần:

1. Lịch/giá/quyền bán và kho ghế được nhà xe xác nhận. Đã có adapter feed lịch JSON chuẩn hóa; chưa kết nối API Vexere hoặc nhà xe thực tế vì chưa có đối tác. Chỉ dùng kho ghế được phân bổ riêng; đồng bộ ghế đa kênh cần tài liệu API giữ/đặt/hủy của đối tác.
2. PostgreSQL vận hành riêng; `NODE_ENV=production`, `SEED_DEMO=false`, `APP_URL` HTTPS, `SESSION_SECRET` mạnh và tài khoản quản trị riêng.
3. SMTP để gửi email thực và tài khoản merchant nếu dùng VNPAY/MoMo/ZaloPay. Không đưa khóa vào mã nguồn.
4. Tên miền/HTTPS và máy chủ triển khai. Kết nối API đồng bộ tồn ghế cần được viết theo hợp đồng/schema của đối tác thực tế.

Production từ chối cấu hình thiếu, seed mẫu và cổng sandbox dùng như cổng thật. Chuyến mẫu không được phép tạo vé bán thật. Xem [hướng dẫn vận hành](docs/operations.md) để nhập lịch, đối soát và cấu hình callback.

## Kiểm tra và đóng gói

```powershell
npm run check
npm test
npm run test:unit
npm run test:integration
npm run test:ci
npm audit
npm run test:ui:all
npm run test:ui:search
npm run test:ui:checkout
npm run test:ui:reschedule
npm run test:ui:admin-reschedule
npm run test:ui:counter
npm run test:ui:cancellation
npm run pack:project
```

ZIP nằm ở `artifacts/Ticket4T-project.zip`, chứa mã nguồn, tài nguyên, hướng dẫn và các cấu hình mẫu. Không chứa `.env`, database, email khách hoặc `node_modules`.

`test:ui` mở Chrome headless, chạy trên database tạm riêng và kiểm tra tìm chuyến → chọn ghế → đặt/tra cứu/hủy vé cùng các trang quản trị. Cần cài Chrome; với trình duyệt Playwright riêng, cài `npx playwright install chromium` và đặt `BROWSER_CHANNEL=chromium`. Ảnh kiểm thử được lưu vào `artifacts/screenshots/`.

Đã tách unit test khỏi API/database test. `test:ci` kiểm tra cú pháp, danh mục ca và toàn bộ backend với ngưỡng coverage 95% dòng, 85% nhánh, 90% hàm; xuất JUnit/JSON/LCOV vào `artifacts/tests/coverage/`. CI GitHub có job Node24 Ubuntu/Windows, PostgreSQL16 và Chromium. Xem [hướng dẫn kiểm thử](docs/testing.md) và [43 tình huống theo chức năng](docs/test-cases.json) để xem tiền điều kiện, bước và kết quả mong đợi; kết quả từng ca được sinh trong báo cáo JSON.

Xem [tình huống và dữ liệu test](docs/test-scenarios.md) để thử mã ưu đãi, vé khứ hồi, các trạng thái thanh toán, chuyến hết ghế và tài khoản nhà xe. Dữ liệu tình huống được thêm một lần, giữ nguyên vé bạn đã tạo. `npm run seed` bổ sung kho chuyến, không xóa dữ liệu. Lộ trình và chứng từ mẫu đều có nhãn minh họa.

Kiểm thử PostgreSQL bằng database kiểm thử riêng:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://user:password@localhost:5432/ticket4t_test'
npm run test:postgres
Remove-Item Env:TEST_DATABASE_URL
```

Không đặt `TEST_DATABASE_URL` vào database đang bán vé. `test:postgres` yêu cầu tên database có đoạn `test`, tạo schema riêng cho từng bộ và dọn sau khi chạy. Lệnh `npm test` thông thường dùng SQLite tạm và không chuyển sang PostgreSQL theo biến môi trường ứng dụng.

## Cấu trúc

- `index.js`: ứng dụng, cookie/phiên, giới hạn API, kiểm tra cấu hình production và phục vụ giao diện.
- `server/`: API, adapter SQLite/PostgreSQL, kho chuyến, email, thanh toán và giao dịch đặt ghế.
- `public/app/`: giao diện đặt vé tiếng Việt, responsive.
- `public/admin/`: cổng quản trị và đối tác.
- `public/images/`, `public/fonts/`: ảnh/font cục bộ có trong dự án.
- `tests/`: kiểm thử đặt chỗ, phân quyền, thanh toán và ranh giới web.
- `models/`, `migrations/`, `config/`: mô hình Sequelize gốc đã sửa khóa ngoại và cấu hình; giữ để tham khảo/phục hồi dữ liệu cũ.
- `docs/legacy-requirements.md`: yêu cầu gốc; `docs/operations.md`: cách vận hành bản mới.
- `docs/api.md`: endpoint và định dạng dữ liệu tích hợp.
- `docs/validation.md`: kết quả kiểm tra và giới hạn kiểm chứng.

Các controller/route/Handlebars cũ được giữ trong thư mục làm việc để đối chiếu, nhưng không gắn vào ứng dụng mới. `legacy-index.js` là bản lưu entrypoint cũ. Không khởi chạy nó. Backend mới tự khởi tạo schema vận hành, không cần các endpoint `/createTables` hoặc `/syncPassword`.

Migration Sequelize đã sửa có thể chạy cho một database cũ riêng bằng `npm run db:migrate:legacy`. Migration sẽ từ chối dữ liệu tham chiếu bị mồ côi thay vì tự xóa dữ liệu.
