'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseSearchQuery,normalizeSearchText,literalSearchPattern,validSearchDate,availableSeatsQuery} = require('../../server/search');

const invalid = error => error.status === 400;

test('[UT-SEARCH-001] recognized query fields require one scalar value and never accept repeated or structured values',() => {
  for (const field of ['from','to','date','operator','type','minPrice','maxPrice','time','sort','page','limit','q','pickup','dropoff','available']) {
    for (const value of [['first','second'],{},null,1,true]) assert.throws(() => parseSearchQuery({[field]:value}),invalid,field);
    assert.throws(() => parseSearchQuery({[field+'[]']:'value'}),invalid,field);
    assert.throws(() => parseSearchQuery({[field+'.value']:'value'}),invalid,field);
    assert.throws(() => parseSearchQuery({[field]:'value\0'}),invalid,field);
  }
});

test('[UT-SEARCH-002] supported time and sort enums are closed against prototype names and invalid casing',() => {
  for (const time of ['constructor','__proto__','toString','MORNING','invalid']) assert.throws(() => parseSearchQuery({time}),invalid);
  for (const sort of ['constructor','__proto__','descending','PRICE']) assert.throws(() => parseSearchQuery({sort}),invalid);
  for (const time of ['morning','afternoon','evening','night']) assert.equal(parseSearchQuery({time}).time,time);
  for (const sort of ['price','departure','rating']) assert.equal(parseSearchQuery({sort}).sort,sort);
});

test('[UT-SEARCH-003] dates accept real leap days and reject normalization or timestamp inputs',() => {
  for (const value of ['2028-02-29','2000-02-29','2026-12-31']) assert.equal(validSearchDate(value),true);
  for (const value of ['2026-02-29','2100-02-29','2028-02-30','2026-04-31','2026-1-01','2026-01-01T00:00:00Z']) {
    assert.equal(validSearchDate(value),false);assert.throws(() => parseSearchQuery({date:value}),invalid);
  }
  assert.equal(parseSearchQuery({},{defaultDate:'2028-02-29'}).date,'2028-02-29');
  assert.equal(parseSearchQuery({date:' '},{defaultDate:'2028-02-29'}).date,'2028-02-29');
  assert.equal(parseSearchQuery({}).date,undefined);
});

test('[UT-SEARCH-004] fare bounds accept zero, equivalent finite decimals and equality but reject inverted or nonnumeric ranges',() => {
  assert.equal(parseSearchQuery({minPrice:'0',maxPrice:'0'}).minPrice,0);
  assert.equal(parseSearchQuery({minPrice:'1e5',maxPrice:'100000.0'}).maxPrice,100000);
  assert.equal(parseSearchQuery({minPrice:'.5'}).minPrice,.5);
  for (const minPrice of ['-1','NaN','Infinity','1e999','0x10','1money','--1']) assert.throws(() => parseSearchQuery({minPrice}),invalid);
  assert.throws(() => parseSearchQuery({minPrice:'300000',maxPrice:'100000'}),invalid);
});

test('[UT-SEARCH-005] paging requires positive integral values and caps valid large values without coercing malformed input',() => {
  assert.deepEqual(Object.fromEntries(['page','limit'].map(key => [key,parseSearchQuery({})[key]])),{page:1,limit:20});
  for (const value of ['0','-1','1.5','2garbage','1e2','9007199254740992']) {
    assert.throws(() => parseSearchQuery({page:value}),invalid);assert.throws(() => parseSearchQuery({limit:value}),invalid);
  }
  const result=parseSearchQuery({page:'100000',limit:'1000'});assert.equal(result.page,10000);assert.equal(result.limit,100);
});

test('[UT-SEARCH-006] availability is optional and accepts only explicit true or false',() => {
  assert.equal(parseSearchQuery({available:'true'}).available,true);
  assert.equal(parseSearchQuery({available:'false'}).available,false);
  assert.equal(parseSearchQuery({available:''}).available,undefined);
  for (const value of ['0','1','yes','TRUE']) assert.throws(() => parseSearchQuery({available:value}),invalid);
});

test('[UT-SEARCH-007] blank filter resets preserve defaults while contradictory locations, invalid vehicle types and oversized text fail',() => {
  const result=parseSearchQuery({from:' ho-chi-minh ',to:'da-lat',q:' ',type:'',page:'',mode:'roundtrip'},{defaultDate:'2028-02-29'});
  assert.equal(result.from,'ho-chi-minh');assert.equal(result.q,undefined);assert.equal(result.page,1);assert.equal(result.mode,undefined);
  assert.throws(() => parseSearchQuery({from:'da-lat',to:'da-lat'}),invalid);
  assert.throws(() => parseSearchQuery({type:'bus'}),invalid);
  assert.throws(() => parseSearchQuery({q:'x'.repeat(101)}),invalid);
  assert.throws(() => parseSearchQuery({operator:'x'.repeat(201)}),invalid);
  assert.equal(parseSearchQuery({q:'x'.repeat(100)}).q.length,100);
  for (const type of ['cabin','sleeper','seater','limousine']) assert.equal(parseSearchQuery({type}).type,type);
});

test('[UT-SEARCH-008] Vietnamese search treats accents, case and canonical Unicode encodings equivalently without joining separate words',() => {
  for (const value of ['ĐÀ NẴNG','Đà Nẵng'.normalize('NFD'),'da nang']) assert.equal(normalizeSearchText(value),'da nang');
  assert.equal(normalizeSearchText('BẾN XE – CỔNG 1'),'ben xe – cong 1');
  assert.equal(normalizeSearchText('đường đón trả'),'duong don tra');
  assert.equal(normalizeSearchText(null),'');
});

test('[UT-SEARCH-009] literal LIKE patterns escape user wildcards and their own escape character',() => {
  assert.equal(literalSearchPattern('50%_!'),'%'+'50!%!_!!'+'%');
  assert.equal(literalSearchPattern('Đà Nẵng'),'%'+'da nang'+'%');
  assert.equal(literalSearchPattern('A\\B'),'%'+'a\\b'+'%');
});

test('[UT-SEARCH-010] inventory query binds each inclusive price band instead of embedding user input in SQL',() => {
  for (const dialect of ['sqlite','postgres']) {
    const query=availableSeatsQuery('SELECT * FROM trips',{minPrice:123456,maxPrice:654321,available:true},dialect);
    assert.deepEqual(query.params,[123456,654321,123456,654321]);
    assert.ok(!query.sql.includes('123456') && !query.sql.includes('654321'));
    assert.equal(availableSeatsQuery('SELECT * FROM trips',{},dialect).params.length,0);
    assert.deepEqual(availableSeatsQuery('SELECT * FROM trips',{maxPrice:0,available:false},dialect).params,[0,0]);
  }
});

test('[UT-SEARCH-011] validation preserves the caller object and uses the API validation error contract',() => {
  const source={q:' Đà Nẵng ',limit:'2',minPrice:'100000'};
  parseSearchQuery(source);assert.deepEqual(source,{q:' Đà Nẵng ',limit:'2',minPrice:'100000'});
  assert.throws(() => parseSearchQuery({time:'invalid'},{fail(status,message){const error=new Error(message);error.status=status;throw error;}}),invalid);
});
