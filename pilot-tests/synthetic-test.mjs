import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require=createRequire(join(process.env.MAILFLARE_CHECKOUT,'package.json'));
const Database=require('better-sqlite3');
const bcrypt=require('bcryptjs');
const nodemailer=require('nodemailer');
const {SMTPServer}=require('smtp-server');
const dataDir=process.env.PILOT_DATA_DIR;
const results=join(dataDir,'results.json');
import { spawnSync } from 'node:child_process';
const base='http://127.0.0.1:3317';
function maintenance(phase,job=''){const r=spawnSync('python',[process.env.MAILFLARE_CLEANUP_BRIDGE,join(dataDir,'mailflare.sqlite'),join(dataDir,'retention.sqlite'),phase,...(job?[job]:[])],{encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);return JSON.parse(r.stdout);}
const db=new Database(join(dataDir,'mailflare.sqlite'));
const report=[];
function pass(name,evidence){report.push({name,status:'pass',evidence});console.log('PASS',name);writeFileSync(results,JSON.stringify(report,null,2));}
async function req(path,token,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data={text:text.slice(0,150)}}return {status:r.status,data};}
const creds=JSON.parse(readFileSync(join(dataDir,'credentials.json')));
const login=await req('/api/auth/login',null,creds);assert.equal(login.status,200,JSON.stringify(login.data));const owner=login.data.token;
const otherPassword=randomBytes(20).toString('hex');
db.prepare("INSERT OR IGNORE INTO users(id,email,password_hash,name,role,created_at) VALUES (?,?,?,?,?,?)").run('usr_pilot_other','other@pilot.example.test',bcrypt.hashSync(otherPassword,12),'Synthetic Other','user',Math.floor(Date.now()/1000));
db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(otherPassword,12),'usr_pilot_other');
const otherLogin=await req('/api/auth/login',null,{email:'other@pilot.example.test',password:otherPassword});assert.equal(otherLogin.status,200);const other=otherLogin.data.token;
const mb=db.prepare('SELECT * FROM mailboxes LIMIT 1').get();
assert.equal((await req('/api/messages')).status,401);assert.equal((await req('/api/messages','invalid')).status,401);pass('unauthenticated and invalid-session list denied','401');
assert.equal((await req('/api/auth/register',null,{...creds,domain:'other.example.test',username:'intruder'})).status,403);pass('first-run registration closes','403 after first admin');
const sinkMessages=[];const sink=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],onRcptTo(address,session,cb){cb(address.address==='sender@example.test'?undefined:new Error('Pilot recipient only'));},onData(stream,session,cb){const chunks=[];stream.on('data',x=>chunks.push(x));stream.on('end',()=>{sinkMessages.push(Buffer.concat(chunks).toString());cb();});}});await new Promise(resolve=>sink.listen(2528,'127.0.0.1',resolve));
try{
 const smtp=nodemailer.createTransport({host:'127.0.0.1',port:2527,secure:false,ignoreTLS:true});
 const marker='TREVELLUM-PILOT-'+randomBytes(6).toString('hex');
 await smtp.sendMail({from:'sender@example.test',to:creds.email,subject:marker,text:marker+' synthetic delivery only',messageId:'<'+marker+'@example.test>',attachments:[{filename:'synthetic.txt',content:marker+' attachment'}]});
 let msg,attachment;for(let i=0;i<40;i++){msg=db.prepare('SELECT * FROM messages WHERE subject=?').get(marker);if(msg){attachment=db.prepare('SELECT * FROM message_attachments WHERE message_id=?').get(msg.id);if(attachment)break;}await new Promise(r=>setTimeout(r,250));}
 assert.ok(msg,'inbound stored');assert.ok(attachment,'attachment stored');
 const ownerRead=await req('/api/messages/'+msg.id,owner);assert.equal(ownerRead.status,200);assert.ok(JSON.stringify(ownerRead.data).includes(marker));pass('SMTP inbound, parsed content and attachment stored','real local SMTP intake and owner API read');
 for(const path of ['/api/messages?mailboxId='+mb.id,'/api/messages/'+msg.id,'/api/messages/'+msg.id+'/original','/api/messages/'+msg.id+'/attachments/'+attachment.id]){const r=await req(path,other);assert.ok([403,404].includes(r.status),path+':'+r.status);}pass('cross-user list, detail, raw MIME and attachment denied','403/404 for a second authenticated user');
 assert.equal((await req('/api/messages/bulk',other,{messageIds:[msg.id],action:'trash'})).status,404);pass('cross-user destructive action denied','404 and original retained');
 const sendBody={from:creds.email,to:['sender@example.test'],mailboxId:mb.id,subject:'Re: '+marker,text:'Synthetic reply '+marker,inReplyTo:msg.provider_message_id,references:[msg.provider_message_id],threadId:msg.thread_id,undoSend:false};
 const denied=await req('/api/send',other,sendBody);assert.ok(denied.status>=400);pass('cross-user sending denied',String(denied.status));
 const reply=await req('/api/send',owner,sendBody);assert.equal(reply.status,200,JSON.stringify(reply.data));assert.equal(sinkMessages.length,1);assert.ok(sinkMessages[0].includes('Synthetic reply'));assert.match(sinkMessages[0],/In-Reply-To:/i);pass('reply delivered to isolated SMTP recipient','reply body and In-Reply-To received by local sink');
 const job=db.prepare('SELECT id,payload,status FROM outbound_jobs WHERE message_id=?').get(reply.data.messageId);
 const fork=process.env.MAILFLARE_TEST_FORK==='1';
 if(fork){
  assert.equal(job.status,'sent');assert.equal(job.payload,'{}');
  const retained=db.prepare('SELECT text_body FROM messages WHERE id=?').get(reply.data.messageId);
  assert.ok(retained.text_body.includes(marker));
  assert.equal(db.prepare("SELECT metadata FROM audit_logs WHERE message_id=? AND action='email.send'").get(reply.data.messageId).metadata,'{}');
  pass('successful send drops duplicate content while preserving support history','message body retained; job and audit content empty');
  const failed=await req('/api/send',owner,{from:creds.email,mailboxId:mb.id,to:['rejected@example.test'],subject:'Synthetic rejected send',text:'Synthetic failure evidence',undoSend:false});
  assert.ok(failed.status>=400);
  const uncertain=db.prepare("SELECT payload FROM outbound_jobs WHERE status='failed'").all();
  assert.ok(uncertain.some(x=>x.payload.includes('Synthetic failure evidence')));
  pass('failed delivery retains reconciliation payload','isolated SMTP recipient rejection');
  // A provider-accepted send can still fail during bookkeeping. Do not erase it.
  db.exec(`CREATE TRIGGER pilot_reject_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action='email.send' AND EXISTS(
      SELECT 1 FROM messages WHERE id=NEW.message_id AND subject='Synthetic audit failure')
    BEGIN SELECT RAISE(ABORT,'synthetic bookkeeping failure'); END`);
  try{
   const acceptedBeforeFailure=await req('/api/send',owner,{from:creds.email,mailboxId:mb.id,to:['sender@example.test'],subject:'Synthetic audit failure',text:'Synthetic uncertain evidence',undoSend:false});
   assert.ok(acceptedBeforeFailure.status>=400);
   assert.equal(sinkMessages.length,2);
   assert.ok(db.prepare("SELECT payload FROM outbound_jobs WHERE status='failed'").all().some(x=>x.payload.includes('Synthetic uncertain evidence')));
   pass('provider-accepted bookkeeping failure preserves reconciliation payload','sink received mail; audit write rejected; payload retained');
  }finally{db.exec('DROP TRIGGER pilot_reject_audit');}
  db.exec(`CREATE TRIGGER pilot_reject_cleanup BEFORE UPDATE OF payload ON outbound_jobs
    WHEN NEW.payload='{}' AND OLD.payload LIKE '%Synthetic cleanup failure%'
    BEGIN SELECT RAISE(ABORT,'synthetic cleanup failure'); END`);
  try{
   const cleanupFailure=await req('/api/send',owner,{from:creds.email,mailboxId:mb.id,to:['sender@example.test'],subject:'Synthetic cleanup failure',text:'Synthetic cleanup evidence',undoSend:false});
   assert.ok(cleanupFailure.status>=400);
   assert.equal(sinkMessages.length,3);
   assert.ok(db.prepare("SELECT payload FROM outbound_jobs WHERE status='sent'").all().some(x=>x.payload.includes('Synthetic cleanup evidence')));
   pass('cleanup failure cannot demote or replay a successful send','sent status and original payload survive failed minimization');
  }finally{db.exec('DROP TRIGGER pilot_reject_cleanup');}
 }else maintenance('enroll',job.id);
 const ids=[msg.id,reply.data.messageId];const all=db.prepare('SELECT id,raw_r2_key FROM messages WHERE id IN (?,?)').all(...ids);const paths=[...all.map(x=>x.raw_r2_key).filter(Boolean),attachment.r2_key];
 const guard=await req('/api/messages/bulk',owner,{messageIds:ids,action:'delete'});assert.equal(guard.data.deleted,0);pass('permanent deletion requires Trash or Spam','active messages skipped');
 assert.equal((await req('/api/messages/bulk',owner,{messageIds:ids,action:'trash'})).status,200);
 const purge=await req('/api/messages/bulk',owner,{messageIds:ids,action:'delete'});assert.equal(purge.data.deleted,2,JSON.stringify(purge));
 assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE id IN (?,?)').get(...ids).n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=?').get(msg.id).n,0);
 for(const p of paths)assert.equal(existsSync(join(dataDir,'blobs',p)),false,p);
 const search=await req('/api/messages?q='+marker,owner);assert.equal(search.status,200);assert.ok(!JSON.stringify(search.data).includes(marker));assert.equal((await req('/api/messages/'+msg.id,owner)).status,404);
 pass('permanent deletion removes messages, attachments, raw objects and search results','two synthetic messages; previous direct URL returns 404');
 if(!fork)pass('separate cleanup dry-run, apply and idempotent repeat',maintenance('apply'));
 assert.equal(db.prepare('SELECT payload FROM outbound_jobs WHERE id=?').get(job.id).payload,'{}');
 assert.equal(db.prepare("SELECT count(*) n FROM audit_logs WHERE metadata LIKE ?").get('%'+marker+'%').n,0);
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();const residual=[];
 for(const {name} of tables){try{const rows=db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all();const count=rows.filter(r=>JSON.stringify(r).includes(marker)).length;if(count)residual.push({table:name,rows:count});}catch{}}
 assert.ok(residual.every(x=>x.table==='jmap_changes'),JSON.stringify(residual));report.push({name:'only bounded JMAP identifiers remain',status:'pass',evidence:residual});writeFileSync(results,JSON.stringify(report,null,2));console.log('RESIDUAL',JSON.stringify(residual));
}finally{await new Promise(r=>sink.close(r));db.close();}
