'use strict';

(() => {
  const currency = new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND',maximumFractionDigits:0});
  const compact = new Intl.NumberFormat('vi-VN',{notation:'compact',maximumFractionDigits:1});
  const count = new Intl.NumberFormat('vi-VN');
  const amount = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const dayLabel = value => String(value).split('-').reverse().join('/');
  const statusNames = {reserved:'Giữ ghế',pending_payment:'Chờ thanh toán',confirmed:'Đã xác nhận',cancelled:'Đã hủy',expired:'Hết hạn',refund_pending:'Chờ hoàn tiền'};
  const statusColors = {reserved:'#c8781f',pending_payment:'#d8ab4b',confirmed:'#087e75',cancelled:'#85938f',expired:'#b5beb9',refund_pending:'#b54443'};
  const methodNames = {cash:'Tiền mặt / tại nhà xe',vnpay:'VNPAY',momo:'MoMo',zalopay:'ZaloPay',demo:'Thanh toán mô phỏng'};
  let charts = [], mountedRoot = null, legendListener = null;

  function destroy() {
    if (mountedRoot && legendListener) mountedRoot.removeEventListener('click',legendListener);
    for (const chart of charts) chart.destroy();
    charts = []; mountedRoot = null; legendListener = null;
  }
  function fallback(canvas, failed) {
    const panel = canvas.closest('[data-chart-panel]');
    canvas.parentElement.hidden = failed;
    panel.querySelector('[data-chart-fallback]').hidden = !failed;
    const legend = panel.querySelector('.chart-series');
    if (legend) legend.hidden = failed;
    if (failed) panel.querySelectorAll('details').forEach(details => { details.open = true; });
  }
  function options(monetary = true) {
    return {
      responsive:true,maintainAspectRatio:false,animation:false,locale:'vi-VN',
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},tooltip:{callbacks:{label:context => `${context.dataset.label}: ${monetary ? currency.format(context.parsed.y) : count.format(context.parsed.y)}`}}},
      scales:{x:{grid:{display:false},ticks:{color:'#6d817f',maxRotation:0,autoSkip:true,maxTicksLimit:8}},y:{beginAtZero:true,grid:{color:'#e9efeb'},ticks:{color:'#6d817f',callback:value => compact.format(value)}}},
    };
  }
  function horizontal(data, monetary) {
    const settings = options(monetary);
    settings.indexAxis = 'y';
    settings.interaction = {mode:'nearest',intersect:false};
    settings.scales = {
      x:{beginAtZero:true,grid:{color:'#e9efeb'},ticks:{color:'#6d817f',precision:monetary ? undefined : 0,callback:value => compact.format(value)}},
      y:{grid:{display:false},ticks:{color:'#183635',autoSkip:false,callback:function(value) { const label = String(this.getLabelForValue(value)); return label.length > 25 ? label.slice(0,23)+'…' : label; }}},
    };
    settings.plugins.tooltip.callbacks = {label:context => `${context.dataset.label}: ${monetary ? currency.format(context.parsed.x) : count.format(context.parsed.x)}`};
    return {type:'bar',data,options:settings};
  }
  function render(root, analytics = {}) {
    destroy();
    if (!root?.isConnected) return;
    mountedRoot = root;
    const daily = analytics.daily || [], statuses = analytics.byStatus || [], methods = analytics.byPaymentMethod || [];
    const routes = [...(analytics.byRoute || [])].sort((a,b) => amount(b.bookings)-amount(a.bookings) || `${a.from}/${a.to}`.localeCompare(`${b.from}/${b.to}`)).slice(0,10);
    const dailyOptions = options();
    dailyOptions.scales.x.ticks.callback = function(value) { return dayLabel(this.getLabelForValue(value)).slice(0,5); };
    dailyOptions.plugins.tooltip.callbacks.title = items => items.length ? dayLabel(items[0].label) : '';
    const definitions = [
      ['dashboard-revenue-chart',{type:'bar',data:{labels:daily.map(row => row.date),datasets:[
        {label:'Đã thu',data:daily.map(row => amount(row.grossRevenue)),backgroundColor:'#087e75',borderRadius:3,maxBarThickness:24},
        {label:'Đã hoàn',data:daily.map(row => amount(row.refundedAmount)),backgroundColor:'#d68a42',borderRadius:3,maxBarThickness:24},
        {type:'line',label:'Thu ròng',data:daily.map(row => amount(row.revenue)),borderColor:'#315c9a',backgroundColor:'#315c9a',borderWidth:2,pointRadius:daily.length <= 31 ? 2 : 0,pointHitRadius:8,tension:0,order:-1},
      ]},options:dailyOptions},daily.length > 0],
      ['dashboard-status-chart',{type:'doughnut',data:{labels:statuses.map(row => statusNames[row.status] || row.status),datasets:[{label:'Số đơn',data:statuses.map(row => amount(row.bookings)),backgroundColor:statuses.map(row => statusColors[row.status] || '#607d8b'),borderWidth:2,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,animation:false,locale:'vi-VN',cutout:'70%',plugins:{legend:{display:false},tooltip:{callbacks:{label:context => `${context.label}: ${count.format(context.parsed)} đơn`}}}}},statuses.some(row => amount(row.bookings) > 0)],
      ['dashboard-payment-chart',horizontal({labels:methods.map(row => methodNames[row.paymentMethod] || row.paymentMethod),datasets:[{label:'Thu ròng',data:methods.map(row => amount(row.revenue)),backgroundColor:methods.map(row => amount(row.revenue) < 0 ? '#b54443' : '#087e75'),borderRadius:4,maxBarThickness:30}]},true),methods.length > 0],
      ['dashboard-route-chart',horizontal({labels:routes.map(row => `${row.fromName || row.from} → ${row.toName || row.to}`),datasets:[{label:'Số đơn',data:routes.map(row => amount(row.bookings)),backgroundColor:'#315c9a',borderRadius:4,maxBarThickness:26}]},false),routes.some(row => amount(row.bookings) > 0)],
    ];
    for (const [id,config,hasData] of definitions) {
      const canvas = root.querySelector('#'+id);
      if (!canvas) continue;
      if (typeof window.Chart !== 'function') { fallback(canvas,true); continue; }
      if (!hasData) { canvas.parentElement.hidden = true; continue; }
      try { charts.push(new window.Chart(canvas,config)); fallback(canvas,false); }
      catch { window.Chart.getChart(canvas)?.destroy(); fallback(canvas,true); }
    }
    legendListener = event => {
      const button = event.target.closest('[data-chart-series]');
      if (!button || !root.contains(button) || !root.isConnected) return;
      const chart = charts.find(item => item.canvas.id === 'dashboard-revenue-chart');
      if (!chart) return;
      const index = Number(button.dataset.chartSeries), visible = !chart.isDatasetVisible(index);
      chart.setDatasetVisibility(index,visible); chart.update('none');
      button.setAttribute('aria-pressed',String(visible));
    };
    root.addEventListener('click',legendListener);
  }
  window.TicketDashboardCharts = Object.freeze({render,destroy});
  document.addEventListener('ticket4t:session-cleared',destroy);
})();
