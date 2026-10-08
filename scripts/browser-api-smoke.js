'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const {createApp}=require('../index');
const {cleanupBrowserTest}=require('./browser-test-helpers');
const {addDays}=require('../server/catalog');

(async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'ticket4t-browser-api-'));
  let runtime,server,browser,testFailure;
  try {
  const env={NODE_ENV:'test',SEED_DEMO:'true',SESSION_SECRET:'api-browser-tests-only-'.repeat(3),APP_URL:'http://127.0.0.1',
    VNPAY_TMN_CODE:'TEST',VNPAY_HASH_SECRET:'test-only-secret',VNPAY_URL:'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    MOMO_PARTNER_CODE:'TEST',MOMO_ACCESS_KEY:'test-access',MOMO_SECRET_KEY:'test-secret',
    ZALOPAY_APP_ID:'2553',ZALOPAY_KEY1:'test-key1',ZALOPAY_KEY2:'test-key2'};
  let walletRequests=0,failNextWallet=false;
  const walletFetch=async (url,options)=>{walletRequests++;if(failNextWallet){failNextWallet=false;throw new Error('Mock provider connection lost');}const body=JSON.parse(options.body);return {ok:true,status:200,json:async()=>String(url).includes('momo')?{resultCode:0,payUrl:'https://test-payment.momo.vn/pay',partnerCode:body.partnerCode,orderId:body.orderId,requestId:body.requestId,amount:body.amount}:{return_code:1,order_url:'https://sbgateway.zalopay.vn/pay'}};};
  runtime=await createApp({env,dataDir,seedDays:5,disableRateLimit:true,walletFetch});
  server=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=env.APP_URL='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
  const errors=[];
  async function pageForTest(){const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.route(/^https:\/\/(sandbox\.vnpayment\.vn|test-payment\.momo\.vn|sbgateway\.zalopay\.vn)\//,route=>route.fulfill({contentType:'text/html',body:'<title>Mock payment gateway</title><p>Payment gateway test</p>'}));return {page,context};}
  const bootstrap=await(await fetch(base+'/api/bootstrap')).json(),date=addDays(bootstrap.today,2),backDate=addDays(bootstrap.today,3);
  async function choose(page,url,count=1){await page.goto(url);await page.locator('[data-action="seat"]:enabled').first().waitFor();for(let i=0;i<count;i++)await page.locator('[data-action="seat"]:enabled').nth(i).click();await page.locator('[data-action="checkout"]').click();}
  async function demoCheckout(page,roundtrip=false){await page.goto(base+'/#/search?'+new URLSearchParams({from:'ho-chi-minh',to:'da-lat',date,...(roundtrip?{mode:'roundtrip',returnDate:backDate,leg:'outbound'}:{})}));await page.locator('.trip-card .btn').first().waitFor();await page.locator('.trip-card .btn').first().click();await page.locator('[data-action="seat"]:enabled').first().waitFor();await page.locator('[data-action="seat"]:enabled').first().click();await page.locator('[data-action="checkout"]').click();if(roundtrip){await page.waitForURL(/leg=return/);await page.locator('.trip-card .btn').first().waitFor();await page.locator('.trip-card .btn').first().click();await page.locator('[data-action="seat"]:enabled').first().waitFor();await page.locator('[data-action="seat"]:enabled').first().click();await page.locator('[data-action="checkout"]').click();}await page.locator('#checkout-form').waitFor();}
  async function fillGuest(page,email){await page.fill('#fullName','Khách kiểm thử API');await page.fill('#phone','0916666777');await page.fill('#email',email);await page.check('#checkout-form [name="consent"]');}
    for(const roundtrip of [false,true]){
      const {page,context}=await pageForTest(),endpoint=roundtrip?'/api/orders':'/api/bookings',email=roundtrip?'lost-order@example.test':'lost-booking@example.test';
      await demoCheckout(page,roundtrip);await fillGuest(page,email);
      assert.equal(await page.locator('.payment-option input:not([value="cash"])').count(),0,'Demo inventory cannot send users to configured payment providers');
      let committed,first=true;const requests=[];
      await page.route('**'+endpoint,async route=>{if(route.request().method()!=='POST')return route.continue();requests.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});if(!first)return route.continue();first=false;const response=await route.fetch();assert.equal(response.status(),201,await response.text());committed=await response.json();await route.abort('failed');});
      await page.click('#book-button');await page.waitForFunction(()=>document.querySelector('#checkout-error')?.textContent.includes('cùng yêu cầu'));
      assert.ok(committed?.booking||committed?.order,'The server committed the request before the connection failed');
      await page.reload();await page.locator('#checkout-form').waitFor();assert.equal(await page.inputValue('#email'),email,'An ambiguous attempt restores its submitted passenger details');
      await page.check('#checkout-form [name="consent"]');assert.ok(await page.locator('#book-button').isEnabled(),'A committed hold can still recover the original response');
      const replay=page.waitForResponse(response=>response.url().endsWith(endpoint)&&response.request().method()==='POST');await page.click('#book-button');const recovered=await(await replay).json();
      assert.equal((recovered.order||recovered.booking).code,(committed.order||committed.booking).code);assert.equal(requests.length,2);assert.equal(requests[0].key,requests[1].key);assert.equal(requests[0].body,requests[1].body);assert.ok(requests[0].key);
      await page.locator(roundtrip?'.order-booking':'.receipt-code').first().waitFor();
      const count=await runtime.api.db.get('SELECT COUNT(*) AS n FROM bookings WHERE email=?',[email]);assert.equal(Number(count.n),roundtrip?2:1,'Retrying the same checkout creates no duplicate tickets');
      assert.equal(await page.evaluate(()=>sessionStorage.getItem('ticket4t_checkout_attempt')),null);await context.close();
    }

    {
      const {page,context}=await pageForTest();await demoCheckout(page);await fillGuest(page,'changed-attempt@example.test');const keys=[];let first=true;
      await page.route('**/api/bookings',async route=>{if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']);if(first){first=false;return route.abort('failed');}return route.continue();});
      await page.click('#book-button');await page.waitForFunction(()=>document.querySelector('#checkout-error')?.textContent.includes('cùng yêu cầu'));await page.fill('#phone','0916666888');await page.click('#book-button');await page.locator('.receipt-code').waitFor();assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1],'Changing submission details starts a distinct idempotent attempt');await context.close();
    }

    {
      const {page,context}=await pageForTest();await demoCheckout(page);await fillGuest(page,'navigation-pending@example.test');let release,intercept;const gate=new Promise(resolve=>{release=resolve;}),pending=new Promise(resolve=>{intercept=resolve;});
      await page.route('**/api/bookings',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();intercept();await gate;await route.fulfill({response});});
      await page.click('#book-button');await pending;await page.evaluate(()=>{location.hash='#/support';});await page.locator('.faq-list').waitFor();release();await page.waitForFunction(()=>sessionStorage.getItem('ticket4t_checkout_attempt')===null);assert.ok(new URL(page.url()).hash.startsWith('#/support'),'A completed background checkout does not replace the page the user opened');assert.equal(await page.locator('.receipt-code').count(),0);const count=await runtime.api.db.get('SELECT COUNT(*) AS n FROM bookings WHERE email=?',['navigation-pending@example.test']);assert.equal(Number(count.n),1);await context.close();
    }

    const staff=await browser.newContext();
    const login=await staff.request.post(base+'/api/auth/login',{data:{email:'admin@ticket4t.vn',password:'Admin@12345'}});assert.equal(login.status(),200,await login.text());
    const operatorResponse=await staff.request.post(base+'/api/admin/operators',{data:{name:'Nhà xe kiểm thử API',phone:'0916666999'}});assert.equal(operatorResponse.status(),201,await operatorResponse.text());const {operator}=await operatorResponse.json();
    const tripResponse=await staff.request.post(base+'/api/admin/trips',{data:{operatorId:operator.id,from:'ho-chi-minh',to:'da-lat',date,departureTime:'10:00',durationMinutes:360,type:'limousine',price:250000,totalSeats:18,pickupPoints:['Văn phòng thử nghiệm'],dropoffPoints:['Điểm trả thử nghiệm'],provenance:'Lịch thử nghiệm giao diện API, không phục vụ vận chuyển'}});assert.equal(tripResponse.status(),201,await tripResponse.text());const {trip}=await tripResponse.json();await staff.close();

    for(const method of ['vnpay','momo','zalopay']){
      const {page,context}=await pageForTest();await choose(page,base+'/#/trip/'+encodeURIComponent(trip.id));await page.locator('#checkout-form').waitFor();await fillGuest(page,method+'-flow@example.test');
      assert.equal(await page.locator('.payment-option input:not([value="cash"])').count(),3,'All configured providers are selectable for managed inventory');await page.check(`#checkout-form [name="paymentMethod"][value="${method}"]`);
      let resolveCreated;const createdResponse=new Promise(resolve=>{resolveCreated=resolve;});await page.route('**/api/bookings',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();resolveCreated(await response.json());await route.fulfill({response});});await page.click('#book-button');const created=await createdResponse;assert.equal(created.booking?.paymentMethod,method,JSON.stringify(created));await page.waitForURL(url=>['sandbox.vnpayment.vn','test-payment.momo.vn','sbgateway.zalopay.vn'].includes(url.hostname));
      await page.goto(base+'/#/lookup?code='+created.booking.code);await page.locator('.receipt-code').waitFor();assert.equal((await page.locator('.receipt-code').innerText()).trim(),created.booking.code);assert.ok(!new URL(page.url()).hash.includes('phone='),'Returning from the gateway recovers the phone from this tab without putting it in the return URL');await page.locator('[data-action="continue-payment"]').waitFor();
      const refresh=page.waitForResponse(item=>item.url().includes('/api/bookings/lookup?'));await page.locator('[data-action="refresh-booking"]').click();assert.equal((await(await refresh).json()).booking.paymentStatus,'pending');
      if(method==='vnpay'){
        let release,intercept;const gate=new Promise(resolve=>{release=resolve;}),pending=new Promise(resolve=>{intercept=resolve;});const handler=async route=>{intercept();await gate;await route.continue();};await page.route('**/payment-link',handler);await page.locator('[data-action="continue-payment"]').click();await pending;await page.evaluate(()=>{location.hash='#/support';});await page.locator('.faq-list').waitFor();const finished=page.waitForResponse(item=>item.url().endsWith('/payment-link'));release();await finished;await page.unroute('**/payment-link',handler);assert.ok(new URL(page.url()).hash.startsWith('#/support'),'A late payment-link response cannot redirect a page the user navigated away from');await page.goto(base+'/#/lookup?code='+created.booking.code);await page.locator('.receipt-code').waitFor();
      }
      const resumed=page.waitForResponse(item=>item.url().endsWith('/payment-link'));await page.locator('[data-action="continue-payment"]').click();assert.equal((await resumed).status(),200);await page.waitForURL(url=>['sandbox.vnpayment.vn','test-payment.momo.vn','sbgateway.zalopay.vn'].includes(url.hostname));
      await page.goto(base+'/#/lookup?code='+created.booking.code);await page.locator('.receipt-code').waitFor();
      await runtime.api.db.transaction(tx=>tx.run("UPDATE bookings SET status='confirmed',payment_status='paid',expires_at=NULL WHERE code=?",[created.booking.code]));
      await page.waitForFunction(()=>document.querySelector('.receipt-header h1')?.textContent.includes('Thanh toán đã được ghi nhận'),{},{timeout:15000});assert.equal(await page.locator('[data-action="continue-payment"]').count(),0,'A verified payment removes the resume action');
      const other=await browser.newContext(),otherPage=await other.newPage();await otherPage.goto(base+'/#/lookup?code='+created.booking.code);await otherPage.locator('#lookup-form').waitFor();assert.equal(await otherPage.inputValue('#lookup-phone'),'','Another session cannot obtain the saved contact phone');await other.close();await context.close();
    }
    assert.equal(walletRequests,2,'Resuming each wallet reuses its provider order and does not send a second charge creation request');

    {
      const {page,context}=await pageForTest();await choose(page,base+'/#/trip/'+encodeURIComponent(trip.id));await page.locator('#checkout-form').waitFor();await fillGuest(page,'gateway-failure@example.test');await page.check('#checkout-form [name="paymentMethod"][value="momo"]');failNextWallet=true;
      const response=page.waitForResponse(item=>item.url().endsWith('/api/bookings')&&item.request().method()==='POST');await page.click('#book-button');const created=await(await response).json();assert.equal(created.booking?.status,'pending_payment');assert.equal(created.paymentError?.code,'PAYMENT_RECONCILIATION_REQUIRED');await page.locator('.receipt-code').waitFor();assert.match(await page.locator('#toast-region .toast.error').last().innerText(),/đối soát|chưa nhận|cổng/i);assert.ok(!new URL(page.url()).hostname.includes('momo'),'A provider failure still shows the committed booking for recovery');
      const resume=page.waitForResponse(item=>item.url().endsWith('/payment-link'));await page.locator('[data-action="continue-payment"]').click();assert.equal((await resume).status(),503);assert.equal(walletRequests,3,'An uncertain provider request is not sent a second time');const count=await runtime.api.db.get('SELECT COUNT(*) AS n FROM bookings WHERE email=?',['gateway-failure@example.test']);assert.equal(Number(count.n),1);await context.close();
    }

    {
      const {page,context}=await pageForTest();await page.goto(base+'/#/trip/'+encodeURIComponent(trip.id));await page.locator('[data-action="seat"]:enabled').first().waitFor();const labels=await page.locator('[data-action="seat"]:enabled').evaluateAll(elements=>elements.slice(0,2).map(element=>element.dataset.label));await page.locator(`[data-label="${labels[0]}"]`).click();await page.locator(`[data-label="${labels[1]}"]`).focus();await page.evaluate(label=>{window.focusedSeat=document.querySelector(`[data-label="${label}"]`);},labels[1]);
      const competitor=await browser.newContext();const hold=await competitor.request.post(base+'/api/holds',{data:{tripId:trip.id,seats:[labels[0]]}});assert.equal(hold.status(),201,await hold.text());await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.waitForFunction(label=>document.querySelector(`[data-label="${label}"]`)?.disabled,labels[0]);assert.equal(await page.locator('.seat.selected').count(),0);assert.ok(await page.evaluate(()=>document.activeElement===window.focusedSeat&&window.focusedSeat.isConnected),'Seat synchronization preserves the focused, unaffected seat element');await competitor.close();await context.close();
    }
    assert.deepEqual(errors,[],'API reliability flows cause no browser exceptions');
    console.log('API browser passed: lost-response retries for tickets/orders, changed attempts, three payment providers, return/resume/status recovery, gateway failure recovery, contact isolation and live seat updates.');
  } catch(error){testFailure=error;throw error;}
  finally {await cleanupBrowserTest({browser,server,runtime,dataDir,prefix:'ticket4t-browser-api-'},testFailure);}
})().catch(error=>{console.error(error);process.exitCode=1;});
