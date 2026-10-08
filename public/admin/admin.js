'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name, options) => window.TicketIcons.render(name, options);
const decorateIcons = root => window.TicketIcons.decorate(root || document);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money = value => new Intl.NumberFormat('vi-VN', {style:'currency',currency:'VND',maximumFractionDigits:0}).format(Number(value) || 0);
const number = value => new Intl.NumberFormat('vi-VN').format(Number(value) || 0);
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const formatDate = value => value ? new Intl.DateTimeFormat('vi-VN', {timeZone:'Asia/Ho_Chi_Minh',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(value.length === 10 ? `${value}T12:00:00+07:00` : value)) : '—';
const tomorrow = () => { const date = new Date(`${today()}T12:00:00+07:00`); date.setUTCDate(date.getUTCDate()+1); return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(date); };
const types = [{id:'limousine',name:'Limousine'}, {id:'sleeper',name:'Giường nằm'}, {id:'cabin',name:'Phòng riêng'}, {id:'seater',name:'Ghế ngồi'}];
const statuses = {reserved:['Giữ ghế','amber'],pending_payment:['Chờ thanh toán','amber'],confirmed:['Đã xác nhận','green'],cancelled:['Đã hủy','gray'],expired:['Hết hạn','gray'],refund_pending:['Chờ hoàn tiền','red']};
const pages = {
  dashboard: ['Tổng quan','BỨC TRANH VẬN HÀNH','Theo dõi lịch trình, nguồn dữ liệu và đơn vé của bạn.'],
  trips: ['Chuyến xe','LỊCH TRÌNH & TỒN CHỖ','Quản lý thời gian khởi hành, giá vé và lịch chạy đã xác nhận.'],
  bookings: ['Đơn đặt vé','VÉ & HÀNH KHÁCH','Tra cứu khách hàng, trạng thái thanh toán và xử lý đơn vé.'],
  promotions: ['Khuyến mãi','ƯU ĐÃI & HẠN MỨC','Thiết lập ưu đãi theo thời gian, nhà xe và hành trình.'],
  operators: ['Nhà xe','ĐỐI TÁC VẬN CHUYỂN','Thông tin đối tác và đầu mối vận hành chuyến xe.'],
  users: ['Tài khoản','NHÂN SỰ & PHÂN QUYỀN','Cấp quyền vận hành cho nhân viên theo từng nhà xe.'],
  audit: ['Nhật ký vận hành','TRUY VẾT & ĐỐI SOÁT','Theo dõi thay đổi lịch trình, quyền truy cập và chứng từ trong phạm vi quản lý.'],
  import: ['Nhập lịch trình','KẾT NỐI DỮ LIỆU NHÀ XE','Đưa lịch chạy do nhà xe cung cấp vào hệ thống.'],
  integrations: ['Kết nối API','DỮ LIỆU & THANH TOÁN','Kiểm tra cấu hình kết nối và đồng bộ lịch chạy từ đối tác.'],
};
const state = {user:null,locations:[],operators:[],routes:[],promotions:[],users:[],trips:[],bookings:[],audit:[],page:'dashboard',pageNumber:1,stats:null,editor:null,importTrips:null,manifest:null,loadId:0,sessionId:0,filters:{},importBusy:false,confirm:null};
const auditLabels = {user_created:'Cấp tài khoản',user_updated:'Đổi thông tin / quyền tài khoản',operator_created:'Thêm nhà xe',operator_updated:'Cập nhật nhà xe',operator_deactivated:'Ngừng hoạt động nhà xe',trip_created:'Thêm chuyến',trip_updated:'Cập nhật chuyến',trip_deactivated:'Ngừng bán chuyến',trip_duplicated:'Sao chép chuyến',trips_imported:'Nhập lịch trình',booking_confirmed:'Xác nhận vé',booking_cancelled:'Hủy vé',counter_booking_created:'Bán vé tại quầy',cash_received:'Ghi nhận thu tiền mặt',refund_recorded:'Ghi nhận hoàn tiền',booking_rescheduled:'Đổi chuyến',promotion_created:'Tạo ưu đãi',promotion_updated:'Cập nhật ưu đãi',promotion_deactivated:'Tạm dừng ưu đãi'};
const entityLabels = {user:'Tài khoản',operator:'Nhà xe',trip:'Chuyến xe',import:'Đợt nhập',booking:'Đơn vé',promotion:'Ưu đãi'};
auditLabels.operator_feed_synced = 'Đồng bộ API nhà xe';
const dateTime = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',dateStyle:'short',timeStyle:'short'}).format(date); };
const addDateDays = (value, days) => { const date = new Date(`${value}T12:00:00+07:00`); date.setUTCDate(date.getUTCDate()+days); return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(date); };
function validDate(value) { const date = new Date(`${value}T12:00:00+07:00`); return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(date.getTime()) && addDateDays(value,0) === value; }
function validateRange(filters) {
  if ((filters.dateFrom && !validDate(filters.dateFrom)) || (filters.dateTo && !validDate(filters.dateTo))) throw new Error('Khoảng ngày chưa hợp lệ.');
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) throw new Error('Ngày kết thúc cần bằng hoặc sau ngày bắt đầu.');
  if (filters.dateFrom && filters.dateTo && new Date(`${filters.dateTo}T00:00:00+07:00`) - new Date(`${filters.dateFrom}T00:00:00+07:00`) > 365*86400000) throw new Error('Chọn khoảng tối đa 366 ngày.');
}

async function api(path, options = {}) {
  const sessionId = state.sessionId;
  const response = await fetch(`/api${path}`, {
    credentials:'same-origin',
    headers:{Accept:'application/json', ...(options.body ? {'Content-Type':'application/json'} : {})},
    ...options,
    ...(options.body ? {body:JSON.stringify(options.body)} : {}),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('Máy chủ chưa sẵn sàng. Vui lòng thử lại.'); }
  if (!response.ok) {
    if (response.status === 401 && state.user && sessionId === state.sessionId) showLogin('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
    if (response.status === 403 && state.user && sessionId === state.sessionId) {
      try {
        const sessionResponse = await fetch('/api/auth/me',{credentials:'same-origin',headers:{Accept:'application/json'}}), session = await sessionResponse.json();
        if (sessionResponse.ok && sessionId === state.sessionId && (!session.user || !['admin','operator'].includes(session.user.role) || session.user.id !== state.user?.id)) showLogin('Quyền truy cập hoặc phiên đăng nhập đã thay đổi. Vui lòng đăng nhập lại.');
      } catch { /* Giữ phiên hiện tại nếu không xác minh được kết nối. */ }
    }
    throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || 'Không thể thực hiện yêu cầu.');
  }
  return data;
}
function toast(message, isError = false) {
  const element = document.createElement('div');
  element.className = `toast${isError ? ' error' : ''}`;
  element.innerHTML = `${icon(isError ? 'info' : 'check-circle')}<span>${escapeHTML(message)}</span>`;
  $('#toast-stack').append(element);
  setTimeout(() => element.remove(), 5500);
}
function showLogin(message = '') {
  state.sessionId++;
  state.loadId++;
  document.dispatchEvent(new CustomEvent('ticket4t:session-cleared'));
  state.user = null;
  state.editor = null; state.manifest = null; state.confirm = null;
  state.locations = []; state.operators = []; state.trips = []; state.bookings = []; state.promotions = []; state.users = []; state.audit = []; state.stats = null; state.importTrips = null; state.importBusy = false; state.filters = {}; state.pageNumber = 1;
  ['#editor-dialog','#confirm-dialog','#manifest-dialog'].forEach(selector => { if ($(selector).open) $(selector).close(); });
  $('#content').innerHTML = ''; $('#editor-fields').innerHTML = ''; $('#manifest-content').innerHTML = ''; $('#toast-stack').innerHTML = '';
  const password = $('#login-form [name="password"]'); password.value = ''; password.type = 'password';
  $('#toggle-password').innerHTML = `${icon('eye',16)}<span>Hiện</span>`; $('#toggle-password').setAttribute('aria-pressed','false'); $('#toggle-password').setAttribute('aria-label','Hiện mật khẩu');
  $('#portal').hidden = true;
  $('#login-screen').hidden = false;
  $('#login-error').textContent = message;
}
function options(items, selected = '', allLabel = '') {
  return (allLabel ? `<option value="">${escapeHTML(allLabel)}</option>` : '') + items.map(item => `<option value="${escapeHTML(item.id)}"${String(item.id) === String(selected) ? ' selected' : ''}>${escapeHTML(item.name)}</option>`).join('');
}
function statusBadge(status) {
  const [label, color] = statuses[status] || [status || '—','gray'];
  return `<span class="badge ${color}">${escapeHTML(label)}</span>`;
}
function paymentLabel(status) {
  return {paid:'Đã thanh toán',refund_pending:'Chờ đối soát hoàn tiền',refunded:'Đã hoàn tiền',pending:'Chưa thanh toán'}[status] || 'Chưa thanh toán';
}
function canReschedule(booking) {
  return ['reserved','confirmed'].includes(booking.status) && ['pending','paid'].includes(booking.paymentStatus) && new Date(`${booking.trip?.date}T${booking.trip?.departureTime}:00+07:00`).getTime() > Date.now()+2*3600000;
}
function localDateTime(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(part => [part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function promotionStatus(promotion) {
  if (!promotion.active) return ['paused','Tạm dừng','gray'];
  if (new Date(promotion.expiresAt).getTime() <= Date.now()) return ['expired','Đã kết thúc','gray'];
  if (new Date(promotion.startsAt).getTime() > Date.now()) return ['upcoming','Chưa bắt đầu','blue'];
  if (Number(promotion.usedCount || 0) >= Number(promotion.maxUses)) return ['exhausted','Hết lượt','amber'];
  return ['active','Đang áp dụng','green'];
}
function locationName(id) { return state.locations.find(location => location.id === id)?.name || id; }
function routeName(id) { const [from,to] = String(id).split('--'); return `${locationName(from)} → ${locationName(to)}`; }
function sourceBadge(source) {
  return source === 'demo' ? '<span class="badge amber">Dữ liệu mẫu</span>' : '<span class="badge teal">Nhà xe cung cấp</span>';
}
const auditFieldLabels = {role:'Vai trò',operatorId:'Nhà xe',active:'Hoạt động',passwordChanged:'Đã đổi mật khẩu',name:'Tên',date:'Ngày đi',departureTime:'Giờ đi',from:'Điểm đi',to:'Điểm đến',price:'Giá vé',totalSeats:'Số chỗ',durationMinutes:'Thời gian (phút)',type:'Loại',changedFields:'Thông tin đã cập nhật',count:'Số chuyến nhập',tripIds:'Mã chuyến',sourceReference:'Nguồn xác nhận',status:'Trạng thái vé',total:'Tổng tiền',reference:'Mã chứng từ',amount:'Số tiền',fromTrip:'Chuyến cũ',toTrip:'Chuyến mới',fromSeats:'Ghế cũ',toSeats:'Ghế mới',seats:'Ghế',channel:'Kênh tạo vé',value:'Mức giảm',pickupPoints:'Điểm đón',dropoffPoints:'Điểm trả',amenities:'Tiện ích',policies:'Chính sách',provenance:'Nguồn xác nhận lịch',seatPrices:'Giá theo ghế'};
function auditDataHTML(data) {
  const entries = Object.entries(data || {});
  if (!entries.length) return 'Không có thông tin bổ sung.';
  return entries.map(([key,value]) => {
    let display = value;
    if (Array.isArray(value)) display = value.map(item => key === 'changedFields' ? auditFieldLabels[item] || item : item).join(', ');
    else if (key === 'operatorId' && value) display = operatorName(value);
    else if (['from','to'].includes(key)) display = locationName(value);
    else if (['price','total','amount'].includes(key)) display = money(value);
    else if (key === 'status') display = statuses[value]?.[0] || value;
    else if (key === 'role') display = {admin:'Quản trị viên',operator:'Nhân viên nhà xe',customer:'Khách hàng'}[value] || value;
    else if (key === 'type') display = types.find(item => item.id === value)?.name || {percentage:'Giảm phần trăm',fixed:'Giảm tiền cố định'}[value] || value;
    else if (key === 'channel') display = value === 'counter' ? 'Tại quầy' : 'Trực tuyến';
    else if (key === 'date') display = formatDate(value);
    else if (typeof value === 'boolean') display = value ? 'Có' : 'Không';
    else if (value && typeof value === 'object') return `<div><strong>${escapeHTML(auditFieldLabels[key] || key)}:</strong>${auditDataHTML(value)}</div>`;
    return `<div><strong>${escapeHTML(auditFieldLabels[key] || key)}:</strong> ${escapeHTML(display ?? '—')}</div>`;
  }).join('');
}
function empty(title, description, colspan = null) {
  const content = `<div class="empty-state"><span class="empty-state-icon">${icon('search',32)}</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p></div>`;
  return colspan ? `<tr><td colspan="${colspan}">${content}</td></tr>` : content;
}
function loading() { return '<div class="loading"><span class="spinner" aria-hidden="true"></span>Đang tải dữ liệu…</div>'; }
function pagination(data, noun) {
  const page = Number(data.page || state.pageNumber), total = Number(data.total ?? data[noun]?.length ?? 0), count = Number(data.pages || 1);
  return `<div class="table-footer"><span>${number(total)} ${{trips:'chuyến xe',bookings:'đơn vé',events:'sự kiện'}[noun] || 'kết quả'} trong kết quả</span><div class="pagination"><button type="button" data-paginate="${page - 1}"${page <= 1 ? ' disabled' : ''} aria-label="Trang trước">${icon('arrow-left',16)}</button><span>Trang ${page} / ${Math.max(count,1)}</span><button type="button" data-paginate="${page + 1}"${page >= count ? ' disabled' : ''} aria-label="Trang sau">${icon('arrow',16)}</button></div></div>`;
}

async function pagedData(path, id) {
  let data = await api(path);
  if (id !== state.loadId) return null;
  const lastPage = Math.max(1,Number(data.pages) || 1);
  if (state.pageNumber > lastPage) { state.pageNumber = lastPage; const query = new URL(path,'https://ticket4t.local'); query.searchParams.set('page',String(lastPage)); data = await api(query.pathname + query.search); }
  return id === state.loadId ? data : null;
}
function tripTable(trips) {
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Chuyến xe / Nhà xe</th><th>Khởi hành</th><th>Loại xe & Chỗ</th><th>Giá vé</th><th>Nguồn / Trạng thái</th><th>Thao tác</th></tr></thead><tbody>${trips.map(trip => `<tr><td><strong class="primary-text">${escapeHTML(trip.fromName || trip.from)} <span aria-hidden="true">→</span> ${escapeHTML(trip.toName || trip.to)}</strong><span class="sub-text">${escapeHTML(trip.operatorName || operatorName(trip.operatorId))}</span></td><td><strong class="primary-text">${escapeHTML(trip.departureTime)}</strong><span class="sub-text">${escapeHTML(formatDate(trip.date))}</span></td><td><span>${escapeHTML(trip.typeName || typeName(trip.type))}</span><span class="sub-text">${number(trip.availableSeats)} / ${number(trip.totalSeats)} chỗ trống · ${number(trip.durationMinutes)} phút</span><span class="sub-text">${number(trip.bookedSeats)} đã đặt · ${number(trip.heldSeats)} giữ tạm</span></td><td class="amount">${money(trip.price)}</td><td>${sourceBadge(trip.source)}<span class="sub-text">${!trip.active ? 'Đã ngừng bán' : trip.bookingOpen === false ? 'Đã đóng nhận vé' : 'Đang mở bán'}</span></td><td><div class="actions"><button class="action-button" data-action="counter-booking" data-id="${escapeHTML(trip.id)}"${trip.bookingOpen === false || !trip.active || !trip.availableSeats ? ' disabled' : ''}><span data-icon="plus" data-icon-size="14"></span>Bán tại quầy</button><button class="action-button" data-action="manifest" data-id="${escapeHTML(trip.id)}"><span data-icon="list" data-icon-size="14"></span>Danh sách</button><button class="action-button" data-action="edit-trip" data-id="${escapeHTML(trip.id)}"><span data-icon="edit" data-icon-size="14"></span>Sửa</button><button class="action-button" data-action="duplicate-trip" data-id="${escapeHTML(trip.id)}" aria-label="Sao chép chuyến"><span data-icon="copy" data-icon-size="14"></span>Sao chép</button><button class="action-button danger-text" data-action="delete-trip" data-id="${escapeHTML(trip.id)}"${trip.active ? '' : ' disabled'}><span data-icon="pause" data-icon-size="14"></span>Ngừng bán</button></div></td></tr>`).join('') || empty('Chưa có chuyến phù hợp','Thay đổi bộ lọc hoặc thêm lịch trình do nhà xe xác nhận.',6)}</tbody></table></div>`;
}
function operatorName(id) { return state.operators.find(operator => operator.id === id)?.name || id; }
function typeName(id) { return types.find(type => type.id === id)?.name || id; }
function bookingTable(bookings, compact = false) {
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Đơn vé / Hành khách</th><th>Hành trình</th>${compact ? '' : '<th>Ghế</th>'}<th>Tổng tiền</th><th>Trạng thái</th>${compact ? '' : '<th>Thao tác</th>'}</tr></thead><tbody>${bookings.map(booking => `<tr><td><button class="action-button" data-action="booking-detail" data-id="${escapeHTML(booking.code)}">${escapeHTML(booking.code)}</button>${booking.channel === 'counter' ? '<span class="badge teal">Tại quầy</span>' : ''}<span class="sub-text">${escapeHTML(booking.fullName)}</span>${compact ? '' : `<span class="sub-text">${escapeHTML(booking.phone)}</span>`}</td><td><strong class="primary-text">${escapeHTML(booking.trip?.fromName || booking.trip?.from || '—')} → ${escapeHTML(booking.trip?.toName || booking.trip?.to || '—')}</strong><span class="sub-text">${escapeHTML(formatDate(booking.trip?.date))} · ${escapeHTML(booking.trip?.departureTime || '')}</span></td>${compact ? '' : `<td>${escapeHTML((booking.seats || []).join(', '))}</td>`}<td><span class="amount">${money(booking.total)}</span><span class="sub-text">${paymentLabel(booking.paymentStatus)}</span></td><td>${statusBadge(booking.status)}</td>${compact ? '' : `<td><div class="actions">${['reserved','pending_payment','confirmed'].includes(booking.status) ? `<button class="action-button danger-text" data-action="cancel-booking" data-id="${escapeHTML(booking.code)}"><span data-icon="close" data-icon-size="14"></span>Hủy vé</button>` : '<span class="sub-text">—</span>'}${booking.paymentMethod === 'cash' && booking.paymentStatus === 'pending' && ['reserved','confirmed'].includes(booking.status) ? `<button class="action-button" data-action="cash-receipt" data-id="${escapeHTML(booking.code)}"><span data-icon="cash" data-icon-size="14"></span>Phiếu thu</button>` : ''}${canReschedule(booking) ? `<button class="action-button" data-action="reschedule-booking" data-id="${escapeHTML(booking.code)}"><span data-icon="swap" data-icon-size="14"></span>Đổi chuyến</button>` : ''}${booking.status === 'refund_pending' && booking.paymentStatus === 'refund_pending' ? `<button class="action-button" data-action="refund-receipt" data-id="${escapeHTML(booking.code)}"><span data-icon="wallet" data-icon-size="14"></span>Phiếu hoàn</button>` : ''}</div></td>`}</tr>`).join('') || empty('Chưa có đơn vé','Đơn mới sẽ hiển thị sau khi khách hàng đặt vé.',compact ? 5 : 6)}</tbody></table></div>`;
}

async function enterPortal(user) {
  if (!['admin','operator'].includes(user?.role)) return showLogin('Tài khoản này chưa có quyền truy cập cổng vận hành.');
  const sessionId = ++state.sessionId;
  state.user = user;
  $('#login-screen').hidden = true;
  $('#portal').hidden = false;
  $('#profile-name').textContent = user.fullName || user.email;
  $('#profile-role').textContent = user.role === 'admin' ? 'Quản trị hệ thống' : 'Điều hành nhà xe';
  $('#avatar').textContent = (user.fullName || user.email).split(/\s+/).slice(-2).map(part => part[0]).join('').toUpperCase();
  $('#portal-date').textContent = new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',dateStyle:'long'}).format(new Date());
  $('[data-page="operators"]').hidden = user.role !== 'admin';
  $('[data-page="users"]').hidden = user.role !== 'admin';
  $('[data-page="promotions"]').hidden = user.role !== 'admin';
  $('[data-page="integrations"]').hidden = user.role !== 'admin';
  try {
    const [locationData, operatorData] = await Promise.all([api('/locations'), api('/admin/operators')]);
    if (sessionId !== state.sessionId || !state.user) return;
    state.locations = locationData.locations || [];
    state.operators = operatorData.operators || [];
  } catch (error) { if (sessionId !== state.sessionId || !state.user) return; toast(error.message, true); }
  await navigate(pages[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard');
}
async function navigate(page, preserveFilters = false) {
  if (!state.user || !pages[page]) return;
  if (['operators','users','promotions','integrations'].includes(page) && state.user.role !== 'admin') page = 'dashboard';
  const previousPage = state.page;
  const oldFilters = preserveFilters ? (previousPage === page && $('#filters') ? Object.fromEntries(new FormData($('#filters'))) : state.filters[page] || {}) : {};
  try { if (['dashboard','audit','bookings'].includes(page)) validateRange(oldFilters); } catch (error) { return toast(error.message,true); }
  state.filters[page] = oldFilters;
  state.page = page;
  if (!preserveFilters) state.pageNumber = 1;
  location.hash = page;
  const [title,kicker,description] = pages[page];
  $('#page-title').textContent = title;
  $('#breadcrumb-page').textContent = title;
  $('#page-kicker').textContent = kicker;
  $('#page-description').textContent = description;
  $$('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  $('#sidebar').classList.remove('open');
  $('#menu-button').setAttribute('aria-expanded','false');
  $('#page-actions').innerHTML = page === 'trips' ? `<button class="button secondary" data-action="refresh">${icon('refresh')}Làm mới</button><button class="button primary" data-action="new-trip">${icon('plus')}Thêm chuyến</button>` : page === 'operators' ? `<button class="button primary" data-action="new-operator">${icon('plus')}Thêm nhà xe</button>` : `<button class="button secondary" data-action="refresh">${icon('refresh')}Làm mới</button>`;
  const id = ++state.loadId;
  $('#content').innerHTML = loading();
  try {
    if (page === 'dashboard') await renderDashboard(id,oldFilters);
    if (page === 'trips') await renderTrips(id, oldFilters);
    if (page === 'bookings') await renderBookings(id, oldFilters);
    if (page === 'promotions') await renderPromotions(id,oldFilters);
    if (page === 'operators') await renderOperators(id);
    if (page === 'users') await renderUsers(id,oldFilters);
    if (page === 'audit') await renderAudit(id,oldFilters);
    if (page === 'import') renderImport();
    if (page === 'integrations') await renderIntegrations(id);
  } catch (error) {
    if (id === state.loadId && state.user) $('#content').innerHTML = `<div class="panel">${empty('Không thể tải dữ liệu',error.message)}<div class="dialog-footer"><button class="button primary" data-action="refresh">Thử lại</button></div></div>`;
  }
  decorateIcons($('#portal'));
}
async function renderDashboard(id,filters = {}) {
  const rangeQuery = new URLSearchParams();
  ['dateFrom','dateTo'].forEach(key => { if (filters[key]) rangeQuery.set(key,filters[key]); });
  const [data, bookingData] = await Promise.all([api(`/admin/stats?${rangeQuery}`),api(`/admin/bookings?limit=5&${rangeQuery}`)]);
  if (id !== state.loadId) return;
  state.stats = data;
  state.bookings = bookingData.bookings || [];
  const stats = data.stats || {}, managed = Number(stats.managedTrips || 0), demo = Number(stats.demoTrips || 0), share = managed + demo ? managed / (managed + demo) * 100 : 0;
  const methods = (data.paymentMethods || []).filter(method => method.enabled).map(method => ({vnpay:'VNPAY',momo:'MoMo',zalopay:'ZaloPay',cash:'Tiền mặt tại quầy',demo:'Thanh toán mô phỏng'}[method.id] || method.id));
  $('#content').innerHTML = `<form id="filters" class="filters dashboard-range"><label>Từ ngày<input name="dateFrom" type="date" value="${escapeHTML(filters.dateFrom || '')}"></label><label>Đến ngày<input name="dateTo" type="date" value="${escapeHTML(filters.dateTo || '')}"></label><button class="button primary" type="submit">${icon('filter',16)}Áp dụng</button><button class="button secondary" type="button" data-action="dashboard-range" data-range="7">7 ngày qua</button><button class="button secondary" type="button" data-action="dashboard-range" data-range="30">30 ngày qua</button><button class="button secondary" type="button" data-action="reset-filters">Toàn bộ</button></form><div class="dashboard-period">${filters.dateFrom || filters.dateTo ? `Kỳ báo cáo: ${escapeHTML(formatDate(filters.dateFrom))} → ${escapeHTML(formatDate(filters.dateTo))}` : 'Kỳ báo cáo: toàn bộ dữ liệu'} · Giờ Việt Nam. Đơn theo ngày đặt; chuyến theo ngày khởi hành; tiền theo ngày thu / hoàn.</div>${demo ? '<div class="notice"><span class="notice-icon" data-icon="info"></span><div><strong>Hệ thống đang có dữ liệu mẫu</strong>Lịch mẫu dùng để kiểm thử luồng bán vé. Chỉ lịch trình có nguồn xác nhận từ nhà xe mới dùng để vận hành thực tế.</div></div>' : '<div class="notice teal"><span class="notice-icon" data-icon="shield"></span><div><strong>Lịch trình do nhà xe cung cấp</strong>Dữ liệu vận hành được quản lý theo quyền tài khoản. Kiểm tra tồn chỗ với nhà xe trước khi mở bán.</div></div>'}<div class="stats-grid">${[
    ['Thu ròng sau hoàn',money(stats.revenue),`Đã thu ${money(stats.grossRevenue)} · Hoàn ${money(stats.refundedAmount)}`,'wallet'],
    ['Đơn đặt vé',number(stats.bookings),`${number(stats.pendingBookings)} đơn đang chờ xử lý`,'ticket'],
    ['Chuyến xe',number(stats.trips),`${number(managed)} chuyến có nguồn nhà xe`,'bus'],
    ['Nhà xe',number(stats.operators),'Đối tác thuộc phạm vi tài khoản','building'],
  ].map(([label,value,sub,iconName]) => `<article class="stat-card"><div class="stat-top">${label}<span class="stat-icon">${icon(iconName)}</span></div><div class="stat-value">${value}</div><small>${sub}</small></article>`).join('')}</div><div class="stats-grid operational-stats">${[
    ['Chờ thu tiền',money(stats.outstandingAmount),`${number(stats.pendingBookings)} đơn giữ ghế / chờ thanh toán`,'cash'],
    ['Cần hoàn tiền',money(stats.refundPendingAmount),'Ghi phiếu hoàn sau khi thực sự chuyển tiền cho khách','wallet'],
    ['Tỷ lệ giữ chỗ',`${number(stats.occupancyRate)}%`,`${number(stats.occupiedSeats)} chỗ có vé / giữ tạm · ${number(stats.availableSeats)} chỗ trống`,'seat'],
    ['Chuyến mở bán',number(stats.activeTrips),`${number(stats.confirmedBookings)} đơn đã xác nhận trong kỳ`,'check-circle'],
  ].map(([label,value,sub,iconName]) => `<article class="stat-card"><div class="stat-top">${label}<span class="stat-icon">${icon(iconName)}</span></div><div class="stat-value">${value}</div><small>${sub}</small></article>`).join('')}</div>${dashboardAnalytics(data.analytics || {})}<div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h3>Đơn đặt vé gần đây</h3><p>Đơn theo khoảng ngày đã chọn</p></div><a href="#bookings" data-page="bookings">Xem tất cả <span data-icon="arrow" data-icon-size="16"></span></a></div>${bookingTable(state.bookings,true)}</section><section class="panel"><div class="panel-heading"><div><h3>Sẵn sàng vận hành</h3><p>Nguồn dữ liệu và kết nối thanh toán</p></div></div><div class="panel-body"><ul class="system-list"><li><div>Thanh toán<small>${escapeHTML(methods.join(', ') || 'Chưa bật phương thức thanh toán')}</small></div><span class="badge ${methods.length ? 'green' : 'amber'}">${methods.length ? 'Đã cấu hình' : 'Chờ cấu hình'}</span></li><li><div>Phạm vi quản lý<small>${state.user.role === 'admin' ? 'Toàn bộ hệ thống' : 'Chuyến xe thuộc nhà xe của bạn'}</small></div><span class="badge teal">${state.user.role === 'admin' ? 'Quản trị' : 'Nhà xe'}</span></li></ul><div class="source-counts"><div><strong>${number(managed)}</strong>Nhà xe cung cấp</div><div><strong>${number(demo)}</strong>Dữ liệu mẫu</div></div><div class="progress-line"><span class="managed-progress"></span><span class="demo-progress"></span></div><div class="quick-links"><a href="#trips" data-page="trips" class="quick-link"><span data-icon="bus"></span>Quản lý chuyến</a><a href="#import" data-page="import" class="quick-link"><span data-icon="upload"></span>Nhập lịch trình</a><a href="#audit" data-page="audit" class="quick-link"><span data-icon="list"></span>Nhật ký thay đổi</a></div></div></section></div>`;
  $('.managed-progress').style.width = `${share}%`;
  $('.demo-progress').style.width = `${100-share}%`;
  $$('[data-revenue-width]').forEach(bar => { bar.style.width = `${Number(bar.dataset.revenueWidth) || 0}%`; });
}
function dashboardAnalytics(analytics) {
  const daily = analytics.daily || [], byStatus = analytics.byStatus || [];
  if (!daily.length && !byStatus.length) return '';
  const visibleDays = daily.slice(-14), maximum = Math.max(1,...visibleDays.map(day => Number(day.grossRevenue) || 0));
  return `<div class="dashboard-grid analytics-grid"><section class="panel"><div class="panel-heading"><div><h3>Thu tiền theo ngày</h3><p>${daily.length > 14 ? '14 ngày cuối của kỳ báo cáo' : state.filters.dashboard?.dateFrom || state.filters.dashboard?.dateTo ? 'Các ngày trong khoảng báo cáo' : '14 ngày gần nhất'} · theo chứng từ ghi nhận</p></div></div><div class="panel-body"><div class="revenue-bars">${visibleDays.map(day => `<div class="revenue-row" title="${escapeHTML(formatDate(day.date))}: Thu ${money(day.grossRevenue)} · Hoàn ${money(day.refundedAmount)} · Thu ròng ${money(day.revenue)}"><span>${escapeHTML(formatDate(day.date).slice(0,5))}</span><div class="revenue-bar-track" aria-hidden="true"><div class="revenue-bar" data-revenue-width="${Math.max(0,Number(day.grossRevenue) || 0)/maximum*100}"></div></div><strong>${money(day.grossRevenue)}</strong></div>`).join('')}</div><details class="analytics-details"><summary>Xem chi tiết thu và hoàn theo ngày</summary><div class="table-wrap analytics-table"><table class="data-table"><thead><tr><th>Ngày</th><th>Đơn đặt</th><th>Đã thu</th><th>Đã hoàn</th><th>Thu ròng</th></tr></thead><tbody>${daily.map(day => `<tr><td>${escapeHTML(formatDate(day.date))}</td><td>${number(day.bookings)}</td><td class="amount">${money(day.grossRevenue)}</td><td>${money(day.refundedAmount)}</td><td class="amount">${money(day.revenue)}</td></tr>`).join('') || empty('Chưa có dữ liệu','Các giao dịch đã ghi nhận sẽ hiển thị tại đây.',5)}</tbody></table></div></details></div></section><section class="panel"><div class="panel-heading"><div><h3>Trạng thái đơn vé</h3><p>Số đơn đặt trong kỳ báo cáo</p></div></div><div class="panel-body"><ul class="system-list">${byStatus.map(item => `<li>${statusBadge(item.status)}<strong>${number(item.bookings)}</strong></li>`).join('') || '<li>Chưa có đơn trong kỳ.</li>'}</ul><div class="quick-links"><button class="quick-link" data-action="view-pending-bookings">${icon('ticket')}Xử lý đơn chờ</button><button class="quick-link" data-action="view-refund-bookings">${icon('wallet')}Đối soát hoàn tiền</button></div></div></section></div>`;
}
function queryFor(filters) {
  const params = new URLSearchParams({page:String(state.pageNumber),limit:'15'});
  Object.entries(filters).forEach(([key,value]) => { if (value) params.set(key,value); });
  return params.toString();
}
async function renderTrips(id, filters) {
  const data = await pagedData(`/admin/trips?${queryFor(filters)}`,id);
  if (!data) return;
  state.trips = data.trips || [];
  $('#content').innerHTML = `<form id="filters" class="filters"><label>Điểm đi<select name="from">${options(state.locations,filters.from,'Tất cả điểm đi')}</select></label><label>Điểm đến<select name="to">${options(state.locations,filters.to,'Tất cả điểm đến')}</select></label><label>Ngày khởi hành<input name="date" type="date" value="${escapeHTML(filters.date || '')}"></label><label>Nhà xe<select name="operator">${options(state.operators,filters.operator,'Tất cả nhà xe')}</select></label><label>Loại xe<select name="type">${options(types,filters.type,'Tất cả loại xe')}</select></label><button class="button primary" type="submit"><span data-icon="filter" data-icon-size="16"></span>Lọc</button><button class="button secondary" type="button" data-action="reset-filters"><span data-icon="refresh" data-icon-size="16"></span>Đặt lại</button></form><div class="panel">${tripTable(state.trips)}${pagination(data,'trips')}</div>`;
}
async function renderBookings(id, filters) {
  const data = await pagedData(`/admin/bookings?${queryFor(filters)}`,id);
  if (!data) return;
  state.bookings = data.bookings || [];
  $('#content').innerHTML = `<form id="filters" class="filters"><label>Mã vé / Email / Số điện thoại<input name="q" maxlength="60" placeholder="Tìm đơn vé…" value="${escapeHTML(filters.q || '')}"></label><label>Trạng thái<select name="status">${options(Object.entries(statuses).map(([id,[name]]) => ({id,name})),filters.status,'Tất cả trạng thái')}</select></label><label>Thanh toán<select name="paymentStatus">${options([{id:'pending',name:'Chưa thanh toán'},{id:'paid',name:'Đã thanh toán'},{id:'refund_pending',name:'Chờ hoàn tiền'},{id:'refunded',name:'Đã hoàn tiền'}],filters.paymentStatus,'Tất cả thanh toán')}</select></label><label>Ngày đặt cụ thể<input name="date" type="date" value="${escapeHTML(filters.date || '')}"></label><label>Từ ngày đặt<input name="dateFrom" type="date" value="${escapeHTML(filters.dateFrom || '')}"></label><label>Đến ngày đặt<input name="dateTo" type="date" value="${escapeHTML(filters.dateTo || '')}"></label><label>Nhà xe<select name="operator">${options(state.operators,filters.operator,'Tất cả nhà xe')}</select></label><button class="button primary" type="submit"><span data-icon="filter" data-icon-size="16"></span>Lọc</button><button class="button secondary" type="button" data-action="reset-filters"><span data-icon="refresh" data-icon-size="16"></span>Đặt lại</button></form><div class="panel">${bookingTable(state.bookings)}${pagination(data,'bookings')}</div>`;
}
async function renderAudit(id,filters) {
  const data = await pagedData(`/admin/audit?${queryFor(filters)}`,id);
  if (!data) return;
  state.audit = data.events || [];
  $('#content').innerHTML = `<div class="notice teal"><span class="notice-icon" data-icon="shield"></span><div><strong>Lịch sử thay đổi được lưu khi thực hiện thao tác</strong>Nhật ký giúp đối soát người thực hiện, đối tượng và thời điểm xử lý. Chỉ hiển thị dữ liệu trong phạm vi quyền của tài khoản.</div></div><form id="filters" class="filters"><label>Tìm mã / Tên người thực hiện<input name="q" maxlength="120" value="${escapeHTML(filters.q || '')}" placeholder="Mã vé, mã chuyến, tên nhân viên…"></label><label>Thao tác<select name="action">${options(Object.entries(auditLabels).map(([id,name]) => ({id,name})),filters.action,'Tất cả thao tác')}</select></label><label>Đối tượng<select name="entityType">${options(Object.entries(entityLabels).map(([id,name]) => ({id,name})),filters.entityType,'Tất cả đối tượng')}</select></label><label>Nhà xe<select name="operator">${options(state.operators,filters.operator,'Tất cả nhà xe')}</select></label><label>Từ ngày<input name="dateFrom" type="date" value="${escapeHTML(filters.dateFrom || '')}"></label><label>Đến ngày<input name="dateTo" type="date" value="${escapeHTML(filters.dateTo || '')}"></label><button class="button primary" type="submit">${icon('filter',16)}Lọc</button><button class="button secondary" type="button" data-action="reset-filters">${icon('refresh',16)}Đặt lại</button></form><div class="panel"><div class="table-wrap"><table class="data-table audit-table"><thead><tr><th>Thời điểm</th><th>Người thực hiện</th><th>Thao tác</th><th>Đối tượng</th><th>Nhà xe</th><th>Chi tiết</th></tr></thead><tbody>${state.audit.map(entry => `<tr><td>${escapeHTML(dateTime(entry.createdAt))}</td><td><strong class="primary-text">${escapeHTML(entry.actorName || entry.actorId || 'Hệ thống')}</strong><span class="sub-text">${escapeHTML({admin:'Quản trị viên',operator:'Nhân viên nhà xe',customer:'Khách hàng',system:'Hệ thống'}[entry.actorRole] || entry.actorRole || '')}</span></td><td>${escapeHTML(auditLabels[entry.action] || entry.action)}</td><td><span>${escapeHTML(entityLabels[entry.entityType] || entry.entityType)}</span><span class="sub-text">${escapeHTML(entry.entityId)}</span></td><td>${escapeHTML(entry.operatorId ? operatorName(entry.operatorId) : 'Toàn hệ thống')}</td><td><details class="audit-detail"><summary>Xem dữ liệu</summary><div class="audit-summary">${auditDataHTML(entry.data)}</div></details></td></tr>`).join('') || empty('Chưa có nhật ký phù hợp','Thử đổi bộ lọc. Các thay đổi mới sẽ được ghi nhận sau khi lưu thành công.',6)}</tbody></table></div>${pagination(data,'events')}</div>`;
}
async function renderOperators(id) {
  const data = await api('/admin/operators');
  if (id !== state.loadId) return;
  state.operators = data.operators || [];
  $('#content').innerHTML = `<div class="operator-grid">${state.operators.map(operator => `<article class="operator-card"><div class="card-head"><span class="operator-logo">${escapeHTML(operator.name.split(/\s+/).slice(0,2).map(part => part[0]).join('').toUpperCase())}</span><span class="badge ${operator.active ? 'green' : 'gray'}">${operator.active ? 'Hoạt động' : 'Tạm dừng'}</span></div><div><h3>${escapeHTML(operator.name)}</h3><p>${operator.source === 'demo' ? 'Nhà xe mẫu · kiểm thử hệ thống' : 'Đối tác vận chuyển'}</p></div><p class="description">${escapeHTML(operator.description || 'Chưa cập nhật giới thiệu nhà xe.')}</p><div class="operator-contact"><div><span>Điện thoại</span> · ${escapeHTML(operator.phone || 'Chưa cập nhật')}</div><div><span>Email</span> · ${escapeHTML(operator.email || 'Chưa cập nhật')}</div><div><span>Mã nhà xe</span> · ${escapeHTML(operator.id)}</div></div><div class="actions"><button class="button secondary small" data-action="edit-operator" data-id="${escapeHTML(operator.id)}"><span data-icon="edit" data-icon-size="16"></span>Chỉnh sửa</button><button class="button danger small" data-action="delete-operator" data-id="${escapeHTML(operator.id)}"><span data-icon="pause" data-icon-size="14"></span>Tạm dừng</button></div></article>`).join('') || `<div class="panel">${empty('Chưa có nhà xe','Thêm đối tác trước khi tạo chuyến và nhập lịch trình.')}</div>`}</div>`;
}

async function renderPromotions(id,filters) {
  const data = await api('/admin/promotions');
  if (id !== state.loadId) return;
  state.promotions = data.promotions || [];
  const term = (filters.q || '').toLocaleLowerCase('vi-VN');
  const promotions = state.promotions.filter(promotion => (!term || `${promotion.code} ${promotion.title}`.toLocaleLowerCase('vi-VN').includes(term)) && (!filters.status || promotionStatus(promotion)[0] === filters.status));
  $('#page-actions').innerHTML = `<button class="button secondary" data-action="refresh">${icon('refresh')}Làm mới</button><button class="button primary" data-action="new-promotion">${icon('plus')}Tạo ưu đãi</button>`;
  $('#content').innerHTML = `<div class="notice teal"><span class="notice-icon" data-icon="tag"></span><div><strong>Ưu đãi được kiểm tra khi khách đặt vé</strong>Lượt được giữ cùng đơn đặt vé. Đơn chưa thanh toán bị hủy hoặc hết hạn trả lại lượt; lượt của đơn đã thanh toán vẫn được tính.</div></div><form id="filters" class="filters"><label>Mã / Tên ưu đãi<input name="q" value="${escapeHTML(filters.q || '')}" placeholder="Tìm ưu đãi…"></label><label>Trạng thái<select name="status">${options([{id:'active',name:'Đang áp dụng'},{id:'upcoming',name:'Chưa bắt đầu'},{id:'exhausted',name:'Hết lượt'},{id:'expired',name:'Đã kết thúc'},{id:'paused',name:'Tạm dừng'}],filters.status,'Tất cả trạng thái')}</select></label><button class="button primary" type="submit"><span data-icon="filter" data-icon-size="16"></span>Lọc</button><button class="button secondary" type="button" data-action="reset-filters"><span data-icon="refresh" data-icon-size="16"></span>Đặt lại</button></form><div class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Mã / Ưu đãi</th><th>Mức giảm</th><th>Điều kiện & Phạm vi</th><th>Hiệu lực</th><th>Lượt sử dụng</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>${promotions.map(promotion => { const [,label,color] = promotionStatus(promotion); return `<tr><td><strong class="primary-text promo-code">${escapeHTML(promotion.code)}</strong><span class="sub-text">${escapeHTML(promotion.title)}</span>${promotion.source === 'demo' ? '<span class="badge amber">Ưu đãi mẫu</span>' : ''}</td><td><strong class="amount">${promotion.type === 'percentage' ? `${number(promotion.value)}%` : money(promotion.value)}</strong><span class="sub-text">${promotion.type === 'percentage' && promotion.maxDiscount > 0 ? `Tối đa ${money(promotion.maxDiscount)}` : promotion.type === 'percentage' ? 'Không giới hạn mức giảm' : 'Giảm theo đơn'}</span></td><td><span>${promotion.minSpend > 0 ? `Đơn từ ${money(promotion.minSpend)}` : 'Không yêu cầu đơn tối thiểu'}</span><span class="sub-text">${promotion.roundTripOnly ? 'Chỉ vé khứ hồi · ' : ''}${number(promotion.perCustomer)} lượt / khách</span><span class="sub-text" title="${escapeHTML((promotion.operatorIds || []).map(operatorName).join(', '))}">${promotion.operatorIds?.length ? `${number(promotion.operatorIds.length)} nhà xe` : 'Tất cả nhà xe'} · ${promotion.routeIds?.length ? `${number(promotion.routeIds.length)} tuyến` : 'Tất cả tuyến'}</span></td><td><span>${escapeHTML(formatDate(promotion.startsAt))}</span><span class="sub-text">đến ${escapeHTML(formatDate(promotion.expiresAt))}</span></td><td><strong>${number(promotion.usedCount || 0)} / ${number(promotion.maxUses)}</strong><span class="sub-text">Đang dùng / Tổng lượt</span></td><td><span class="badge ${color}">${label}</span></td><td><div class="actions"><button class="action-button" data-action="edit-promotion" data-id="${escapeHTML(promotion.code)}"><span data-icon="edit" data-icon-size="14"></span>Sửa</button>${promotion.active ? `<button class="action-button danger-text" data-action="pause-promotion" data-id="${escapeHTML(promotion.code)}"><span data-icon="pause" data-icon-size="14"></span>Tạm dừng</button>` : ''}</div></td></tr>`; }).join('') || empty('Chưa có ưu đãi phù hợp','Tạo mã mới hoặc thay đổi bộ lọc để xem ưu đãi.',7)}</tbody></table></div><div class="table-footer"><span>${number(promotions.length)} ưu đãi trong kết quả</span><span>Thời gian hiển thị theo giờ Việt Nam</span></div></div>`;
}
function beginEditor(editor) {
  state.editor = editor;
  const form = $('#editor-form'), button = form.querySelector('[type="submit"]');
  form.inert = false; form.removeAttribute('aria-busy');
  button.hidden = false; button.disabled = false; button.textContent = 'Lưu thông tin';
  $$('[data-close-dialog]').forEach(close => close.disabled = false);
}
function setEditorBusy(current,busy) {
  if (state.editor !== current) return;
  current.busy = busy;
  const form = $('#editor-form'); form.inert = busy; form.setAttribute('aria-busy',String(busy));
  form.querySelector('[type="submit"]').disabled = busy;
  $$('[data-close-dialog]').forEach(close => close.disabled = busy);
  if (!busy && current.kind === 'reschedule') updateRescheduleSummary();
}
function openPromotionEditor(promotion = null) {
  beginEditor({kind:'promotion',id:promotion?.code,routes:[...(promotion?.routeIds || [])]});
  $('#editor-form').reset();
  $('#editor-title').textContent = promotion ? 'Chỉnh sửa ưu đãi' : 'Tạo ưu đãi';
  $('#editor-kicker').textContent = promotion?.source === 'demo' ? 'ƯU ĐÃI MẪU · KIỂM THỬ' : 'KHUYẾN MÃI & HẠN MỨC';
  $('#editor-error').textContent = '';
  const selectedOperators = new Set(promotion?.operatorIds || []);
  $('#editor-fields').innerHTML = `${field('code','Mã ưu đãi',promotion?.code,'required minlength="3" maxlength="32" '+(promotion ? 'readonly' : ''),'text',false,'Từ 3–32 chữ, số, dấu gạch ngang hoặc gạch dưới.')}${field('title','Tên ưu đãi',promotion?.title,'required minlength="2" maxlength="150"')}${textareaField('description','Mô tả',promotion?.description)}${selectField('type','Hình thức giảm',[{id:'percentage',name:'Giảm theo phần trăm'},{id:'fixed',name:'Giảm số tiền cố định'}],promotion?.type || 'percentage')}${field('value','Mức giảm',promotion?.value || 10,'required min="1" step="1"','number',false,promotion?.type === 'fixed' ? 'Số tiền VND được giảm trên đơn.' : 'Phần trăm từ 1 đến 100.')}${field('minSpend','Đơn tối thiểu (VND)',promotion?.minSpend || 0,'required min="0" step="1"','number',false,'Nhập 0 để không giới hạn giá trị đơn.')}${field('maxDiscount','Giảm tối đa (VND)',promotion?.maxDiscount || 0,'required min="0" step="1"','number',false,'Áp dụng cho phần trăm; 0 là không giới hạn.')}${field('maxUses','Tổng lượt sử dụng',promotion?.maxUses || 1000,'required min="1" max="1000000" step="1"','number')}${field('perCustomer','Lượt tối đa / khách',promotion?.perCustomer || 1,'required min="1" max="1000000" step="1"','number')}${field('startsAt','Bắt đầu (giờ Việt Nam)',localDateTime(promotion?.startsAt || Date.now()),'required','datetime-local')}${field('expiresAt','Kết thúc (giờ Việt Nam)',localDateTime(promotion?.expiresAt || Date.now()+30*86400000),'required','datetime-local')}<label class="span-2">Nhà xe được áp dụng<select name="operatorIds" multiple size="4">${state.operators.map(operator => `<option value="${escapeHTML(operator.id)}"${selectedOperators.has(operator.id) ? ' selected' : ''}>${escapeHTML(operator.name)}</option>`).join('')}</select><small>Không chọn nhà xe nào để áp dụng cho tất cả. Có thể chọn nhiều nhà xe.</small></label><div class="span-2 route-builder"><label>Tuyến được áp dụng<small>Không thêm tuyến để áp dụng cho tất cả hành trình.</small></label><div class="route-builder-inputs"><select name="promotionFrom" aria-label="Điểm đi ưu đãi">${options(state.locations)}</select><select name="promotionTo" aria-label="Điểm đến ưu đãi">${options(state.locations,state.locations[1]?.id)}</select><button class="button secondary small" type="button" data-action="add-promotion-route"><span data-icon="plus" data-icon-size="16"></span>Thêm tuyến</button></div><div id="promotion-routes" class="route-chips"></div></div><label class="check-label span-2"><input name="roundTripOnly" type="checkbox"${promotion?.roundTripOnly ? ' checked' : ''}>Chỉ áp dụng cho đặt vé khứ hồi</label><label class="check-label span-2"><input name="active" type="checkbox"${promotion?.active !== false ? ' checked' : ''}>Bật mã ưu đãi</label>`;
  renderPromotionRoutes(); updatePromotionType();
  decorateIcons($('#editor-dialog'));
  $('#editor-dialog').showModal();
}
function renderPromotionRoutes() {
  if (state.editor?.kind !== 'promotion') return;
  $('#promotion-routes').innerHTML = state.editor.routes.map(route => `<button class="route-chip" type="button" data-action="remove-promotion-route" data-route="${escapeHTML(route)}">${escapeHTML(routeName(route))}${icon("close",14)}<span class="sr-only">Xóa tuyến</span></button>`).join('');
}
function updatePromotionType() {
  const form = $('#editor-form');
  const percentage = form.elements.type.value === 'percentage';
  form.elements.value.max = percentage ? '100' : '10000000';
  form.elements.value.parentElement.querySelector('small').textContent = percentage ? 'Phần trăm từ 1 đến 100.' : 'Số tiền VND được giảm trên đơn.';
  form.elements.maxDiscount.parentElement.hidden = !percentage;
  form.elements.maxDiscount.required = percentage;
  if (!percentage && !form.elements.maxDiscount.value) form.elements.maxDiscount.value = '0';
}
async function openManifest(trip) {
  const request = {tripId:trip.id}; state.manifest = request;
  $('#manifest-title').textContent = `${trip.fromName || trip.from} → ${trip.toName || trip.to}`;
  $('#manifest-content').innerHTML = loading();
  $('#manifest-dialog [data-action="print-manifest"]').disabled = true;
  $('#manifest-dialog').showModal();
  try {
    const data = await api(`/admin/trips/${encodeURIComponent(trip.id)}/manifest`);
    if (!$('#manifest-dialog').open || state.manifest !== request) return;
    Object.assign(request,data);
    const journey = data.trip || trip, counts = data.counts || {}, passengers = data.passengers || [];
    $('#manifest-content').innerHTML = `<div class="manifest-meta"><div><strong>${escapeHTML(journey.operatorName || operatorName(journey.operatorId))}</strong><p>${escapeHTML(formatDate(journey.date))} · ${escapeHTML(journey.departureTime)} · ${escapeHTML(journey.typeName || typeName(journey.type))}</p><small>Mã chuyến: ${escapeHTML(journey.id)}</small></div>${sourceBadge(journey.source)}</div><div class="manifest-counts"><div><strong>${number(counts.bookings ?? passengers.length)}</strong><span>Đơn vé đang giữ chỗ</span></div><div><strong>${number(counts.seats ?? passengers.reduce((sum,passenger) => sum+(passenger.seats?.length || 0),0))}</strong><span>Chỗ đang giữ</span></div><div><strong>${number(counts.paid || 0)}</strong><span>Đơn đã thanh toán</span></div><div><strong>${number(counts.unpaid || 0)}</strong><span>Đơn chưa thanh toán</span></div></div><div class="manifest-note">Danh sách gồm vé còn hiệu lực tại thời điểm tra cứu. Số chỗ đang giữ có thể gồm đơn chờ thanh toán; kiểm tra trạng thái trước khi cho khách lên xe.</div><div class="table-wrap"><table class="data-table manifest-table"><thead><tr><th>STT / Mã vé</th><th>Hành khách / Điện thoại</th><th>Ghế</th><th>Điểm đón</th><th>Điểm trả</th><th>Vé / Thanh toán</th></tr></thead><tbody>${passengers.map((passenger,index) => `<tr><td><strong>${index+1}</strong><span class="sub-text">${escapeHTML(passenger.bookingCode)}</span></td><td><strong class="primary-text">${escapeHTML(passenger.fullName)}</strong><span class="sub-text">${escapeHTML(passenger.phone)}</span></td><td><strong>${escapeHTML((passenger.seats || []).join(', '))}</strong></td><td>${escapeHTML(passenger.pickup || '—')}</td><td>${escapeHTML(passenger.dropoff || '—')}</td><td>${statusBadge(passenger.status)}<span class="sub-text">${paymentLabel(passenger.paymentStatus)}</span></td></tr>`).join('') || empty('Chưa có khách giữ chỗ','Chuyến này chưa có đơn vé còn hiệu lực.',6)}</tbody></table></div><div class="manifest-generated">Tra cứu lúc ${escapeHTML(new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',dateStyle:'short',timeStyle:'short'}).format(new Date()))} · Ticket4T</div>`;
    $('#manifest-dialog [data-action="print-manifest"]').disabled = false;
  } catch (error) { if ($('#manifest-dialog').open && state.manifest === request) $('#manifest-content').innerHTML = empty('Không thể tải danh sách',error.message); }
}
async function renderUsers(id,filters) {
  const data = await api('/admin/users');
  if (id !== state.loadId) return;
  state.users = data.users || [];
  const term = (filters.q || '').toLocaleLowerCase('vi-VN');
  const users = state.users.filter(user => (!term || `${user.fullName} ${user.email} ${user.phone}`.toLocaleLowerCase('vi-VN').includes(term)) && (!filters.role || user.role === filters.role) && (!filters.operator || user.operatorId === filters.operator));
  $('#page-actions').innerHTML = `<button class="button primary" data-action="new-user">${icon('plus')}Cấp tài khoản</button>`;
  $('#content').innerHTML = `<div class="notice teal"><span class="notice-icon" data-icon="users"></span><div><strong>Nhân viên chỉ quản lý nhà xe được cấp quyền</strong>Đổi mật khẩu, nhà xe hoặc tạm khóa tài khoản sẽ yêu cầu nhân viên đăng nhập lại. Tài khoản quản trị được thiết lập riêng.</div></div><form id="filters" class="filters"><label>Họ tên / Email / Điện thoại<input name="q" value="${escapeHTML(filters.q || '')}" placeholder="Tìm tài khoản…"></label><label>Vai trò<select name="role">${options([{id:'admin',name:'Quản trị viên'},{id:'operator',name:'Nhân viên nhà xe'},{id:'customer',name:'Khách hàng'}],filters.role,'Tất cả vai trò')}</select></label><label>Nhà xe<select name="operator">${options(state.operators,filters.operator,'Tất cả nhà xe')}</select></label><button class="button primary" type="submit"><span data-icon="filter" data-icon-size="16"></span>Lọc</button><button class="button secondary" type="button" data-action="reset-filters"><span data-icon="refresh" data-icon-size="16"></span>Đặt lại</button></form><div class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>Họ tên / Email</th><th>Điện thoại</th><th>Vai trò</th><th>Nhà xe</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>${users.map(user => `<tr><td><strong class="primary-text">${escapeHTML(user.fullName)}</strong><span class="sub-text">${escapeHTML(user.email)}</span></td><td>${escapeHTML(user.phone || '—')}</td><td><span class="badge ${user.role === 'admin' ? 'blue' : user.role === 'operator' ? 'teal' : 'gray'}">${{admin:'Quản trị viên',operator:'Nhân viên nhà xe',customer:'Khách hàng'}[user.role] || escapeHTML(user.role)}</span></td><td>${escapeHTML(user.operatorId ? operatorName(user.operatorId) : '—')}</td><td><span class="badge ${user.active !== false ? 'green' : 'gray'}">${user.active !== false ? 'Hoạt động' : 'Tạm khóa'}</span></td><td>${user.role === 'admin' ? '<span class="sub-text">Cấu hình riêng</span>' : `<button class="action-button" data-action="edit-user" data-id="${escapeHTML(user.id)}"><span data-icon="shield" data-icon-size="14"></span>Chỉnh sửa quyền</button>`}</td></tr>`).join('') || empty('Không có tài khoản phù hợp','Thay đổi bộ lọc hoặc cấp tài khoản cho nhân viên nhà xe.',6)}</tbody></table></div><div class="table-footer"><span>${number(users.length)} tài khoản hiển thị · tối đa 1.000 tài khoản gần đây</span></div></div>`;
}
function openUserEditor(user = null) {
  const operators = state.operators.filter(operator => operator.active || operator.id === user?.operatorId);
  if (!user && !operators.length) return toast('Tạo hoặc kích hoạt nhà xe trước khi cấp tài khoản nhân viên.',true);
  beginEditor({kind:'user',id:user?.id});
  $('#editor-form').reset();
  $('#editor-title').textContent = user ? 'Chỉnh sửa tài khoản' : 'Cấp tài khoản nhân viên';
  $('#editor-kicker').textContent = 'QUYỀN TRUY CẬP & NHÀ XE';
  $('#editor-error').textContent = '';
  $('#editor-fields').innerHTML = `${field('fullName','Họ tên',user?.fullName,'required minlength="2" maxlength="100"','text',true)}${field('email','Email đăng nhập',user?.email,'required maxlength="254"','email')}${field('phone','Điện thoại',user?.phone,'required maxlength="30"','tel')}${selectField('role','Vai trò',[{id:'operator',name:'Nhân viên nhà xe'},{id:'customer',name:'Khách hàng'}],user?.role || 'operator')}${selectField('operatorId','Nhà xe được quản lý',operators,user?.operatorId)}${field('password',user ? 'Mật khẩu mới (bỏ trống để giữ nguyên)' : 'Mật khẩu ban đầu','',`${user ? '' : 'required'} minlength="10" maxlength="128" autocomplete="new-password"`,'password',true,'Ít nhất 10 ký tự, gồm chữ hoa, chữ thường và chữ số.')}${user ? '<div class="notice teal span-2"><div>Nhân viên sẽ cần đăng nhập lại sau khi thay đổi thông tin hoặc quyền truy cập.</div></div>' : ''}<label class="check-label span-2"><input name="active" type="checkbox"${user?.active !== false ? ' checked' : ''}>Tài khoản được hoạt động</label>`;
  const operatorSelect = $('#editor-form [name="operatorId"]');
  operatorSelect.required = !user || user.role === 'operator';
  operatorSelect.parentElement.hidden = user?.role === 'customer';
  decorateIcons($('#editor-dialog'));
  $('#editor-dialog').showModal();
}
function field(name, label, value = '', extra = '', type = 'text', wide = false, help = '') {
  return `<label${wide ? ' class="span-2"' : ''}>${label}<input name="${name}" type="${type}" value="${escapeHTML(value)}" ${extra}>${help ? `<small>${help}</small>` : ''}</label>`;
}
function selectField(name, label, items, selected, wide = false) {
  return `<label${wide ? ' class="span-2"' : ''}>${label}<select name="${name}" required>${options(items,selected)}</select></label>`;
}
function textareaField(name, label, value, help = '', required = false) {
  return `<label class="span-2">${label}<textarea name="${name}" ${required ? 'required' : ''}>${escapeHTML(value || '')}</textarea>${help ? `<small>${help}</small>` : ''}</label>`;
}
function openTripEditor(trip = null, duplicate = false) {
  if (!state.operators.length || !state.locations.length) return toast('Cần tạo nhà xe và cấu hình danh sách địa điểm trước khi thêm chuyến.',true);
  const tripOperators = state.operators.filter(operator => (operator.active && (trip || operator.source !== 'demo')) || operator.id === trip?.operatorId);
  if (!tripOperators.length) return toast('Cần có nhà xe vận hành thật đang hoạt động trước khi thêm chuyến. Liên hệ quản trị để cấp nhà xe.',true);
  beginEditor({kind:duplicate ? 'duplicate-trip' : 'trip',id:trip?.id,trip});
  $('#editor-form').reset();
  $('#editor-title').textContent = duplicate ? 'Sao chép lịch trình' : trip ? 'Chỉnh sửa chuyến xe' : 'Thêm chuyến xe';
  $('#editor-kicker').textContent = trip?.source === 'demo' ? 'LỊCH TRÌNH MẪU · KIỂM THỬ' : 'LỊCH TRÌNH DO NHÀ XE XÁC NHẬN';
  $('#editor-error').textContent = '';
  $('#editor-fields').innerHTML = `${selectField('operatorId','Nhà xe',tripOperators,trip?.operatorId || state.user.operatorId)}${selectField('type','Loại xe',types,trip?.type || 'sleeper')}${selectField('from','Điểm đi',state.locations,trip?.from)}${selectField('to','Điểm đến',state.locations,trip?.to || state.locations[1]?.id)}${field('date','Ngày khởi hành',duplicate ? tomorrow() : trip?.date || tomorrow(),'required','date')}${field('departureTime','Giờ khởi hành',trip?.departureTime || '08:00','required','time')}${field('durationMinutes','Thời gian di chuyển (phút)',trip?.durationMinutes || 240,'required min="30" max="2880" step="1"','number')}${field('price','Giá vé (VND)',trip?.price || 250000,'required min="10000" max="10000000" step="1"','number')}${field('totalSeats','Tổng số chỗ',trip?.totalSeats || 40,'required min="1" max="60" step="1"','number')}${field('sourceLabel','Nguồn dữ liệu',trip?.source === 'demo' ? 'Dữ liệu mẫu' : 'Nhà xe cung cấp','readonly', 'text',false,trip?.source === 'demo' ? 'Sửa và sao chép chuyến mẫu vẫn giữ nhãn dữ liệu mẫu.' : '')}${textareaField('pickupPoints','Điểm đón',(trip?.pickupPoints || []).join('\n'),'Mỗi điểm một dòng.',true)}${textareaField('dropoffPoints','Điểm trả',(trip?.dropoffPoints || []).join('\n'),'Mỗi điểm một dòng.',true)}${textareaField('amenities','Tiện ích',(trip?.amenities || ['Điều hòa','Nước uống']).join('\n'),'Mỗi tiện ích một dòng.')}${textareaField('policies','Chính sách',(trip?.policies || ['Có mặt trước giờ khởi hành 30 phút.']).join('\n'),'Mỗi chính sách một dòng.')}${textareaField('provenance','Nguồn xác nhận lịch trình',trip?.provenance || '','Ví dụ: Hợp đồng phân phối số 12/2026, lịch do đối tác gửi ngày 07/10/2026. Chỉ đăng lịch trình có quyền bán vé.',true)}<label class="check-label span-2"><input name="active" type="checkbox"${trip?.active !== false ? ' checked' : ''}>Mở bán chuyến này</label>`;
  if (trip && !duplicate && Number(trip.occupiedSeats ?? (trip.totalSeats-trip.availableSeats)) > 0) {
    const locked = ['operatorId','from','to','date','departureTime','type','totalSeats','price','durationMinutes','pickupPoints','dropoffPoints'];
    locked.forEach(name => { const input = $('#editor-form').elements[name]; if (input) { input.disabled = true; input.required = false; } });
    $('#editor-fields').insertAdjacentHTML('afterbegin','<div class="notice span-2"><span class="notice-icon" data-icon="info"></span><div><strong>Chuyến đã có ghế đang giữ / đã đặt</strong>Lịch, tuyến, nhà xe, giá, điểm đón trả và sơ đồ ghế được khóa để bảo vệ vé hiện có. Có thể cập nhật tiện ích, chính sách, nguồn xác nhận hoặc ngừng mở bán. Dùng Sao chép để tạo lịch mới.</div></div>');
  }
  decorateIcons($('#editor-dialog'));
  $('#editor-dialog').showModal();
}
function openOperatorEditor(operator = null) {
  beginEditor({kind:'operator',id:operator?.id});
  $('#editor-form').reset();
  $('#editor-title').textContent = operator ? 'Chỉnh sửa nhà xe' : 'Thêm nhà xe';
  $('#editor-kicker').textContent = 'ĐỐI TÁC VẬN CHUYỂN';
  $('#editor-error').textContent = '';
  $('#editor-fields').innerHTML = `${field('name','Tên nhà xe',operator?.name,'required maxlength="120"','text',true)}${field('phone','Điện thoại',operator?.phone,'maxlength="30"','tel')}${field('email','Email',operator?.email,'maxlength="160"','email')}${selectField('image','Ảnh đại diện nhà xe',[...(operator?.image ? [{id:operator.image,name:'Ảnh đang sử dụng'}] : []),{id:'/images/chuyenxe/hoang-anh-1.jpg',name:'Xe khách Hoàng Anh'},{id:'/images/chuyenxe/ha-my-1.jpg',name:'Xe khách Hà My'},{id:'/images/chuyenxe/minh-phuong-1.jpg',name:'Xe khách Minh Phương'}],operator?.image || '/images/chuyenxe/hoang-anh-1.jpg',true)}${textareaField('description','Giới thiệu',operator?.description)}<label class="check-label span-2"><input name="active" type="checkbox"${operator?.active !== false ? ' checked' : ''}>Nhà xe đang hoạt động</label>`;
  decorateIcons($('#editor-dialog'));
  $('#editor-dialog').showModal();
}
async function openBookingDetail(booking) {
  const current = {kind:'readonly',id:booking.code}; beginEditor(current);
  $('#editor-title').textContent = `Đơn ${booking.code}`;
  $('#editor-kicker').textContent = 'CHI TIẾT ĐẶT VÉ';
  $('#editor-error').textContent = '';
  $('#editor-fields').innerHTML = `<dl class="detail-list span-2">${[
    ['Hành khách',booking.fullName],['Kênh tạo vé',booking.channel === 'counter' ? 'Tại quầy' : 'Trực tuyến'],['Người tạo',booking.createdBy || 'Khách hàng'],['Số điện thoại',booking.phone],['Email',booking.email],['Ghế',(booking.seats || []).join(', ')],['Tổng tiền',money(booking.total)],['Trạng thái',statuses[booking.status]?.[0] || booking.status],['Thanh toán',paymentLabel(booking.paymentStatus)],['Phương thức',({vnpay:'VNPAY',momo:'MoMo',zalopay:'ZaloPay',cash:'Tiền mặt',demo:'Mô phỏng'}[booking.paymentMethod] || booking.paymentMethod)],['Ngày đặt',formatDate(booking.createdAt)],['Ngày đi',`${formatDate(booking.trip?.date)} · ${booking.trip?.departureTime || ''}`],['Điểm đón',booking.pickup],['Điểm trả',booking.dropoff],['Nhà xe',booking.trip?.operatorName],['Nguồn lịch trình',booking.trip?.source === 'demo' ? 'Dữ liệu mẫu' : 'Nhà xe cung cấp'],
  ].map(([label,value]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value || '—')}</dd></div>`).join('')}</dl>`;
  $('#editor-form [type="submit"]').hidden = true;
  $('#editor-fields').insertAdjacentHTML('beforeend','<section class="span-2 audit-panel"><h3>Lịch sử xử lý</h3><div id="audit-events" class="audit-events">Đang tải lịch sử…</div></section>');
  decorateIcons($('#editor-dialog'));
  $('#editor-dialog').showModal();
  try {
    const data = await api(`/admin/bookings/${encodeURIComponent(booking.code)}/events`);
    if (state.editor !== current || !$('#editor-dialog').open) return;
    const labels = {created:'Đặt vé',cancelled:'Hủy đơn',refund_requested:'Yêu cầu hoàn tiền',rescheduled:'Đổi chuyến',refund_recorded:'Đã ghi nhận hoàn tiền',payment_failed:'Thanh toán thất bại',payment_verified:'Xác nhận thanh toán qua VNPay',late_payment_refund_required:'Thanh toán trễ · cần hoàn tiền',operator_confirmed:'Nhà xe xác nhận vé',cash_received:'Ghi nhận thu tiền mặt'};
    $('#audit-events').innerHTML = (data.events || []).map(entry => `<article><div><strong>${escapeHTML(labels[entry.event] || entry.event)}</strong><small>${escapeHTML(new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',dateStyle:'short',timeStyle:'short'}).format(new Date(entry.created_at || entry.createdAt)))}</small></div><p>Thực hiện: ${escapeHTML(entry.actor === 'guest' ? 'Khách vãng lai' : entry.actor === 'vnpay' ? 'VNPay' : entry.actor)}</p>${entry.data?.reference ? `<p>Chứng từ: ${escapeHTML(entry.data.reference)}</p>` : ''}${entry.data?.amount ? `<p>Số tiền: ${money(entry.data.amount)}</p>` : ''}</article>`).join('') || '<p>Chưa có nhật ký xử lý.</p>';
  } catch (error) { if (state.editor === current && $('#editor-dialog').open && $('#audit-events')) $('#audit-events').textContent = error.message; }
}
function openCashReceipt(booking) {
  beginEditor({kind:'cash-receipt',id:booking.code,booking});
  $('#editor-title').textContent = `Phiếu thu · ${booking.code}`;
  $('#editor-kicker').textContent = 'XÁC NHẬN THU TIỀN TẠI QUẦY';
  $('#editor-error').textContent = '';
  $('#editor-fields').innerHTML = `<div class="notice teal span-2"><div><strong>${money(booking.total)} · ${escapeHTML(booking.fullName)}</strong>Chỉ ghi nhận sau khi đã thu đủ tiền mặt. Phiếu thu được lưu để đối soát.</div></div>${field('amount','Số tiền đã thu (VND)',booking.total,'required readonly min="1" step="1"','number',true)}${field('reference','Số phiếu thu / Mã chứng từ','','required minlength="5" maxlength="100"','text',true)}<label class="check-label span-2"><input type="checkbox" name="cashConfirmed" required>Tôi xác nhận đã thu đủ số tiền trên từ khách hàng.</label>`;
  $('#editor-form [type="submit"]').textContent = 'Ghi nhận phiếu thu';
  decorateIcons($('#editor-dialog'));
  $('#editor-dialog').showModal();
}
async function openReschedule(booking) {
  beginEditor({kind:'reschedule',id:booking.code,booking,target:null,seats:[]});
  $('#editor-title').textContent = `Đổi chuyến · ${booking.code}`;
  $('#editor-kicker').textContent = 'ĐỔI LỊCH TRONG CÙNG NHÀ XE';
  $('#editor-error').textContent = '';
  $('#editor-fields').innerHTML = `<div class="notice teal span-2"><div><strong>${escapeHTML(booking.fullName)} · ${escapeHTML((booking.seats || []).join(', '))}</strong>${escapeHTML(booking.trip?.fromName)} → ${escapeHTML(booking.trip?.toName)} · ${escapeHTML(formatDate(booking.trip?.date))} ${escapeHTML(booking.trip?.departureTime)}<br>Chọn đúng ${number(booking.seats?.length || 0)} chỗ trên chuyến cùng tuyến và nhà xe, cùng giá trị vé. Cả hai chuyến cần còn ít nhất 2 giờ trước khi khởi hành. Ưu đãi của đơn được giữ khi đủ điều kiện.</div></div>${field('targetDate','Ngày đi mới',booking.trip?.date || tomorrow(),'required','date')}<div class="reschedule-search"><button class="button secondary" type="button" data-action="find-reschedule-trips">Tìm chuyến phù hợp</button></div><label class="span-2">Chuyến mới<select name="tripId" required disabled><option value="">Đang tải chuyến phù hợp…</option></select></label><div id="reschedule-target" class="span-2"></div>`;
  $('#editor-form [type="submit"]').textContent = 'Xác nhận đổi chuyến';
  $('#editor-form [type="submit"]').disabled = true;
  decorateIcons($('#editor-dialog'));
  $('#editor-dialog').showModal();
  await findRescheduleTrips();
}
async function findRescheduleTrips() {
  if (state.editor?.kind !== 'reschedule') return;
  const current = state.editor, booking = current.booking, form = $('#editor-form');
  const searchId = (current.searchId || 0)+1; current.searchId = searchId;
  current.target = null; current.seats = [];
  $('#reschedule-target').innerHTML = '';
  form.querySelector('[type="submit"]').disabled = true;
  form.elements.tripId.disabled = true;
  form.elements.tripId.innerHTML = '<option value="">Đang tìm chuyến…</option>';
  $('#editor-error').textContent = '';
  const date = form.elements.targetDate.value;
  if (!validDate(date)) { form.elements.tripId.innerHTML = '<option value="">Chọn ngày đi hợp lệ…</option>'; $('#editor-error').textContent = 'Chọn ngày đi mới trước khi tìm chuyến.'; return; }
  try {
    const query = new URLSearchParams({operator:booking.trip.operatorId,from:booking.trip.from,to:booking.trip.to,date,limit:'100'});
    const data = await api(`/admin/trips?${query}`);
    if (state.editor !== current || current.searchId !== searchId) return;
    current.candidates = (data.trips || []).filter(trip => trip.id !== booking.tripId && trip.active && trip.source === booking.trip.source && Number(trip.availableSeats) >= booking.seats.length && new Date(`${trip.date}T${trip.departureTime}:00+07:00`).getTime() > Date.now()+2*3600000);
    form.elements.tripId.innerHTML = '<option value="">Chọn chuyến mới…</option>' + current.candidates.map(trip => `<option value="${escapeHTML(trip.id)}">${escapeHTML(trip.departureTime)} · ${escapeHTML(trip.typeName || typeName(trip.type))} · ${money(trip.price)} / chỗ · ${number(trip.availableSeats)} chỗ trống</option>`).join('');
    form.elements.tripId.disabled = !current.candidates.length;
    if (!current.candidates.length) $('#reschedule-target').innerHTML = '<div class="notice"><div>Không có chuyến đáp ứng tuyến, nhà xe, nguồn dữ liệu và thời gian trong ngày đã chọn. Thử ngày khác.</div></div>';
  } catch (error) { if (state.editor === current && current.searchId === searchId) $('#editor-error').textContent = error.message; }
}
async function loadRescheduleTarget(id) {
  if (state.editor?.kind !== 'reschedule') return;
  const current = state.editor;
  const targetRequest = (current.targetRequest || 0)+1; current.targetRequest = targetRequest;
  current.target = null; current.seats = [];
  if (!id) { $('#reschedule-target').innerHTML = ''; $('#editor-form [type="submit"]').disabled = true; return; }
  $('#reschedule-target').innerHTML = loading();
  $('#editor-form [type="submit"]').disabled = true;
  $('#editor-error').textContent = '';
  try {
    const trip = await api(`/trips/${encodeURIComponent(id)}`);
    if (state.editor !== current || current.targetRequest !== targetRequest || $('#editor-form').elements.tripId.value !== id) return;
    current.target = trip;
    const points = (name,items,selected) => `<label>${name === 'pickup' ? 'Điểm đón mới' : 'Điểm trả mới'}<select name="${name}" required>${(items || []).map(item => `<option value="${escapeHTML(item)}"${item === selected ? ' selected' : ''}>${escapeHTML(item)}</option>`).join('')}</select></label>`;
    $('#reschedule-target').innerHTML = `<div class="reschedule-points">${points('pickup',trip.pickupPoints,current.booking.pickup)}${points('dropoff',trip.dropoffPoints,current.booking.dropoff)}</div><div class="reschedule-seat-heading"><strong>Chọn ${number(current.booking.seats.length)} chỗ mới</strong><span>Trống · <i></i> Đã có khách</span></div><div class="reschedule-seats">${(trip.seats || []).map(seat => `<button class="reschedule-seat${seat.status !== 'available' ? ' unavailable' : ''}" type="button" data-action="toggle-reschedule-seat" data-seat="${escapeHTML(seat.label)}"${seat.status !== 'available' ? ' disabled' : ''} aria-pressed="false"><strong>${escapeHTML(seat.label)}</strong><small>${money(seat.price || trip.price)}</small></button>`).join('')}</div><div id="reschedule-summary" class="reschedule-summary"></div>`;
    updateRescheduleSummary();
  } catch (error) { if (state.editor === current && current.targetRequest === targetRequest) $('#reschedule-target').innerHTML = empty('Không thể tải ghế',error.message); }
}
function updateRescheduleSummary() {
  if (state.editor?.kind !== 'reschedule' || !state.editor.target) return;
  const {booking,target,seats} = state.editor;
  const subtotal = seats.reduce((sum,label) => sum + Number(target.seats.find(seat => seat.label === label)?.price || target.price),0);
  const originalSubtotal = Number(booking.subtotal ?? booking.total);
  const complete = seats.length === booking.seats.length;
  const matching = subtotal === originalSubtotal;
  $('#reschedule-summary').innerHTML = `<strong>${number(seats.length)} / ${number(booking.seats.length)} chỗ đã chọn · ${money(subtotal)}</strong><p>Giá trị vé gốc trước ưu đãi: ${money(originalSubtotal)}. ${complete && !matching ? 'Chọn ghế có tổng giá bằng giá trị vé gốc để đổi chuyến.' : 'Ghế được kiểm tra lại khi xác nhận đổi chuyến.'}</p>`;
  $('#editor-form [type="submit"]').disabled = !complete || !matching;
  $$('.reschedule-seat').forEach(button => { const selected = seats.includes(button.dataset.seat); button.classList.toggle('selected',selected); button.setAttribute('aria-pressed',String(selected)); });
}
function openRefundReceipt(booking) {
  beginEditor({kind:'refund-receipt',id:booking.code,booking});
  $('#editor-title').textContent = `Phiếu hoàn tiền · ${booking.code}`;
  $('#editor-kicker').textContent = 'ĐỐI SOÁT GIAO DỊCH ĐÃ HOÀN';
  $('#editor-error').textContent = '';
  $('#editor-fields').innerHTML = `<div class="notice teal span-2"><div><strong>${money(booking.total)} · ${escapeHTML(booking.fullName)}</strong>Chỉ ghi nhận giao dịch hoàn đủ tiền đã thực hiện với khách hàng. Mã chuyển khoản hoặc phiếu chi được lưu để đối soát.</div></div>${field('amount','Số tiền đã hoàn (VND)',booking.total,'required readonly min="1" step="1"','number',true)}${field('reference','Mã giao dịch chuyển khoản / Số phiếu chi','','required minlength="5" maxlength="100"','text',true)}<label class="check-label span-2"><input type="checkbox" name="receiptConfirmed" required>Tôi xác nhận đã hoàn đủ số tiền trên cho khách hàng.</label>`;
  $('#editor-form [type="submit"]').textContent = 'Ghi nhận phiếu hoàn';
  decorateIcons($('#editor-dialog'));
  $('#editor-dialog').showModal();
}
function closeEditor(force = false) {
  if (state.editor?.busy && !force) return;
  $('#editor-dialog').close();
  $('#editor-form [type="submit"]').hidden = false;
  state.editor = null;
}
async function confirmAction(title, message, callback, buttonText = 'Xác nhận') {
  const current = {busy:false,sessionId:state.sessionId}; state.confirm = current;
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-submit').textContent = buttonText;
  $('#confirm-submit').onclick = async () => {
    if (state.confirm !== current || current.busy || current.sessionId !== state.sessionId) return;
    const button = $('#confirm-submit');
    current.busy = true; button.disabled = true;
    $$('[data-close-confirm]').forEach(close => close.disabled = true);
    try { await callback(); if (state.confirm === current) $('#confirm-dialog').close(); } catch (error) { if (current.sessionId === state.sessionId) toast(error.message,true); }
    finally { if (state.confirm === current) current.busy = false; button.disabled = false; $$('[data-close-confirm]').forEach(close => close.disabled = false); }
  };
  $('#confirm-dialog').showModal();
}
const splitLines = value => String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);

function renderImport() {
  state.importTrips = null;
  $('#content').innerHTML = `<div class="notice teal"><span class="notice-icon" data-icon="upload"></span><div><strong>Nhập lịch chạy từ đối tác</strong>Mỗi đợt nhập phải có mã nguồn xác nhận. Hệ thống kiểm tra toàn bộ dữ liệu trước khi lưu; lịch không hợp lệ sẽ không được nhập.</div></div><div class="import-grid"><section class="panel"><div class="panel-heading"><div><h3>Tệp lịch trình</h3><p>Hỗ trợ CSV và JSON · tối đa 500 chuyến mỗi đợt</p></div></div><div class="panel-body"><form id="import-form" class="import-form"><label>Nguồn xác nhận<input name="sourceReference" required minlength="5" maxlength="500" placeholder="Hợp đồng / Tệp lịch chạy / Email đối tác…"><small>Nguồn xác nhận được gắn vào tất cả chuyến trong đợt nhập.</small></label><div class="dropzone"><span class="dropzone-icon" data-icon="upload" data-icon-size="28"></span><strong>Chọn lịch trình do nhà xe cung cấp</strong><span>CSV hoặc JSON · tối đa 2 MB</span><input id="import-file" type="file" accept=".json,.csv,application/json,text/csv" aria-label="Chọn tệp lịch trình"></div><label>Hoặc dán JSON / CSV<textarea name="schedule" placeholder='[{"operatorId":"ma-nha-xe","from":"ho-chi-minh","to":"da-lat","date":"2026-10-10",…}]'></textarea></label><div id="import-preview" class="preview-box" hidden></div><div class="actions"><button class="button secondary" type="button" data-action="preview-import"><span data-icon="check-circle" data-icon-size="16"></span>Kiểm tra dữ liệu</button><button class="button primary" type="submit">Nhập lịch trình <span data-icon="arrow" data-icon-size="16"></span></button></div></form></div></section><aside class="panel"><div class="panel-heading"><div><h3>Chuẩn bị dữ liệu</h3><p>Giữ nguyên mã địa điểm và mã nhà xe</p></div></div><div class="panel-body"><ol class="import-requirements"><li>Tạo nhà xe trong mục Nhà xe.</li><li>Dùng mã điểm đi, điểm đến từ danh sách địa điểm.</li><li>Ngày dùng dạng YYYY-MM-DD, giờ HH:mm.</li><li>Giá là số nguyên VND. Số chỗ từ 1 đến 60.</li><li>Loại xe: limousine, sleeper, cabin, seater.</li><li>Điểm đón, trả và tiện ích trong CSV cách nhau bằng dấu |.</li><li>Chỉ nhập lịch đã được nhà xe xác nhận và cho phép bán.</li></ol><div class="template-buttons"><button class="button secondary small" data-action="download-json">Mẫu JSON <span data-icon="download" data-icon-size="14"></span></button><button class="button secondary small" data-action="download-csv">Mẫu CSV <span data-icon="download" data-icon-size="14"></span></button><button class="button secondary small" data-action="download-locations">Mã địa điểm <span data-icon="download" data-icon-size="14"></span></button><button class="button secondary small" data-action="download-operators">Mã nhà xe <span data-icon="download" data-icon-size="14"></span></button></div><div class="notice import-notice"><div><strong>Tồn chỗ từ đối tác</strong>Lịch nhập chỉ phản ánh dữ liệu được cung cấp tại thời điểm nhập. Kết nối API nhà xe cần cấu hình riêng để đồng bộ liên tục.</div></div></div></aside></div>`;
}
function csvRows(text) {
  const rows = []; let row = [], value = '', quoted = false, closedQuote = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index+1] === '"') { value += '"'; index++; }
      else if (quoted) { quoted = false; closedQuote = true; }
      else if (!closedQuote && !value.trim()) { value = ''; quoted = true; }
      else throw new Error('CSV có dấu nháy sai vị trí. Dùng hai dấu nháy để viết dấu nháy trong một ô.');
    } else if (char === ',' && !quoted) { row.push(value); value = ''; closedQuote = false; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index+1] === '\n') index++;
      row.push(value); if (row.some(item => item.trim())) rows.push(row); row = []; value = ''; closedQuote = false;
    } else if (closedQuote) { if (!/\s/.test(char)) throw new Error('CSV có nội dung thừa sau dấu nháy đóng.'); }
    else value += char;
  }
  if (quoted) throw new Error('CSV có dấu nháy chưa đóng.');
  row.push(value); if (row.some(item => item.trim())) rows.push(row);
  return rows;
}
function parseImport() {
  const text = $('#import-form [name="schedule"]').value.trim().replace(/^\uFEFF/,'');
  if (!text) throw new Error('Chọn tệp hoặc dán dữ liệu lịch trình trước.');
  if (new Blob([text]).size > 2*1024*1024) throw new Error('Dữ liệu quá lớn. Mỗi đợt nhập tối đa 2 MB.');
  let trips;
  if (/^[\[{]/.test(text)) {
    const parsed = JSON.parse(text);
    trips = Array.isArray(parsed) ? parsed : parsed.trips;
  } else {
    const [rawHeaders,...rows] = csvRows(text), headers = rawHeaders?.map(header => header.trim());
    if (!headers?.length || !rows.length) throw new Error('CSV cần có tiêu đề và ít nhất một chuyến.');
    if (headers.some(header => !header) || new Set(headers).size !== headers.length) throw new Error('CSV có tên cột trống hoặc trùng nhau.');
    trips = rows.map((row,index) => {
      if (row.length !== headers.length) throw new Error(`Dòng ${index+2}: số cột không khớp tiêu đề.`);
      return Object.fromEntries(headers.map((header,column) => [header.trim(),row[column].trim()]));
    });
  }
  if (!Array.isArray(trips) || !trips.length || trips.length > 500) throw new Error('Mỗi đợt nhập cần từ 1 đến 500 chuyến.');
  return trips.map((trip,index) => {
    if (!trip || typeof trip !== 'object' || Array.isArray(trip)) throw new Error(`Chuyến ${index+1}: dữ liệu cần là một đối tượng lịch trình.`);
    const data = {...trip};
    ['operatorId','from','to','date','departureTime','type'].forEach(field => data[field] = String(data[field] ?? '').trim());
    ['durationMinutes','price','totalSeats'].forEach(field => data[field] = Number(data[field]));
    ['pickupPoints','dropoffPoints','amenities','policies'].forEach(field => data[field] = Array.isArray(data[field]) ? data[field] : String(data[field] || '').split('|').map(item => item.trim()).filter(Boolean));
    const active = typeof data.active === 'string' ? data.active.trim().toLowerCase() : data.active;
    if (active !== undefined && ![true,false,'true','false','1','0',1,0,''].includes(active)) throw new Error(`Chuyến ${index+1}: trạng thái active cần true hoặc false.`);
    data.active = ![false,'false','0',0].includes(active);
    const errors = [];
    const operator = state.operators.find(operator => operator.id === data.operatorId);
    if (!operator || !operator.active) errors.push('mã nhà xe chưa tồn tại hoặc đã ngừng hoạt động');
    else if (operator.source === 'demo') errors.push('cần nhà xe vận hành thật; không nhập lịch thật cho nhà xe mẫu');
    if (!state.locations.some(location => location.id === data.from) || !state.locations.some(location => location.id === data.to)) errors.push('mã địa điểm không hợp lệ');
    if (data.from === data.to) errors.push('điểm đi và đến phải khác nhau');
    if (!validDate(data.date)) errors.push('ngày phải là ngày hợp lệ dạng YYYY-MM-DD');
    else if (data.date < today() || data.date > addDateDays(today(),365)) errors.push('ngày cần nằm trong 365 ngày tới');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.departureTime || '')) errors.push('giờ phải là HH:mm');
    else if (validDate(data.date) && new Date(`${data.date}T${data.departureTime}:00+07:00`).getTime() <= Date.now()+30*60000) errors.push('khởi hành cần cách hiện tại ít nhất 30 phút');
    if (!types.some(type => type.id === data.type)) errors.push('loại xe không hợp lệ');
    if (!Number.isInteger(data.price) || data.price < 10000 || data.price > 10000000) errors.push('giá vé từ 10.000 đến 10.000.000 VND');
    if (!Number.isInteger(data.totalSeats) || data.totalSeats < 1 || data.totalSeats > 60) errors.push('số chỗ từ 1 đến 60');
    if (!Number.isInteger(data.durationMinutes) || data.durationMinutes < 30 || data.durationMinutes > 2880) errors.push('thời gian từ 30 đến 2.880 phút');
    ['pickupPoints','dropoffPoints','amenities','policies'].forEach(field => {
      if (data[field].length > 20 || data[field].some(item => typeof item !== 'string' || item.length > 500)) errors.push(`danh sách ${field} cần tối đa 20 mục văn bản, mỗi mục tối đa 500 ký tự`);
      else data[field] = data[field].map(item => item.trim()).filter(Boolean);
    });
    if (!data.pickupPoints.length || !data.dropoffPoints.length) errors.push('cần điểm đón và điểm trả');
    if (errors.length) throw new Error(`Chuyến ${index+1}: ${errors.join('; ')}.`);
    return data;
  });
}
function previewImport() {
  const preview = $('#import-preview');
  preview.hidden = false;
  try {
    const trips = parseImport();
    state.importTrips = trips;
    preview.classList.remove('error');
    preview.innerHTML = `<strong>${icon("check-circle",16)} ${number(trips.length)} chuyến đã qua kiểm tra ban đầu</strong><br>${trips.slice(0,5).map(trip => `${escapeHTML(operatorName(trip.operatorId))} · ${escapeHTML(trip.from)} → ${escapeHTML(trip.to)} · ${escapeHTML(trip.date)} ${escapeHTML(trip.departureTime)}`).join('<br>')}${trips.length > 5 ? '<br>…' : ''}<br><small>Máy chủ sẽ kiểm tra lại quyền tài khoản, ngày giờ và các ràng buộc trước khi lưu.</small>`;
    return trips;
  } catch (error) {
    state.importTrips = null;
    preview.classList.add('error');
    preview.textContent = error instanceof SyntaxError ? 'JSON chưa hợp lệ. Kiểm tra dấu nháy và dấu phẩy.' : error.message;
    return null;
  }
}
function download(filename, content, mime = 'application/json') {
  const blob = new Blob([content],{type:`${mime};charset=utf-8`}), url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
function sampleTrip() {
  return {operatorId:state.user.operatorId || state.operators.find(operator => operator.active && operator.source !== 'demo')?.id || state.operators[0]?.id || 'ma-nha-xe',from:state.locations[0]?.id || 'ho-chi-minh',to:state.locations[1]?.id || 'da-lat',date:tomorrow(),departureTime:'22:00',durationMinutes:360,price:280000,totalSeats:40,type:'sleeper',pickupPoints:['Văn phòng nhà xe'],dropoffPoints:['Bến xe đích'],amenities:['Điều hòa','Nước uống'],policies:['Có mặt trước giờ khởi hành 30 phút.'],active:true};
}
function toCSV(trips) {
  const headers = Object.keys(trips[0]);
  const cell = value => `"${String(Array.isArray(value) ? value.join('|') : value ?? '').replace(/"/g,'""')}"`;
  return '\uFEFF' + headers.map(cell).join(',') + '\r\n' + trips.map(trip => headers.map(header => cell(trip[header])).join(',')).join('\r\n');
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  $('#login-error').textContent = '';
  try { const data = await api('/auth/login',{method:'POST',body:Object.fromEntries(new FormData(event.target))}); await enterPortal(data.user); event.target.reset(); }
  catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#toggle-password').addEventListener('click', event => {
  const input = $('#login-form [name="password"]');
  input.type = input.type === 'password' ? 'text' : 'password';
  event.currentTarget.innerHTML = `${icon(input.type === 'password' ? 'eye' : 'eye-off',16)}<span>${input.type === 'password' ? 'Hiện' : 'Ẩn'}</span>`;
  event.currentTarget.setAttribute('aria-label',input.type === 'password' ? 'Hiện mật khẩu' : 'Ẩn mật khẩu');
  event.currentTarget.setAttribute('aria-pressed',String(input.type === 'text'));
});
$('#logout-button').addEventListener('click',async () => {
  const button = $('#logout-button'); button.disabled = true;
  try { await api('/auth/logout',{method:'POST',body:{}}); showLogin(); } catch (error) { toast(error.message,true); } finally { button.disabled = false; }
});
$('#menu-button').addEventListener('click', () => {
  const open = $('#sidebar').classList.toggle('open');
  $('#menu-button').setAttribute('aria-expanded',String(open));
});
document.addEventListener('keydown',event => {
  if (event.key === 'Escape' && $('#sidebar').classList.contains('open')) { $('#sidebar').classList.remove('open'); $('#menu-button').setAttribute('aria-expanded','false'); $('#menu-button').focus(); }
});
document.addEventListener('click',event => {
  if ($('#sidebar').classList.contains('open') && !event.target.closest('#sidebar') && !event.target.closest('#menu-button')) { $('#sidebar').classList.remove('open'); $('#menu-button').setAttribute('aria-expanded','false'); }
});
$$('[data-close-dialog]').forEach(button => button.addEventListener('click',closeEditor));
$('#editor-dialog').addEventListener('cancel',event => { if (state.editor?.busy) event.preventDefault(); });
$('#editor-dialog').addEventListener('close',() => {
  if ($('#editor-dialog').open) return;
  state.editor = null;
  const form = $('#editor-form'), button = form.querySelector('[type="submit"]');
  form.inert = false; form.removeAttribute('aria-busy'); button.hidden = false; button.disabled = false; button.textContent = 'Lưu thông tin';
  $$('[data-close-dialog]').forEach(close => close.disabled = false);
});
$$('[data-close-confirm]').forEach(button => button.addEventListener('click',() => { if (!state.confirm?.busy) $('#confirm-dialog').close(); }));
$('#confirm-dialog').addEventListener('cancel',event => { if (state.confirm?.busy) event.preventDefault(); });
$('#confirm-dialog').addEventListener('close',() => { if ($('#confirm-dialog').open) return; state.confirm = null; $('#confirm-submit').disabled = false; $$('[data-close-confirm]').forEach(close => close.disabled = false); });
$$('[data-close-manifest]').forEach(button => button.addEventListener('click',() => { $('#manifest-dialog').close(); state.manifest = null; }));
$('#manifest-dialog').addEventListener('close',() => { if (!$('#manifest-dialog').open) state.manifest = null; });
document.addEventListener('ticket4t:session-expired',() => showLogin('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'));
document.addEventListener('ticket4t:counter-booked',async event => {
  if (!state.user || !event.detail?.code) return;
  toast(`Đã tạo vé ${event.detail.code}. Chưa ghi nhận thu tiền.`);
  await navigate('bookings');
  if (state.user) openBookingDetail(event.detail);
});
document.addEventListener('click', async event => {
  const navigation = event.target.closest('[data-page]');
  if (navigation) { event.preventDefault(); if (navigation.dataset.page !== state.page) await navigate(navigation.dataset.page); return; }
  const paginationButton = event.target.closest('[data-paginate]');
  if (paginationButton && !paginationButton.disabled) { state.pageNumber = Number(paginationButton.dataset.paginate); await navigate(state.page,true); return; }
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action, id = button.dataset.id;
  const trip = state.trips.find(trip => trip.id === id), operator = state.operators.find(operator => operator.id === id), booking = state.bookings.find(booking => booking.code === id);
  if (action === 'refresh') return navigate(state.page,true);
  if (action === 'reset-filters') return navigate(state.page);
  if (action === 'dashboard-range') {
    const form = $('#filters'); form.elements.dateTo.value = today(); form.elements.dateFrom.value = addDateDays(today(),1-Number(button.dataset.range));
    state.pageNumber = 1; return navigate('dashboard',true);
  }
  if (action === 'view-pending-bookings' || action === 'view-refund-bookings') {
    state.filters.bookings = {...(state.filters.dashboard || {}),status:action === 'view-refund-bookings' ? 'refund_pending' : '',paymentStatus:action === 'view-pending-bookings' ? 'pending' : 'refund_pending'};
    state.pageNumber = 1; return navigate('bookings',true);
  }
  if (action === 'new-trip') return openTripEditor();
  if (action === 'edit-trip' && trip) return openTripEditor(trip);
  if (action === 'duplicate-trip' && trip) return openTripEditor(trip,true);
  if (action === 'manifest' && trip) return openManifest(trip);
  if (action === 'counter-booking' && trip) return window.TicketCounter?.open(trip,state.user);
  if (action === 'print-manifest' && state.manifest && $('#manifest-dialog').open) return window.print();
  if (action === 'new-promotion') return openPromotionEditor();
  if (action === 'edit-promotion') { const promotion = state.promotions.find(promotion => promotion.code === id); if (promotion) return openPromotionEditor(promotion); }
  if (action === 'pause-promotion') {
    const promotion = state.promotions.find(promotion => promotion.code === id);
    if (promotion) return confirmAction('Tạm dừng ưu đãi?',`Mã ${promotion.code} sẽ ngừng áp dụng cho đơn mới. Ưu đãi đã áp dụng vào đơn hiện có được giữ nguyên.`,async () => { await api(`/admin/promotions/${encodeURIComponent(id)}`,{method:'DELETE',body:{}}); toast('Đã tạm dừng ưu đãi.'); await navigate('promotions',true); },'Tạm dừng mã');
  }
  if (action === 'add-promotion-route' && state.editor?.kind === 'promotion') {
    const form = $('#editor-form'), from = form.elements.promotionFrom.value, to = form.elements.promotionTo.value;
    if (from === to) return toast('Điểm đi và điểm đến cần khác nhau.',true);
    const route = `${from}--${to}`;
    if (!state.editor.routes.includes(route)) state.editor.routes.push(route);
    return renderPromotionRoutes();
  }
  if (action === 'remove-promotion-route' && state.editor?.kind === 'promotion') { state.editor.routes = state.editor.routes.filter(route => route !== button.dataset.route); return renderPromotionRoutes(); }
  if (action === 'new-operator') return openOperatorEditor();
  if (action === 'edit-operator' && operator) return openOperatorEditor(operator);
  if (action === 'new-user') return openUserEditor();
  if (action === 'edit-user') { const user = state.users.find(user => user.id === id); if (user) return openUserEditor(user); }
  if (action === 'booking-detail' && booking) return openBookingDetail(booking);
  if (action === 'cash-receipt' && booking) return openCashReceipt(booking);
  if (action === 'refund-receipt' && booking) return openRefundReceipt(booking);
  if (action === 'reschedule-booking' && booking) return openReschedule(booking);
  if (action === 'find-reschedule-trips') return findRescheduleTrips();
  if (action === 'toggle-reschedule-seat' && state.editor?.kind === 'reschedule') {
    const label = button.dataset.seat, current = state.editor;
    if (current.seats.includes(label)) current.seats = current.seats.filter(seat => seat !== label);
    else if (current.seats.length >= current.booking.seats.length) return toast(`Chỉ chọn ${current.booking.seats.length} chỗ để đổi chuyến.`,true);
    else current.seats.push(label);
    return updateRescheduleSummary();
  }
  if (action === 'delete-trip' && trip) return confirmAction('Ngừng mở bán chuyến xe?',`Chuyến ${trip.fromName || trip.from} → ${trip.toName || trip.to}, ${formatDate(trip.date)} lúc ${trip.departureTime}. Chuyến này sẽ ngừng nhận đặt vé mới. Vé hiện có được giữ nguyên; cần liên hệ khách nếu lịch chạy thay đổi.`,async () => { await api(`/admin/trips/${encodeURIComponent(id)}`,{method:'DELETE',body:{}}); toast('Chuyến xe đã ngừng mở bán.'); await navigate('trips',true); },'Ngừng mở bán');
  if (action === 'delete-operator' && operator) return confirmAction('Ngừng hoạt động nhà xe?',`Tạm dừng ${operator.name}. Chuyến thuộc nhà xe sẽ ngừng nhận vé mới; lịch sử và vé hiện có vẫn được giữ để xử lý với khách hàng.`,async () => { await api(`/admin/operators/${encodeURIComponent(id)}`,{method:'DELETE',body:{}}); toast('Nhà xe đã ngừng hoạt động.'); await navigate('operators'); },'Ngừng hoạt động');
  if (action === 'cancel-booking' && booking) return confirmAction('Hủy đơn đặt vé?',`Hủy đơn ${booking.code} của ${booking.fullName}. Ghế được giải phóng. Nếu đã thu tiền, hệ thống chuyển sang chờ hoàn tiền để đối soát; thao tác này không tự chuyển tiền hoàn cho khách.`,async () => { await api(`/admin/bookings/${encodeURIComponent(id)}`,{method:'PATCH',body:{status:'cancelled'}}); toast('Đã xử lý hủy đơn vé.'); await navigate('bookings',true); },'Hủy vé');
  if (action === 'preview-import') return previewImport();
  if (action === 'download-json') return download('lich-trinh-mau.json',JSON.stringify([sampleTrip()],null,2));
  if (action === 'download-csv') return download('lich-trinh-mau.csv',toCSV([sampleTrip()]),'text/csv');
  if (action === 'download-locations') return download('ma-dia-diem.json',JSON.stringify(state.locations.map(({id,name}) => ({id,name})),null,2));
  if (action === 'download-operators') return download('ma-nha-xe.json',JSON.stringify(state.operators.map(({id,name}) => ({id,name})),null,2));
});
document.addEventListener('submit',async event => {
  if (event.target.id === 'filters') { event.preventDefault(); state.pageNumber = 1; await navigate(state.page,true); }
  if (event.target.id === 'import-form') {
    event.preventDefault();
    if (state.importBusy) return;
    const trips = previewImport(); if (!trips) return;
    const sourceReference = event.target.elements.sourceReference.value.trim();
    if (sourceReference.length < 5) return toast('Nguồn xác nhận cần ít nhất 5 ký tự.',true);
    const form = event.target, button = form.querySelector('[type="submit"]'), sessionId = state.sessionId;
    state.importBusy = true; form.inert = true; button.disabled = true;
    try {
      const data = await api('/admin/import',{method:'POST',body:{source:'operator',sourceReference,trips}});
      if (sessionId !== state.sessionId || !state.user) return;
      toast(`Đã nhập ${number(data.imported ?? data.count ?? trips.length)} chuyến xe.`);
      if (state.page === 'import' && $('#import-form') === form) await navigate('trips');
    } catch (error) { if (sessionId === state.sessionId) toast(error.message,true); }
    finally { state.importBusy = false; form.inert = false; button.disabled = false; }
  }
});
document.addEventListener('change', async event => {
  if (event.target.name === 'targetDate' && state.editor?.kind === 'reschedule') await findRescheduleTrips();
  if (event.target.name === 'tripId' && state.editor?.kind === 'reschedule') await loadRescheduleTarget(event.target.value);
  if (event.target.name === 'type' && state.editor?.kind === 'promotion') updatePromotionType();
  if (event.target.name === 'role' && state.editor?.kind === 'user') {
    const select = $('#editor-form [name="operatorId"]');
    select.required = event.target.value === 'operator';
    select.parentElement.hidden = !select.required;
  }
  if (event.target.id !== 'import-file') return;
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 2*1024*1024) { toast('Tệp quá lớn. Chọn tệp tối đa 2 MB.',true); event.target.value = ''; return; }
  const form = $('#import-form'), input = event.target;
  try { const content = await file.text(); if ($('#import-form') !== form || input.files[0] !== file || !state.user) return; form.elements.schedule.value = content; previewImport(); }
  catch { if ($('#import-form') === form) toast('Không đọc được tệp.',true); }
});
$('#editor-form').addEventListener('submit', async event => {
  event.preventDefault();
  const current = state.editor;
  if (!current || current.kind === 'readonly' || current.busy || !event.target.reportValidity()) return;
  const {kind,id} = current, sessionId = state.sessionId, form = event.target, data = Object.fromEntries(new FormData(form));
  setEditorBusy(current,true); $('#editor-error').textContent = '';
  let path, method = id ? 'PATCH' : 'POST', targetPage, success;
  try {
    if (kind === 'reschedule') {
      if (!current.target || current.seats.length !== current.booking.seats.length) throw new Error('Chọn chuyến và đủ số ghế mới trước khi đổi.');
      path = `/admin/bookings/${encodeURIComponent(id)}/reschedule`; method = 'POST';
      Object.keys(data).forEach(key => delete data[key]);
      Object.assign(data,{tripId:current.target.id,seats:[...current.seats],pickup:form.elements.pickup.value,dropoff:form.elements.dropoff.value});
      targetPage = 'bookings'; success = 'Đã đổi chuyến và chuyển ghế của đơn vé.';
    } else if (kind === 'promotion') {
      ['value','minSpend','maxDiscount','maxUses','perCustomer'].forEach(field => data[field] = Number(data[field]));
      data.code = data.code.trim().toUpperCase(); data.title = data.title.trim();
      if (!/^[A-Z0-9_-]{3,32}$/.test(data.code)) throw new Error('Mã ưu đãi cần từ 3–32 chữ, số, dấu gạch ngang hoặc gạch dưới.');
      if (data.title.length < 2) throw new Error('Tên ưu đãi cần ít nhất 2 ký tự.');
      data.active = form.elements.active.checked; data.roundTripOnly = form.elements.roundTripOnly.checked;
      data.operatorIds = new FormData(form).getAll('operatorIds'); data.routeIds = [...current.routes];
      data.startsAt = new Date(`${data.startsAt}:00+07:00`).toISOString(); data.expiresAt = new Date(`${data.expiresAt}:00+07:00`).toISOString();
      if (data.startsAt >= data.expiresAt) throw new Error('Thời gian kết thúc cần sau thời gian bắt đầu.');
      if (data.type === 'fixed') data.maxDiscount = 0;
      delete data.promotionFrom; delete data.promotionTo;
      path = `/admin/promotions${id ? `/${encodeURIComponent(id)}` : ''}`;
      targetPage = 'promotions'; success = 'Đã lưu mã ưu đãi.';
    } else if (kind === 'refund-receipt' || kind === 'cash-receipt') {
      const confirmed = kind === 'cash-receipt' ? form.elements.cashConfirmed.checked : form.elements.receiptConfirmed.checked;
      if (!confirmed) throw new Error(kind === 'cash-receipt' ? 'Cần xác nhận đã thu đủ tiền từ khách hàng.' : 'Cần xác nhận tiền đã được hoàn đủ cho khách hàng.');
      const reference = data.reference.trim(), amount = Number(data.amount);
      if (reference.length < 5) throw new Error('Mã chứng từ cần ít nhất 5 ký tự sau khi bỏ khoảng trắng.');
      if (!Number.isSafeInteger(amount) || amount !== current.booking.total) throw new Error('Số tiền cần đúng bằng tổng tiền của đơn vé.');
      Object.keys(data).forEach(key => delete data[key]); Object.assign(data,{reference,amount});
      path = `/admin/bookings/${encodeURIComponent(id)}/${kind}`; method = 'POST'; targetPage = 'bookings';
      success = kind === 'cash-receipt' ? 'Đã ghi nhận phiếu thu tiền mặt.' : 'Đã lưu chứng từ hoàn tiền.';
    } else if (kind === 'user') {
      data.fullName = data.fullName.trim(); data.email = data.email.trim().toLowerCase(); data.phone = data.phone.trim();
      if (data.fullName.length < 2) throw new Error('Họ tên cần ít nhất 2 ký tự.');
      if (!/^0\d{9,10}$/.test(data.phone.replace(/[\s().-]/g,'').replace(/^\+84/,'0'))) throw new Error('Nhập số điện thoại Việt Nam hợp lệ (10–11 số).');
      data.active = form.elements.active.checked;
      if (id && !data.password) delete data.password;
      if (data.password !== undefined && (data.password.length < 10 || !/[A-Z]/.test(data.password) || !/[a-z]/.test(data.password) || !/\d/.test(data.password))) throw new Error('Mật khẩu cần ít nhất 10 ký tự, có chữ hoa, chữ thường và chữ số.');
      if (data.role === 'customer') data.operatorId = null;
      path = `/admin/users${id ? `/${encodeURIComponent(id)}` : ''}`; targetPage = 'users'; success = 'Đã lưu tài khoản và quyền truy cập.';
    } else if (kind === 'operator') {
      data.name = data.name.trim(); data.phone = data.phone.trim(); data.email = data.email.trim().toLowerCase();
      if (data.name.length < 2) throw new Error('Tên nhà xe cần ít nhất 2 ký tự.');
      if (data.phone && !/^0\d{9,10}$/.test(data.phone.replace(/[\s().-]/g,'').replace(/^\+84/,'0'))) throw new Error('Nhập số điện thoại Việt Nam hợp lệ (10–11 số).');
      data.active = form.elements.active.checked;
      path = `/admin/operators${id ? `/${encodeURIComponent(id)}` : ''}`; targetPage = 'operators'; success = 'Đã lưu thông tin nhà xe.';
    } else {
      const locked = ['operatorId','from','to','date','departureTime','type','totalSeats','price','durationMinutes','pickupPoints','dropoffPoints'];
      locked.forEach(field => { if (form.elements[field]?.disabled && current.trip) data[field] = current.trip[field]; });
      ['durationMinutes','price','totalSeats'].forEach(field => data[field] = Number(data[field]));
      ['pickupPoints','dropoffPoints','amenities','policies'].forEach(field => { data[field] = Array.isArray(data[field]) ? data[field] : splitLines(data[field]); });
      data.active = form.elements.active.checked; data.provenance = data.provenance.trim(); delete data.sourceLabel;
      if (data.from === data.to) throw new Error('Điểm đi và điểm đến phải khác nhau.');
      if (!data.provenance) throw new Error('Cần ghi nguồn xác nhận lịch trình.');
      if (!data.pickupPoints.length || !data.dropoffPoints.length) throw new Error('Cần ít nhất một điểm đón và một điểm trả.');
      // Các trường lịch bị khóa giữ nguyên; máy chủ kiểm tra lại ghế đang giữ trước khi lưu.
      if (!current.trip || kind === 'duplicate-trip' || !form.elements.date.disabled) {
        if (!validDate(data.date) || data.date < today() || data.date > addDateDays(today(),365)) throw new Error('Ngày khởi hành cần nằm trong 365 ngày tới.');
        if (new Date(`${data.date}T${data.departureTime}:00+07:00`).getTime() <= Date.now()+30*60000) throw new Error('Giờ khởi hành cần cách hiện tại ít nhất 30 phút.');
      }
      path = kind === 'duplicate-trip' ? `/admin/trips/${encodeURIComponent(id)}/duplicate` : `/admin/trips${id ? `/${encodeURIComponent(id)}` : ''}`;
      if (kind === 'duplicate-trip') method = 'POST';
      targetPage = 'trips'; success = kind === 'duplicate-trip' ? 'Đã sao chép chuyến xe.' : 'Đã lưu chuyến xe.';
    }
    await api(path,{method,body:data});
    if (state.editor !== current || sessionId !== state.sessionId || !state.user) return;
    closeEditor(true); toast(success);
    await navigate(targetPage,true);
  } catch (error) {
    if (state.editor === current && sessionId === state.sessionId && $('#editor-dialog').open) $('#editor-error').textContent = error.message;
  } finally { if (state.editor === current) setEditorBusy(current,false); }
});
window.addEventListener('hashchange',() => { const page = location.hash.slice(1); if (state.user && pages[page] && page !== state.page) navigate(page); });
(async () => {
  try { const data = await api('/auth/me'); if (data.user) await enterPortal(data.user); else showLogin(); }
  catch (error) { showLogin(error.message); }
})();
