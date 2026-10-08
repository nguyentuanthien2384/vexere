# API Ticket4T

Tiền tố `/api`. JSON UTF-8. Xác thực dùng cookie phiên `ticket4t.sid`. Yêu cầu ghi từ một origin khác bị từ chối. Mã lỗi trả về `{ "error": "…", "code": "…" }` với HTTP 400/401/403/404/409/503 tương ứng.

## Dữ liệu công khai

- `GET /bootstrap`: địa điểm, nhà xe, loại xe, tuyến phổ biến, thống kê, ngày Việt Nam, nhãn nguồn và phương thức thanh toán được mở.
- `GET /health`: tình trạng kết nối database.
- `GET /locations`: mã và tên địa điểm.
- `GET /operators`, `GET /operators/:id`: hồ sơ nhà xe và đánh giá. Đánh giá mẫu có `source=demo`, `verifiedBooking=false`.
- `GET /trips`: truy vấn `from`, `to`, `date`, `operator`, `type`, `minPrice`, `maxPrice`, `time`, `sort`, `page`, `limit`.
- `GET /trips/:id`: lịch, điểm đón/trả, tiện ích, chính sách và `seats` gồm nhãn, tầng, giá, trạng thái.
- `GET /promotions`: các mã ưu đãi đang mở và điều kiện áp dụng.
- `GET /demo-scenarios`: bộ tình huống mẫu trong chế độ phát triển; không công khai khi chạy production.

`date` dạng `YYYY-MM-DD`, giờ `HH:mm`, giá là số nguyên VND. `time` nhận `morning`, `afternoon`, `evening`, `night`; `sort` nhận `departure`, `price`, `rating`. Loại xe: `limousine`, `sleeper`, `cabin`, `seater`.

## Tài khoản

- `POST /auth/register`: `fullName`, `email`, `phone`, `password`.
- `POST /auth/login`: `email`, `password`; `POST /auth/logout`.
- `GET /auth/me`: thông tin an toàn của tài khoản hiện tại.
- `POST /auth/forgot-password`: `email`.
- `POST /auth/reset-password`: `token`, `password`.
- `POST /auth/verify`: `token`; `POST /auth/resend-verification` yêu cầu đăng nhập.

## Đặt vé

`POST /bookings` nhận:

```json
{
  "tripId": "id-chuyen-xe",
  "seats": ["A01", "A02"],
  "fullName": "Tên hành khách",
  "email": "khach@example.com",
  "phone": "0901234567",
  "pickup": "Một điểm đón có trong chuyến",
  "dropoff": "Một điểm trả có trong chuyến",
  "paymentMethod": "cash"
}
```

Giá được tính từ database, không nhận tổng tiền do client gửi. Tối đa 6 ghế mỗi lần. Với `vnpay`, response có `paymentUrl` khi cổng được cấu hình và giữ ghế 15 phút. Không sử dụng đặt chỗ minh họa để thanh toán thật.

`POST /holds` nhận `{tripId,seats}`; trả về `{hold:{token,tripId,seats,expiresAt}}`. Thời hạn 5 phút. Token ngẫu nhiên 256 bit là quyền sử dụng/giải phóng giữ ghế, cần giữ bí mật; database chỉ lưu bản băm. Phiên khách dùng để nhận diện ghế của mình và thay giữ chỗ. `DELETE /holds/:token` giải phóng giữ ghế khi có token đúng. Gửi `holdToken` khi tạo vé để chuyển giữ ghế thành đặt chỗ; token hết hạn không được dùng. Token vẫn dùng được khi khách đăng nhập trong lúc điền thông tin.

`POST /promotions/quote` nhận `{legs:[{tripId,seats}],couponCode,phone}`; trả `{subtotal,discount,total,couponCode}`. Báo giá không tiêu thụ hạn mức; khi tạo đơn, máy chủ kiểm tra và tính lại trong giao dịch. `POST /bookings` nhận thêm `couponCode` tùy chọn.

`POST /orders` tạo khứ hồi:

```json
{
  "legs": [
    {"tripId":"chuyen-di","seats":["A01"],"pickup":"Điểm đón hợp lệ","dropoff":"Điểm trả hợp lệ","holdToken":"token-di"},
    {"tripId":"chuyen-ve","seats":["A01"],"pickup":"Điểm đón hợp lệ","dropoff":"Điểm trả hợp lệ","holdToken":"token-ve"}
  ],
  "fullName":"Tên hành khách",
  "phone":"0901234567",
  "email":"khach@example.com",
  "paymentMethod":"cash",
  "couponCode":"KHUHOI10"
}
```

Trả `{order:{code,subtotal,discount,total,couponCode,bookings:[…]}}`. Hai lượt có tuyến đảo chiều, cùng số lượng ghế và lịch về sau khi lượt đi tới nơi. Nếu bất kỳ lượt nào không thể đặt, giao dịch rollback cả đơn. Hiện không hỗ trợ thanh toán VNPAY tổng hợp cho đơn khứ hồi.

- `GET /orders/lookup?code=…&phone=…`: tra cứu cả hai lượt.
- `GET /orders`: đơn thuộc tài khoản đang đăng nhập.
- `POST /bookings/:code/reschedule`: `{tripId,seats,pickup,dropoff,phone}`. Kiểm tra quyền sở hữu, nhà xe, tuyến, nguồn, giờ đi và tiền vé; cập nhật ghế trong một giao dịch, lưu nhật ký. Chuyến đích cần cùng giá; thay đổi mức giá cần nhà xe xử lý.

- `GET /bookings/lookup?code=…&phone=…`: cần đúng cả mã và số điện thoại.
- `GET /bookings`: lịch sử thuộc tài khoản đang đăng nhập.
- `POST /bookings/:code/cancel`: `phone` cho khách vãng lai; hoặc phiên tài khoản sở hữu vé.
- `POST /reviews`: `bookingCode`, `rating` từ 1–5, `title`, `comment`; yêu cầu vé thuộc người đăng nhập, đã thanh toán, chuyến đã kết thúc và là dữ liệu nhà xe cung cấp.

## Vận hành

Yêu cầu vai trò `admin` hoặc `operator`. Tài khoản operator bị giới hạn theo `operatorId` đã giao.

- `GET /admin/stats`, `/admin/trips`, `/admin/operators`, `/admin/bookings`.
- `POST /admin/operators`, `PATCH /admin/operators/:id`, `DELETE /admin/operators/:id`.
- `POST /admin/trips`, `PATCH /admin/trips/:id`, `DELETE /admin/trips/:id`.
- `POST /admin/trips/:id/duplicate`: đổi ngày/giờ và các thông tin cần thiết. Bản sao của chuyến mẫu vẫn mang nguồn mẫu.
- `POST /admin/import`: `{source:"operator", sourceReference:"nguồn xác nhận", trips:[…]}`; hoặc nội dung `csv`. Tối đa 500 chuyến, kiểm tra toàn bộ trước khi lưu.
- `PATCH /admin/bookings/:code`: `status=confirmed` xác nhận đặt chỗ, `status=cancelled` xử lý hủy.
- `POST /admin/bookings/:code/cash-receipt`: `reference` của phiếu thu đã thực hiện.
- `POST /admin/bookings/:code/refund-receipt`: `reference`, `amount` bằng đúng tổng tiền của vé đang chờ hoàn. Ghi chứng từ hoàn đã thực hiện; không gọi ngân hàng chuyển tiền.
- `GET /admin/bookings/:code/events`: nhật ký xử lý.
- `POST /admin/bookings/:code/reschedule`: cùng dữ liệu đổi vé; kiểm tra phạm vi nhà xe của nhân viên.
- `GET /admin/trips/:id/manifest`: danh sách hành khách, ghế, điểm đón/trả và trạng thái thu tiền; giới hạn theo nhà xe.
- `GET /admin/promotions`, `POST /admin/promotions`, `PATCH /admin/promotions/:code`, `DELETE /admin/promotions/:code`: chỉ quản trị; xóa là ngừng mã, giữ lịch sử sử dụng.
- `GET /admin/users`, `POST /admin/users`, `PATCH /admin/users/:id`: chỉ quản trị viên; cấp/đổi quyền nhà xe, bật/tắt tài khoản và đổi mật khẩu. Phiên cũ bị thu hồi khi thay đổi quyền.

Chuyến quản lý cần `operatorId`, `from`, `to`, `date`, `departureTime`, `durationMinutes`, `price`, `totalSeats`, `type`, `pickupPoints`, `dropoffPoints`, `provenance`. `seatPrices` là map giá theo nhãn ghế tùy chọn. Điểm đón/trả, tiện ích và chính sách là mảng chuỗi. Chuyến đã có ghế đặt không được thay lịch, giá hoặc sơ đồ; thao tác ngừng bán vẫn giữ đặt chỗ và lịch sử.

Ưu đãi có `code`, `title`, `description`, `type=fixed|percentage`, `value`, `minSpend`, `maxDiscount`, `maxUses`, `perCustomer`, `roundTripOnly`, `operatorIds`, `routeIds`, `startsAt`, `expiresAt`, `active`. Thời điểm ISO 8601; `routeIds` dạng `ho-chi-minh--da-lat`. Trạng thái và `usedCount` được máy chủ quản lý. Hạn mức được khóa trong giao dịch, không chỉ kiểm tra ở giao diện.

## Callback thanh toán

- `GET /payments/vnpay/ipn`: xác minh chữ ký, mã merchant, mã vé, số tiền và trạng thái; lặp callback không ghi tiền hai lần.
- `GET /payments/vnpay/return`: kiểm tra chữ ký, chuyển về tra cứu vé; không đánh dấu đã thanh toán.

Tham số/chữ ký tuân theo [tài liệu VNPAY PAY](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html). Đăng ký URL IPN public và thông tin merchant với cổng thanh toán trước khi vận hành.
