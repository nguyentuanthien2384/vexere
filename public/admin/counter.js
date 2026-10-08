'use strict';

// Counter sales share the server's inventory and fare rules with online checkout.
(() => {
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon=name=>window.TicketIcons.render(name);
  const money=value=>new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND',maximumFractionDigits:0}).format(Number(value)||0);
  const dialog=document.createElement('dialog');
  dialog.id='counter-dialog';dialog.className='counter-dialog';dialog.setAttribute('aria-labelledby','counter-title');
  document.body.append(dialog);
  let current=null,version=0;

  async function request(path,options={}){
    const snapshot=current,id=version;
    const response=await fetch('/api'+path,{credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/json'},...options});
    const data=await response.json().catch(()=>({error:'Máy chủ chưa trả về dữ liệu hợp lệ.'}));
    if(!response.ok){
      const active=()=>id===version&&current===snapshot&&dialog.open;
      if(response.status===401&&active())document.dispatchEvent(new CustomEvent('ticket4t:session-expired'));
      if(response.status===403&&active()){
        try{
          const sessionResponse=await fetch('/api/auth/me',{credentials:'same-origin',headers:{Accept:'application/json'}}),session=await sessionResponse.json();
          if(sessionResponse.ok&&active()&&(!session.user||!['admin','operator'].includes(session.user.role)||snapshot.actor&&['id','role','operatorId'].some(key=>(session.user[key]||null)!==(snapshot.actor[key]||null))))document.dispatchEvent(new CustomEvent('ticket4t:session-expired'));
        }catch{ /* Keep the dialog retryable when the session cannot be checked. */ }
      }
      const error=new Error(data.error||'Không thể xử lý yêu cầu.');error.status=response.status;error.code=data.code;throw error;
    }
    return data;
  }
  function error(message){const target=dialog.querySelector('#counter-error');if(target)target.textContent=message;}
  function total(){return (current?.trip?.seats||[]).filter(seat=>current.selected.includes(seat.label)).reduce((sum,seat)=>sum+Number(seat.price??current.trip.price),0);}
  function selectable(seat){return seat.status==='available'&&current?.trip?.bookingOpen!==false;}
  function updateSummary(){
    if(!current)return;
    const label=dialog.querySelector('#counter-selected'),amount=dialog.querySelector('#counter-total'),button=dialog.querySelector('#counter-submit');
    label.textContent=current.selected.length?current.selected.join(', '):'Chưa chọn ghế';
    amount.textContent=money(total());
    button.disabled=current.loading||current.busy||!current.selected.length||current.trip?.bookingOpen===false;
    button.textContent=current.busy?'Đang xác nhận ghế…':'Tạo đặt chỗ tại quầy';
    dialog.querySelectorAll('.counter-seat').forEach(button=>{const selected=current.selected.includes(button.dataset.seat);button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));button.disabled=current.busy||!selectable(current.trip.seats.find(seat=>seat.label===button.dataset.seat));});
    dialog.querySelectorAll('[data-counter-close],#counter-refresh').forEach(button=>button.disabled=current.busy||current.loading);
  }
  function pointName(point){return typeof point==='string'?point:point?.name||point?.address||'';}
  function points(values){return (values||[]).map(point=>`<option value="${esc(pointName(point))}">${esc(pointName(point))}</option>`).join('');}
  function renderSeats(){
    const trip=current.trip,decks=[...new Set((trip.seats||[]).map(seat=>seat.deck||1))];
    dialog.querySelector('#counter-seats').classList.remove('loading');
    dialog.querySelector('#counter-seats').innerHTML=`<div class="counter-legend"><span><i></i>Còn trống</span><span><i class="selected"></i>Đang chọn</span><span><i class="unavailable"></i>Đã đặt / đang giữ</span></div><div class="counter-decks">${decks.map(deck=>`<section><h3>${decks.length>1?'Tầng '+esc(deck):'Sơ đồ ghế'}</h3><div class="counter-seat-grid">${trip.seats.filter(seat=>(seat.deck||1)===deck).map(seat=>`<button type="button" class="counter-seat${selectable(seat)?'':' unavailable'}" data-seat="${esc(seat.label)}" aria-label="Ghế ${esc(seat.label)}, ${esc(money(seat.price??trip.price))}, ${selectable(seat)?'còn trống':seat.status==='held'?'đang giữ':'không còn bán'}" aria-pressed="false" ${selectable(seat)?'':'disabled'}>${icon(trip.type==='sleeper'?'bed':trip.type==='cabin'?'cabin':'seat')}<strong>${esc(seat.label)}</strong><small>${money(seat.price??trip.price)}</small></button>`).join('')}</div></section>`).join('')}</div>`;
    const banner=dialog.querySelector('#counter-notice');
    banner.innerHTML=trip.bookingOpen===false?`${icon('clock')}<span>Chuyến đã đóng bán. Hãy chọn chuyến khác.</span>`:trip.source==='demo'?`${icon('info')}<span>Chuyến minh họa. Đặt chỗ này không dùng để lên xe hoặc thu tiền thật.</span>`:`${icon('shield')}<span>Chọn tối đa 6 ghế. Máy chủ kiểm tra lại ghế và giá khi lưu; đặt chỗ chưa ghi nhận thanh toán.</span>`;
    updateSummary();
  }
  async function refresh(){
    const snapshot=current,id=version;
    if(!snapshot||snapshot.loading||snapshot.busy)return;
    snapshot.loading=true;error('');updateSummary();
    try{
      const data=await request('/trips/'+encodeURIComponent(snapshot.tripId));
      if(id!==version||current!==snapshot||!dialog.open)return;
      snapshot.trip=data.trip||data;
      const previous=snapshot.selected.length;
      snapshot.selected=snapshot.selected.filter(label=>snapshot.trip.seats?.some(seat=>seat.label===label&&selectable(seat)));
      const pickup=dialog.querySelector('[name="pickup"]'),dropoff=dialog.querySelector('[name="dropoff"]'),oldPickup=pickup.value,oldDropoff=dropoff.value;
      pickup.innerHTML=points(snapshot.trip.pickupPoints);dropoff.innerHTML=points(snapshot.trip.dropoffPoints);
      if([...pickup.options].some(option=>option.value===oldPickup))pickup.value=oldPickup;
      if([...dropoff.options].some(option=>option.value===oldDropoff))dropoff.value=oldDropoff;
      renderSeats();
      if(previous!==snapshot.selected.length)error('Một số ghế đã được khách khác đặt hoặc giữ. Vui lòng chọn lại.');
    }catch(failure){if(id===version&&current===snapshot){error(failure.message);snapshot.selected=[];const seats=dialog.querySelector('#counter-seats');if(seats.classList.contains('loading')){seats.classList.remove('loading');seats.innerHTML='<p class="counter-empty">Không thể tải sơ đồ ghế. Chọn Cập nhật để thử lại.</p>';}}}
    finally{if(id===version&&current===snapshot){snapshot.loading=false;updateSummary();}}
  }
  async function open(trip,actor){
    if(current?.busy||dialog.open)return;
    current={tripId:trip.id,trip,actor:actor?{id:actor.id,role:actor.role,operatorId:actor.operatorId}:null,selected:[],busy:false,loading:false};version++;
    const dateLabel=trip.date?new Intl.DateTimeFormat('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'Asia/Ho_Chi_Minh'}).format(new Date(trip.date+'T12:00:00+07:00')):'';
    dialog.innerHTML=`<form id="counter-form"><div class="dialog-heading"><div><span class="eyebrow">BÁN VÉ TẠI QUẦY</span><h2 id="counter-title">${esc(trip.fromName||trip.from)} → ${esc(trip.toName||trip.to)}</h2><p>${esc(trip.operatorName)} · ${esc(dateLabel)} · ${esc(trip.departureTime)}</p></div><button class="icon-button" type="button" data-counter-close aria-label="Đóng bán vé tại quầy">${icon('close')}</button></div><div class="counter-layout"><section class="counter-inventory"><div class="counter-section-heading"><div><h3>Chọn chỗ cho hành khách</h3><p>Ghế và tổng tiền được xác nhận khi lưu.</p></div><button class="button secondary small" id="counter-refresh" type="button">${icon('refresh')}Cập nhật</button></div><div id="counter-notice" class="notice teal"></div><div id="counter-seats" class="loading">Đang tải sơ đồ ghế…</div></section><section class="counter-passenger"><h3>Thông tin hành khách</h3><div class="form-grid"><label class="span-2">Họ và tên<input name="fullName" autocomplete="name" minlength="2" maxlength="100" required placeholder="Tên hành khách"></label><label>Số điện thoại<input name="phone" type="tel" autocomplete="tel" pattern="[0-9+ ]{9,20}" required></label><label>Email liên hệ (tùy chọn)<input name="email" type="email" autocomplete="email" maxlength="254"></label><label class="span-2">Điểm đón<select name="pickup" required></select></label><label class="span-2">Điểm trả<select name="dropoff" required></select></label></div><div class="counter-summary"><div><span>Ghế đã chọn</span><strong id="counter-selected">Chưa chọn ghế</strong></div><div><span>Tổng tiền</span><strong id="counter-total">0 ₫</strong></div><p>${icon('cash')}Thanh toán tại nhà xe. Ghi phiếu thu riêng sau khi đã nhận đủ tiền.</p></div></section></div><p id="counter-error" class="error-text" role="alert"></p><div class="dialog-footer"><button class="button secondary" type="button" data-counter-close>Quay lại</button><button class="button primary" id="counter-submit" type="submit" disabled>Tạo đặt chỗ tại quầy</button></div></form>`;
    dialog.showModal();await refresh();
  }
  dialog.addEventListener('click',event=>{
    if(event.target.closest('[data-counter-close]')){if(!current?.busy)dialog.close();return;}
    if(event.target.closest('#counter-refresh')){refresh();return;}
    const button=event.target.closest('.counter-seat');
    if(!button||button.disabled||!current||current.busy||current.loading)return;
    const label=button.dataset.seat;
    if(current.selected.includes(label))current.selected=current.selected.filter(seat=>seat!==label);
    else if(current.selected.length===6){error('Mỗi lần đặt chọn tối đa 6 ghế.');return;}
    else current.selected.push(label);
    error('');updateSummary();
  });
  dialog.addEventListener('submit',async event=>{
    event.preventDefault();const snapshot=current,id=version;
    if(!snapshot||snapshot.busy||snapshot.loading||!snapshot.selected.length||!event.target.reportValidity())return;
    const data=Object.fromEntries(new FormData(event.target));
    snapshot.busy=true;error('');updateSummary();
    try{
      const result=await request('/admin/bookings',{method:'POST',body:JSON.stringify({...data,tripId:snapshot.tripId,seats:[...snapshot.selected],paymentMethod:'cash'})});
      if(id!==version||current!==snapshot)return;
      snapshot.busy=false;dialog.close();
      document.dispatchEvent(new CustomEvent('ticket4t:counter-booked',{detail:result.booking}));
    }catch(failure){if(id===version&&current===snapshot){error(failure.message);snapshot.busy=false;if(['SEAT_UNAVAILABLE','DEPARTED'].includes(failure.code))await refresh();}}
    finally{if(id===version&&current===snapshot){snapshot.busy=false;updateSummary();}}
  });
  dialog.addEventListener('cancel',event=>{if(current?.busy)event.preventDefault();});
  dialog.addEventListener('close',()=>{if(dialog.open)return;version++;current=null;});
  document.addEventListener('ticket4t:session-cleared',()=>{if(dialog.open)dialog.close();version++;current=null;dialog.innerHTML='';});
  window.TicketCounter=Object.freeze({open});
})();
