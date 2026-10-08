# Vận hành Ticket4T

## Chuyển từ kiểm thử sang mở bán

Ứng dụng quản lý kho ghế được cấp cho Ticket4T. Chưa có kết nối tự động với Vexere hoặc hệ thống điều hành của nhà xe. Lịch minh họa không phải lịch chạy thật và không được bán trong môi trường production.

1. Tạo cơ sở dữ liệu PostgreSQL riêng cho vận hành; giữ cơ sở dữ liệu kiểm thử tách biệt.
2. Cấu hình `.env`: `NODE_ENV=production`, `SEED_DEMO=false`, `DATABASE_URL`, `SESSION_SECRET` ngẫu nhiên tối thiểu 32 ký tự, `APP_URL=https://ten-mien-cua-ban.vn`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
3. Mật khẩu quản trị cần tối thiểu 10 ký tự, gồm chữ hoa, chữ thường và chữ số. Không dùng tài khoản minh họa để mở bán.
4. Đăng nhập `/admin`, tạo hồ sơ nhà xe, thông tin liên hệ và tài khoản đối tác theo phân quyền.
5. Nhập lịch do đối tác xác nhận qua CSV/JSON hoặc tạo chuyến riêng. Ghi mã hợp đồng/tệp/email xác nhận trong trường nguồn cung cấp.
6. Đối soát giá, giờ, điểm đón/trả, sơ đồ và quyền phân phối số ghế được mở bán. Nếu nhà xe bán qua các kênh khác, cần phân bổ kho ghế riêng hoặc bổ sung kết nối đồng bộ giữ chỗ với API nhà xe.
7. Cấu hình SMTP rồi kiểm tra đăng ký, xác minh email, khôi phục mật khẩu và email đặt chỗ bằng địa chỉ email bạn quản lý.
8. Ký kết/cấu hình tài khoản merchant VNPAY nếu nhận tiền trực tuyến. Kiểm thử trước trên môi trường sandbox riêng. Khi production, dùng URL thanh toán thật được cấp và đăng ký URL IPN.
9. Đặt và hủy vé thử trên lịch kiểm thử riêng; kiểm tra ghế được giải phóng, nhật ký và biên nhận. Sau đó mở lịch đã xác nhận cho khách.

## Thanh toán và hoàn tiền

Khách có 5 phút giữ ghế trước khi tạo vé; mỗi phiên có tối đa hai chuyến đang giữ để hỗ trợ khứ hồi. Giữ ghế không phải xác nhận đã thu tiền. Kho có ghế đang giữ hoặc đã đặt không được thay giá, lịch và sơ đồ cho đến khi hết hạn/giải phóng; ngừng mở bán vẫn giữ lịch sử.

- Thanh toán tại nhà xe tạo đặt chỗ đang chờ thu tiền. Xác nhận đặt chỗ và xác nhận đã thu tiền là hai thao tác riêng.
- Nhân viên chỉ ghi nhận tiền mặt sau khi đã thu đủ, kèm mã phiếu thu thực tế. Mỗi biên nhận chỉ được ghi một lần.
- Với VNPAY, trình duyệt quay về không đủ để đánh dấu đã thanh toán. IPN phải có chữ ký đúng, mã đơn đúng và số tiền khớp. IPN lặp không tạo khoản thu thứ hai.
- Giữ chỗ khi thanh toán trực tuyến có hạn 15 phút. IPN đến sau khi ghế đã giải phóng sẽ được ghi nhận vào hàng chờ hoàn tiền; hệ thống không giành lại ghế đã bán cho người khác.
- Hủy vé đã thu tiền tạo trạng thái chờ hoàn tiền. Hoàn tiền cần thực hiện và đối soát với cổng thanh toán/nhà xe; phần mềm không báo đã chuyển tiền khi chưa có chứng từ.
- Sau khi đã hoàn đủ tiền thực tế, nhân viên nhập phiếu hoàn/mã chuyển khoản trong quản trị. Số tiền phải khớp với vé; mã chứng từ chỉ được ghi một lần và có nhật ký người xử lý.
- Đặt chỗ khách tự hủy cần trước giờ khởi hành ít nhất hai giờ. Quản trị có quyền xử lý vận hành và nhật ký ghi nhận người thao tác.

Tài liệu tích hợp: [VNPAY PAY](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html).

## Khứ hồi, ưu đãi và đổi vé

Đơn khứ hồi chứa hai mã vé, tạo trong một giao dịch. Hiện nhận thanh toán tại nhà xe theo từng chiều. Hủy một chiều không tự hủy chiều còn lại; trang đơn hiển thị tổng gốc và số tiền các chiều còn hiệu lực.

Quản trị tạo ưu đãi cố định/phần trăm, mức đơn tối thiểu, trần giảm, thời hạn và hạn mức. Có thể giới hạn nhà xe, tuyến hoặc chỉ khứ hồi. Lượt sử dụng được kiểm tra ở máy chủ và khóa khi tạo đơn. Hủy/hết hạn đơn chưa thanh toán trả lại lượt; với khứ hồi, chỉ trả sau khi cả hai chiều không còn hiệu lực. Lượt của đơn đã thanh toán/hoàn vẫn được tính để tránh tái sử dụng ưu đãi. Hạn mức theo khách sử dụng số điện thoại đã chuẩn hóa; không thay thế xác minh danh tính nếu sau này triển khai chương trình chỉ dành cho khách mới.

Đổi vé hiện hỗ trợ cùng nhà xe, tuyến, nguồn và giá gốc, số hành khách giữ nguyên, trước giờ đi ít nhất hai giờ. Chiết khấu của vé được giữ lại, ghế cũ/mới cập nhật trong giao dịch và có nhật ký. Khi cần thay giá, liên hệ nhà xe xử lý đối soát; hệ thống từ chối tự đổi với chênh lệch chưa được xác nhận.

Nhà xe mở Danh sách ở chuyến để xem/in hành khách và điểm đón/trả. Số chỗ có thể gồm vé chờ thanh toán; cần kiểm tra trạng thái trước khi cho khách lên xe.

## Email

Cấu hình `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Dịch vụ SMTP có thể là máy chủ doanh nghiệp hoặc một dịch vụ gửi email giao dịch.

Trong phát triển, khi chưa cấu hình SMTP, email được ghi vào `data/email-outbox.jsonl` để kiểm tra liên kết xác minh/khôi phục. Tệp này có dữ liệu nhạy cảm, không được phục vụ qua HTTP hay đưa vào ZIP.

Production không dùng hộp thư phát triển. Nếu chưa có SMTP, các chức năng đăng ký/khôi phục qua email không mở; quản trị vẫn có thể vận hành kho vé đã nhập và khách có thể đặt chỗ bằng thông tin liên hệ.

## Dữ liệu và sao lưu

- Phát triển: SQLite nằm trong `data/ticket4t.sqlite`; vé, ghế, tài khoản và phiên đăng nhập được giữ qua lần khởi động sau.
- Production: PostgreSQL lưu lịch, người dùng, đặt chỗ, ghế, khoản thu, nhật ký và phiên. Dùng `pg_dump` cho sao lưu, kiểm tra khôi phục trên một database riêng.
- Không chạy seed minh họa vào database vận hành. `npm run seed` bị chặn ở production.
- Không chạy `legacy-index.js`; các endpoint cũ tạo bảng và thay mật khẩu hàng loạt không được gắn vào ứng dụng mới.
- Các bảng Sequelize cũ và các migration đã sửa được giữ để phục hồi mã nguồn gốc. Backend mới dùng schema vận hành riêng, khởi tạo có kiểm soát trong `server/database.js`; không cần chạy migration Sequelize để khởi động bản mới.

## Triển khai

Chạy Node.js 24 LTS dưới một trình quản lý tiến trình hoặc Docker, đặt sau reverse proxy HTTPS. Khi chỉ có một proxy được tin cậy phía trước, đặt `TRUST_PROXY=1`; cấu hình proxy chuyển tiếp đúng giao thức và địa chỉ IP.

Health check: `GET /api/health`. Phiên đăng nhập lưu trong database; cookie có `HttpOnly`, `SameSite=Lax` và `Secure` ở production. Yêu cầu ghi dữ liệu từ website khác bị từ chối; API có giới hạn tần suất.

Docker Compose sử dụng PostgreSQL 16 và health check. Điền `POSTGRES_PASSWORD` và `SESSION_SECRET` trước khi chạy. Cấu hình production dùng tên miền HTTPS và kho dữ liệu riêng, không sử dụng volume kiểm thử đã có tài khoản mẫu.

## Nguồn của dự án

- Mã nguồn Node/Express, dữ liệu và ảnh có sẵn trong thư mục dự án người dùng cung cấp.
- `20221203140358-create-chuyen-xe.txt`: đối chiếu và sửa quan hệ chuyến xe. `carId` liên kết nhà xe; `cateCarId` liên kết loại xe. File đính kèm thiếu dấu đóng và tham chiếu sai bảng.
- `review.txt`, `20221203142901-create-review.txt`: phục hồi quan hệ đánh giá với tài khoản và nhà xe.
- `hướng dẫn.docx`: đọc như tài liệu tham khảo cài đặt. Tài liệu nói MongoDB nhưng mã nguồn gốc dùng PostgreSQL/Sequelize; bản hoàn thiện chọn SQLite cho phát triển và PostgreSQL cho vận hành.
- [Vexere](https://vexere.com/): tham khảo trải nghiệm tìm tuyến/ngày, lựa chọn chuyến và tra cứu đơn. Không lấy kho ghế riêng, danh tính khách hàng hay thông tin thanh toán của Vexere.

Nội dung tài liệu đính kèm được dùng làm dữ liệu tham khảo, không thay thế yêu cầu trực tiếp của người dùng.
