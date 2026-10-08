# Kết quả kiểm tra bản 3 — 07/10/2026

## Cập nhật logic và icon — 08/10/2026

- `npm run check`: 38 file JavaScript hợp lệ cú pháp.
- `npm test`: 43/43 đạt trên SQLite và ranh giới ứng dụng web; thêm kiểm thử dữ liệu đầu vào sai, ghế/giữ chỗ khi báo giá ưu đãi, đóng bán và thời hạn giữ gần giờ khởi hành.
- `npm run test:ui` và `npm run test:ui:advanced`: đạt sau tích hợp bộ icon SVG và sửa logic đặt vé.
- `npm run test:ui:regression`: kiểm tra tìm/lọc/sắp xếp, đảo tuyến, tìm địa điểm có/không dấu và tên quen gọi, giới hạn sáu ghế, ghế bị người khác giữ, sửa ngày về và chọn lại ghế khứ hồi, phản hồi mã ưu đãi đến chậm, storage sai cấu trúc, chặn chuyến đóng bán, SVG, menu/bộ lọc mobile và tra cứu mã bằng số điện thoại.
- Giao diện dùng 65 icon SVG cục bộ thống nhất giữa trang khách và quản trị; hỗ trợ trình đọc màn hình qua nhãn thao tác và ẩn icon trang trí.
- Đã xem ảnh trang chủ và hộp chọn địa điểm desktop/mobile; hộp tìm kiếm hiển thị đúng, không tràn ngang hoặc cắt nội dung.

Đợt này dùng database tạm riêng, không thay đổi kho vé đang chạy. Chưa kiểm tra lại PostgreSQL, Docker, SMTP hay merchant VNPAY trong đợt này. Đối chiếu giao diện công khai tại https://vexere.com/ là tham chiếu cho trải nghiệm vé xe và icon; chưa thể chứng nhận tương đương toàn bộ dịch vụ Vexere. Dự án chưa có đặt vé máy bay, tàu hỏa, thuê xe, theo dõi xe trực tiếp hoặc kết nối kho vé nhà xe thật. Khứ hồi hiện thanh toán tại nhà xe và hoàn tiền vẫn cần đối soát/biên nhận của nhân viên.

## Kết quả đợt trước

Môi trường kiểm tra: Windows, Node.js 24.21.0, Chrome headless, SQLite tích hợp Node và PostgreSQL 18.4 trong cluster kiểm thử riêng.

- `npm run check`: 36 file JavaScript hợp lệ cú pháp.
- `npm test`: 39/39 đạt trên SQLite và ranh giới ứng dụng web.
- Bộ backend và nâng cao chạy với `TEST_DATABASE_URL` và `--test-concurrency=1`: 35/35 đạt trên PostgreSQL thực, database UTF-8 có locale C.
- `npm audit`: không có lỗ hổng được báo cáo tại thời điểm kiểm tra.
- `npm run test:ui`: đạt luồng tìm/lọc chuyến, chọn nhiều ghế, đặt/tra cứu/hủy, các trang khách, desktop/mobile, đăng nhập quản trị, các phân hệ, tạo nhà xe và chuyến, phiếu thu/hoàn cùng nội dung trạng thái.
- `npm run test:ui:advanced`: đạt khứ hồi hai lượt, giữ ghế và phục hồi sau tải lại, hết hạn/gia hạn, lọc điểm đón/trả, mã hết lượt và mã khứ hồi hợp lệ, phân bổ chiết khấu, tra cứu đơn, đổi chuyến có ưu đãi, hủy riêng một chiều, lưu/so sánh chuyến, quản lý ưu đãi, danh sách hành khách và mobile.
- Kiểm thử nghiệp vụ nâng cao: cạnh tranh giữ ghế, hạn mức ưu đãi giữa nhiều chuyến, hoàn trả lượt của đơn chưa thu tiền, rollback khi lượt về hết ghế, hai yêu cầu hủy đồng thời, giảm 100% với giá hai chiều khác nhau, đổi vé/ghi nhật ký, quyền nhà xe sau đổi chủ chuyến, bảo vệ giá/sơ đồ khi đang giữ ghế và tìm kiếm tiếng Việt.
- Kiểm tra production với PostgreSQL riêng: cấp quản trị ban đầu, kho không có tình huống mẫu, cookie HTTPS, tạo chuyến quản lý, 8 yêu cầu đồng thời chỉ bán được một ghế, giữ hai lượt, ưu đãi theo điều kiện, giao dịch khứ hồi, danh sách hành khách và chặn đăng ký email khi chưa cấu hình SMTP.
- Schema Sequelize cũ: cả 7 migration và 6 seeder chạy thành công; 5 nhà xe, 84 chuyến, 15 đặt chỗ và 10 đánh giá. Các quan hệ eager-loading đã được kiểm tra.
- `docker compose --env-file .env.example config --quiet`: cấu hình hợp lệ.
- ZIP bàn giao: khoảng 40 MB; giải nén vào thư mục riêng, cài bằng `npm ci --omit=dev` và khởi động bằng dependencies vận hành. Trang khách, quản trị, script/style, ảnh/font, kho chuyến, dữ liệu tình huống bản 3 và health check đều truy cập được; không có `.env` thật, database hoặc email khách trong ZIP.

Các bài kiểm tra giao dịch dùng dữ liệu, chữ ký và chứng từ kiểm thử trên kho riêng; không gọi nhà xe thật hoặc chuyển tiền thật. Chưa kiểm thử tài khoản merchant, SMTP hoặc API nhà xe vì người dùng chưa cung cấp các kết nối đó. Docker image/Compose chưa được chạy do daemon Docker chưa hoạt động; database đã được kiểm tra trực tiếp trên PostgreSQL 18.4, còn Compose cấu hình PostgreSQL 16.

Ảnh giao diện desktop/mobile nằm trong `artifacts/screenshots/` tại thư mục làm việc. Các bài kiểm tra dùng database tạm, không làm thay đổi kho vé đang hiển thị ở `localhost:3000`.
