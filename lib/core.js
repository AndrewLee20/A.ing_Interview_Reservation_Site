const {createClient}=require('@supabase/supabase-js');
const {createHmac,createHash,timingSafeEqual}=require('node:crypto');
const APPLICANT_COOKIE='__Host-interview_session',ADMIN_COOKIE='__Host-interview_admin';
const APPLICANT_SESSION_SECONDS=60*60*4,ADMIN_SESSION_SECONDS=60*60*2;
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/,TIME_RE=/^(?:[01]\d|2[0-3]):[0-5]\d$/;let db=null;
function supabase(){if(db)return db;const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;if(!url||!key)throw Error('Supabase env missing');db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});return db}
function json(res,status,data){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data))}
function body(req){if(req.body&&typeof req.body==='object'&&!Buffer.isBuffer(req.body))return req.body;if(Buffer.isBuffer(req.body)){try{return JSON.parse(req.body.toString('utf8'))}catch{return null}}if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return null}}return null}
function parseCookies(req){const out={};for(const item of String(req.headers.cookie||'').split(';')){const i=item.indexOf('=');if(i>0)out[item.slice(0,i).trim()]=decodeURIComponent(item.slice(i+1).trim())}return out}
function appendCookie(res,value){const old=res.getHeader('Set-Cookie');res.setHeader('Set-Cookie',old?[].concat(old,value):value)}
function setCookie(res,name,value,maxAge){appendCookie(res,`${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`)}
function clearCookie(res,name){appendCookie(res,`${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`)}
function sessionSecret(){const s=process.env.SESSION_SECRET;if(!s)throw Error('SESSION_SECRET missing');return s}
function sign(payload){return createHmac('sha256',sessionSecret()).update(payload).digest('base64url')}
function safeEqual(a,b){const aa=Buffer.from(String(a)),bb=Buffer.from(String(b));return aa.length===bb.length&&timingSafeEqual(aa,bb)}
function makeSession(type,subject,seconds){const exp=Math.floor(Date.now()/1000)+seconds,p=`${type}.${subject}.${exp}`;return `${p}.${sign(p)}`}
function readSession(value,type){if(!value)return null;const [t,subject,exp,sig]=String(value).split('.');if(t!==type||!subject||!exp||!sig)return null;const p=`${t}.${subject}.${exp}`;if(!safeEqual(sign(p),sig))return null;const e=Number(exp);if(!Number.isSafeInteger(e)||e<Math.floor(Date.now()/1000))return null;return subject}
function applicantId(req){return readSession(parseCookies(req)[APPLICANT_COOKIE],'applicant')}
function isAdmin(req){return readSession(parseCookies(req)[ADMIN_COOKIE],'admin')==='admin'}
function setApplicantSession(res,id){setCookie(res,APPLICANT_COOKIE,makeSession('applicant',id,APPLICANT_SESSION_SECONDS),APPLICANT_SESSION_SECONDS)}
function clearApplicantSession(res){clearCookie(res,APPLICANT_COOKIE)}
function setAdminSession(res){setCookie(res,ADMIN_COOKIE,makeSession('admin','admin',ADMIN_SESSION_SECONDS),ADMIN_SESSION_SECONDS)}
function clearAdminSession(res){clearCookie(res,ADMIN_COOKIE)}
function normalizeName(v){return String(v??'').normalize('NFKC').replace(/\s+/g,' ').trim()}
function hashLast4(last4){const secret=process.env.IDENTITY_PEPPER||process.env.SESSION_SECRET;if(!secret)throw Error('IDENTITY_PEPPER missing');return createHmac('sha256',secret).update(`phone-last4:${last4}`).digest('hex')}
function safeSecretEqual(a,b){const aa=createHash('sha256').update(String(a)).digest(),bb=createHash('sha256').update(String(b)).digest();return timingSafeEqual(aa,bb)}
function validDate(v){if(!DATE_RE.test(v))return false;const [y,m,d]=v.split('-').map(Number),x=new Date(Date.UTC(y,m-1,d));return x.getUTCFullYear()===y&&x.getUTCMonth()===m-1&&x.getUTCDate()===d}
function toMinutes(t){const [h,m]=String(t).split(':').map(Number);return h*60+m}
function isoKst(date,total){const h=String(Math.floor(total/60)).padStart(2,'0'),m=String(total%60).padStart(2,'0');return `${date}T${h}:${m}:00+09:00`}
function listDates(from,to){const out=[],a=new Date(from+'T00:00:00Z'),b=new Date(to+'T00:00:00Z');for(let d=new Date(a);d<=b;d.setUTCDate(d.getUTCDate()+1))out.push(d.toISOString().slice(0,10));return out}
function kstDate(value=Date.now()){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value)),one=t=>parts.find(x=>x.type===t)?.value;return `${one('year')}-${one('month')}-${one('day')}`}
function isLocked(startsAt,hours){const h=Number(hours)||0;return h>0&&Date.now()>=new Date(startsAt).getTime()-h*3600000}
async function getCutoff(){const {data,error}=await supabase().from('booking_settings').select('cutoff_hours').eq('id',true).maybeSingle();if(error)throw error;return Number.isInteger(data?.cutoff_hours)?data.cutoff_hours:24}
async function targetSlot(slotId){if(!UUID_RE.test(String(slotId||'')))return null;const {data,error}=await supabase().from('interview_slots').select('id,starts_at,ends_at,note,location').eq('id',slotId).maybeSingle();if(error)throw error;return data}
async function currentReservation(appId){const {data:r,error:e}=await supabase().from('reservations').select('id,slot_id').eq('applicant_id',appId).maybeSingle();if(e)throw e;if(!r)return null;const s=await targetSlot(r.slot_id);return s?{...r,slot:s}:null}
function requireAdmin(req,res){if(!isAdmin(req)){json(res,401,{error:'관리자 로그인이 필요합니다.'});return false}return true}
function fail(res,e){console.error(e);json(res,500,{error:'서버 오류가 발생했습니다.'})}
module.exports={supabase,json,body,UUID_RE,TIME_RE,applicantId,isAdmin,setApplicantSession,clearApplicantSession,setAdminSession,clearAdminSession,normalizeName,hashLast4,safeSecretEqual,validDate,toMinutes,isoKst,listDates,kstDate,isLocked,getCutoff,targetSlot,currentReservation,requireAdmin,fail};
