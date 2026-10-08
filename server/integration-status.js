'use strict';

const {configured:vnpayConfigured} = require('./payments');
const {getOperatorFeedStatus} = require('./operator-feed');
const {providerConfig} = require('./wallet-payments');

function paymentEnvironment(env) {
  if (!env.VNPAY_URL) return 'sandbox';
  try {
    const url = new URL(env.VNPAY_URL);
    if (!['http:','https:'].includes(url.protocol)) return 'invalid';
    // Match the production startup guard; classification does not verify the endpoint.
    return /sandbox/i.test(env.VNPAY_URL) ? 'sandbox' : 'live';
  } catch { return 'invalid'; }
}

function walletStatus(provider,env) {
  const config = providerConfig(provider,env);
  const name = provider === 'momo' ? 'MoMo' : 'ZaloPay';
  const missingConfiguration = config.missing.map(key => 'Thiết lập '+key+' hợp lệ để bật thanh toán '+name+'.');
  if (!config.validEndpoint) missingConfiguration.push('Thiết lập '+provider.toUpperCase()+'_URL đúng endpoint HTTPS chính thức do '+name+' cấp.');
  if (env.NODE_ENV === 'production' && config.environment === 'sandbox') missingConfiguration.push('Thiết lập '+provider.toUpperCase()+'_URL thanh toán thật trước khi chạy production.');
  return {configured:config.configured,environment:config.environment,externallyVerified:false,missingConfiguration,
    notes:['Cấu hình chưa được xác minh với '+name+'. Cần kiểm thử khởi tạo thanh toán và callback có chữ ký trước khi nhận tiền thật.']};
}

async function getIntegrationStatus({db,env = process.env}) {
  const counts = await db.get("SELECT SUM(CASE WHEN source='managed' THEN 1 ELSE 0 END) AS managed_trips,SUM(CASE WHEN source='demo' THEN 1 ELSE 0 END) AS demo_trips,SUM(CASE WHEN source='managed' AND active=1 THEN 1 ELSE 0 END) AS active_managed_trips,SUM(CASE WHEN source='demo' AND active=1 THEN 1 ELSE 0 END) AS active_demo_trips FROM trips");
  const environment = paymentEnvironment(env);
  const paymentMissing = [];
  for (const key of ['VNPAY_TMN_CODE','VNPAY_HASH_SECRET','APP_URL']) {
    if (!env[key]) paymentMissing.push('Thiết lập '+key+' để bật thanh toán VNPAY.');
  }
  if (environment === 'invalid') paymentMissing.push('VNPAY_URL cần là URL thanh toán hợp lệ do VNPAY cấp.');
  if (env.NODE_ENV === 'production' && environment === 'sandbox') paymentMissing.push('Thiết lập VNPAY_URL thanh toán thật được cấp theo hợp đồng trước khi chạy production.');
  const emailMissing = [];
  if (!env.SMTP_HOST) emailMissing.push('Thiết lập SMTP_HOST và thông tin gửi thư để gửi email xác minh, khôi phục và thông báo vé.');
  else {
    if (!env.SMTP_FROM && !env.SMTP_USER) emailMissing.push('Thiết lập SMTP_FROM hoặc SMTP_USER để xác định người gửi email.');
    if (env.SMTP_USER && !env.SMTP_PASS && !env.SMTP_PASSWORD) emailMissing.push('Thiết lập SMTP_PASS (hoặc SMTP_PASSWORD) cho tài khoản SMTP_USER.');
  }
  const dialect = ['postgres','sqlite'].includes(db.dialect) ? db.dialect : 'unknown';
  return {
    checkedAt:new Date().toISOString(),
    inventory:{managedTrips:Number(counts.managed_trips || 0),demoTrips:Number(counts.demo_trips || 0),activeManagedTrips:Number(counts.active_managed_trips || 0),activeDemoTrips:Number(counts.active_demo_trips || 0),providerSync:getOperatorFeedStatus(env)},
    payments:{cash:{enabled:true},vnpay:{configured:vnpayConfigured(env),environment,externallyVerified:false,missingConfiguration:paymentMissing,
      notes:['Có cấu hình không đồng nghĩa merchant đã hoạt động. Cần kiểm thử giao dịch, chữ ký và IPN với VNPAY trước khi nhận tiền thật.']},momo:walletStatus('momo',env),zalopay:walletStatus('zalopay',env)},
    email:{configured:Boolean(env.SMTP_HOST),mode:env.SMTP_HOST ? 'smtp' : env.NODE_ENV === 'production' ? 'disabled' : 'development_outbox',externallyVerified:false,missingConfiguration:emailMissing,
      notes:[env.SMTP_HOST ? 'Chưa kiểm tra đăng nhập SMTP hoặc khả năng gửi đến hộp thư thực tế.' : env.NODE_ENV === 'production' ? 'Production không dùng hộp thư phát triển; tính năng xác minh và khôi phục qua email cần SMTP.' : 'Email đang được ghi vào hộp thư phát triển, chưa gửi đến người nhận.']},
    database:{dialect,connected:true,productionReady:dialect === 'postgres',
      notes:[dialect === 'postgres' ? 'Đạt yêu cầu PostgreSQL của ứng dụng cho production; chưa kiểm tra sao lưu hoặc hạ tầng vận hành.' : 'Thiết lập DATABASE_URL để dùng PostgreSQL trước khi chạy production.']}
  };
}

module.exports = {getIntegrationStatus};
