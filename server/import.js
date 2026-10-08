"use strict";

// Small RFC 4180 parser for a bounded operator import. Quotes and embedded newlines
// are handled without evaluating content; every resulting field is then validated.
function parseCsv(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text,'utf8')>1000000) throw new Error('CSV cần là văn bản UTF-8 không quá 1 MB.');
  const rows=[]; let row=[],field='',quoted=false,closedQuote=false;
  const input=text.replace(/^\uFEFF/,'');
  for (let i=0;i<input.length;i++) {
    const c=input[i];
    if (closedQuote && c!==',' && c!=='\n' && c!=='\r') throw new Error('CSV có ký tự không hợp lệ sau dấu ngoặc kép đóng.');
    if (c === '"') {
      if (quoted && input[i+1] === '"') {field+='"';i++;}
      else if (quoted) {quoted=false;closedQuote=true;}
      else if (field === '') quoted=true;
      else throw new Error('CSV có dấu ngoặc kép không hợp lệ.');
    } else if (c === ',' && !quoted) {row.push(field);field='';closedQuote=false;}
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && input[i+1] === '\n') i++;
      row.push(field);if (row.some(value => value.trim())) rows.push(row);row=[];field='';closedQuote=false;
    } else field+=c;
    if (rows.length>501 || field.length>10000) throw new Error('CSV vượt quá 500 chuyến hoặc có ô quá dài.');
  }
  if (quoted) throw new Error('CSV thiếu dấu ngoặc kép đóng.');
  row.push(field); if (row.some(value => value.trim())) rows.push(row);
  if (rows.length>501) throw new Error('CSV vượt quá 500 chuyến hoặc có ô quá dài.');
  if (rows.length<2) throw new Error('CSV cần hàng tiêu đề và ít nhất một chuyến.');
  const headers=rows.shift().map(value => value.trim());
  const allowed=['operatorId','from','to','date','departureTime','durationMinutes','price','totalSeats','type','pickupPoints','dropoffPoints','amenities','policies','seatPrices'];
  if (new Set(headers).size !== headers.length || headers.some(h => !allowed.includes(h))) throw new Error('Tiêu đề CSV trùng hoặc không được hỗ trợ.');
  for (const required of ['operatorId','from','to','date','departureTime','durationMinutes','price','type']) if (!headers.includes(required)) throw new Error('CSV thiếu cột '+required+'.');
  return rows.map((values,index) => {
    if (values.length !== headers.length) throw new Error('Dòng '+(index+2)+' có số cột không khớp.');
    const trip=Object.fromEntries(headers.map((header,i) => [header,values[i].trim()]));
    for (const field of ['durationMinutes','price','totalSeats']) if (trip[field] !== undefined && trip[field] !== '') trip[field]=Number(trip[field]); else delete trip[field];
    for (const field of ['pickupPoints','dropoffPoints','amenities','policies']) if (trip[field]) trip[field]=trip[field].split('|').map(x => x.trim()).filter(Boolean); else delete trip[field];
    if (trip.seatPrices) {try {trip.seatPrices=JSON.parse(trip.seatPrices);} catch {throw new Error('Dòng '+(index+2)+': seatPrices phải là JSON hợp lệ.');}} else delete trip.seatPrices;
    return trip;
  });
}

module.exports={parseCsv};
