const applicant=require('../lib/applicant');
const basic=require('../lib/admin-basic');
const admin=require('../lib/admin-slots');
module.exports=async function(req,res){
  const u=new URL(req.url,'https://x');
  const p=u.pathname.replace(/^\/api/,'')||'/';
  const routes={
    '/login':applicant.login,'/logout':applicant.logout,'/reservations':applicant.reservations,
    '/admin/login':basic.login,'/admin/logout':basic.logout,'/admin/overview':basic.overview,
    '/admin/applicants':basic.applicants,'/admin/settings':basic.settings,
    '/admin/slots':admin.slots,'/admin/reservation':admin.reservation,
    '/admin/slots-preview':admin.preview,'/admin/slot-trash':admin.trash
  };
  const fn=routes[p];
  if(!fn){res.statusCode=404;res.setHeader('Content-Type','application/json; charset=utf-8');return res.end(JSON.stringify({error:'API를 찾을 수 없습니다.'}));}
  return fn(req,res);
};
