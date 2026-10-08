'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const csv=require('../../public/admin/schedule-csv');

test('[UT-ADMINCSV-001] comma semicolon and tab imports preserve raw identifiers and string numbers',()=>{
  for(const delimiter of [',',';','\t']) {
    const rows=csv.rows(['operatorId','phone','price'].join(delimiter)+'\n'+['0007','0901234567','250000'].join(delimiter));
    assert.deepEqual(rows,[['operatorId','phone','price'],['0007','0901234567','250000']]);
  }
});
test('[UT-ADMINCSV-002] UTF8 BOM and each supported line ending keep Unicode and ignore empty records',()=>{
  for(const newline of ['\n','\r','\r\n'])assert.deepEqual(csv.rows('\uFEFFname,city'+newline+'"Nguyễn An","Đà Lạt"'+newline+'  ,   '+newline+newline),[['name','city'],['Nguyễn An','Đà Lạt']]);
  for(const delimiter of [',',';','\t'])assert.deepEqual(csv.rows((delimiter+'\n').repeat(30)+'name'+delimiter+'city\nNguyễn An'+delimiter+'Đà Lạt'),[['name','city'],['Nguyễn An','Đà Lạt']]);
});
test('[UT-ADMINCSV-003] escaped quotes separators and multiline quoted cells retain their complete content',()=>{
  assert.deepEqual(csv.rows('id,pickup\r\n001,"Văn phòng, \"\"Q1\"\"\r\nCửa A"'),[['id','pickup'],['001','Văn phòng, "Q1"\r\nCửa A']]);
  assert.deepEqual(csv.rows('id;pickup\n001;"Văn phòng; Q1\nCửa A"'),[['id','pickup'],['001','Văn phòng; Q1\nCửa A']]);
});
test('[UT-ADMINCSV-004] existing legal padding around quoted fields is accepted without changing unquoted cells',()=>{
  for(const delimiter of [',',';','\t'])assert.deepEqual(csv.rows('  "id"  '+delimiter+' "point"\n  001 '+delimiter+'  "Văn phòng"  '),[['id','point'],['  001 ','Văn phòng']]);
});
test('[UT-ADMINCSV-005] malformed quotes never silently become literal or partially imported values',()=>{
  for(const text of ['id,name\n001,An"Bình','id,name\n001,"An','id,name\n001,"An"x','id,name\n001,"An" "Bình"','id;name\n001;An"Bình'])assert.throws(()=>csv.rows(text),/CSV/);
});
test('[UT-ADMINCSV-006] empty duplicate and whitespace-equivalent headers and mismatched row widths are rejected',()=>{
  for(const text of ['id,\n001,An','id,id\n001,An','id, id \n001,An','id,name\n001','id,name\n001,An,extra'])assert.throws(()=>csv.rows(text),/CSV|số cột/);
  for(const text of ['', ' \n\t ', 'id,name'])assert.throws(()=>csv.rows(text));
});
test('[UT-ADMINCSV-007] list separators stay inside cells and never become a guessed CSV delimiter',()=>{
  assert.deepEqual(csv.rows('id,pickupPoints\n001,A|B|C'),[['id','pickupPoints'],['001','A|B|C']]);
  assert.deepEqual(csv.rows('pickupPoints\nA|B|C'),[['pickupPoints'],['A|B|C']]);
});
test('[UT-ADMINCSV-008] maximum 500 trips includes the final record without newline and skips empty records',()=>{
  const valid='id,name\n'+Array.from({length:500},(_,index)=>`${index},An`).join('\n\n');
  assert.equal(csv.rows(valid).length,501);
  assert.throws(()=>csv.rows(valid+'\n500,An'),/500/);
  assert.throws(()=>csv.rows(valid+'\n'+Array.from({length:5000},()=>',').join('\n')+'\n500,An'),/500/);
});
test('[UT-ADMINCSV-009] import size is measured in UTF8 bytes and accepts the exact 2 MB boundary',()=>{
  const exact='id\n'+'é'.repeat((csv.MAX_BYTES-4)/2)+'a';
  assert.equal(Buffer.byteLength(exact),csv.MAX_BYTES);
  assert.equal(csv.rows(exact)[1][0],exact.slice(3));
  assert.throws(()=>csv.rows(exact+'a'),/2 MB/);
  assert.throws(()=>csv.rows('id\n'+'x'.repeat(csv.MAX_BYTES)),/2 MB/);
});
test('[UT-ADMINCSV-010] CSV export uses BOM CRLF quoted Unicode cells lists and stable first object columns',()=>{
  const trips=[{id:'0001',name:'Nguyễn "An", Bình',pickupPoints:['Văn phòng','Bến xe'],active:true},{id:'0002',name:'Khách\nB',pickupPoints:[],active:false}];
  const output=csv.stringify(trips);
  assert.ok(output.startsWith('\uFEFF"id","name","pickupPoints","active"\r\n'));
  assert.match(output,/"Nguyễn ""An"", Bình"/);
  assert.deepEqual(csv.rows(output),[['id','name','pickupPoints','active'],['0001','Nguyễn "An", Bình','Văn phòng|Bến xe','true'],['0002','Khách\nB','','false']]);
});
test('[UT-ADMINCSV-011] exported spreadsheet formula prefixes including leading whitespace are neutralized',()=>{
  const dangerous=['=1+1','+SUM(1)','-1+2','@SUM(1)','  =HYPERLINK("https://example.invalid")','\tplain','\rplain','\n  @SUM(1)'];
  for(const value of dangerous)assert.equal(csv.rows(csv.stringify([{id:'001',value}]))[1][1],"'"+value);
  assert.equal(csv.rows(csv.stringify([{id:'001',value:'Văn phòng A'}]))[1][1],'Văn phòng A');
  assert.equal(csv.rows(csv.stringify([{'=header':'safe'}]))[0][0],"'=header");
});
test('[UT-ADMINCSV-012] missing browser Papa is isolated to CSV calls and malformed export data is rejected',()=>{
  const context=vm.createContext({TextEncoder});
  vm.runInContext(fs.readFileSync(require.resolve('../../public/admin/schedule-csv'),'utf8'),context);
  assert.equal(typeof context.TicketScheduleCSV.rows,'function');
  assert.throws(()=>context.TicketScheduleCSV.rows('id,name\n001,An'),/Thư viện CSV.*JSON/);
  assert.throws(()=>context.TicketScheduleCSV.stringify([{id:'001'}]),/Thư viện CSV.*JSON/);
  for(const invalid of [null,[],['text'],[{}],[{id:'001'},null]])assert.throws(()=>csv.stringify(invalid));
});
