const C=require('./core');

async function readAll(table,columns){
 const rows=[],pageSize=1000;
 for(let from=0;;from+=pageSize){
  const {data,error}=await C.supabase().from(table).select(columns).range(from,from+pageSize-1);
  if(error)throw error;
  rows.push(...(data||[]));
  if((data||[]).length<pageSize)break;
 }
 return rows;
}

async function deletionTarget(input){
 const mode=String(input.mode||(input.cutoffEmpty?'cutoffEmpty':input.all?'all':input.date?(input.includeReserved?'dayAll':'dayEmpty'):''));
 if(!['cutoffEmpty','all','dayEmpty','dayAll'].includes(mode))throw Object.assign(Error('삭제 범위가 올바르지 않습니다.'),{status:400});
 const date=String(input.date||'');
 if((mode==='dayEmpty'||mode==='dayAll')&&!C.validDate(date))throw Object.assign(Error('삭제할 날짜가 올바르지 않습니다.'),{status:400});
 const [all,reservations,cutoff]=await Promise.all([
  readAll('interview_slots','id,starts_at,ends_at'),
  readAll('reservations','slot_id'),
  mode==='cutoffEmpty'?C.getCutoff():Promise.resolve(null)
 ]);
 const occupied=new Set((reservations||[]).map(x=>x.slot_id)),today=C.kstDate(),limit=Date.now()+(Number(cutoff)||0)*3600000;
 const targets=(all||[]).filter(slot=>{
  if(mode==='all')return true;
  if(mode==='dayAll')return C.kstDate(slot.starts_at)===date;
  if(mode==='dayEmpty')return C.kstDate(slot.starts_at)===date&&!occupied.has(slot.id);
  return !occupied.has(slot.id)&&new Date(slot.starts_at).getTime()<=limit&&C.kstDate(slot.starts_at)<=today;
 });
 const reservationCount=targets.reduce((n,x)=>n+(occupied.has(x.id)?1:0),0);
 const kind={cutoffEmpty:'cutoff_empty',all:'all',dayEmpty:'day_empty',dayAll:'day_all'}[mode];
 return {mode,kind,date:date||null,cutoffHours:cutoff,targets,reservationCount,emptyCount:targets.length-reservationCount};
}

function targetResponse(target){
 const sorted=[...target.targets].sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at));
 return {
  mode:target.mode,date:target.date,cutoffHours:target.cutoffHours,
  slotCount:sorted.length,reservationCount:target.reservationCount,emptyCount:target.emptyCount,
  firstStartsAt:sorted[0]?.starts_at||null,lastStartsAt:sorted.at(-1)?.starts_at||null
 };
}

async function archive(target,label){
 const ids=target.targets.map(x=>x.id);
 if(!ids.length)return {batchId:null,deletedCount:0,reservationCount:0};
 const {data,error}=await C.supabase().rpc('archive_and_delete_interview_slots',{p_slot_ids:ids,p_kind:target.kind,p_label:label||null});
 if(error)throw error;
 return data||{batchId:null,deletedCount:0,reservationCount:0};
}

async function preview(req,res){
 try{
  if(!C.requireAdmin(req,res))return;
  if(req.method!=='POST')return C.json(res,405,{error:'허용되지 않은 요청입니다.'});
  const target=await deletionTarget(C.body(req)||{});
  return C.json(res,200,targetResponse(target));
 }catch(e){
  if(e.status===400)return C.json(res,400,{error:e.message});
  C.fail(res,e);
 }
}

async function trash(req,res){
 if(!C.requireAdmin(req,res))return;
 if(req.method!=='POST')return C.json(res,405,{error:'허용되지 않은 요청입니다.'});
 const id=String((C.body(req)||{}).batchId||'');
 if(!C.UUID_RE.test(id))return C.json(res,400,{error:'복구할 삭제 기록이 올바르지 않습니다.'});
 try{
  const {data,error}=await C.supabase().rpc('restore_interview_slot_deletion',{p_batch_id:id});
  if(error)throw error;
  return C.json(res,200,{ok:true,...data});
 }catch(e){
  console.error(e);
  return C.json(res,409,{error:'복구할 수 없습니다. 이미 복구됐거나 같은 시간·지원자의 현재 예약과 충돌하는지 확인해주세요.'});
 }
}

async function slots(req,res){try{
 if(!C.requireAdmin(req,res))return;
 const b=C.body(req)||{};
 if(req.method==='POST'){
  const from=String(b.dateFrom||b.startDate||b.date||''),to=String(b.dateTo||b.endDate||b.date||''),start=String(b.start||''),end=String(b.end||''),minutes=Number(b.minutes),location=String(b.location||'AI공학관').trim()||'AI공학관';
  if(!C.validDate(from)||!C.validDate(to)||!C.TIME_RE.test(start)||!C.TIME_RE.test(end)||!Number.isInteger(minutes)||minutes<1||minutes>180||location.length>200)return C.json(res,400,{error:'입력값을 확인해주세요.'});
  const dates=C.listDates(from,to);if(!dates.length||dates.length>90)return C.json(res,400,{error:'생성 기간은 최대 90일까지 설정할 수 있습니다.'});
  const a=C.toMinutes(start),z=C.toMinutes(end);if(a>=z||z-a<minutes)return C.json(res,400,{error:'시작/종료 시간을 확인해주세요.'});
  const rows=[];for(const date of dates)for(let t=a;t+minutes<=z;t+=minutes)rows.push({starts_at:C.isoKst(date,t),ends_at:C.isoKst(date,t+minutes),location});
  if(!rows.length||rows.length>3000)return C.json(res,400,{error:'한 번에 생성할 수 있는 슬롯은 최대 3,000개입니다.'});
  const {error}=await C.supabase().from('interview_slots').insert(rows);if(error)throw error;
  return C.json(res,200,{ok:true,count:rows.length,dayCount:dates.length});
 }
 if(req.method==='PATCH'){
  if(!C.UUID_RE.test(String(b.id||'')))return C.json(res,400,{error:'면접 시간 정보가 올바르지 않습니다.'});
  const patch={};if(Object.prototype.hasOwnProperty.call(b,'note'))patch.note=String(b.note||'').trim()||null;if(Object.prototype.hasOwnProperty.call(b,'location'))patch.location=String(b.location||'').trim()||'AI공학관';
  if(!Object.keys(patch).length)return C.json(res,400,{error:'수정할 내용이 없습니다.'});
  if((patch.note&&patch.note.length>200)||(patch.location&&patch.location.length>200))return C.json(res,400,{error:'입력값이 너무 깁니다.'});
  const {data,error}=await C.supabase().from('interview_slots').update(patch).eq('id',b.id).select('id,note,location').maybeSingle();if(error)throw error;
  if(!data)return C.json(res,404,{error:'면접 시간을 찾을 수 없습니다.'});
  return C.json(res,200,{ok:true,...data,location:data.location||'AI공학관'});
 }
 if(req.method==='DELETE'){
  if(b.cutoffEmpty||b.all||b.date){
   const target=await deletionTarget(b),hasExpectedSlots=Object.prototype.hasOwnProperty.call(b,'expectedSlotCount'),hasExpectedReservations=Object.prototype.hasOwnProperty.call(b,'expectedReservationCount'),expectedSlots=Number(b.expectedSlotCount),expectedReservations=Number(b.expectedReservationCount);
   if((hasExpectedSlots&&!Number.isInteger(expectedSlots))||(hasExpectedReservations&&!Number.isInteger(expectedReservations)))return C.json(res,400,{error:'삭제 확인 정보가 올바르지 않습니다.'});
   if((hasExpectedSlots&&expectedSlots!==target.targets.length)||(hasExpectedReservations&&expectedReservations!==target.reservationCount))return C.json(res,409,{error:'미리보기 이후 슬롯 또는 예약이 변경되었습니다. 삭제 대상을 다시 확인해주세요.'});
   const result=await archive(target,target.date);
   return C.json(res,200,{ok:true,...result});
  }
  if(!C.UUID_RE.test(String(b.id||'')))return C.json(res,400,{error:'면접 시간 정보가 올바르지 않습니다.'});
  const slot=await C.targetSlot(b.id);if(!slot)return C.json(res,404,{error:'면접 시간을 찾을 수 없습니다.'});
  const {data:r,error:re}=await C.supabase().from('reservations').select('id').eq('slot_id',b.id).maybeSingle();if(re)throw re;
  if(r&&new Date(slot.ends_at).getTime()<Date.now())return C.json(res,409,{error:'면접자가 있는 지난 슬롯은 면접 기록으로 유지되어 삭제할 수 없습니다.'});
  const target={kind:'single',targets:[slot]},result=await archive(target,C.kstDate(slot.starts_at));
  return C.json(res,200,{ok:true,...result});
 }
 return C.json(res,405,{error:'허용되지 않은 요청입니다.'});
}catch(e){if(e.status===400)return C.json(res,400,{error:e.message});C.fail(res,e)}}

async function reservation(req,res){try{if(!C.requireAdmin(req,res))return;if(req.method!=='POST')return C.json(res,405,{error:'허용되지 않은 요청입니다.'});const b=C.body(req)||{},appId=String(b.applicantId||''),slotId=b.slotId==null||b.slotId===''?null:String(b.slotId);if(!C.UUID_RE.test(appId)||(slotId&&!C.UUID_RE.test(slotId)))return C.json(res,400,{error:'예약 정보가 올바르지 않습니다.'});const {data:app,error:ae}=await C.supabase().from('applicants').select('id').eq('id',appId).maybeSingle();if(ae)throw ae;if(!app)return C.json(res,404,{error:'지원자를 찾을 수 없습니다.'});if(!slotId){const {error}=await C.supabase().from('reservations').delete().eq('applicant_id',appId);if(error)throw error;return C.json(res,200,{ok:true,slotId:null})}const slot=await C.targetSlot(slotId);if(!slot)return C.json(res,404,{error:'면접 시간을 찾을 수 없습니다.'});const {data:occupied,error:oe}=await C.supabase().from('reservations').select('applicant_id').eq('slot_id',slotId).maybeSingle();if(oe)throw oe;if(occupied&&occupied.applicant_id!==appId)return C.json(res,409,{error:'이미 다른 지원자가 예약한 시간입니다.'});const {data:existing,error:ee}=await C.supabase().from('reservations').select('id').eq('applicant_id',appId).maybeSingle();if(ee)throw ee;if(existing){const {error}=await C.supabase().from('reservations').update({slot_id:slotId}).eq('applicant_id',appId);if(error)throw error}else{const {error}=await C.supabase().from('reservations').insert({applicant_id:appId,slot_id:slotId});if(error)throw error}return C.json(res,200,{ok:true,slotId})}catch(e){C.fail(res,e)}}

module.exports={slots,reservation,preview,trash};
