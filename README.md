# Ticket4T — đặt vé xe và vận hành kho chuyến

Dự án được hoàn thiện từ mã nguồn và bốn tài liệu bạn cung cấp. Bản 3 bổ sung đặt vé khứ hồi, giữ ghế trước thanh toán, ưu đãi có điều kiện, đổi chuyến, so sánh/lưu chuyến và danh sách hành khách cho nhà xe.

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

- Tìm chuyến theo tuyến/ngày; đảo chiều; lọc nhà xe, loại xe, giá và khung giờ; sắp xếp và phân trang.
- Tìm nhanh địa điểm có dấu/không dấu, tên quen gọi như Sài Gòn; lưu sáu địa điểm chọn gần đây trên trình duyệt. Hộp chọn hỗ trợ bàn phím và Escape.
- Bộ icon SVG cục bộ dùng chung cho trang khách và quản trị: xe, địa điểm, lịch, ghế/giường/cabin, tiện ích, ưu đãi, thanh toán và các thao tác quản lý.
- Xem hành trình, giờ đến qua ngày tiếp theo, tiện ích, chính sách, điểm đón/trả và hồ sơ nhà xe.
- Chọn nhiều ghế trên sơ đồ theo tầng; giá theo ghế nếu nhà xe cấu hình.
- Giữ ghế tối đa 5 phút trước khi hoàn thành thông tin; bộ đếm và kiểm tra tồn ghế ở máy chủ. Tìm kiếm, giữ ghế, báo giá và đặt vé cùng đóng bán trước khởi hành 30 phút; thời hạn giữ không vượt mốc đóng bán. Hết hạn cần chọn lại, không đặt tiếp bằng ghế cũ.
- Đặt vé khứ hồi bằng một lần gửi; hai lượt được lưu trong cùng giao dịch. Nếu một lượt không còn ghế, cả đơn không được tạo. Khứ hồi hiện hỗ trợ thanh toán tại nhà xe.
- Mã giảm giá cố định/phần trăm, mức đơn tối thiểu, trần giảm, thời hạn, hạn mức tổng/theo số điện thoại, điều kiện tuyến/nhà xe/khứ hồi.
- So sánh tối đa ba chuyến và lưu chuyến yêu thích trên trình duyệt.
- Đổi sang chuyến cùng nhà xe, tuyến và giá trước giờ đi ít nhất 2 giờ. Thay đổi mức giá cần nhà xe xử lý; lịch sử thao tác được lưu.
- Đặt chỗ với thông tin hành khách; giá tính ở máy chủ. Ghế được khóa trong giao dịch, có ràng buộc duy nhất để chống đặt trùng.
- Tra cứu bằng mã/số điện thoại, lịch sử của tài khoản, hủy theo điều kiện và in/lưu vé thành PDF bằng trình duyệt.
- Đăng ký, đăng nhập, đăng xuất, xác minh email, quên và đặt lại mật khẩu. Token dùng một lần, có thời hạn, lưu dưới dạng băm.
- Đánh giá từ tài khoản có đặt chỗ đã thanh toán và chuyến đã kết thúc; mỗi vé chỉ được đánh giá một lần.

### Quản trị và đối tác

- Tổng quan chuyến, đơn vé, doanh thu đã thu và nguồn dữ liệu.
- Thêm/sửa/ngừng hoạt động nhà xe, tạo/sửa/ngừng mở bán/nhân bản chuyến.
- Nhập CSV/JSON, xem trước, kiểm tra toàn bộ trước khi lưu và ghi nguồn lịch từ đối tác.
- Tra cứu đặt chỗ, xác nhận/hủy, ghi nhận phiếu thu tiền mặt, xem nhật ký thao tác.
- Tạo tài khoản quản trị/đối tác; quyền nhà xe chỉ truy cập chuyến và đặt chỗ thuộc nhà xe được giao.
- Quản lý mã ưu đãi, điều kiện áp dụng, thời hạn và số lượt sử dụng.
- Xem/in danh sách hành khách theo chuyến, ghế, điểm đón/trả và trạng thái thu tiền.

### Thanh toán

Thanh toán tại nhà xe tạo đặt chỗ **chưa thanh toán**. Nhân viên ghi nhận phiếu thu sau khi đã thu đủ tiền.

VNPAY chỉ hiện khả dụng khi được cấu hình. Backend tạo URL có chữ ký HMAC-SHA512 và chỉ ghi nhận tiền qua IPN đã xác minh chữ ký, mã đơn, số tiền và trạng thái giao dịch. Không có nút thanh toán giả. Hủy vé đã thu tiền chuyển sang chờ hoàn tiền để đối soát.

## Chạy với PostgreSQL và Docker

Điền `.env` theo `.env.example`, đặt `POSTGRES_PASSWORD` và `SESSION_SECRET` của bạn:

```powershell
docker compose up --build -d
```

Compose chạy Node 24 và PostgreSQL 16, có health check và volume dữ liệu bền vững. Bản Compose mặc định dùng chế độ phát triển để kiểm thử. Để bán thật, dùng cơ sở dữ liệu riêng và cấu hình production bên dưới.

Nếu bạn có PostgreSQL sẵn, đặt `DATABASE_URL=postgresql://user:password@host:5432/ticket4t` rồi `npm start`. Khi dùng dịch vụ cần TLS, đặt `PG_SSL=true` và giữ xác minh chứng chỉ bật.

## Chuẩn bị mở bán thực tế

Bạn đã chọn chuẩn bị hệ thống trước khi có đối tác nhà xe. Để đưa vào vận hành cần:

1. Lịch/giá/quyền bán và kho ghế được nhà xe xác nhận. Website chưa kết nối API Vexere hoặc API nhà xe.
2. PostgreSQL vận hành riêng; `NODE_ENV=production`, `SEED_DEMO=false`, `APP_URL` HTTPS, `SESSION_SECRET` mạnh và tài khoản quản trị riêng.
3. SMTP để gửi email thực và tài khoản merchant nếu dùng VNPAY. Không đưa khóa vào mã nguồn.
4. Tên miền/HTTPS và máy chủ triển khai. Kết nối API đồng bộ tồn ghế cần được viết theo hợp đồng/schema của đối tác thực tế.

Production từ chối cấu hình thiếu, seed mẫu và cổng sandbox dùng như cổng thật. Chuyến mẫu không được phép tạo vé bán thật. Xem [hướng dẫn vận hành](docs/operations.md) để nhập lịch, đối soát và cấu hình callback.

## Kiểm tra và đóng gói

```powershell
npm run check
npm test
npm audit
npm run test:ui
npm run test:ui:advanced
npm run test:ui:regression
npm run pack:project
```

ZIP nằm ở `artifacts/Ticket4T-project.zip`, chứa mã nguồn, tài nguyên, hướng dẫn và các cấu hình mẫu. Không chứa `.env`, database, email khách hoặc `node_modules`.

`test:ui` mở Chrome headless, chạy trên database tạm riêng và kiểm tra tìm chuyến → chọn ghế → đặt/tra cứu/hủy vé cùng các trang quản trị. Cần cài Chrome; với trình duyệt Playwright riêng, cài `npx playwright install chromium` và đặt `BROWSER_CHANNEL=chromium`. Ảnh kiểm thử được lưu vào `artifacts/screenshots/`.

Xem [tình huống và dữ liệu test](docs/test-scenarios.md) để thử mã ưu đãi, vé khứ hồi, các trạng thái thanh toán, chuyến hết ghế và tài khoản nhà xe. Dữ liệu tình huống được thêm một lần, giữ nguyên vé bạn đã tạo. `npm run seed` bổ sung kho chuyến, không xóa dữ liệu. Lộ trình và chứng từ mẫu đều có nhãn minh họa.

Kiểm thử PostgreSQL bằng database kiểm thử riêng:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://user:password@localhost:5432/ticket4t_test'
npm test
```

Không đặt `TEST_DATABASE_URL` vào database đang bán vé. Bộ kiểm thử tạo và xử lý dữ liệu kiểm thử.

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
