"use strict";

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function escapeHtml(value) { return String(value).replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function createMailer(db, env, dataDir) {
  let transport;
  if (env.SMTP_HOST) transport = require('nodemailer').createTransport({host:env.SMTP_HOST,port:Number(env.SMTP_PORT || 587),secure:env.SMTP_SECURE === 'true',
    auth:env.SMTP_USER ? {user:env.SMTP_USER,pass:env.SMTP_PASS || env.SMTP_PASSWORD} : undefined});
  return async ({to,subject,text,html,sensitive=false}) => {
    const entry = {id:crypto.randomUUID(),to,subject,text,createdAt:new Date().toISOString()};
    if (!sensitive || env.NODE_ENV !== 'production') await db.transaction(tx => tx.run('INSERT INTO email_outbox(id,recipient,subject,body,created_at,status) VALUES(?,?,?,?,?,?)',[entry.id,to,subject,text,entry.createdAt,'pending']));
    if (transport) {
      try {
        await transport.sendMail({from:env.SMTP_FROM || env.SMTP_USER,to,subject,text,html});
        if (!sensitive || env.NODE_ENV !== 'production') await db.transaction(tx => tx.run("UPDATE email_outbox SET status='sent' WHERE id=?",[entry.id]));
        return {delivered:true};
      }
      catch (error) { console.error('Email delivery failed:',error.code || 'SMTP_ERROR'); return {delivered:false}; }
    }
    // No production fallback stores verification or recovery tokens unencrypted.
    if (env.NODE_ENV === 'production') return {delivered:false};
    await db.transaction(tx => tx.run("UPDATE email_outbox SET status='development' WHERE id=?",[entry.id]));
    const directory = path.resolve(dataDir || env.DATA_DIR || path.join(process.cwd(),'data'));
    fs.mkdirSync(directory,{recursive:true});
    fs.appendFileSync(path.join(directory,'email-outbox.jsonl'),JSON.stringify(entry)+'\n',{encoding:'utf8',mode:0o600});
    return {delivered:false,development:true};
  };
}

module.exports = {createMailer,escapeHtml};
