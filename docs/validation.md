# Kết quả kiểm tra bản 3 — 07/10/2026

## Xác nhận và khôi phục đổi chuyến tại cổng vận hành — 08/10/2026

- Admin/nhà xe gửi `expectedSourceVersion`, `expectedBookingVersion` và `Idempotency-Key`. Khi mất phản hồi, giữ nguyên body/path/key cùng thông tin vé gốc/chuyến mới; thông báo toàn cổng cho phép mở lại sau reload trong cùng tài khoản. Yêu cầu khôi phục cần xác nhận thủ công, khóa lựa chọn ban đầu và không tạo thêm lần đổi. Replay hiển thị trạng thái hiện tại kể cả vé đã hủy, hoàn tiền hoặc đổi tiếp.
- Vé gốc hoặc điều kiện chuyến mới thay đổi yêu cầu tải lại và kiểm tra trạng thái, ghế, giá, lịch, điểm đón/trả rồi đồng ý mới. Hai lỗi phản hồi muộn đã được sửa và có ca hồi quy: tải lại sau lỗi không ghi đè editor mới của cùng mã vé; tải danh sách sau thành công không mở lại chi tiết cũ khi người dùng đã điều hướng đi rồi quay lại.
- Helper thuần lưu snapshot bất biến, kiểm tra thời hạn 24 giờ, cấu trúc/body/path/key, ngày giờ thật, nhãn ghế/điểm/giá và danh tính gồm tài khoản/quyền/phạm vi nhà xe. Vé tiền mặt có `expiresAt:null` khôi phục được; cache sai bị loại. Không lưu điện thoại/email khách trong snapshot helper. Đăng xuất, hết phiên hoặc đổi danh tính/phạm vi xóa dữ liệu khôi phục; kiểm tra phiên trước/sau gửi và chặn phản hồi cũ tác động editor hoặc tài khoản mới.
- Thêm **10 unit + 7 API + 14 tình huống browser**. `npm run test:ci` đạt **292/292** (113 unit, 179 integration/component/subprocess), không skip/todo; **87** file JS hợp lệ, **39** tình huống catalogue và 4 nhóm kết nối ngoài chưa chạy. API nhân viên kiểm tra thu tiền/xác nhận/hủy trong lúc yêu cầu chờ, phiên bản nguồn/đích, key riêng từng tài khoản, giữ chứng từ và replay trạng thái hiện tại.
- Coverage backend SQLite đạt **97,31% dòng, 89,02% nhánh, 95,68% hàm**, vượt gate 95/85/90. Số này không đo JavaScript browser, kể cả helper frontend có unit test, hoặc dịch vụ đối tác.
- PostgreSQL **18.4** thực đạt **101/101** (19 backend, 20 nâng cao, 10 admin, 10 search, 16 hold-recovery, 16 reschedule-recovery, 7 admin-reschedule-contracts, 3 database/session). Mỗi file dùng schema riêng, các ca mới còn tách schema từng ca. Schema/cluster tạm riêng đã được dọn; không thay cluster của người dùng.
- `npm run test:ui:all` đạt **10/10** bộ Chrome trên mã cuối; bộ nhân viên đạt **14/14** ca, gồm nguyên body/key sau mất phản hồi và reload, chống gửi trùng, đồng ý mới sau thay đổi, mobile 390px, cache lỗi/ngày không tồn tại/key quá dài, thu hồi quyền, đổi tài khoản, replay vé hủy/đổi tiếp và hai race lồng nhau. Bộ mới không có lỗi JavaScript/CSP.

Hợp đồng tại [API](api.md), vận hành tại [hướng dẫn](operations.md), cách chạy tại [kiểm thử](testing.md), truy vết tại [danh mục ca](test-cases.json). Toàn bộ kiểm thử dùng kho tạm/loopback; không đổi `.env` hoặc database đang bán vé. Merchant/SMTP/API nhà xe thực, CI GitHub, PostgreSQL16/Docker và tải vận hành lớn chưa được xác minh trong đợt này. Các kiểm thử gate/fault injection không chứng nhận tải nhiều tiến trình thực.

Fixture của một lượt browser bị ngắt còn tại `C:\Users\Admin\AppData\Local\Temp\ticket4t-browser-admin-reschedule-nhXonL`: phê duyệt tự động từ chối thao tác xóa đệ quy với lý do `blocked by policy`. Không thử cách xóa khác; thư mục chỉ chứa dữ liệu kiểm thử. Các lượt hoàn tất sau đó và lượt mười bộ cuối đã dọn fixture riêng thành công.

## Đổi chuyến có phiên bản gốc và phục hồi an toàn — 08/10/2026

- API đổi chuyến khách/nhân viên hỗ trợ `Idempotency-Key`: cùng body/path/key chỉ chuyển ghế, tiêu thụ giữ chỗ và ghi lịch sử/audit một lần. Replay trả vé hiện tại sau khi giữ chỗ cũ đã tiêu thụ, chuyến đích ngừng bán, vé bị hủy hoặc đổi tiếp. Vẫn kiểm tra chủ vé, phiên và phạm vi nhân viên hiện tại. Lỗi trước commit rollback cả khóa yêu cầu.
- Tra cứu và đổi chuyến trả `rescheduleVersion`; `expectedSourceVersion` chặn xác nhận từ vé gốc đã đổi bằng `409 BOOKING_CHANGED`, kể cả A → B → A. Phiên bản điều kiện chuyến đích kiểm tra riêng. Giữ giá gốc, phân bổ ưu đãi, chứng từ và thứ tự đơn khứ hồi; client cũ không gửi trường/header mới vẫn tương thích. Replay gặp thay đổi chuyến khi lấy khóa thử tối đa ba giao dịch mới rồi trả `503 RESCHEDULE_RETRY` để client giữ nguyên yêu cầu và thử lại.
- Giao diện khách lưu nguyên request/key và snapshot nguồn/đích khi kết quả chưa rõ. Reload hoặc hết giữ ghế vẫn kiểm tra lại đúng yêu cầu; sửa điểm đón/trả phải khôi phục thông tin gốc và đồng ý lại trước khi gửi. Mã vé gắn với bản nháp, chặn gửi trùng; thay điều kiện hiển thị thông báo/trạng thái hiện tại và bỏ đồng ý cũ. Cache sai cấu trúc được bỏ an toàn. Phản hồi cũ không xóa bản nháp mới, ghi thông tin hoặc điều hướng tài khoản mới; đăng xuất/đổi tài khoản xóa snapshot vé gốc và yêu cầu khôi phục, kể cả tải lại sau đổi phiên ở tab khác.
- Thêm **10 unit + 16 API + 11 tình huống browser**. `npm run test:ci` đạt **275/275** (103 unit, 172 integration/component/subprocess), không skip/todo; **83** file JS hợp lệ, **37** tình huống catalogue và 4 nhóm kết nối ngoài chưa chạy.
- Coverage backend SQLite đạt **97,31% dòng, 88,93% nhánh, 95,68% hàm**, vượt gate 95/85/90. Module phiên bản vé gốc đạt 100% cả ba chỉ số; coverage này không đo browser hoặc dịch vụ đối tác.
- PostgreSQL **18.4** thực đạt **94/94** (19 backend, 20 nâng cao, 10 admin, 10 search, 16 hold-recovery, 16 reschedule-recovery, 3 database/session). Schema và cluster tạm riêng đã được dọn. Hai ca retry tranh chấp khóa dùng fault injection vào kết quả đọc trong transaction, không thay thế kiểm thử tải/multiworker thực.
- `npm run test:ui:all` đạt **9/9** bộ Chrome trên mã cuối; bộ đổi chuyến đạt **11/11** ca, gồm khôi phục nguyên body/key, consent mới sau thay đổi nguồn/đích, cache sai cấu trúc, trạng thái đã hủy, mobile 390px, hết giữ chỗ, phản hồi trễ và riêng tư giữa tài khoản. Bộ mới không có lỗi JavaScript/CSP. Ca hồi quy xác nhận `expiresAt:null` hợp lệ của vé trả tiền tại nhà xe vẫn phục hồi; thời hạn giữ ghế mới phải có ngày và cache có ngày hết hạn sai bị bỏ an toàn.

Hợp đồng tại [API](api.md), cách chạy tại [kiểm thử](testing.md), truy vết tại [danh mục ca](test-cases.json). Tất cả ca dùng kho tạm; không đổi `.env` hoặc database đang bán vé. Merchant/SMTP/API nhà xe thực, CI GitHub, PostgreSQL16/Docker và tải vận hành lớn chưa được xác minh trong đợt này.

## Giữ ghế, xác nhận giá và phục hồi checkout — 08/10/2026

- Chi tiết chuyến có `bookingVersion`; giữ ghế, báo giá và đặt vé có thể gửi `expectedBookingVersion`. Máy chủ kiểm tra dưới khóa chuyến; giá/lịch/điểm đón thay đổi trả `409 TRIP_CHANGED` trước khi tác động kho. Client cũ thiếu trường mới vẫn tương thích.
- Checkout gửi `expectedTotal` là tổng khách xác nhận. Ưu đãi đổi làm tổng khác sẽ trả `409 PRICE_CHANGED`, rollback đơn/vé/kho/quota/key/email; yêu cầu đã lưu vẫn replay bằng đúng body/key ban đầu kể cả ưu đãi đổi sau đó.
- Browser thiết lập cookie khách qua `/holds/session` trước lần giữ ghế đầu; retry sau mất phản hồi thay giữ chỗ cùng phiên trong giao dịch. Không nhả giữ cũ trước khi thay lựa chọn.
- Gia hạn từng chiều hết hiệu lực, bảo toàn chiều còn hạn. Khi chiều thứ hai lỗi hoặc phản hồi đến sau khi đổi bản nháp, chỉ dọn các giữ chỗ mới của lần gia hạn đó. `expectedHoldToken` chặn yêu cầu cũ đến máy chủ chậm thay lựa chọn mới trên cùng chuyến; bản băm token tiền nhiệm và danh sách ghế cho phép retry đúng lần gia hạn bị mất phản hồi, kể cả sau reload. Giá/điểm đón trả mới được hiển thị, ưu đãi cũ và đồng ý cũ bị bỏ để khách kiểm tra lại.
- Giữ thông tin hành khách trong bản nháp cùng hành trình khi reload, sửa ghế hoặc gia hạn; bỏ dữ liệu liên hệ, yêu cầu chưa rõ kết quả và số điện thoại thanh toán khi đăng xuất/đổi tài khoản. Tải lại tab sau khi tab khác đổi tài khoản cũng kiểm tra chủ bản nháp. Phản hồi checkout cũ không ghi dữ liệu hoặc điều hướng tài khoản mới. Cập nhật ghế theo từng chuyến, tránh yêu cầu chuyến cũ chặn hoặc ghi đè chuyến mới.
- Thêm **10 unit + 16 API + 15 tình huống browser**. `npm run test:ci` đạt **249/249** (93 unit, 156 integration/component/subprocess), không skip/todo; **79** file JS hợp lệ, **35** tình huống catalogue cùng 4 nhóm kết nối ngoài chưa chạy.
- Coverage backend SQLite: **97,26% dòng, 88,27% nhánh, 94,97% hàm**, đạt gate 95/85/90. Module phiên bản điều kiện chuyến đạt 100% dòng/hàm và 95,45% nhánh; số này không bao gồm browser hoặc dịch vụ ngoài.
- PostgreSQL **18.4** thực đạt **78/78** (19 backend, 20 nâng cao, 10 admin, 10 search, 16 hold-recovery, 3 database/session). Schema được dọn; cluster tạm riêng đã dừng và xóa thư mục. `npm run test:ui:all` đạt **8/8** bộ Chrome, gồm **15/15** ca checkout mới; không có lỗi JavaScript/CSP trong bộ mới. Ca mất phản hồi gia hạn kiểm tra cả reload và retry gặp `TRIP_CHANGED` trước khi giữ/đặt thành công.

Hợp đồng tại [API](api.md), cách chạy tại [kiểm thử](testing.md), truy vết tại [danh mục ca](test-cases.json). Toàn bộ kiểm thử dùng kho tạm; không đổi `.env` hoặc database đang bán vé. Chưa xác minh merchant/SMTP/API nhà xe thực, CI GitHub, PostgreSQL16/Docker hoặc tải vận hành lớn trong đợt này.

Một fixture tái hiện lỗi riêng biệt còn tại `C:\Users\Admin\AppData\Local\Temp\ticket4t-feature-contracts-EUtb0u`: phê duyệt tự động từ chối thao tác xóa đệ quy với lý do `blocked by policy`. Không thử cách xóa khác; fixture chỉ chứa dữ liệu kiểm thử. Cluster PostgreSQL và các lượt kiểm thử hoàn tất vẫn được dọn như đã ghi ở trên.

## Phát triển tìm kiếm, lọc chuyến và giữ ngữ cảnh khứ hồi — 08/10/2026

- API kiểm tra chặt tham số scalar, enum, ngày thật, mã địa điểm/nhà xe, khoảng giá và số nguyên phân trang. Tham số lặp/mảng/object, prototype names, NUL hoặc giá đảo trả 400; không còn lỗi 500 hay vô tình bỏ lọc. PostgreSQL nhận đúng các biên giá hữu hạn, kể cả fractional/lớn, nhờ bind kiểu numeric.
- Từ khóa, điểm đón/trả nhận tiếng Việt không dấu, chữ hoa và Unicode NFD. `%`, `_`, `!` và backslash được tìm theo nội dung thật. API và browser có ca hồi quy tương ứng.
- Lọc/sắp xếp public theo từng ghế đang trống; bỏ ghế đã đặt hoặc giữ tạm. Thêm `displayPrice`, `minAvailablePrice`, `maxAvailablePrice`, `matchingSeats` và `available=true/false`; giữ giá cơ sở `price` và tính tiền đặt vé ở máy chủ. Giá tuyến phổ biến cũng lấy từ ghế trống, bỏ tuyến hết ghế.
- SQL tính ghế giá cơ sở bằng số lượng và chỉ mở rộng các giá ghế riêng. Sửa truy vấn catalog PostgreSQL bị timeout với kho 7.200 chuyến mẫu; thêm index theo ngày chuyến và hết hạn đặt chỗ. Đây là kiểm thử fixture, chưa phải kiểm thử tải vận hành nhiều người dùng.
- Browser báo ngày/giá sai trước khi gửi tìm kiếm, kể cả radio tự áp dụng; có lọc còn chỗ và nhãn hết chỗ. Trang vượt cuối được đưa về trang cuối có dữ liệu, cập nhật URL đúng trang. Admin giữ bảng và bộ lọc khi tuyến chọn sai.
- Đổi ngày trên cùng tuyến giữ filter/sort; compare/favorites giữ chiều về và ghế lượt đi còn hiệu lực. Chuyến về đã lưu trong phiên mới hoặc hành trình khác mở được như một chiều, không gắn nhầm lượt đi hoặc nhả giữ chỗ chỉ vì điều hướng.
- Thêm **11 unit + 10 API + 13 tình huống browser**. `npm run test:ci` đạt **223/223** (83 unit, 140 integration/component/subprocess), không skip/todo; **75** file JS hợp lệ, **32** tình huống catalogue cùng 4 nhóm kết nối ngoài chưa chạy.
- Coverage SQLite/backend: **97,21% dòng, 87,89% nhánh, 94,87% hàm**, giữ ngưỡng 95/85/90. Module tìm kiếm đạt 100% dòng/hàm và 95,28% nhánh; coverage này không bao gồm browser hoặc dịch vụ đối tác.
- PostgreSQL **18.4** thực đạt **62/62** (19 backend, 20 nâng cao, 10 admin, 10 search, 3 database/session). Mỗi file/schema test đã dọn; cluster tạm riêng đã dừng và xóa thư mục. **7/7** bộ Chrome UI đạt, gồm 13 ca tìm/lọc mới và các bộ hiện có.

Hợp đồng mới tại [API](api.md), cách chạy tại [kiểm thử](testing.md), truy vết tại [danh mục ca](test-cases.json). Không đổi `.env` hoặc kho vé đang chạy. Chưa xác minh merchant/SMTP/API nhà xe thực, CI GitHub, PostgreSQL16/Docker hoặc tải lớn trong đợt này.

## Kiểm định và phát triển bộ test — 08/10/2026

- Trước đợt: 98 ca trộn API/component/helper; coverage baseline 95,20% dòng, 83,76% nhánh, 91,69% hàm, chưa có unit command, coverage gate, JUnit/LCOV hay CI.
- Sau bổ sung: `npm run test:ci` đạt **202/202**, gồm **72 unit** và **130 integration/component/subprocess**; không skip/todo. Coverage backend SQLite đạt **97,04% lines, 87,18% branches, 94,70% functions**. Ngưỡng CI: 95/85/90%; đã kiểm tra runner thật thất bại khi assertion sai hoặc coverage thiếu.
- `npm run check`: **71** file JavaScript hợp lệ; `test:cases` kiểm tra **29** tình huống theo nhóm chức năng và **4** nhóm kết nối ngoài chưa chạy. Mỗi tình huống có tiền điều kiện, input, bước, expected và mapping automation. JSON report ghi từng ca với ID, file/dòng, status và thời gian; có JUnit và LCOV.
- `npm run test:postgres` đạt **52/52** trên PostgreSQL **18.4** UTF8/locale C, cluster tạm riêng: backend 19, nâng cao 20, admin 10 và database/session chuyên biệt 3. Mỗi bộ dùng schema riêng, đã dọn schema; cluster riêng đã dừng và thư mục đã dọn. Các ca feature-contracts/wallet/feed mới khác vẫn SQLite, không được tuyên bố là đã kiểm chứng PostgreSQL.
- `npm run test:ui:all`: **6/6** bộ Chrome headless đạt; gồm 11 tình huống regression, 15 admin và 6 integrations cùng smoke/advanced/API. Bốn script đã kiểm tra lỗi launch với channel không tồn tại: thoát mã 1 trong khoảng 1,6–1,9 giây, không để server sống. Teardown có unit test lỗi close và guard path xóa.
- Sửa các lỗi được tái hiện bằng ca mới: CSV chấp nhận ký tự sau quote đóng; vượt 500 dòng nếu thiếu newline cuối; giới hạn CSV đếm ký tự thay UTF8 bytes; review dùng eligibility trước transaction nên lọt khi hủy thắng; ngày ưu đãi không tồn tại tự rollover; SMTP đã gửi nhưng cập nhật outbox lỗi làm trả chưa gửi. Thêm ID cuối cho sort tìm chuyến để phân trang đồng hạng ổn định.
- Thêm workflow GitHub Actions: Node24 Ubuntu/Windows, PostgreSQL16 và Chromium UI, lưu artifacts kể cả thất bại. Workflow chưa được chạy trên GitHub trong đợt này; PostgreSQL16/Docker chưa được xác minh thực ở local.

[Hướng dẫn kiểm thử](testing.md) và [danh mục ca](test-cases.json) ghi rõ phân tầng, cách chạy, tiêu chí và phần còn thiếu. Test sử dụng fixture/database/transport riêng; không gửi SMTP, không gọi merchant hoặc API nhà xe thật, không sửa kho vé của người dùng. Coverage chỉ tính source backend được nạp, không phải browser/legacy/live integration. Chưa có kiểm thử tải lớn, proxy nhiều tiến trình, visual baseline, WCAG/penetration audit toàn bộ hoặc xác minh kết nối merchant/SMTP/đối tác thực.

## Tích hợp API và phục hồi thanh toán — 08/10/2026

- `npm test`: 98/98 kiểm thử đạt trên SQLite và ranh giới HTTP. Bổ sung 45 kiểm thử cho chống gửi trùng/phục hồi sau restart, URL thanh toán, chữ ký/kiểu dữ liệu/trạng thái MoMo, MAC ZaloPay, callback lặp/đồng thời, tiền đến muộn, lỗi mạng sau khi đơn đã lưu, cấu hình và đồng bộ feed nhà xe.
- `npm run check`: 55 file JavaScript hợp lệ cú pháp; `git diff --check` đạt.
- `npm run test:ui`, `npm run test:ui:advanced`, `npm run test:ui:regression` (11 tình huống) và `npm run test:ui:admin` (15 tình huống) đạt.
- `npm run test:ui:api`: đạt thử lại đơn một chiều/khứ hồi sau mất phản hồi và reload; đổi dữ liệu đổi key; VNPAY/MoMo/ZaloPay tạo → quay về → tiếp tục → cập nhật đã thanh toán; lỗi tạo ví vẫn hiển thị đơn để đối soát; phản hồi trễ không đổi trang đang xem; ghế cập nhật tại chỗ giữ focus.
- `npm run test:ui:integrations`: 6 tình huống đạt, gồm cấu hình thiếu/đủ, xem trước chưa ghi dữ liệu, áp dụng/cập nhật không trùng, dữ liệu đổi sau xem trước bị chặn, quyền admin và bố cục desktop/mobile. Đã xem ảnh `artifacts/screenshots/integrations-desktop.png` và `integrations-mobile.png`.

Đã đối chiếu giao diện công khai [Vexere](https://vexere.com/) và giao thức thanh toán từ tài liệu chính thức MoMo/ZaloPay. Đợt này dùng database tạm, API nhà xe giả lập và callback có chữ ký kiểm thử; không thay dữ liệu của người dùng, không gọi merchant hoặc chuyển tiền thật. Chưa xác minh PostgreSQL, Docker, SMTP, merchant thực hay API nhà xe cụ thể trong đợt này.

API nhà xe mới đồng bộ lịch/giá/kho được phân bổ riêng theo JSON chuẩn hóa, có xem trước và upsert theo externalId. Chưa có API giữ/đặt/hủy ghế đa kênh hoặc kết nối Vexere; cần tài liệu đối tác để bổ sung phần này. Khứ hồi vẫn thanh toán tại nhà xe. Thanh toán ví mất phản hồi không tạo thêm đơn merchant; chờ IPN hoặc đối soát tại cổng. Chưa tự truy vấn lại giao dịch hoặc gọi API hoàn tiền. `.env` thật được giữ nguyên, các khóa mới có mẫu tại `.env.example`.

## Nâng cấp trang quản trị — 08/10/2026

- `npm run check`: 42 file JavaScript hợp lệ cú pháp; `git diff --check` đạt.
- `npm test`: 53/53 đạt trên SQLite và ranh giới ứng dụng web. Bổ sung kiểm thử báo cáo theo chứng từ, ngày Việt Nam, nhật ký có phạm vi nhà xe, giao dịch bán tại quầy, giữ chủ nhà xe/tuyến/giá lịch sử và quyền nhân viên thay đổi trong lúc chờ giao dịch.
- `npm run test:ui:admin`: 15 tình huống đạt. Bao gồm đăng nhập/phân quyền, lọc và phân trang, thêm/sửa/sao chép/ngừng bán chuyến, sửa tiện ích khi giá/lịch bị khóa, quản lý nhà xe/tài khoản, CSV/JSON và rollback khi dữ liệu đối tác thay đổi, phiếu thu/hoàn đúng tiền và không trùng chứng từ, danh sách hành khách, đóng modal bằng Escape và phản hồi tới muộn.
- Bán tại quầy được kiểm tra giới hạn sáu ghế, ghế đang giữ bởi khách khác, cạnh tranh khi lưu, giá theo ghế, email tùy chọn, đặt chỗ chưa thu tiền, tách khách khỏi tài khoản nhân viên, chặn nhà xe khác và ngăn đóng hộp thoại khi đang ghi. Tải sơ đồ lỗi có thể thử lại; tài khoản bị khóa trả 403 đưa về đăng nhập và xóa thông tin khách đang nhập.
- `npm run test:ui`, `npm run test:ui:advanced` và `npm run test:ui:regression` đều đạt; bộ hồi quy trang khách có 11 tình huống. Luồng thu tiền trong kiểm thử cũ đã cập nhật để đánh dấu xác nhận thu đủ tiền.
- Đã xem ảnh dashboard, bảng chuyến, nhật ký, danh sách hành khách và bán tại quầy trên desktop/mobile. Sơ đồ ghế, thông tin liên hệ, tóm tắt giá và các nút hiển thị trong khung; bảng cuộn bên trong, điều hướng hỗ trợ Escape và hộp thoại có nhãn truy cập.

Tiền thu ròng lấy từ sổ chứng từ: tiền đã thu vẫn được tính khi chờ hoàn, chỉ trừ sau khi ghi chứng từ hoàn. Tiền VNPAY đến muộn cũng được tính vào khoản đã thu/chờ hoàn, không lấy lại ghế đã bán cho người khác. Số đơn theo ngày đặt, lịch theo ngày đi, tiền theo ngày chứng từ; mốc ngày bao gồm cả ngày chọn theo `Asia/Ho_Chi_Minh`.

Đợt kiểm thử dùng database tạm riêng, không sửa dữ liệu đang chạy. SQL hỗ trợ SQLite/PostgreSQL nhưng chưa kiểm thử lại PostgreSQL thực, SMTP, merchant VNPAY hoặc Docker trong đợt này. Không có giao dịch thu/hoàn tiền thật.

Tham chiếu các chức năng công khai trong [hướng dẫn quản lý bán vé của Vexere](https://hotro.vexere.com/gioi-thieu-ung-dung-quan-ly-ban-ve/). Không truy cập được trang quản trị riêng để chứng nhận tương đương toàn bộ. Dự án hiện chưa có quản lý đội xe/tài xế, đại lý và công nợ, GPS, hay đồng bộ kho ghế với API nhà xe thật; hoàn tiền vẫn ghi nhận chứng từ đã thực hiện, không tự chuyển tiền.

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
