'use strict';

const {busTypes} = require('./catalog');

const times = Object.freeze({morning:['06:00','12:00'],afternoon:['12:00','18:00'],evening:['18:00','24:00'],night:['00:00','06:00']});
const fields = ['from','to','date','operator','type','minPrice','maxPrice','time','sort','page','limit','q','pickup','dropoff','available'];

function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();
}
function literalSearchPattern(value) {
  return '%' + normalizeSearchText(value).replace(/[!%_]/g,character => '!' + character) + '%';
}
function validSearchDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z'))
    && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
}
function parseSearchQuery(query, {defaultDate, fail} = {}) {
  const invalid = message => {
    if (fail) fail(400,message);
    const error = new Error(message); error.status = 400; throw error;
  };
  const result = {};
  // Express's simple query parser keeps bracket syntax as a literal key. Reject
  // it too, rather than silently dropping an attempted structured filter.
  for (const key of Object.keys(query)) {
    if (fields.some(field => key.startsWith(field+'[') || key.startsWith(field+'.'))) invalid('Tham số tìm kiếm cần có một giá trị duy nhất.');
  }
  for (const field of fields) {
    const value = query[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') invalid('Tham số ' + field + ' cần có một giá trị duy nhất.');
    if (value.includes('\0')) invalid('Tham số ' + field + ' chứa ký tự không hợp lệ.');
    const trimmed = value.trim();
    if (trimmed.length > (['q','pickup','dropoff'].includes(field) ? 100 : 200)) invalid('Tham số ' + field + ' quá dài.');
    if (trimmed) result[field] = trimmed;
  }
  result.date ??= defaultDate;
  if (result.date && !validSearchDate(result.date)) invalid('Ngày đi không hợp lệ.');
  if (result.from && result.from === result.to) invalid('Điểm đi và điểm đến phải khác nhau.');
  if (result.type && !busTypes.some(type => type.id === result.type)) invalid('Loại xe không hợp lệ.');
  if (result.time && !Object.hasOwn(times,result.time)) invalid('Khoảng giờ không hợp lệ.');
  if (result.sort && !['departure','price','rating'].includes(result.sort)) invalid('Thứ tự sắp xếp không hợp lệ.');
  result.sort ??= 'departure';
  for (const field of ['minPrice','maxPrice']) {
    if (result[field] === undefined) continue;
    const value = Number(result[field]);
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(result[field]) || !Number.isFinite(value) || value < 0) invalid('Khoảng giá không hợp lệ.');
    result[field] = value;
  }
  if (result.minPrice !== undefined && result.maxPrice !== undefined && result.minPrice > result.maxPrice) invalid('Giá thấp nhất cần nhỏ hơn hoặc bằng giá cao nhất.');
  for (const [field,defaultValue,maximum] of [['page',1,10000],['limit',20,100]]) {
    if (result[field] === undefined) { result[field] = defaultValue; continue; }
    if (!/^\d+$/.test(result[field]) || !Number.isSafeInteger(Number(result[field])) || Number(result[field]) < 1) invalid('Tham số ' + field + ' phải là số nguyên dương.');
    result[field] = Math.min(maximum,Number(result[field]));
  }
  if (result.available !== undefined) {
    if (!['true','false'].includes(result.available)) invalid('Bộ lọc còn chỗ cần là true hoặc false.');
    result.available = result.available === 'true';
  }
  return result;
}

// PostgreSQL's normalize() requires UTF8, which is also required by our catalog.
// Fold Vietnamese letters before LOWER so LC_CTYPE=C behaves like SQLite.
function normalizedTextSql(expression,dialect) {
  return dialect === 'postgres'
    ? "LOWER(TRANSLATE(REGEXP_REPLACE(normalize(" + expression + ",NFD),'[\u0300-\u036f]','','g'),'Đđ','Dd'))"
    : 'vi_search(' + expression + ')';
}
function tripTextSql(key,dialect) {
  const array = field => dialect === 'postgres'
    ? "COALESCE((SELECT STRING_AGG(value,' ') FROM jsonb_array_elements_text(COALESCE(t.data::jsonb->'" + field + "','[]'::jsonb)) AS text_values(value)),'')"
    : "COALESCE((SELECT GROUP_CONCAT(value,' ') FROM json_each(t.data,'$." + field + "')),'')";
  const scalar = field => dialect === 'postgres' ? "COALESCE(t.data::jsonb->>'" + field + "','')" : "COALESCE(json_extract(t.data,'$." + field + "'),'')";
  if (key !== 'q') return array(key === 'pickup' ? 'pickupPoints' : 'dropoffPoints');
  const stops = dialect === 'postgres'
    ? "COALESCE((SELECT STRING_AGG(COALESCE(value->>'name','') || ' ' || COALESCE(value->>'address',''),' ') FROM jsonb_array_elements(COALESCE(t.data::jsonb->'stops','[]'::jsonb)) AS stop_values(value)),'')"
    : "COALESCE((SELECT GROUP_CONCAT(COALESCE(json_extract(value,'$.name'),'') || ' ' || COALESCE(json_extract(value,'$.address'),''),' ') FROM json_each(t.data,'$.stops')),'')";
  return '(' + [array('pickupPoints'),array('dropoffPoints'),array('amenities'),stops,...['operatorName','fromName','toName','typeName'].map(scalar),'o.name'].join(" || ' ' || ") + ')';
}
function ratingSql(expression,dialect) {
  return dialect === 'postgres' ? "COALESCE((" + expression + "::jsonb->>'rating')::numeric,0)" : "COALESCE(CAST(json_extract(" + expression + ",'$.rating') AS REAL),0)";
}

function availableSeatsQuery(candidateSql,query,dialect) {
  const half = '(t.total_seats+1)/2';
  const doubleDeck = "t.type IN ('sleeper','cabin')";
  const validLabel = dialect === 'postgres' ? "p.key ~ '^[AB][0-9]{2}$'" : "p.key GLOB '[AB][0-9][0-9]'";
  const number = '(CASE WHEN ' + validLabel + ' THEN CAST(SUBSTR(p.key,2) AS INTEGER) ELSE 0 END)';
  const labelLimit = '(CASE WHEN ' + doubleDeck + " THEN CASE WHEN SUBSTR(p.key,1,1)='A' THEN " + half + ' ELSE t.total_seats-' + half + " END ELSE CASE WHEN SUBSTR(p.key,1,1)='A' THEN t.total_seats ELSE 0 END END)";
  const overrideSource = dialect === 'postgres'
    ? "jsonb_each(COALESCE(t.data::jsonb->'seatPrices','{}'::jsonb)) p"
    : "json_each(t.data,'$.seatPrices') p";
  const price = dialect === 'postgres' ? 'CAST(p.value::text AS INTEGER)' : 'p.value';
  const conditions = [], params = [];
  for (const [field,operator] of [['minPrice','>='],['maxPrice','<=']]) if (query[field] !== undefined) { conditions.push('seat_price' + operator + 'CAST(? AS NUMERIC)'); params.push(query[field]); }
  const inRange = conditions.join(' AND ') || '1=1';
  const filters = [];
  if (conditions.length) filters.push('COALESCE(i.matching_seats,0)>0');
  if (query.available !== undefined) filters.push('COALESCE(i.available_count,0)' + (query.available ? '>0' : '=0'));
  return {
    // Most seats use the base fare. Expand only explicit overrides, not every
    // physical seat in every catalog trip; carry base seats as a weighted row.
    sql: 'WITH candidate_trips AS (' + candidateSql + '), free_overrides AS ('
      + 'SELECT t.id,' + price + ' AS seat_price FROM candidate_trips t CROSS JOIN ' + overrideSource + ' WHERE ' + number + '>0 AND ' + number + '<=' + labelLimit
      + ' AND NOT EXISTS(SELECT 1 FROM reserved_seats rs WHERE rs.trip_id=t.id AND rs.seat=p.key)'
      + ' AND NOT EXISTS(SELECT 1 FROM hold_seats hs WHERE hs.trip_id=t.id AND hs.seat=p.key)), override_counts AS ('
      + 'SELECT id,COUNT(*) AS n FROM free_overrides GROUP BY id), free_seats AS ('
      + 'SELECT t.id,t.price AS seat_price,t.total_seats-t.reserved_count-t.held_count-COALESCE(c.n,0) AS seat_count FROM candidate_trips t LEFT JOIN override_counts c ON c.id=t.id'
      + ' WHERE t.total_seats-t.reserved_count-t.held_count-COALESCE(c.n,0)>0 UNION ALL SELECT id,seat_price,1 AS seat_count FROM free_overrides), seat_summary AS ('
      + 'SELECT id,SUM(seat_count) AS available_count,MIN(seat_price) AS min_available_price,MAX(seat_price) AS max_available_price,'
      + 'SUM(CASE WHEN ' + inRange + ' THEN seat_count ELSE 0 END) AS matching_seats,MIN(CASE WHEN ' + inRange + ' THEN seat_price END) AS display_price FROM free_seats GROUP BY id), searched_trips AS ('
      + 'SELECT t.*,COALESCE(i.available_count,0) AS available_count,i.min_available_price,i.max_available_price,COALESCE(i.matching_seats,0) AS matching_seats,i.display_price FROM candidate_trips t LEFT JOIN seat_summary i ON i.id=t.id'
      + (filters.length ? ' WHERE ' + filters.join(' AND ') : '') + ') ',
    params: [...params,...params],
  };
}

module.exports = {times,normalizeSearchText,literalSearchPattern,validSearchDate,parseSearchQuery,normalizedTextSql,tripTextSql,ratingSql,availableSeatsQuery};
