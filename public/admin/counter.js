'use strict';

// Counter sales share the server's inventory and fare rules with online checkout.
(() => {
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon=name=>window.TicketIcons.render(name);
  const money=value=>new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND',maximumFractionDigits:0}).format(Number(value)||0);
  const recovery=window.TicketCounterRecovery,storageKey='ticket4t_counter_attempt';
  const dialog=document.createElement('dialog');
  dialog.id='counter-dialog';dialog.className='counter-dialog';dialog.setAttribute('aria-labelledby','counter-title');document.body.append(dialog);
  const banner=document.createElement('div');banner.id='admin-counter-pending';banner.className='notice admin-counter-pending';banner.setAttribute('role','status');banner.hidden=true;
  document.getElementById('main')?.before(banner);
  let current=null,version=0,actor=null,attempt=null;
  const sameActor=(left,right)=>Boolean(left&&right)&&['id','role','operatorId'].every(key=>(left[key]??null)===(right[key]??null));
  const active=(snapshot,id)=>Boolean(snapshot)&&current===snapshot&&version===id&&dialog.open&&snapshot.route===location.hash&&sameActor(snapshot.actor,actor);
  function renderPending(){banner.hidden=!actor||!attempt;banner.innerHTML=!actor||!attempt?'':`<div><strong>Cần kiểm tra yêu cầu bán vé tại quầy</strong>Yêu cầu trước chưa nhận được kết quả chắc chắn. Xác nhận lại đúng hành khách, chuyến, ghế và tổng tiền đã gửi.</div><button class="button secondary" type="button" data-action="resume-counter-request">Kiểm tra đặt chỗ tại quầy</button>`;}
  function clearAttempt(key){if(key&&attempt?.key!==key)return;attempt=null;try{sessionStorage.removeItem(storageKey);}catch{}renderPending();}
  function saveAttempt(value){sessionStorage.setItem(storageKey,JSON.stringify(value));attempt=value;renderPending();}
  function close(){if(dialog.open)dialog.close();version++;current=null;dialog.innerHTML='';}
  function restore(user){
    if(!sameActor(user,actor)||actor!==user)close();actor=user;
    try{attempt=recovery.read(sessionStorage.getItem(storageKey),actor);}catch{attempt=null;}
    if(!attempt)clearAttempt();else renderPending();
  }
  async function request(path,options={}){
    const snapshot=current,id=version,{headers={},timeoutMs=20000,...settings}=options,controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetch('/api'+path,{credentials:'same-origin',...settings,headers:{Accept:'application/json','Content-Type':'application/json',...headers},signal:controller.signal});
      let data;
      try{data=await response.json();}catch{if(response.status===401&&active(snapshot,id))document.dispatchEvent(new CustomEvent('ticket4t:session-expired'));const failure=new Error('Máy chủ chưa trả về đủ kết quả. Vui lòng kiểm tra lại.');failure.ambiguous=true;throw failure;}
      if(!data||typeof data!=='object'||Array.isArray(data)){const failure=new Error('Máy chủ chưa trả về đủ kết quả. Vui lòng kiểm tra lại.');failure.ambiguous=true;throw failure;}
      if(!response.ok){
        if(response.status===401&&active(snapshot,id))document.dispatchEvent(new CustomEvent('ticket4t:session-expired'));
        const failure=new Error(data.error||'Không thể xử lý yêu cầu.');failure.status=response.status;failure.code=data.code;failure.ambiguous=response.status>=500;throw failure;
      }
      return data;
    }catch(failure){if(failure.name==='AbortError'||failure instanceof TypeError){const error=new Error(failure.name==='AbortError'?'Máy chủ phản hồi quá lâu. Vui lòng kiểm tra lại.':'Mất kết nối tới máy chủ. Vui lòng kiểm tra lại.');error.ambiguous=true;throw error;}throw failure;}
    finally{clearTimeout(timer);}
  }
  async function verifyIdentity(snapshot,id){
    if(!active(snapshot,id))return false;
    const session=await request('/auth/me');
    if(!active(snapshot,id))return false;
    if(!Object.hasOwn(session,'user')||session.user!==null&&(typeof session.user!=='object'||Array.isArray(session.user))){const failure=new Error('Chưa xác minh được phiên vận hành. Vui lòng kiểm tra lại.');failure.ambiguous=true;throw failure;}
    if(!sameActor(snapshot.actor,session.user)||!['admin','operator'].includes(session.user?.role)){document.dispatchEvent(new CustomEvent('ticket4t:session-expired'));return false;}
    return true;
  }
  function error(message){const target=dialog.querySelector('#counter-error');if(target)target.textContent=message;}
  function total(){return current?.attempt?.body.expectedTotal??(current?.trip?.seats||[]).filter(seat=>current.selected.includes(seat.label)).reduce((sum,seat)=>sum+Number(seat.price??current.trip.price),0);}
  function selectable(seat){return Boolean(seat)&&seat.status==='available'&&current?.trip?.bookingOpen!==false;}
  function reviewed(){const checkbox=dialog.querySelector('[name="counterConfirmed"]');if(checkbox)checkbox.checked=false;}
  function updateSummary(){
    if(!current)return;
    const form=dialog.querySelector('#counter-form'),label=dialog.querySelector('#counter-selected'),amount=dialog.querySelector('#counter-total'),button=dialog.querySelector('#counter-submit');
    if(!form||!label||!amount||!button)return;
    label.textContent=current.selected.length?current.selected.join(', '):'Chưa chọn ghế';amount.textContent=money(total());
    button.disabled=current.loading||current.busy||!current.selected.length||!current.attempt&&current.trip?.bookingOpen===false;
    button.textContent=current.busy?'Đang kiểm tra kết quả…':current.attempt?'Kiểm tra đúng yêu cầu đã gửi':'Tạo đặt chỗ tại quầy';
    form.inert=Boolean(current.busy);form.setAttribute('aria-busy',String(Boolean(current.busy)));
    dialog.querySelectorAll('.counter-seat').forEach(button=>{const selected=current.selected.includes(button.dataset.seat);button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));button.disabled=Boolean(current.attempt)||current.loading||current.busy||!selectable(current.trip.seats.find(seat=>seat.label===button.dataset.seat));});
    dialog.querySelectorAll('[data-counter-close]').forEach(button=>button.disabled=current.busy||current.loading);
    const refresh=dialog.querySelector('#counter-refresh');if(refresh){refresh.disabled=current.busy||current.loading;refresh.hidden=Boolean(current.attempt);}
  }
  const pointName=point=>typeof point==='string'?point:point?.name||point?.address||'';
  const points=values=>(values||[]).map(point=>`<option value="${esc(pointName(point))}">${esc(pointName(point))}</option>`).join('');
  function heading(trip){
    const dateLabel=trip.date?new Intl.DateTimeFormat('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'Asia/Ho_Chi_Minh'}).format(new Date(trip.date+'T12:00:00+07:00')):'';
    dialog.querySelector('#counter-title').textContent=`${trip.fromName||trip.from} → ${trip.toName||trip.to}`;
    dialog.querySelector('#counter-trip-info').textContent=`${trip.operatorName||trip.operatorId} · ${dateLabel} · ${trip.departureTime}`;
  }
  function renderSeats(){
    const trip=current.trip,decks=[...new Set((trip.seats||[]).map(seat=>seat.deck||1))];
    dialog.querySelector('#counter-seats').classList.remove('loading');
    dialog.querySelector('#counter-seats').innerHTML=`<div class="counter-legend"><span><i></i>Còn trống</span><span><i class="selected"></i>Đang chọn</span><span><i class="unavailable"></i>Đã đặt / đang giữ</span></div><div class="counter-decks">${decks.map(deck=>`<section><h3>${decks.length>1?'Tầng '+esc(deck):'Sơ đồ ghế'}</h3><div class="counter-seat-grid">${trip.seats.filter(seat=>(seat.deck||1)===deck).map(seat=>`<button type="button" class="counter-seat${selectable(seat)?'':' unavailable'}" data-seat="${esc(seat.label)}" aria-label="Ghế ${esc(seat.label)}, ${esc(money(seat.price??trip.price))}, ${selectable(seat)?'còn trống':seat.status==='held'?'đang giữ':'không còn bán'}" aria-pressed="false" ${selectable(seat)?'':'disabled'}>${icon(trip.type==='sleeper'?'bed':trip.type==='cabin'?'cabin':'seat')}<strong>${esc(seat.label)}</strong><small>${money(seat.price??trip.price)}</small></button>`).join('')}</div></section>`).join('')}</div>`;
    dialog.querySelector('#counter-notice').innerHTML=current.attempt?`${icon('info')}<span id="counter-recovery-notice"><strong>Chưa biết chắc kết quả yêu cầu trước.</strong> Các thông tin đã gửi được giữ nguyên. Máy chủ trả về vé hiện tại, kể cả khi vé đã thu tiền, hủy hoặc đổi tiếp. Kiểm tra và đồng ý lại để nhận kết quả.</span>`:trip.bookingOpen===false?`${icon('clock')}<span>Chuyến đã đóng bán. Hãy chọn chuyến khác.</span>`:trip.source==='demo'?`${icon('info')}<span>Chuyến minh họa. Đặt chỗ này không dùng để lên xe hoặc thu tiền thật.</span>`:`${icon('shield')}<span>Chọn tối đa 6 ghế. Máy chủ kiểm tra lại ghế, điều kiện chuyến và tổng tiền đã xác nhận; đặt chỗ chưa ghi nhận thanh toán.</span>`;
    heading(trip);updateSummary();
  }
  function formValues(){const form=dialog.querySelector('#counter-form');return Object.fromEntries(['fullName','phone','email','pickup','dropoff'].map(name=>[name,form?.elements[name]?.value||'']));}
  function terms(trip){return trip?.bookingVersion;}
  async function refresh(message=''){
    const snapshot=current,id=version;
    if(!snapshot||snapshot.loading||snapshot.busy||snapshot.attempt)return;
    snapshot.loading=true;error('');updateSummary();
    try{
      const data=await request('/trips/'+encodeURIComponent(snapshot.tripId));if(!active(snapshot,id))return;
      const previousTrip=snapshot.trip,previous=snapshot.selected.length;snapshot.trip=data.trip||data;
      snapshot.selected=snapshot.selected.filter(label=>snapshot.trip.seats?.some(seat=>seat.label===label&&selectable(seat)));
      const pickup=dialog.querySelector('[name="pickup"]'),dropoff=dialog.querySelector('[name="dropoff"]'),oldPickup=pickup.value,oldDropoff=dropoff.value;
      pickup.innerHTML=points(snapshot.trip.pickupPoints);dropoff.innerHTML=points(snapshot.trip.dropoffPoints);
      if([...pickup.options].some(option=>option.value===oldPickup))pickup.value=oldPickup;
      if([...dropoff.options].some(option=>option.value===oldDropoff))dropoff.value=oldDropoff;
      const changed=terms(previousTrip)&&terms(previousTrip)!==terms(snapshot.trip);
      if(changed||previous!==snapshot.selected.length||message){reviewed();const notice=dialog.querySelector('#counter-review-notice');notice.hidden=false;notice.textContent=message||'Giá, lịch, điểm đón trả hoặc ghế đã thay đổi. Vui lòng kiểm tra thông tin hiện tại và đồng ý lại.';}
      renderSeats();if(previous!==snapshot.selected.length)error('Một số ghế đã được khách khác đặt hoặc giữ. Vui lòng chọn lại.');
    }catch(failure){if(active(snapshot,id)){error(failure.message);snapshot.selected=[];reviewed();const seats=dialog.querySelector('#counter-seats');if(seats.classList.contains('loading')){seats.classList.remove('loading');seats.innerHTML='<p class="counter-empty">Không thể tải sơ đồ ghế. Chọn Cập nhật để thử lại.</p>';}}}
    finally{if(active(snapshot,id)){snapshot.loading=false;updateSummary();}}
  }
  function render(){
    const snapshot=current,trip=snapshot.trip,recovering=Boolean(snapshot.attempt),saved=snapshot.attempt?.body;
    dialog.innerHTML=`<form id="counter-form"><div class="dialog-heading"><div><span class="eyebrow">BÁN VÉ TẠI QUẦY</span><h2 id="counter-title"></h2><p id="counter-trip-info"></p></div><button class="icon-button" type="button" data-counter-close aria-label="Đóng bán vé tại quầy">${icon('close')}</button></div><div class="counter-layout"><section class="counter-inventory"><div class="counter-section-heading"><div><h3>Chọn chỗ cho hành khách</h3><p>Kiểm tra chuyến, ghế và tổng tiền trước khi xác nhận.</p></div><button class="button secondary small" id="counter-refresh" type="button">${icon('refresh')}Cập nhật</button></div><div id="counter-notice" class="notice teal"></div><div id="counter-review-notice" class="notice counter-review-notice" role="alert" hidden></div><div id="counter-seats" class="loading">Đang tải sơ đồ ghế…</div></section><section class="counter-passenger"><h3>Thông tin hành khách</h3><div class="form-grid"><label class="span-2">Họ và tên<input name="fullName" autocomplete="name" minlength="2" maxlength="100" required placeholder="Tên hành khách"></label><label>Số điện thoại<input name="phone" type="tel" autocomplete="tel" pattern="[0-9+ ]{9,20}" required></label><label>Email liên hệ (tùy chọn)<input name="email" type="email" autocomplete="email" maxlength="254"></label><label class="span-2">Điểm đón<select name="pickup" required>${points(trip.pickupPoints)}</select></label><label class="span-2">Điểm trả<select name="dropoff" required>${points(trip.dropoffPoints)}</select></label></div><div class="counter-summary"><div><span>Ghế đã chọn</span><strong id="counter-selected">Chưa chọn ghế</strong></div><div><span>Tổng tiền đã kiểm tra</span><strong id="counter-total">0 ₫</strong></div><p>${icon('cash')}Thanh toán tại nhà xe. Ghi phiếu thu riêng sau khi đã nhận đủ tiền.</p></div>${recovering?'<button class="button secondary counter-restore" type="button" id="counter-restore-request">Khôi phục đúng thông tin đã gửi</button>':''}<label class="check-label counter-confirmation"><input type="checkbox" name="counterConfirmed" required>Tôi đã kiểm tra hành khách, chuyến, ghế, điểm đón trả và tổng tiền${recovering?' của yêu cầu đã gửi; đồng ý kiểm tra kết quả hiện tại.':'; đồng ý tạo đặt chỗ chưa ghi nhận thanh toán.'}</label></section></div><p id="counter-error" class="error-text" role="alert"></p><div class="dialog-footer"><button class="button secondary" type="button" data-counter-close>Quay lại</button><button class="button primary" id="counter-submit" type="submit" disabled>Tạo đặt chỗ tại quầy</button></div></form>`;
    if(saved)for(const name of ['fullName','phone','email','pickup','dropoff']){const field=dialog.querySelector('#counter-form').elements[name];field.value=saved[name];if(field instanceof HTMLSelectElement)field.disabled=true;else field.readOnly=true;}
    heading(trip);if(recovering)renderSeats();
  }
  async function open(trip,user){
    if(current?.busy||dialog.open)return;
    if(!sameActor(actor,user))restore(user);
    if(attempt){await resume(user);return;}
    current={tripId:trip.id,trip,actor:{id:user.id,role:user.role,operatorId:user.operatorId??null},selected:[],busy:false,loading:false,route:location.hash,attempt:null};version++;
    render();dialog.showModal();await refresh();
  }
  async function resume(user=actor){
    if(current?.busy)return;
    if(!sameActor(actor,user))restore(user);
    if(!attempt||!sameActor(attempt.actor,user))return;
    close();current={tripId:attempt.trip.id,trip:attempt.trip,actor:attempt.actor,selected:[...attempt.body.seats],busy:false,loading:false,route:location.hash,attempt};version++;
    render();dialog.showModal();updateSummary();
  }
  dialog.addEventListener('click',event=>{
    if(event.target.closest('[data-counter-close]')){if(!current?.busy)close();return;}
    if(event.target.closest('#counter-refresh')){refresh();return;}
    if(event.target.closest('#counter-restore-request')){if(current?.attempt&&!current.busy){render();updateSummary();error('Đã khôi phục đúng thông tin đã gửi. Vui lòng kiểm tra và đồng ý lại.');}return;}
    const button=event.target.closest('.counter-seat');
    if(!button||button.disabled||!current||current.busy||current.loading||current.attempt)return;
    const label=button.dataset.seat;
    if(current.selected.includes(label))current.selected=current.selected.filter(seat=>seat!==label);
    else if(current.selected.length===6){error('Mỗi lần đặt chọn tối đa 6 ghế.');return;}
    else current.selected.push(label);
    reviewed();error('');updateSummary();
  });
  dialog.addEventListener('change',event=>{if(event.target.name!=='counterConfirmed')reviewed();});
  dialog.addEventListener('input',event=>{if(event.target.name!=='counterConfirmed')reviewed();});
  dialog.addEventListener('submit',async event=>{
    event.preventDefault();const snapshot=current,id=version,form=event.target;
    if(!active(snapshot,id)||snapshot.busy||snapshot.loading||!snapshot.selected.length||!form.reportValidity()||!form.elements.counterConfirmed.checked)return;
    if(snapshot.attempt&&!recovery.matches(snapshot.attempt,{tripId:snapshot.tripId,seats:snapshot.selected,passenger:formValues()})){reviewed();error('Thông tin đã thay đổi so với yêu cầu trước. Hãy khôi phục đúng thông tin đã gửi rồi xác nhận lại.');return;}
    snapshot.busy=true;error('');updateSummary();let posted=false,pending=snapshot.attempt;
    try{
      if(!await verifyIdentity(snapshot,id))return;
      if(!pending){const passenger=Object.fromEntries(Object.entries(formValues()).map(([key,value])=>[key,value.trim()]));pending=recovery.create({actor:snapshot.actor,trip:snapshot.trip,seats:snapshot.selected,passenger,key:crypto.randomUUID()});saveAttempt(pending);snapshot.attempt=pending;}
      posted=true;
      const result=await request(pending.path,{method:'POST',headers:{'Idempotency-Key':pending.key},body:JSON.stringify(pending.body)});
      if(!active(snapshot,id)||!await verifyIdentity(snapshot,id))return;
      if(!result?.booking?.code){const failure=new Error('Chưa nhận được thông tin vé đầy đủ. Vui lòng kiểm tra lại đúng yêu cầu.');failure.ambiguous=true;throw failure;}
      clearAttempt(pending.key);const owner=snapshot.actor;close();
      document.dispatchEvent(new CustomEvent('ticket4t:counter-booked',{detail:{booking:result.booking,actor:owner,replayed:Boolean(result.replayed)}}));
    }catch(failure){
      if(!active(snapshot,id))return;
      if(failure.status===403){try{await verifyIdentity(snapshot,id);}catch{}if(!active(snapshot,id))return;}
      snapshot.busy=false;
      if(posted&&failure.ambiguous){snapshot.attempt=pending;render();updateSummary();error(`${failure.message} Chưa biết chắc kết quả. Xác nhận lại đúng yêu cầu đã gửi để kiểm tra.`);}
      else{
        if(posted){clearAttempt(pending?.key);snapshot.attempt=null;for(const name of ['fullName','phone','email','pickup','dropoff']){form.elements[name].readOnly=false;form.elements[name].disabled=false;}dialog.querySelector('#counter-restore-request')?.remove();}
        reviewed();error(failure.message);
        if(['TRIP_CHANGED','PRICE_CHANGED','SEAT_UNAVAILABLE','SEATS_UNAVAILABLE','DEPARTED','NOT_FOUND'].includes(failure.code))await refresh('Điều kiện chuyến, giá hoặc ghế đã thay đổi. Kiểm tra lại thông tin hiện tại và đồng ý lại trước khi tạo đặt chỗ.');
      }
    }finally{if(active(snapshot,id)){snapshot.busy=false;updateSummary();}}
  });
  dialog.addEventListener('cancel',event=>{if(current?.busy)event.preventDefault();});
  dialog.addEventListener('close',()=>{if(dialog.open)return;version++;current=null;dialog.innerHTML='';});
  window.addEventListener('hashchange',()=>{if(current&&current.route!==location.hash)close();});
  document.addEventListener('ticket4t:session-cleared',()=>{close();actor=null;clearAttempt();});
  document.addEventListener('click',event=>{if(event.target.closest('[data-action="resume-counter-request"]')){event.preventDefault();resume();}});
  window.TicketCounter=Object.freeze({open,restore,resume,pending:()=>Boolean(attempt)});
})();
