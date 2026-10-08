'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const {createApp}=require('../index');
const {addDays}=require('../server/catalog');
const {cleanupBrowserTest}=require('./browser-test-helpers');

// CSV uploads and imports use only this loopback application and managed fixtures.
(async()=>{
  const prefix='ticket4t-browser-csv-',dataDir=await fs.mkdtemp(path.join(os.tmpdir(),prefix));
  const env={NODE_ENV:'test',SEED_DEMO:'false',SESSION_SECRET:'csv-browser-isolated-fixture-'.repeat(3),ADMIN_EMAIL:'csv-admin@example.test',ADMIN_PASSWORD:'CSVAdmin@12345'};
  const failures=[],errors=[],contexts=[],screenshots=path.resolve('artifacts/screenshots');
  let runtime,server,browser,staff,base,operator,zeroOperator,today,passed=0,executed=0,testFailure;
  async function json(response,status=200){const value=await response.json();assert.equal(response.status(),status,JSON.stringify(value));return value;}
  async function count(){return Number((await runtime.api.db.get('SELECT COUNT(*) AS n FROM trips')).n);}
  async function check(id,title,work,{blockPapa=false}={}){
    if(process.env.UI_CSV_CASE&&!id.endsWith(process.env.UI_CSV_CASE))return;
    executed++;const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});contexts.push(context);
    if(blockPapa)await context.route('**/admin/vendor/papaparse.min.js',route=>route.fulfill({status:503,contentType:'text/plain',body:'Isolated unavailable asset fixture'}));
    const page=await context.newPage();page.setDefaultTimeout(12000);
    page.on('pageerror',error=>errors.push(id+': '+error.message));
    page.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused to|Uncaught/i.test(message.text()))errors.push(id+': '+message.text());});
    try{await work(page,context);passed++;console.log('PASS ['+id+'] '+title);}
    catch(error){const message=String(error.message).slice(0,4000);failures.push('['+id+'] '+title+': '+message);console.error('FAIL ['+id+'] '+title+'\n'+message);await page.screenshot({path:path.join(screenshots,'csv-failure-'+id.toLowerCase()+'.png'),fullPage:true,animations:'disabled'}).catch(()=>{});}
    finally{await context.close();}
  }
  async function open(page){
    await page.goto(base+'/admin');await page.locator('#login-form').waitFor({state:'visible'});await page.fill('#login-form [name="email"]',env.ADMIN_EMAIL);await page.fill('#login-form [name="password"]',env.ADMIN_PASSWORD);await page.locator('#login-form [type="submit"]').click();await page.locator('#portal').waitFor({state:'visible'});await page.locator('.stats-grid').first().waitFor();
    await page.locator('#sidebar [data-page="import"]').click();await page.locator('#import-form').waitFor();await page.fill('#import-form [name="sourceReference"]','Lịch nhà xe xác nhận riêng cho ca CSV cục bộ');
  }
  function trip(extra={}){return {operatorId:operator.id,from:'ho-chi-minh',to:'da-lat',date:addDays(today,3),departureTime:'08:05',durationMinutes:360,price:250000,totalSeats:9,type:'limousine',pickupPoints:'Văn phòng CSV',dropoffPoints:'Bến xe Đà Lạt',amenities:'Điều hòa|Nước uống',policies:'Có mặt trước 30 phút',active:true,...extra};}
  function csv(item,{delimiter=',',bom=false}={}){const quote=value=>'"'+String(value).replaceAll('"','""')+'"';return (bom?'\uFEFF':'')+Object.keys(item).join(delimiter)+'\r\n'+Object.values(item).map(quote).join(delimiter)+'\r\n';}
  async function preview(page,text){await page.fill('#import-form [name="schedule"]',text);await page.locator('[data-action="preview-import"]').click();await page.locator('#import-preview').waitFor();return page.locator('#import-preview');}
  function importRequest(value){return new URL(value.url()).pathname==='/api/admin/import'&&value.request().method()==='POST';}
  async function submit(page){const response=page.waitForResponse(importRequest);await page.locator('#import-form [type="submit"]').click();const received=await response;const data=await json(received,201);await page.waitForFunction(()=>location.hash==='#trips'&&document.querySelector('#sidebar [data-page="trips"]')?.classList.contains('active'));return {data,body:received.request().postDataJSON()};}
  async function assertPreviewSuccess(preview){assert.ok(!(await preview.getAttribute('class')).split(/\s+/).includes('error'));assert.match(await preview.innerText(),/1 chuyến đã qua kiểm tra ban đầu/);}
  try{
    await fs.mkdir(screenshots,{recursive:true});runtime=await createApp({env,dataDir,seedDemo:false,disableRateLimit:true});server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=env.APP_URL='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});staff=await browser.newContext();contexts.push(staff);await json(await staff.request.post(base+'/api/auth/login',{data:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}}));({today}=await json(await staff.request.get(base+'/api/bootstrap')));
    operator=(await json(await staff.request.post(base+'/api/admin/operators',{data:{name:'Nhà xe CSV kiểm thử',phone:'0901234567'}}),201)).operator;
    zeroOperator=(await json(await staff.request.post(base+'/api/admin/operators',{data:{name:'Nhà xe mã số 0 kiểm thử',phone:'0901234567'}}),201)).operator;
    // A valid managed operator with a string ID proves CSV never coerces codes.
    const zeroRow=await runtime.api.db.get('SELECT data FROM operators WHERE id=?',[zeroOperator.id]);
    await runtime.api.db.run('UPDATE operators SET id=?,data=? WHERE id=?',['0000202',JSON.stringify({...JSON.parse(zeroRow.data),id:'0000202'}),zeroOperator.id]);zeroOperator.id='0000202';

    await check('UI-CSV-001','Semicolon CSV upload and paste preserve BOM, multiline cells and escaped quotes before one managed import',async(page,context)=>{
      await open(page);const item=trip({pickupPoints:'Văn phòng "An; Bình"\r\nCổng 02'}),text=csv(item,{delimiter:';',bom:true}),before=await count(),posts=[];
      page.on('request',request=>{if(new URL(request.url()).pathname==='/api/admin/import'&&request.method()==='POST')posts.push(request.postDataJSON());});
      await page.locator('#import-file').setInputFiles({name:'lich-trinh-bom-semicolon.csv',mimeType:'text/csv',buffer:Buffer.from(text,'utf8')});await page.locator('#import-preview').waitFor();await assertPreviewSuccess(page.locator('#import-preview'));assert.equal(await count(),before);
      await assertPreviewSuccess(await preview(page,text));assert.equal(posts.length,0,'Preview must never write inventory');
      const result=await submit(page);assert.equal(result.data.imported,1);assert.equal(posts.length,1);assert.equal(await count(),before+1);
      assert.deepEqual(result.body.trips[0].pickupPoints,['Văn phòng "An; Bình"\nCổng 02']);assert.equal(result.body.trips[0].departureTime,'08:05');
      const saved=await json(await context.request.get(base+'/api/trips/'+result.data.trips[0].id));assert.equal(saved.source,'managed');assert.equal(saved.operatorId,operator.id);assert.deepEqual(saved.pickupPoints,result.body.trips[0].pickupPoints);assert.deepEqual(saved.amenities,['Điều hòa','Nước uống']);
    });

    await check('UI-CSV-002','Tab-delimited schedules preserve leading-zero operator codes in parsing, preview, request and stored inventory',async(page,context)=>{
      await open(page);const text=csv(trip({operatorId:zeroOperator.id,departureTime:'09:05'}),{delimiter:'\t'}),before=await count();
      const raw=await page.evaluate(text=>window.TicketScheduleCSV.rows(text),text);assert.equal(raw[1][raw[0].indexOf('operatorId')],'0000202');assert.equal(typeof raw[1][0],'string');
      const reviewed=await preview(page,text);await assertPreviewSuccess(reviewed);assert.match(await reviewed.innerText(),/Nhà xe mã số 0 kiểm thử/);
      const result=await submit(page);assert.equal(result.body.trips[0].operatorId,'0000202');assert.equal(typeof result.body.trips[0].operatorId,'string');assert.equal(await count(),before+1);
      const saved=await json(await context.request.get(base+'/api/trips/'+result.data.trips[0].id));assert.equal(saved.operatorId,'0000202');assert.equal(saved.departureTime,'09:05');
    });

    await check('UI-CSV-003','Malformed quotes, duplicate headers, column mismatch, more than 500 rows and UTF-8 payloads over 2 MB cannot submit',async page=>{
      await open(page);const valid=csv(trip()),lines=valid.split('\r\n'),before=await count();let posts=0;
      page.on('request',request=>{if(new URL(request.url()).pathname==='/api/admin/import'&&request.method()==='POST')posts++;});
      const cases=[
        ['operatorId,from\r\n"unterminated,ho-chi-minh',/nháy chưa đóng|CSV chưa hợp lệ/],
        [lines[0]+',operatorId\r\n'+lines[1]+',"'+operator.id+'"',/cột trống hoặc trùng/],
        [lines[0]+'\r\n'+lines[1]+',"extra"',/số cột không khớp/],
        [lines[0]+'\r\n'+Array(501).fill(lines[1]).join('\r\n'),/1 đến 500 chuyến/],
        ['operatorId,from\r\n"'+('ấ'.repeat(700000))+'",ho-chi-minh',/quá lớn.*2 MB/],
      ];
      assert.ok(Buffer.byteLength(cases[4][0],'utf8')>2*1024*1024,'The size case exceeds bytes while remaining below two million characters');
      for(const [text,error] of cases){
        if(text.length>100000){
          // Run both real form handlers in the same browser task, then clear
          // the fixture value before Chromium lays out 700,000 pasted glyphs.
          const result=await page.evaluate(value=>{
            const form=document.getElementById('import-form'),field=form.elements.schedule;
            field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action="preview-import"]').click();
            const first=document.getElementById('import-preview').textContent;form.requestSubmit(form.querySelector('[type="submit"]'));
            const second=document.getElementById('import-preview').textContent,className=document.getElementById('import-preview').className;field.value='';return {first,second,className};
          },text);
          assert.match(result.className,/\berror\b/);assert.match(result.first,error);assert.match(result.second,error);
        }else{const reviewed=await preview(page,text);assert.match(await reviewed.getAttribute('class'),/\berror\b/);assert.match(await reviewed.innerText(),error);await page.locator('#import-form [type="submit"]').click();assert.match(await reviewed.innerText(),error);}
      }
      assert.equal(posts,0);assert.equal(await count(),before);
    });

    await check('UI-CSV-004','Downloaded CSV template round-trips with BOM and CRLF, while hostile spreadsheet cells are escaped without executing code',async page=>{
      await open(page);const received=page.waitForEvent('download');await page.locator('[data-action="download-csv"]').click();const download=await received;assert.equal(download.suggestedFilename(),'lich-trinh-mau.csv');
      const stream=await download.createReadStream(),buffers=[];for await(const chunk of stream)buffers.push(chunk);const bytes=Buffer.concat(buffers),text=bytes.toString('utf8');assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf]);assert.match(text,/\r\n/);assert.doesNotMatch(text,/(?<!\r)\n/);
      const parsed=await page.evaluate(text=>({raw:window.Papa.parse(text,{header:true,skipEmptyLines:'greedy'}),rows:window.TicketScheduleCSV.rows(text)}),text);assert.deepEqual(parsed.raw.errors,[]);assert.equal(parsed.raw.data.length,1);assert.equal(parsed.raw.data[0].operatorId,operator.id);assert.equal(parsed.rows.length,2);await assertPreviewSuccess(await preview(page,text));
      const hostile=['=1+1','+SUM(1,2)','-2+3','@SUM(1,2)','\t=1+1','\r=1+1','  =1+1','<script>window.csvExecuted=true</script>','Tên xe "An, Bình"'];
      const escaped=await page.evaluate(values=>{window.csvExecuted=false;const text=window.TicketScheduleCSV.stringify(values.map(operatorName=>({operatorName})));const result=window.Papa.parse(text,{header:true,delimiter:',',skipEmptyLines:'greedy'});return {cells:result.data.map(row=>row.operatorName),errors:result.errors,executed:window.csvExecuted};},hostile);
      assert.deepEqual(escaped.errors,[]);assert.deepEqual(escaped.cells,hostile.map((value,index)=>index<7?"'"+value:value));assert.equal(escaped.executed,false);assert.equal(await page.locator('#import-preview script').count(),0);
    });

    await check('UI-CSV-005','Unavailable Papa Parse reports recoverable CSV errors and leaves JSON preview and managed import usable',async(page,context)=>{
      await open(page);assert.equal(await page.evaluate(()=>typeof window.Papa),'undefined');const before=await count(),reviewed=await preview(page,csv(trip()));assert.match(await reviewed.getAttribute('class'),/\berror\b/);assert.match(await reviewed.innerText(),/Thư viện CSV chưa tải được.*JSON/);
      let downloads=0;page.on('download',()=>{downloads++;});await page.locator('[data-action="download-csv"]').click();await page.locator('#toast-stack .toast').filter({hasText:/Thư viện CSV chưa tải được.*JSON/}).waitFor();assert.equal(downloads,0);assert.equal(await count(),before);
      const item=trip({departureTime:'10:05',pickupPoints:['Văn phòng JSON'],dropoffPoints:['Bến xe Đà Lạt JSON'],amenities:['Điều hòa'],policies:[]});await assertPreviewSuccess(await preview(page,JSON.stringify([item])));
      const result=await submit(page);assert.equal(result.data.imported,1);assert.deepEqual(result.body.trips[0].pickupPoints,['Văn phòng JSON']);assert.equal(await count(),before+1);const saved=await json(await context.request.get(base+'/api/trips/'+result.data.trips[0].id));assert.equal(saved.source,'managed');assert.equal(saved.departureTime,'10:05');
    },{blockPapa:true});

    assert.deepEqual(errors,[],'CSV flows must not raise browser exceptions or CSP errors');if(failures.length)throw new AggregateError(failures.map(message=>new Error(message)),passed+'/'+executed+' CSV browser scenarios passed');console.log('CSV browser passed: '+passed+'/'+executed+' scenarios; upload, delimiter and code preservation, malformed and oversized inputs, safe exports, and JSON fallback.');
  }catch(error){testFailure=error;throw error;}
  finally{await Promise.allSettled(contexts.map(context=>context.close()));await cleanupBrowserTest({browser,server,runtime,dataDir,prefix},testFailure);}
})().catch(error=>{console.error(error);process.exitCode=1;});
