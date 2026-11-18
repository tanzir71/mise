import {Buffer} from 'node:buffer';
/** Browser/visual fixture only. Every Auth response is intercepted on a .test host. */
export async function installPhoneAuthFixture(page,options={}){
 const base='https://cloud.test',calls=[],subject='00000000-0000-4000-8000-000000000001',phone=options.phone??'+8801712345482';
 const b=v=>Buffer.from(JSON.stringify(v)).toString('base64url'),access=[b({alg:'HS256',typ:'JWT'}),b({sub:subject,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000)}),'synthetic-browser-signature'].join('.');
 const user={id:subject,aud:'authenticated',role:'authenticated',phone:phone.slice(1),phone_confirmed_at:new Date().toISOString(),created_at:new Date().toISOString(),app_metadata:{provider:'phone'},user_metadata:{},is_anonymous:false};
 const session={access_token:access,refresh_token:'synthetic-browser-refresh',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,token_type:'bearer',user};
 await page.route(base+'/auth/v1/**',async route=>{const request=route.request(),url=new URL(request.url()),path=url.pathname.split('/').at(-1);if(request.method()==='OPTIONS'){await route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'*'}});return;}
  const body=request.postData()?JSON.parse(request.postData()):{};calls.push({path,method:request.method(),body});let result={},status=200;
  if(path==='settings')result={external:{phone:options.phoneEnabled!==false,email:false},disable_signup:false,phone_autoconfirm:false};
  else if(path==='otp'){status=options.otpStatus??200;result=status===200?{message_id:'synthetic'}:{error_code:'over_sms_send_rate_limit',msg:'PRIVATE SERVICE DETAILS'};}
  else if(path==='verify'){status=options.verifyStatus??200;result=status===200?session:{error_code:'otp_expired',msg:'PRIVATE SERVICE DETAILS'};}
  else if(path==='user')result=user;else if(path==='token')result=session;else if(path!=='logout')throw Error('Unexpected browser Auth request');
  await route.fulfill({status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'},body:JSON.stringify(result)});
 });return {calls,phone,subject};
}
