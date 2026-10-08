'use strict';

let feedPreview = null;
let feedBusy = false;
const paymentEnvironmentLabel = environment => ({live:'vận hành',sandbox:'thử nghiệm',invalid:'chưa hợp lệ'}[environment] || 'chưa xác định');

function integrationCard(title, configured, description, notes = []) {
  return `<section class="panel integration-card"><div class="panel-heading"><h3>${escapeHTML(title)}</h3><span class="badge ${configured ? 'teal' : 'amber'}">${configured ? 'Đã cấu hình' : 'Chờ cấu hình'}</span></div><div class="panel-body"><p>${escapeHTML(description)}</p>${notes.length ? `<ul>${notes.map(note => `<li>${escapeHTML(note)}</li>`).join('')}</ul>` : ''}</div></section>`;
}

async function renderIntegrations(id) {
  feedPreview = null;
  const data = await api('/admin/integrations');
  if (id !== state.loadId || state.page !== 'integrations' || !state.user) return;
  const {inventory, payments, email, database} = data;
  const feed = inventory.providerSync;
  const walletCards = ['momo','zalopay'].filter(provider => payments[provider]).map(provider => {
    const info = payments[provider];
    return integrationCard(provider === 'momo' ? 'MoMo' : 'ZaloPay', info.configured,
      `Môi trường ${paymentEnvironmentLabel(info.environment)}. Kết quả thanh toán được xác minh qua callback máy chủ.`, [...(info.missingConfiguration || []), ...(info.notes || [])]);
  }).join('');
  $('#content').innerHTML = `<div class="notice teal"><span class="notice-icon">${icon('info')}</span><div><strong>Trạng thái cấu hình trên máy chủ</strong>Cấu hình đầy đủ cần được kiểm thử với tài khoản đối tác trước khi mở bán. Lần kiểm tra: ${escapeHTML(dateTime(data.checkedAt))}.</div></div>
    <div class="integration-grid">
      ${integrationCard('API lịch nhà xe', feed.configured, `${number(inventory.managedTrips)} chuyến do nhà xe cung cấp · ${number(inventory.demoTrips)} chuyến mẫu.`, [...(feed.missingConfiguration || []), ...(feed.notes || [])])}
      ${integrationCard('VNPAY', payments.vnpay.configured, `Môi trường ${paymentEnvironmentLabel(payments.vnpay.environment)}. Thanh toán tại nhà xe luôn có thể sử dụng.`, [...(payments.vnpay.missingConfiguration || []), ...(payments.vnpay.notes || [])])}
      ${walletCards}
      ${integrationCard('Email giao dịch', email.configured, email.mode === 'smtp' ? 'Gửi xác nhận và khôi phục tài khoản qua SMTP.' : email.mode === 'disabled' ? 'Gửi email đang tắt; cần cấu hình SMTP để sử dụng.' : 'Email được lưu vào hộp thư phát triển cục bộ.', [...(email.missingConfiguration || []), ...(email.notes || [])])}
      ${integrationCard('Cơ sở dữ liệu', database.connected, database.dialect === 'postgres' ? 'PostgreSQL' : 'SQLite cục bộ', database.notes || [])}
    </div>
    <section class="panel"><div class="panel-heading"><div><h3>Đồng bộ lịch qua API</h3><p>Xem trước thay đổi rồi áp dụng vào kho lịch đang quản lý.</p></div><button class="button secondary" data-action="preview-feed" ${feed.configured ? '' : 'disabled'}>${icon('refresh')}Đọc lịch đối tác</button></div><div class="panel-body"><p class="integration-note">Kết nối này cập nhật lịch, giá và tổng số ghế được phân bổ. Kho ghế bán trên nhiều hệ thống cần API giữ/đặt/hủy ghế của nhà xe trước khi có thể đồng bộ bán vé trực tiếp.</p><div id="feed-feedback" role="status"></div><div id="feed-preview"></div></div></section>`;
  decorateIcons($('#content'));
}

function feedPreviewHTML(preview) {
  const counts = preview.counts;
  return `<div class="feed-summary"><strong>${number(counts.created)} chuyến mới</strong><span>${number(counts.updated)} cập nhật</span><span>${number(counts.unchanged)} giữ nguyên</span></div><p class="integration-note">Nguồn xác nhận: ${escapeHTML(preview.sourceReference)}</p><div class="table-wrap"><table class="data-table"><thead><tr><th>Mã đối tác</th><th>Tuyến</th><th>Khởi hành</th><th>Giá</th><th>Thay đổi</th></tr></thead><tbody>${preview.trips.map(trip => `<tr><td>${escapeHTML(trip.externalId)}</td><td>${escapeHTML(trip.fromName)} → ${escapeHTML(trip.toName)}</td><td>${escapeHTML(formatDate(trip.date))} · ${escapeHTML(trip.departureTime)}</td><td>${money(trip.price)}</td><td>${{created:'Thêm mới',updated:'Cập nhật',unchanged:'Giữ nguyên'}[trip.change]}</td></tr>`).join('')}</tbody></table></div><div class="feed-actions"><button class="button primary" data-action="apply-feed" ${counts.created + counts.updated ? '' : 'disabled'}>Áp dụng lịch đã xem</button></div>`;
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action="preview-feed"], [data-action="apply-feed"]');
  if (!button || feedBusy || state.page !== 'integrations' || state.user?.role !== 'admin') return;
  const id = state.loadId, sessionId = state.sessionId, preview = feedPreview;
  const apply = button.dataset.action === 'apply-feed';
  if (apply && !preview) return;
  feedBusy = true;
  $$('[data-action="preview-feed"], [data-action="apply-feed"]').forEach(item => item.disabled = true);
  const current = () => id === state.loadId && sessionId === state.sessionId && state.page === 'integrations';
  $('#feed-feedback').textContent = apply ? 'Đang cập nhật lịch…' : 'Đang đọc và kiểm tra lịch đối tác…';
  try {
    const data = await api(`/admin/integrations/operator-feed/${apply ? 'apply' : 'preview'}`, {method:'POST', body:apply ? {digest:preview.digest} : {}});
    if (!current()) return;
    if (apply) {
      toast(`Đã thêm ${data.sync.created} và cập nhật ${data.sync.updated} chuyến.`);
      await renderIntegrations(id);
    } else {
      feedPreview = data.preview;
      $('#feed-feedback').textContent = 'Dữ liệu hợp lệ. Kiểm tra lịch và giá trước khi áp dụng.';
      $('#feed-preview').innerHTML = feedPreviewHTML(feedPreview);
    }
  } catch (error) {
    if (!current()) return;
    feedPreview = null;
    $('#feed-preview').innerHTML = '';
    $('#feed-feedback').textContent = error.message;
  } finally {
    feedBusy = false;
    if (current()) {
      const read = $('[data-action="preview-feed"]');
      if (read) read.disabled = false;
      const save = $('[data-action="apply-feed"]');
      if (save) save.disabled = !feedPreview || !(feedPreview.counts.created + feedPreview.counts.updated);
    }
  }
});

document.addEventListener('ticket4t:session-cleared', () => { feedPreview = null; });
