'use strict';

const crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

// Sorting object keys accepts equivalent JSON sent by clients with a different
// property order. Array order and every supplied value remain significant.
function canonicalBody(value) {
  if (Array.isArray(value)) return '['+value.map(canonicalBody).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalBody(value[key])).join(',')+'}';
  return JSON.stringify(value);
}

function checkoutIdempotency(req,fail) {
  const key=req.get('Idempotency-Key');
  if (key===undefined) return null;
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) fail(400,'Idempotency-Key cần từ 16 đến 128 ký tự chữ, số hoặc . _ : - .','INVALID_IDEMPOTENCY_KEY');
  // Anonymous keys are recovery capabilities, including when the response and
  // its session cookie are lost. Logged-in requests are isolated by user ID.
  const owner=req.user ? 'user:'+req.user.id : 'guest';
  return {keyHash:digest(owner+'\0'+key),requestHash:digest(req.path+'\0'+canonicalBody(req.body))};
}

module.exports={checkoutIdempotency};
