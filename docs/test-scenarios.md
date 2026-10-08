# Dữ liệu và tình huống kiểm thử bản 3

Đây là hướng dẫn thử dữ liệu demo bằng tay. Bộ tự động, cách chạy unit/API/UI và ngưỡng chất lượng nằm trong [testing.md](testing.md); [test-cases.json](test-cases.json) mô tả 29 tình huống theo chức năng và liên kết tới automation. Test tự động dùng kho tạm riêng, không chạy thao tác thử trên dữ liệu đang bán vé.

Mở `http://localhost:3000`. Bản phát triển tự tạo kho mẫu trên 30 ngày; không cần nhập thủ công. `npm run seed` bổ sung dữ liệu còn thiếu và giữ nguyên đặt chỗ đang có. Không chạy seed vào kho vận hành thật.

## Tài khoản

- Quản trị: `admin@ticket4t.vn` / `Admin@12345`.
- Khách: `khach@ticket4t.vn` / `Khach@12345`, số điện thoại tra cứu `0900000000`.
- Nhân viên nhà xe An Việt mẫu: `operator@ticket4t.vn` / `Nhaxe@12345`. Chỉ truy cập được chuyến/vé của `demo-op-1`.

Tất cả chứng từ thanh toán và hoàn tiền trong bộ tình huống đều là mô phỏng, không có giao dịch tiền thật. Chế độ production không tạo các tài khoản, mã ưu đãi hoặc vé này.

## Vé có sẵn

Nhập mã và số điện thoại `0900000000` trong Tra cứu vé:

- `T4TDEMORESERVED`: đặt chỗ thanh toán tại nhà xe, chưa thu tiền.
- `T4TDEMOPAID`: vé đã thanh toán mô phỏng, ghế đã đặt.
- `T4TDEMOPENDING`: chờ thanh toán VNPAY mô phỏng, hết hạn sau 15 phút từ lúc tạo dữ liệu.
- `T4TDEMOCANCELLED`: đã hủy, ghế được trả về kho.
- `T4TDEMOEXPIRED`: đã hết thời hạn thanh toán.
- `T4TDEMOREFUND`: đã yêu cầu hoàn tiền, chờ đối soát chứng từ.
- `T4TDEMOREFUNDED`: đã ghi nhận hoàn tiền mô phỏng.
- `T4TDEMOCOMPLETED`: chuyến đã đi, dùng kiểm tra giao diện lịch sử.
- `T4ODEMOROUND`: đơn khứ hồi, hai mã vé lượt đi/lượt về được liên kết.

Ngày chuyến được lấy tại lần thêm tình huống đầu tiên. Sau một thời gian, chúng trở thành lịch sử để tiếp tục thử tra cứu; kho chuyến tương lai vẫn được bổ sung. Dùng `GET /api/demo-scenarios` ở chế độ phát triển để lấy ngày tạo, mã đơn và mã chuyến chính xác. Nếu một ghế đã được bạn đặt từ bản cũ, hệ thống bỏ qua tình huống đụng ghế thay vì ghi đè vé của bạn.

## Mã ưu đãi

- `TEST50K`: giảm 50.000đ, tổng gốc từ 200.000đ, tối đa 5 lần/số điện thoại.
- `KHUHOI10`: giảm 10%, tối đa 150.000đ, đơn khứ hồi từ 300.000đ.
- `DALAT20`: giảm 20.000đ, áp dụng Sài Gòn ↔ Đà Lạt, tổng từ 100.000đ.
- `LIMO15`: giảm 15%, tối đa 100.000đ, chỉ nhà xe An Việt mẫu.
- `HETHAN`: mã hết hạn; máy chủ phải từ chối.
- `HETLUOT`: mã hết lượt; máy chủ phải từ chối.

Ngày hiệu lực được thiết lập tương đối từ thời điểm tạo bộ dữ liệu. Quản trị có thể sửa thời hạn trong trang Ưu đãi. Giá và giảm giá được tính lại khi tạo đơn, không tin tổng tiền do trình duyệt gửi.

## Luồng cần thử

1. Tìm Sài Gòn → Đà Lạt ngày mai; chọn loại xe/nhà xe, sắp xếp theo giá, lưu và so sánh chuyến.
2. Chọn hai ghế, tiếp tục, kiểm tra bộ đếm giữ ghế. Trong trình duyệt khác thử chọn cùng ghế: phải bị từ chối. Chờ hết giữ ghế rồi tải lại: ghế trở về kho nếu chưa tạo vé.
3. Áp dụng `TEST50K`, nhập khách và tạo vé; đối chiếu tổng gốc, tiền giảm và số tiền cuối trên trang vé.
4. Chọn Khứ hồi, lượt về ít nhất ngày sau lượt đi. Chọn ghế mỗi lượt, áp dụng `KHUHOI10`, tạo đơn và tra cứu cả hai vé. Nếu lịch về sớm hơn lúc chuyến đi tới, hệ thống từ chối.
5. Chọn Đổi vé từ vé còn hiệu lực; chọn chuyến cùng nhà xe/tuyến/giá và ghế trống. Ghế cũ phải được trả về kho và nhật ký lưu chuyến cũ/mới. Thay đổi giá cần nhà xe xử lý.
6. Hủy vé chưa thu tiền; ghế trở về kho. Hủy vé đã thanh toán mô phỏng; chuyển sang chờ hoàn, không hiển thị đã hoàn trước khi có biên nhận.
7. Ngày thứ ba từ lúc tạo dữ liệu: Hà Nội → Hải Phòng có chuyến limousine hết ghế; Hà Nội → Sa Pa có chuyến limousine còn một ghế. Dùng mã chuyến trong API tình huống để xác định lịch.
8. Trong quản trị, thêm ưu đãi cố định/phần trăm, giới hạn tuyến, kiểm tra hết hạn/hết lượt; mở Danh sách hành khách của chuyến và in.
9. Đăng nhập tài khoản nhà xe; thử truy cập nhà xe khác: máy chủ phải từ chối cả khi gọi API trực tiếp.

## Kiểm thử tự động

`npm test` kiểm tra nghiệp vụ trên database riêng, gồm cạnh tranh ghế, thời hạn giữ ghế, hạn mức ưu đãi, giao dịch khứ hồi, đổi vé, chữ ký VNPAY, chứng từ thu/hoàn và phân quyền. `npm run test:ui` kiểm tra luồng ban đầu; `npm run test:ui:advanced` kiểm tra các luồng bản 3 bằng Chrome headless.

Lộ trình dừng nghỉ hiện dùng để hiển thị thông tin. Chưa bán ghế theo từng chặng trung gian hoặc theo dõi GPS trực tiếp. Đơn khứ hồi hiện dùng thanh toán tại nhà xe; thanh toán VNPAY được hỗ trợ cho vé một chiều khi có cấu hình hợp lệ.
