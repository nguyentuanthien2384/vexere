# API Ticket4T

Tiền tố `/api`. JSON UTF-8. Xác thực dùng cookie phiên `ticket4t.sid`. Yêu cầu ghi từ một origin khác bị từ chối. Mã lỗi trả về `{ "error": "…", "code": "…" }` với HTTP 400/401/403/404/409/503 tương ứng.

## Dữ liệu công khai

- `GET /bootstrap`: địa điểm, nhà xe, loại xe, tuyến phổ biến, thống kê, ngày Việt Nam, nhãn nguồn và phương thức thanh toán được mở.
- `GET /health`: tình trạng kết nối database.
- `GET /locations`: mã và tên địa điểm.
- `GET /operators`, `GET /operators/:id`: hồ sơ nhà xe và đánh giá. Đánh giá mẫu có `source=demo`, `verifiedBooking=false`.
- `GET /trips`: truy vấn `from`, `to`, `date`, `operator`, `type`, `minPrice`, `maxPrice`, `time`, `sort`, `page`, `limit`, `q`, `pickup`, `dropoff`, `available`.
- `GET /trips/:id`: lịch, điểm đón/trả, tiện ích, chính sách và `seats` gồm nhãn, tầng, giá, trạng thái.
- `GET /promotions`: các mã ưu đãi đang mở và điều kiện áp dụng.
- `GET /demo-scenarios`: bộ tình huống mẫu trong chế độ phát triển; không công khai khi chạy production.

`date` dạng `YYYY-MM-DD`, giờ `HH:mm`, giá là số nguyên VND. `time` nhận `morning`, `afternoon`, `evening`, `night`; `sort` nhận `departure`, `price`, `rating`. Loại xe: `limousine`, `sleeper`, `cabin`, `seater`.

Tìm kiếm `q`, `pickup`, `dropoff` không phân biệt hoa/thường hoặc dấu tiếng Việt, nhận cả Unicode phân rã. `%`, `_` và `!` là ký tự trong từ khóa, không phải wildcard. `q` tìm tên nhà xe, tuyến, loại xe, điểm đón/trả, điểm dừng và tiện ích. Mỗi tham số được hỗ trợ chỉ nhận một giá trị chuỗi; lặp tham số hoặc gửi dạng mảng/object, enum/mã địa điểm/mã nhà xe không hợp lệ, ngày không tồn tại, giá âm/không hữu hạn hay `minPrice > maxPrice` trả HTTP 400 `VALIDATION_ERROR`. `page`/`limit` phải là số nguyên dương; giới hạn tối đa lần lượt 10.000 và 100.

`GET /trips` lọc giá trên từng ghế đang trống, bỏ ghế đã đặt hoặc đang giữ. Ít nhất một ghế phải nằm trong toàn bộ khoảng giá; chuyến có ghế 200.000 và 400.000 không khớp khoảng 300.000–300.000. `sort=price` dùng giá thấp nhất của ghế phù hợp. `available=true` chỉ trả chuyến còn ghế trống, `available=false` chỉ trả chuyến hết ghế; bỏ tham số để xem cả hai. Kết quả có `trips`, `total`, `page`, `pages`; yêu cầu trang vượt cuối được đưa về trang cuối còn dữ liệu, kết quả rỗng dùng trang 1.

Mỗi chuyến tìm được giữ `price` là giá cơ sở để tương thích đặt vé/quản trị, đồng thời trả `displayPrice` (giá ghế trống thấp nhất phù hợp bộ lọc), `minAvailablePrice`, `maxAvailablePrice` (khoảng giá toàn bộ ghế trống) và `matchingSeats` (số ghế trống phù hợp). Ba trường giá là `null` khi hết ghế. Giao diện dùng `displayPrice` để hiển thị “Giá từ”; API giữ ghế/đặt vé luôn kiểm tra lại tồn và tính giá trong giao dịch. `bookingOpen` vẫn mô tả giờ mở bán, không thay cho tình trạng còn ghế; khách có thể xem lại chuyến và ghế đang giữ của mình.

`GET /admin/trips` vẫn lọc/sắp xếp theo giá cơ sở của chuyến để quản lý lịch và giá, với kiểm tra tham số, tìm chữ và phân trang tương tự trong phạm vi nhà xe được cấp quyền.

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

Giá được tính từ database, không nhận tổng tiền do client gửi. Tối đa 6 ghế mỗi lần. `paymentMethod` nhận `cash`, `vnpay`, `momo`, `zalopay`; chỉ cổng có cấu hình hợp lệ mới được mở. Thanh toán online giữ ghế 15 phút. Response có `paymentUrl` khi khởi tạo thành công. Nếu MoMo/ZaloPay không trả kết quả sau khi đặt chỗ đã lưu, HTTP 201 vẫn trả `booking` và `paymentError:{code,message}` để khách tra cứu/đối soát. Không sử dụng đặt chỗ minh họa để thanh toán thật.

`POST /bookings` và `POST /orders` hỗ trợ header `Idempotency-Key`: 16–128 ký tự chữ/số hoặc `._:-`. Client tạo giá trị ngẫu nhiên ít nhất 128 bit và giữ nguyên cả key lẫn body khi thử lại sau mất kết nối. Cùng key và body trả đơn đã tạo với trạng thái hiện tại, `replayed:true`, header `Idempotency-Replayed:true`; không giữ ghế, dùng ưu đãi hoặc gửi email lần hai. Cùng key nhưng body/endpoint khác trả 409 `IDEMPOTENCY_CONFLICT`. Khóa của tài khoản được giới hạn theo user; khóa khách vãng lai là quyền khôi phục bí mật và yêu cầu đúng toàn bộ payload ban đầu. Database lưu hash khóa. Thay thông tin đặt vé cần khóa mới; không dùng retry để tạo đơn khác. Giao diện lưu lần gửi chưa rõ kết quả trong sessionStorage để khôi phục sau khi tải lại.

`POST /bookings/:code/payment-link` nhận `{phone}` hoặc phiên tài khoản sở hữu vé; trả `{booking,paymentUrl}` cho vé online còn chờ và chưa hết hạn. Không kéo dài giữ ghế. VNPAY tạo lại URL có chữ ký; MoMo/ZaloPay sử dụng cùng mã đơn merchant và URL đã lưu. Nếu kết quả khởi tạo ví chưa xác định, trả `PAYMENT_RECONCILIATION_REQUIRED` và không gửi yêu cầu tạo đơn thu tiền thứ hai. Chờ IPN/đối soát với cổng; API này không tự xác nhận thanh toán. Giao diện tra cứu kiểm tra trạng thái trong tối đa một phút, có nút làm mới thủ công.

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
- `GET /admin/stats?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`: hai mốc bao gồm ngày chọn theo giờ Việt Nam; tối đa 366 ngày khi đủ hai mốc. `stats.grossRevenue` là tiền đã thu theo chứng từ, `refundedAmount` là đã hoàn, `revenue` là thu ròng. Tiền đã thu vẫn được tính trong lúc vé chờ hoàn. `outstandingAmount`, `refundPendingAmount` là số tiền trên các đơn trong kỳ. `analytics` chứa `daily`, `byStatus`, `byPaymentMethod`, `byOperator`, `byRoute`; đơn theo ngày đặt, chuyến theo ngày đi, tiền theo ngày thu/hoàn. Khi lọc một phía hoặc toàn bộ, bảng ngày hiển thị trong `analytics.dailyRange`, tối đa 366 ngày.
- `GET /admin/bookings`: lọc `q`, `status`, `paymentStatus`, `operator`, `dateFrom`, `dateTo`, `page`, `limit`; ngày lọc theo lúc đặt vé. Quyền và báo cáo vé dùng nhà xe/tuyến đã lưu trong vé, giữ lịch sử sau khi chuyển chủ chuyến.
- `POST /admin/bookings`: bán một chuyến tại quầy với cùng `tripId`, `seats`, `fullName`, `phone`, `pickup`, `dropoff` như đặt vé công khai; `email` tùy chọn, `paymentMethod=cash` mặc định. Máy chủ xác nhận quyền nhà xe, giờ đóng bán, ghế và giá trong giao dịch; trả `{booking}` có `channel=counter`, `createdBy` là mã nhân viên, `userId=null`, `paymentStatus=pending`. Không tự ghi tiền đã thu.
- `GET /admin/audit`: nhật ký vận hành có `events`, `total`, `page`, `pages`; lọc `q`, `actor`, `action`, `entityType`, `entityId`, `operator`, `dateFrom`, `dateTo`, `page`, `limit`. Mỗi sự kiện gồm mã, người thực hiện, vai trò, thao tác, đối tượng, nhà xe, thời gian và `data` đã chọn lọc. Không ghi mật khẩu hoặc token; operator chỉ đọc nhật ký nhà xe của mình.
- `POST /admin/operators`, `PATCH /admin/operators/:id`, `DELETE /admin/operators/:id`.
- `POST /admin/trips`, `PATCH /admin/trips/:id`, `DELETE /admin/trips/:id`.
- `POST /admin/trips/:id/duplicate`: đổi ngày/giờ và các thông tin cần thiết. Bản sao của chuyến mẫu vẫn mang nguồn mẫu.
- `POST /admin/import`: `{source:"operator", sourceReference:"nguồn xác nhận", trips:[…]}`; hoặc nội dung `csv`. Tối đa 500 chuyến, kiểm tra toàn bộ trước khi lưu.
- `PATCH /admin/bookings/:code`: `status=confirmed` xác nhận đặt chỗ, `status=cancelled` xử lý hủy.
- `POST /admin/bookings/:code/cash-receipt`: `reference` của phiếu thu đã thực hiện, `amount` nếu gửi phải bằng đúng tổng vé; giao diện xác nhận đã thu đủ tiền trước khi gửi. Mã chứng từ không được trùng.
- `POST /admin/bookings/:code/refund-receipt`: `reference`, `amount` bằng đúng tổng tiền của vé đang chờ hoàn. Ghi chứng từ hoàn đã thực hiện; không gọi ngân hàng chuyển tiền.
- `GET /admin/bookings/:code/events`: nhật ký xử lý.
- `POST /admin/bookings/:code/reschedule`: cùng dữ liệu đổi vé; kiểm tra phạm vi nhà xe của nhân viên.
- `GET /admin/trips/:id/manifest`: danh sách hành khách, ghế, điểm đón/trả và trạng thái thu tiền; giới hạn theo nhà xe.
- `GET /admin/promotions`, `POST /admin/promotions`, `PATCH /admin/promotions/:code`, `DELETE /admin/promotions/:code`: chỉ quản trị; xóa là ngừng mã, giữ lịch sử sử dụng.
- `GET /admin/users`, `POST /admin/users`, `PATCH /admin/users/:id`: chỉ quản trị viên; cấp/đổi quyền nhà xe, bật/tắt tài khoản và đổi mật khẩu. Phiên cũ bị thu hồi khi thay đổi quyền.

Chuyến quản lý cần `operatorId`, `from`, `to`, `date`, `departureTime`, `durationMinutes`, `price`, `totalSeats`, `type`, `pickupPoints`, `dropoffPoints`, `provenance`. `seatPrices` là map giá theo nhãn ghế tùy chọn. Điểm đón/trả, tiện ích và chính sách là mảng chuỗi. Chuyến đã có ghế đặt hoặc giữ tạm không được thay lịch, giá, sơ đồ, điểm đón/trả hoặc thời gian hành trình; vẫn sửa được tiện ích/chính sách. Ngừng bán giữ đặt chỗ và lịch sử. Chỉ admin được bật/tắt nhà xe; operator chỉnh thông tin liên hệ trong phạm vi của mình. Các thao tác ghi kiểm tra lại quyền nhân viên bên trong giao dịch và lưu nhật ký cùng lúc với thay đổi.

Ưu đãi có `code`, `title`, `description`, `type=fixed|percentage`, `value`, `minSpend`, `maxDiscount`, `maxUses`, `perCustomer`, `roundTripOnly`, `operatorIds`, `routeIds`, `startsAt`, `expiresAt`, `active`. Thời điểm ISO 8601; `routeIds` dạng `ho-chi-minh--da-lat`. Trạng thái và `usedCount` được máy chủ quản lý. Hạn mức được khóa trong giao dịch, không chỉ kiểm tra ở giao diện.

## Callback thanh toán

- `GET /payments/vnpay/ipn`: xác minh chữ ký, mã merchant, mã vé, số tiền và trạng thái; lặp callback không ghi tiền hai lần.
- `GET /payments/vnpay/return`: kiểm tra chữ ký, chuyển về tra cứu vé; không đánh dấu đã thanh toán.
- `POST /payments/momo/ipn`: xác minh HMAC-SHA256, partner, requestId/mã đơn đã lưu và đúng số tiền. Xử lý thành công trả HTTP 204.
- `POST /payments/zalopay/ipn`: kiểm tra MAC key2 trên chuỗi `data` nguyên gốc, app_id, mã đơn đã lưu, số tiền và loại callback đơn hàng. Trả `{return_code:1,return_message:"success"}` khi đã xử lý; MAC sai `-1`, cần thử lại `0`.
- `GET /payments/momo/return`, `GET /payments/zalopay/return`: chuyển về tra cứu bằng `code`, không ghi nhận tiền. Trình duyệt trong cùng phiên có thể phục hồi số điện thoại từ sessionStorage; phiên khác vẫn phải nhập mã và số điện thoại.

Hai endpoint IPN ví nhận yêu cầu server-to-server và xác thực bằng chữ ký, không phụ thuộc cookie/origin trình duyệt. Các API ghi khác vẫn kiểm tra cùng origin. Callback lặp không ghi tiền hai lần; callback thành công đến sau khi ghế hết hạn hoặc đã bán lại ghi khoản đã nhận vào hàng chờ hoàn tiền, không lấy ghế của khách sau. Hoàn tiền cần chứng từ đối soát của nhân viên; chưa gọi API hoàn tiền tự động.

MoMo dùng `captureWallet`, khóa `MOMO_PARTNER_CODE`, `MOMO_ACCESS_KEY`, `MOMO_SECRET_KEY` và `MOMO_URL`. ZaloPay dùng `ZALOPAY_APP_ID`, `ZALOPAY_KEY1`, `ZALOPAY_KEY2`, `ZALOPAY_URL`. Mẫu `.env.example` dùng endpoint sandbox chính thức. Production yêu cầu endpoint live chính thức và APP_URL HTTPS. Khứ hồi hiện vẫn chỉ thanh toán tại nhà xe. Tài liệu giao thức: [MoMo tạo thanh toán](https://developers.momo.vn/v3/docs/payment/api/wallet/onetime/), [MoMo IPN](https://developers.momo.vn/v3/docs/payment/api/result-handling/notification/), [ZaloPay tạo đơn](https://docs.zalopay.vn/docs/specs/order-create/), [ZaloPay callback](https://docs.zalopay.vn/docs/developer-tools/knowledge-base/callback/).

Tham số/chữ ký tuân theo [tài liệu VNPAY PAY](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html). Đăng ký URL IPN public và thông tin merchant với cổng thanh toán trước khi vận hành.

## Kết nối API lịch nhà xe

Chỉ quản trị viên có quyền đọc `GET /admin/integrations`. Endpoint trả số lượng dữ liệu mẫu/nhà xe, tình trạng cấu hình feed, VNPAY, MoMo, ZaloPay, SMTP và database. `configured` chỉ xác nhận cấu hình cục bộ; `externallyVerified:false` thể hiện chưa kiểm chứng dịch vụ thật. Không trả khóa, mã merchant, URL máy chủ, chuỗi kết nối hoặc dữ liệu khách.

Khi đã có đối tác, cấu hình `OPERATOR_FEED_URL`, `OPERATOR_FEED_TOKEN`, `OPERATOR_FEED_OPERATOR_ID` trong `.env`. Tạo hồ sơ nhà xe vận hành trước và dùng ID của hồ sơ đó. Máy chủ gọi GET tới URL cố định với `Authorization: Bearer <token>`. HTTPS bắt buộc; HTTP loopback chỉ dùng phát triển/kiểm thử. Không theo redirect; timeout mặc định 8 giây (`OPERATOR_FEED_TIMEOUT_MS`, 100–30000 ms), phản hồi tối đa 1 MB, tối đa 500 chuyến.

Đối tác hoặc adapter cần chuẩn hóa phản hồi theo hợp đồng của Ticket4T:

```json
{
  "version": 1,
  "sourceReference": "Lịch được xác nhận / kho ghế phân bổ theo hợp đồng",
  "trips": [{
    "externalId": "ma-luot-khoi-hanh-duy-nhat",
    "from": "ho-chi-minh",
    "to": "da-lat",
    "date": "2026-10-12",
    "departureTime": "22:00",
    "durationMinutes": 420,
    "type": "sleeper",
    "price": 250000,
    "totalSeats": 20,
    "pickupPoints": ["Bến xe đi"],
    "dropoffPoints": ["Bến xe đến"],
    "amenities": ["Điều hòa"],
    "policies": ["Có mặt trước 30 phút"],
    "active": true
  }]
}
```

`externalId` phải ổn định và duy nhất cho từng lượt khởi hành, không chỉ từng tuyến. `operatorId` luôn lấy từ cấu hình máy chủ. Có thể gửi `seatPrices` hợp lệ theo sơ đồ. Không nhận trường trạng thái ghế đã bán/giữ từ hệ thống khác. Chỉ mở bán phần ghế được nhà xe phân bổ riêng cho Ticket4T; API giữ/đặt/hủy ghế liên hệ thống cần triển khai theo tài liệu đối tác thực tế.

- `POST /admin/integrations/operator-feed/preview` body `{}`: đọc feed và kiểm tra toàn bộ; trả `preview:{digest,sourceReference,counts:{created,updated,unchanged},trips:[…]}`. Chưa nhập lịch.
- `POST /admin/integrations/operator-feed/apply` body `{digest}`: đọc lại feed; khác digest trả 409 `OPERATOR_FEED_CHANGED`. Kiểm tra lại giữ ghế/đặt chỗ trong giao dịch; một chuyến lỗi rollback toàn đợt. Upsert bằng ánh xạ nhà xe + externalId; đồng bộ lại không sinh chuyến trùng. Ghi nhật ký khi có thay đổi.

Chuyến đã có khách/giữ ghế không được sửa lịch, tuyến, giá, số chỗ hoặc điểm đón/trả. Chuyến vắng trong feed vẫn giữ nguyên: muốn ngừng bán cần đối tác gửi `active:false` và xử lý khách hiện có theo quy trình vận hành. Đây là đồng bộ lịch theo lần chạy từ trang **Kết nối API**, chưa có tác vụ nền tự động, kết nối Vexere hoặc đồng bộ tồn ghế đa kênh.
