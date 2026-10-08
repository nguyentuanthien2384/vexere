'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const nodemailer=require('nodemailer');
const {createMailer,escapeHtml}=require('../../server/mailer');

const virtualDirectory=path.join(os.tmpdir(),'ticket4t-mailer-unit-virtual');
const message={to:'passenger@example.test',subject:'Thông tin chuyến đi',text:'Mã xác minh: private-unit-token',html:'<p>Thông tin vé</p>'};

function fakeDatabase(){
  const rows=new Map(),operations=[];
  const db={async transaction(work){return work({async run(sql,params){
    operations.push({sql,params});
    if(sql.startsWith('INSERT INTO email_outbox')){
      const [id,to,subject,text,createdAt,status]=params;rows.set(id,{id,to,subject,text,createdAt,status});
    }else{
      const status=/SET status='(\w+)'/.exec(sql)?.[1],row=rows.get(params[0]);assert.ok(row,'Status changes reference an existing outbox message');row.status=status;
    }
  }});}};
  return {db,rows,operations};
}
function isolateFileWrites(t){
  const created=[],appended=[];
  t.mock.method(fs,'mkdirSync',(directory,options)=>{created.push({directory,options});});
  t.mock.method(fs,'appendFileSync',(filename,body,options)=>{appended.push({filename,body,options});});
  return {created,appended};
}
function fakeSMTP(t,send=async()=>{}){
  const configurations=[],sent=[];
  t.mock.method(nodemailer,'createTransport',configuration=>{
    configurations.push(configuration);
    return {async sendMail(value){sent.push(value);return send(value);}};
  });
  return {configurations,sent};
}

test('[UT-MAIL-001] HTML escaping protects all reserved characters and preserves Vietnamese text',()=>{
  assert.equal(escapeHtml('&<>"\' Đà Lạt'),'&amp;&lt;&gt;&quot;&#39; Đà Lạt');
  assert.equal(escapeHtml(250000),'250000');
});

test('[UT-MAIL-002] development fallback records the message and appends a private JSONL entry',async t=>{
  const {db,rows}=fakeDatabase(),files=isolateFileWrites(t),smtp=fakeSMTP(t);
  const send=createMailer(db,{NODE_ENV:'development'},virtualDirectory),result=await send({...message,sensitive:true});
  assert.deepEqual(result,{delivered:false,development:true});assert.equal(smtp.configurations.length,0);
  assert.equal(rows.size,1);const row=[...rows.values()][0];assert.equal(row.status,'development');assert.equal(row.text,message.text);
  assert.equal(files.created.length,1);assert.equal(files.created[0].directory,path.resolve(virtualDirectory));
  assert.equal(files.appended.length,1);const file=files.appended[0];assert.equal(file.filename,path.join(virtualDirectory,'email-outbox.jsonl'));assert.deepEqual(file.options,{encoding:'utf8',mode:0o600});assert.ok(file.body.endsWith('\n'));
  const entry=JSON.parse(file.body);assert.equal(entry.id,row.id);assert.equal(entry.to,message.to);assert.equal(entry.subject,message.subject);assert.equal(entry.text,message.text);assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
});

test('[UT-MAIL-003] production without SMTP never persists sensitive recovery tokens',async t=>{
  const {db,rows,operations}=fakeDatabase(),files=isolateFileWrites(t),smtp=fakeSMTP(t);
  const result=await createMailer(db,{NODE_ENV:'production'},virtualDirectory)({...message,sensitive:true});
  assert.deepEqual(result,{delivered:false});assert.equal(rows.size,0);assert.equal(operations.length,0);assert.equal(smtp.configurations.length,0);assert.deepEqual(files,{created:[],appended:[]});
});

test('[UT-MAIL-004] sensitive production SMTP sends the message without retaining its token',async t=>{
  const {db,operations}=fakeDatabase(),files=isolateFileWrites(t),smtp=fakeSMTP(t);
  const env={NODE_ENV:'production',SMTP_HOST:'smtp.example.test',SMTP_PORT:'465',SMTP_SECURE:'true',SMTP_USER:'sender@example.test',SMTP_PASSWORD:'unit-password-alias',SMTP_FROM:'Ticket4T <support@example.test>'};
  assert.deepEqual(await createMailer(db,env,virtualDirectory)({...message,sensitive:true}),{delivered:true});
  assert.deepEqual(smtp.configurations,[{host:env.SMTP_HOST,port:465,secure:true,auth:{user:env.SMTP_USER,pass:env.SMTP_PASSWORD}}]);
  assert.deepEqual(smtp.sent,[{from:env.SMTP_FROM,...message}]);assert.equal(operations.length,0);assert.deepEqual(files,{created:[],appended:[]});
});

test('[UT-MAIL-005] sensitive SMTP failure returns an error result without logging message content',async t=>{
  const {db,operations}=fakeDatabase(),files=isolateFileWrites(t),logs=[];
  const error=Object.assign(new Error('Private SMTP response containing '+message.text),{code:'EAUTH'});
  fakeSMTP(t,async()=>{throw error;});t.mock.method(console,'error',(...args)=>logs.push(args));
  const env={NODE_ENV:'production',SMTP_HOST:'smtp.example.test',SMTP_USER:'sender@example.test',SMTP_PASS:'private-password'};
  assert.deepEqual(await createMailer(db,env,virtualDirectory)({...message,sensitive:true}),{delivered:false});
  assert.deepEqual(logs,[['Email delivery failed:','EAUTH']]);for(const secret of [message.to,message.text,env.SMTP_PASS,error.message])assert.ok(!JSON.stringify(logs).includes(secret));assert.equal(operations.length,0);assert.deepEqual(files,{created:[],appended:[]});
});

test('[UT-MAIL-006] successful booking notifications change outbox status to sent',async t=>{
  const {db,rows}=fakeDatabase(),files=isolateFileWrites(t),smtp=fakeSMTP(t);
  const env={NODE_ENV:'production',SMTP_HOST:'smtp.example.test',SMTP_USER:'sender@example.test',SMTP_PASS:'primary-password',SMTP_PASSWORD:'unused-alias'};
  assert.deepEqual(await createMailer(db,env,virtualDirectory)(message),{delivered:true});
  assert.equal(rows.size,1);assert.equal([...rows.values()][0].status,'sent');assert.equal(smtp.configurations[0].auth.pass,'primary-password');assert.equal(smtp.sent[0].from,env.SMTP_USER);assert.deepEqual(files,{created:[],appended:[]});
});

test('[UT-MAIL-007] failed SMTP booking notifications remain pending and do not fall back to disk',async t=>{
  const {db,rows}=fakeDatabase(),files=isolateFileWrites(t),logs=[];fakeSMTP(t,async()=>{throw new Error('Private transport failure');});t.mock.method(console,'error',(...args)=>logs.push(args));
  assert.deepEqual(await createMailer(db,{NODE_ENV:'development',SMTP_HOST:'smtp.example.test',SMTP_FROM:'support@example.test'},virtualDirectory)(message),{delivered:false});
  assert.equal([...rows.values()][0].status,'pending');assert.deepEqual(logs,[['Email delivery failed:','SMTP_ERROR']]);assert.deepEqual(files,{created:[],appended:[]});
});

test('[UT-MAIL-008] an unauthenticated SMTP relay uses default port and the configured sender',async t=>{
  const {db}=fakeDatabase();isolateFileWrites(t);const smtp=fakeSMTP(t),env={NODE_ENV:'production',SMTP_HOST:'relay.example.test',SMTP_FROM:'support@example.test'};
  assert.deepEqual(await createMailer(db,env,virtualDirectory)(message),{delivered:true});
  assert.deepEqual(smtp.configurations,[{host:env.SMTP_HOST,port:587,secure:false,auth:undefined}]);assert.equal(smtp.sent[0].from,env.SMTP_FROM);
});

test('[UT-MAIL-009] outbox persistence failure propagates before sending a notification',async t=>{
  const files=isolateFileWrites(t),smtp=fakeSMTP(t),failure=new Error('Outbox unavailable');const db={async transaction(){throw failure;}};
  const send=createMailer(db,{NODE_ENV:'production',SMTP_HOST:'smtp.example.test',SMTP_FROM:'support@example.test'},virtualDirectory);
  await assert.rejects(()=>send(message),error=>error===failure);assert.equal(smtp.sent.length,0);assert.deepEqual(files,{created:[],appended:[]});
});

test('[UT-MAIL-010] post-send outbox failure preserves confirmed delivery and logs only a sanitized recording error',async t=>{
  const {db,rows}=fakeDatabase(),files=isolateFileWrites(t),smtp=fakeSMTP(t),logs=[];
  const persist=db.transaction;let writes=0;const failure=Object.assign(new Error('Private database failure '+message.text),{code:'private-database-secret'});
  db.transaction=async work=>{if(++writes===2)throw failure;return persist(work);};
  t.mock.method(console,'error',(...args)=>logs.push(args));
  const env={NODE_ENV:'production',SMTP_HOST:'smtp.example.test',SMTP_USER:'sender@example.test',SMTP_PASS:'private-mail-password'};
  assert.deepEqual(await createMailer(db,env,virtualDirectory)(message),{delivered:true});
  assert.equal(smtp.sent.length,1,'A recording failure never repeats SMTP delivery');assert.equal(writes,2);assert.equal([...rows.values()][0].status,'pending');
  assert.deepEqual(logs,[['Email outbox recording failed:','OUTBOX_STATUS_ERROR']]);
  for(const secret of [message.to,message.text,env.SMTP_PASS,failure.message,failure.code])assert.ok(!JSON.stringify(logs).includes(secret));
  assert.deepEqual(files,{created:[],appended:[]});
});
