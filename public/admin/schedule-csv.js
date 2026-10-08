(function(root,factory) {
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory(()=>require('papaparse'));
  else root.TicketScheduleCSV=factory(()=>root.Papa);
})(typeof globalThis==='object'?globalThis:this,function(getPapa) {
  'use strict';
  const MAX_BYTES=2*1024*1024,MAX_TRIPS=500,DELIMITERS=[',',';','\t'];
  function library() {
    const papa=getPapa();
    if(!papa||typeof papa.parse!=='function'||typeof papa.unparse!=='function')throw new Error('Thư viện CSV chưa tải được. Vui lòng tải lại trang hoặc dùng tệp JSON.');
    return papa;
  }
  // Papa accepts quotes inside unquoted cells. Enforce the existing import
  // syntax and remove only the whitespace surrounding a quoted cell.
  function strictQuotes(text,delimiter) {
    let quoted=false,closed=false,nonWhitespace=false,fieldStart=0,last=0;
    const parts=[];
    function remove(start,end) {if(end>start){parts.push(text.slice(last,start));last=end;}}
    for(let index=0;index<text.length;index++) {
      const char=text[index];
      if(quoted) {
        if(char==='"') {
          if(text[index+1]==='"')index++;
          else {quoted=false;closed=true;fieldStart=index+1;}
        }
        continue;
      }
      if(char===delimiter||char==='\r'||char==='\n') {
        if(closed)remove(fieldStart,index);
        closed=false;nonWhitespace=false;fieldStart=index+1;
      } else if(closed) {
        if(!/\s/.test(char))throw new Error('CSV có nội dung thừa sau dấu nháy đóng.');
      } else if(char==='"') {
        if(nonWhitespace)throw new Error('CSV có dấu nháy sai vị trí. Dùng hai dấu nháy để viết dấu nháy trong một ô.');
        remove(fieldStart,index);quoted=true;
      } else if(!/\s/.test(char))nonWhitespace=true;
    }
    if(quoted)throw new Error('CSV có dấu nháy chưa đóng.');
    if(closed)remove(fieldStart,text.length);
    parts.push(text.slice(last));
    return parts.join('');
  }
  function rows(text) {
    if(typeof text!=='string'||!text.trim())throw new Error('Chọn tệp hoặc dán dữ liệu lịch trình trước.');
    if(text.length>MAX_BYTES||new TextEncoder().encode(text).length>MAX_BYTES)throw new Error('Dữ liệu quá lớn. Mỗi đợt nhập tối đa 2 MB.');
    text=text.replace(/^\uFEFF/,'');
    const papa=library(),config={header:false,dynamicTyping:false,skipEmptyLines:'greedy'};
    const detectionText=text.replace(/^(?:(?:[^\S\r\n]|[,;])*(?:\r\n|\r|\n))+/,'');
    const detected=papa.parse(detectionText,{...config,preview:MAX_TRIPS+2,delimitersToGuess:DELIMITERS});
    const delimiter=DELIMITERS.includes(detected.meta?.delimiter)?detected.meta.delimiter:',';
    const data=[];let tooMany=false,parseError=false;
    papa.parse(strictQuotes(text,delimiter),{...config,delimiter,step(result,parser) {
      if(result.errors?.length) {parseError=true;parser.abort();return;}
      data.push(result.data);
      if(data.length>MAX_TRIPS+1) {tooMany=true;parser.abort();}
    }});
    if(parseError)throw new Error('CSV chưa hợp lệ. Kiểm tra dấu nháy và dấu phân cách các cột.');
    if(!Array.isArray(data)||data.length<2)throw new Error('CSV cần có tiêu đề và ít nhất một chuyến.');
    if(tooMany)throw new Error('Mỗi đợt nhập cần từ 1 đến 500 chuyến.');
    const headers=data[0].map(header=>header.trim());
    if(headers.some(header=>!header)||new Set(headers).size!==headers.length)throw new Error('CSV có tên cột trống hoặc trùng nhau.');
    for(let index=1;index<data.length;index++)if(data[index].length!==headers.length)throw new Error(`Dòng ${index+1}: số cột không khớp tiêu đề.`);
    return data;
  }
  function stringify(trips) {
    if(!Array.isArray(trips)||!trips.length||trips.some(trip=>!trip||typeof trip!=='object'||Array.isArray(trip)))throw new Error('Cần danh sách dữ liệu để xuất CSV.');
    const fields=Object.keys(trips[0]),headers=fields.map(field=>field.trim());
    if(!fields.length||headers.some(header=>!header)||new Set(headers).size!==headers.length)throw new Error('CSV có tên cột trống hoặc trùng nhau.');
    const data=trips.map(trip=>fields.map(field=>String(Array.isArray(trip[field])?trip[field].join('|'):trip[field]??'')));
    return '\uFEFF'+library().unparse({fields,data},{delimiter:',',newline:'\r\n',quotes:true,escapeFormulae:/^[\s\uFEFF]*[=+\-@]|^[\t\r]/});
  }
  return Object.freeze({rows,stringify,MAX_BYTES,MAX_TRIPS});
});
