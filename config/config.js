'use strict';

require('dotenv').config();

const connection = {
  dialect: 'postgres',
  logging: process.env.DB_LOG_SQL === 'true' ? console.log : false,
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  ...(process.env.DATABASE_URL
    ? { use_env_variable: 'DATABASE_URL' }
    : {
      username: process.env.DB_USER || 'ticket4t',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'ticket4t',
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
    }),
  ...(process.env.DB_SSL === 'true'
    ? { dialectOptions: { ssl: { require: true, rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } } }
    : {}),
};

module.exports = { development: { ...connection }, test: { ...connection }, production: { ...connection } };
