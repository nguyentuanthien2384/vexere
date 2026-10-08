'use strict';
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  console.error('Không thêm dữ liệu minh họa vào production. Dùng trang quản trị để nhập lịch nhà xe.');
  process.exitCode = 1;
} else {
  const { createApi } = require('../server/app');
  createApi({ env: { ...process.env, SEED_DEMO: 'true' }, seedDemo: true })
    .then(async api => { console.log('Dữ liệu minh họa đã sẵn sàng. Tài khoản, vé và lịch hiện có được giữ lại.'); await api.close(); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
