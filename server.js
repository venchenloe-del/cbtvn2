const express=require('express');
const session=require('express-session');
const Database=require('better-sqlite3');
const bcrypt=require('bcryptjs');
const multer=require('multer');
const XLSX=require('xlsx');
const path=require('path');
const fs=require('fs');
const crypto=require('crypto');
const EventEmitter=require('events');
const QRCode=require('./vendor/qrcode');
const QRErrorCorrectLevel=require('./vendor/qrcode/QRErrorCorrectLevel');

const app=express();
const PORT=Number(process.env.PORT||60696),HOST=process.env.HOST||'0.0.0.0';
const db=new Database(path.join(__dirname,'data/cbt.sqlite'));
db.pragma('journal_mode=WAL');
db.pragma('foreign_keys=ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','guru','siswa')),nis TEXT UNIQUE,class_name TEXT,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS subjects(id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL,name TEXT NOT NULL,duration_minutes INTEGER DEFAULT 45,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS questions(id INTEGER PRIMARY KEY AUTOINCREMENT,subject_id INTEGER NOT NULL,type TEXT DEFAULT 'single',text TEXT NOT NULL,options_json TEXT NOT NULL,correct_json TEXT NOT NULL,points REAL DEFAULT 1,image_path TEXT,explanation TEXT,difficulty TEXT DEFAULT 'medium',tags TEXT,status TEXT DEFAULT 'ready',updated_at INTEGER,FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS schedules(id INTEGER PRIMARY KEY AUTOINCREMENT,subject_id INTEGER NOT NULL,name TEXT NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,shuffle_questions INTEGER DEFAULT 1,shuffle_options INTEGER DEFAULT 1,active INTEGER DEFAULT 1,FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS schedule_questions(schedule_id INTEGER NOT NULL,question_id INTEGER NOT NULL,PRIMARY KEY(schedule_id,question_id),FOREIGN KEY(schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,subject_id INTEGER NOT NULL,schedule_id INTEGER,started_at INTEGER NOT NULL,finished_at INTEGER,score REAL DEFAULT 0,correct_count INTEGER DEFAULT 0,wrong_count INTEGER DEFAULT 0,answers_json TEXT DEFAULT '{}',FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(subject_id) REFERENCES subjects(id),FOREIGN KEY(schedule_id) REFERENCES schedules(id));
`);

try{db.prepare("ALTER TABLE users ADD COLUMN cbt_locked INTEGER DEFAULT 0").run()}catch(e){}
try{db.prepare("ALTER TABLE users ADD COLUMN cbt_lock_reason TEXT").run()}catch(e){}
try{db.prepare("ALTER TABLE attempts ADD COLUMN status TEXT DEFAULT 'active'").run()}catch(e){}
try{db.prepare("ALTER TABLE attempts ADD COLUMN violation_reason TEXT").run()}catch(e){}
try{db.prepare("ALTER TABLE attempts ADD COLUMN violation_at INTEGER").run()}catch(e){}
try{db.prepare("ALTER TABLE schedules ADD COLUMN allow_repeat INTEGER DEFAULT 0").run()}catch(e){}
try{db.prepare("ALTER TABLE schedules ADD COLUMN question_selection_mode INTEGER DEFAULT 0").run()}catch(e){}

// Migration aman untuk database V3 lama.
const userCols=db.prepare('PRAGMA table_info(users)').all().map(x=>x.name);
if(!userCols.includes('nisn')) db.exec('ALTER TABLE users ADD COLUMN nisn TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nisn_unique ON users(nisn) WHERE nisn IS NOT NULL AND trim(nisn)<>\'\'');
// Migrasi Bank Soal: kompatibel dengan database lama tanpa menghapus data.
const questionCols=db.prepare('PRAGMA table_info(questions)').all().map(x=>x.name);
const addQuestionCol=(name,definition)=>{if(!questionCols.includes(name))db.exec(`ALTER TABLE questions ADD COLUMN ${definition}`);};
addQuestionCol('image_path','image_path TEXT');
addQuestionCol('explanation','explanation TEXT');
addQuestionCol('difficulty',"difficulty TEXT DEFAULT 'medium'");
addQuestionCol('tags','tags TEXT');
addQuestionCol('status',"status TEXT DEFAULT 'ready'");
addQuestionCol('updated_at','updated_at INTEGER');
db.exec("UPDATE questions SET difficulty='medium' WHERE difficulty IS NULL OR trim(difficulty)=''");
db.exec("UPDATE questions SET status='ready' WHERE status IS NULL OR trim(status)=''");
const questionUploadDir=path.join(__dirname,'public','uploads','questions');
fs.mkdirSync(questionUploadDir,{recursive:true});


// Pastikan kolom fitur CBT terbaru tersedia pada database lama tanpa menghapus data.
function ensureColumn(table,column,definition){
  const cols=db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);
  if(!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}
// Fitur Kartu Login: password kartu terenkripsi, bukan plaintext di database.
try{ ensureColumn('users','card_password_enc','card_password_enc TEXT'); }catch(e){}
try{ ensureColumn('users','nipd','nipd TEXT'); }catch(e){}
const cardUploadDir=path.join(__dirname,'public','uploads','cards');
fs.mkdirSync(cardUploadDir,{recursive:true});
const cardCryptoKey=crypto.createHash('sha256').update(process.env.SESSION_SECRET||'ubah-secret-cbt').digest();
function encryptCardPassword(value){
  const iv=crypto.randomBytes(12);
  const c=crypto.createCipheriv('aes-256-gcm',cardCryptoKey,iv);
  const enc=Buffer.concat([c.update(String(value),'utf8'),c.final()]);
  return [iv.toString('base64url'),c.getAuthTag().toString('base64url'),enc.toString('base64url')].join('.');
}
function decryptCardPassword(value){
  try{const [ivS,tagS,dataS]=String(value||'').split('.');if(!ivS||!tagS||!dataS)return '';const d=crypto.createDecipheriv('aes-256-gcm',cardCryptoKey,Buffer.from(ivS,'base64url'));d.setAuthTag(Buffer.from(tagS,'base64url'));return d.update(Buffer.from(dataS,'base64url'))+d.final('utf8')}catch{return ''}
}
function makeCardPassword(){return crypto.randomBytes(5).toString('base64url').replace(/[^A-Za-z0-9]/g,'').slice(0,8).toUpperCase()||'CBT2026';}
try{
  ensureColumn('users','cbt_locked','cbt_locked INTEGER DEFAULT 0');
  ensureColumn('users','cbt_lock_reason','cbt_lock_reason TEXT');
  ensureColumn('attempts','status',"status TEXT DEFAULT 'active'");
  ensureColumn('attempts','violation_reason','violation_reason TEXT');
  ensureColumn('attempts','violation_at','violation_at INTEGER');
  ensureColumn('attempts','essay_score','essay_score REAL DEFAULT 0');
  ensureColumn('attempts','essay_graded','essay_graded INTEGER DEFAULT 0');
  ensureColumn('attempts','essay_grades_json',"essay_grades_json TEXT DEFAULT '{}'");
}catch(e){
  console.error('[CBTVEN] Gagal menyiapkan kolom CBT:',e.message);
}

// Normalisasi data CBT lama agar database dari versi sebelumnya tetap kompatibel.
try{
  db.exec("UPDATE users SET cbt_locked=0 WHERE cbt_locked IS NULL");
  db.exec("UPDATE attempts SET status='active' WHERE status IS NULL OR trim(status)=''");
}catch(e){
  console.error('[CBTVEN] Gagal menormalisasi status CBT:',e.message);
}

const getS=k=>db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setS=(k,v)=>db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v));
if(!getS('school_name'))setS('school_name','Nama Sekolah');
if(!getS('app_name'))setS('app_name','Portal CBT Ujian Online');
if(!getS('logo_text'))setS('logo_text','CBT');
if(!getS('card_exam_type'))setS('card_exam_type','UJIAN BERBASIS KOMPUTER');
if(!getS('card_exam_date'))setS('card_exam_date','');
if(!getS('card_header1'))setS('card_header1',getS('school_name')||'NAMA SEKOLAH');
if(!getS('card_header2'))setS('card_header2','Portal CBT Ujian Online');
if(!getS('card_address'))setS('card_address','');
if(!getS('card_login_url'))setS('card_login_url','');
if(!getS('card_head_name'))setS('card_head_name','');
if(!getS('card_head_nip'))setS('card_head_nip','');
if(!getS('card_sign_place_date'))setS('card_sign_place_date','');
if(!getS('card_header3'))setS('card_header3','TAHUN PELAJARAN 2025/2026');
if(!getS('card_logo'))setS('card_logo','');
if(!getS('card_signature'))setS('card_signature','');
if(!getS('card_stamp'))setS('card_stamp','');

if(!db.prepare('SELECT COUNT(*) c FROM users').get().c){
 const q=db.prepare('INSERT INTO users(username,password_hash,name,role,nis,class_name) VALUES(?,?,?,?,?,?)');
 q.run('admin',bcrypt.hashSync('adminpassword',10),'Administrator','admin',null,null);
 q.run('guru',bcrypt.hashSync('gurupassword',10),'Guru Demo','guru',null,null);
 q.run('1001',bcrypt.hashSync('123',10),'Budi Santoso','siswa','1001','XII-IPA-1');
 q.run('1002',bcrypt.hashSync('123',10),'Siti Aminah','siswa','1002','XII-IPA-1');
}
if(!db.prepare('SELECT COUNT(*) c FROM subjects').get().c){
 const s=db.prepare('INSERT INTO subjects(code,name,duration_minutes) VALUES(?,?,?)');
 const id=s.run('MTK-XII','Matematika IPA',45).lastInsertRowid;s.run('BIN-XII','Bahasa Indonesia',30);
 const q=db.prepare('INSERT INTO questions(subject_id,type,text,options_json,correct_json,points) VALUES(?,?,?,?,?,?)');
 q.run(id,'single','Berapakah hasil 2 + 3?',JSON.stringify(['3','4','5','6','7']),JSON.stringify([2]),1);
 q.run(id,'single','Akar x² - 5x + 6 = 0 adalah...',JSON.stringify(['1 dan 6','2 dan 3','-2 dan -3','0 dan 5','1 dan 5']),JSON.stringify([1]),1);
}

// ===== Session multi-user stabil =====
// Setiap HP/PC mendapat session sendiri. Session disimpan di SQLite agar tidak
// bergantung pada MemoryStore dan tetap stabil saat banyak siswa login bersamaan.
class SQLiteSessionStore extends session.Store {
  constructor(database){
    super();
    this.db=database;
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL)`);
    this.getStmt=this.db.prepare('SELECT sess, expire FROM sessions WHERE sid=?');
    this.setStmt=this.db.prepare('INSERT INTO sessions(sid,sess,expire) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expire=excluded.expire');
    this.destroyStmt=this.db.prepare('DELETE FROM sessions WHERE sid=?');
    this.touchStmt=this.db.prepare('UPDATE sessions SET sess=?, expire=? WHERE sid=?');
    this.pruneStmt=this.db.prepare('DELETE FROM sessions WHERE expire <= ?');
    this.lastPrune=0;
  }
  _prune(){
    const nowMs=Date.now();
    if(nowMs-this.lastPrune>60000){this.pruneStmt.run(nowMs);this.lastPrune=nowMs;}
  }
  get(sid,cb){try{this._prune();const row=this.getStmt.get(sid);if(!row)return cb(null,null);if(row.expire<=Date.now()){this.destroyStmt.run(sid);return cb(null,null);}const sess=JSON.parse(row.sess);if(sess.cookie&&sess.cookie.expires)sess.cookie.expires=new Date(sess.cookie.expires);cb(null,sess);}catch(e){cb(e);}}
  set(sid,sess,cb){try{this._prune();const copy={...sess,cookie:{...sess.cookie}};const expire=copy.cookie&&copy.cookie.expires?new Date(copy.cookie.expires).getTime():Date.now()+8*60*60*1000;this.setStmt.run(sid,JSON.stringify(copy),expire);if(cb)cb(null);}catch(e){if(cb)cb(e);}}
  destroy(sid,cb){try{this.destroyStmt.run(sid);if(cb)cb(null);}catch(e){if(cb)cb(e);}}
  touch(sid,sess,cb){try{const copy={...sess,cookie:{...sess.cookie}};const expire=copy.cookie&&copy.cookie.expires?new Date(copy.cookie.expires).getTime():Date.now()+8*60*60*1000;this.touchStmt.run(JSON.stringify(copy),expire,sid);if(cb)cb(null);}catch(e){if(cb)cb(e);}}
}

app.use(express.json({limit:'15mb'}));
app.use(express.urlencoded({extended:true}));
app.use(session({
  store:new SQLiteSessionStore(db),
  name:'cbtven.sid',
  secret:process.env.SESSION_SECRET||'ubah-secret-cbt',
  resave:false,
  saveUninitialized:false,
  rolling:true,
  cookie:{httpOnly:true,sameSite:'lax',maxAge:8*60*60*1000}
}));
// Jangan biarkan browser memakai HTML/JS lama setelah update aplikasi.
app.use((req,res,next)=>{if(req.path==='/'||req.path==='/index.html')res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');next();});
app.use(express.static(path.join(__dirname,'public')));

const auth=(req,res,next)=>req.session.user?next():res.status(401).json({error:'Belum login'});
const staff=(req,res,next)=>req.session.user&&['admin','guru'].includes(req.session.user.role)?next():res.status(403).json({error:'Akses ditolak'});
const admin=(req,res,next)=>req.session.user?.role==='admin'?next():res.status(403).json({error:'Khusus admin'});
const now=()=>Date.now();
// Admin-only consistent SQLite backup. better-sqlite3 backup API includes committed WAL data.
app.get('/api/admin/backup',admin,async(req,res)=>{
 try{
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const filename=`CBTVEN_backup_${stamp}.sqlite`;
  const tmp=path.join(require('os').tmpdir(),filename);
  await db.backup(tmp);
  res.download(tmp,filename,err=>{try{fs.unlinkSync(tmp)}catch{};if(err&&!res.headersSent)res.status(500).end('Gagal mengunduh backup')});
 }catch(e){console.error('[CBTVEN] backup:',e);res.status(500).json({error:'Backup gagal: '+e.message})}
});
// Admin-only restore: validate uploaded SQLite, create safety backup, replace DB, then restart process.
const restoreUpload=multer({dest:path.join(require('os').tmpdir(),'cbtven-restore'),limits:{fileSize:100*1024*1024},fileFilter:(req,file,cb)=>cb(null,/\.(sqlite|db)$/i.test(file.originalname))});
app.post('/api/admin/restore',admin,restoreUpload.single('backup'),async(req,res)=>{
 let uploaded=req.file?.path;
 try{
  if(!uploaded) return res.status(400).json({error:'Pilih file backup .sqlite atau .db terlebih dahulu.'});
  const fd=fs.openSync(uploaded,'r');const magic=Buffer.alloc(16);fs.readSync(fd,magic,0,16,0);fs.closeSync(fd);
  if(magic.toString('binary')!=='SQLite format 3\u0000') throw Error('File bukan database SQLite yang valid.');
  const test=new Database(uploaded,{readonly:true,fileMustExist:true});
  try{
   const integrity=test.pragma('integrity_check',{simple:true});
   if(integrity!=='ok') throw Error('Pemeriksaan integritas database gagal.');
   const names=test.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
   for(const required of ['users','subjects','questions','attempts','settings']) if(!names.includes(required)) throw Error('Backup tidak cocok dengan CBTVEN: tabel '+required+' tidak ditemukan.');
  }finally{test.close()}
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const dbPath=path.join(__dirname,'data','cbt.sqlite');
  const safety=path.join(__dirname,'data',`cbt_before_restore_${stamp}.sqlite`);
  await db.backup(safety);
  // Close current connection before replacing database file (including WAL sidecars).
  db.close();
  for(const suffix of ['-wal','-shm']){try{fs.unlinkSync(dbPath+suffix)}catch{}}
  fs.copyFileSync(uploaded,dbPath);
  res.json({ok:true,message:'Restore berhasil. Database sebelum restore disimpan sebagai '+path.basename(safety)+'. Server akan dimulai ulang; jika tidak otomatis, jalankan kembali aplikasi CBTVEN.'});
  setTimeout(()=>process.exit(0),800);
 }catch(e){console.error('[CBTVEN] restore:',e);if(!res.headersSent)res.status(400).json({error:'Restore gagal: '+e.message});}
 finally{if(uploaded){try{fs.unlinkSync(uploaded)}catch{}}}
});
const safe=u=>({id:u.id,username:u.username,name:u.name,role:u.role,nis:u.nis,nisn:u.nisn,class_name:u.class_name,cbt_locked:!!u.cbt_locked});
const clean=v=>String(v??'').trim();

app.get('/api/config',(req,res)=>res.json({school_name:getS('school_name'),app_name:getS('app_name'),logo_text:getS('logo_text'),card_exam_type:getS('card_exam_type'),card_exam_date:getS('card_exam_date'),card_header1:getS('card_header1'),card_header2:getS('card_header2'),card_header3:getS('card_header3'),card_address:getS('card_address'),card_login_url:getS('card_login_url'),card_head_name:getS('card_head_name'),card_head_nip:getS('card_head_nip'),card_sign_place_date:getS('card_sign_place_date'),card_logo:getS('card_logo'),card_signature:getS('card_signature'),card_stamp:getS('card_stamp')}));
app.post('/api/login',(req,res)=>{
 const login=clean(req.body.username),password=String(req.body.password||'');
 const u=db.prepare('SELECT * FROM users WHERE (username=? OR nis=? OR nisn=?) AND active=1 LIMIT 1').get(login,login,login);
 if(!u||!bcrypt.compareSync(password,u.password_hash))return res.status(401).json({error:'Username/NIS/NISN atau password salah'});
 if(u.role==='siswa'&&Number(u.cbt_locked))return res.status(423).json({error:'Akun siswa sedang dikunci oleh sistem/admin. Hubungi admin untuk mengaktifkan kembali login.'});
 req.session.user=safe(u);res.json({user:req.session.user});
});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/me',(req,res)=>res.json({user:req.session.user||null}));

// ===== Siswa =====
app.get('/api/students',staff,(req,res)=>res.json(db.prepare("SELECT id,username,name,nis,nipd,nisn,class_name,active FROM users WHERE role='siswa' ORDER BY name").all()));
app.get('/api/classes',staff,(req,res)=>res.json(db.prepare("SELECT DISTINCT trim(class_name) class_name FROM users WHERE role='siswa' AND class_name IS NOT NULL AND trim(class_name)<>'' ORDER BY class_name").all().map(x=>x.class_name)));
app.post('/api/students',staff,(req,res)=>{
 const {username,password,name,nis,nipd,nisn,class_name,active}=req.body;
 if(!clean(username)||!password||!clean(name)||!clean(nis))return res.status(400).json({error:'Nama, username, NIS, password wajib'});
 try{const id=db.prepare('INSERT INTO users(username,password_hash,name,role,nis,nipd,nisn,class_name,active) VALUES(?,?,?,?,?,?,?,?,?)').run(clean(username),bcrypt.hashSync(String(password),10),clean(name),'siswa',clean(nis),clean(nipd),clean(nisn)||null,clean(class_name),active===false?0:1).lastInsertRowid;res.json({id});}
 catch(e){res.status(400).json({error:e.message.includes('nisn')?'NISN sudah digunakan':'Username/NIS sudah digunakan'});}
});
app.put('/api/students/:id',staff,(req,res)=>{
 const u=db.prepare("SELECT * FROM users WHERE id=? AND role='siswa'").get(req.params.id);if(!u)return res.status(404).json({error:'Siswa tidak ditemukan'});
 const {username,name,nis,nipd,nisn,class_name,active,password}=req.body;
 if(!clean(username)||!clean(name)||!clean(nis))return res.status(400).json({error:'Username, nama dan NIS wajib'});
 try{db.prepare('UPDATE users SET username=?,name=?,nis=?,nipd=?,nisn=?,class_name=?,active=? WHERE id=?').run(clean(username),clean(name),clean(nis),clean(nipd),clean(nisn)||null,clean(class_name),active?1:0,u.id);if(password)db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(password),10),u.id);res.json({ok:true});}
 catch(e){res.status(400).json({error:e.message.includes('nisn')?'NISN sudah digunakan':'Username/NIS sudah digunakan'});}
});

// ===== Guru & Admin =====
app.get('/api/staff',admin,(req,res)=>res.json(db.prepare("SELECT id,username,name,role,active FROM users WHERE role IN ('admin','guru') ORDER BY role,name").all()));
app.post('/api/staff',admin,(req,res)=>{const {username,password,name,role,active}=req.body;if(!clean(username)||!password||!clean(name)||!['admin','guru'].includes(role))return res.status(400).json({error:'Data guru/admin belum lengkap'});try{const id=db.prepare('INSERT INTO users(username,password_hash,name,role,active) VALUES(?,?,?,?,?)').run(clean(username),bcrypt.hashSync(String(password),10),clean(name),role,active===false?0:1).lastInsertRowid;res.json({id});}catch(e){res.status(400).json({error:'Username sudah digunakan'});}});
app.put('/api/staff/:id',admin,(req,res)=>{const u=db.prepare('SELECT * FROM users WHERE id=? AND role IN (\'admin\',\'guru\')').get(req.params.id);if(!u)return res.status(404).json({error:'Akun tidak ditemukan'});const {username,name,role,active,password}=req.body;if(!clean(username)||!clean(name)||!['admin','guru'].includes(role))return res.status(400).json({error:'Data belum lengkap'});if(u.role==='admin'&&role!=='admin'&&db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c<=1)return res.status(400).json({error:'Minimal harus ada satu admin aktif'});try{db.prepare('UPDATE users SET username=?,name=?,role=?,active=? WHERE id=?').run(clean(username),clean(name),role,active?1:0,u.id);if(password)db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(password),10),u.id);res.json({ok:true});}catch(e){res.status(400).json({error:'Username sudah digunakan'});}});
app.delete('/api/staff/:id',admin,(req,res)=>{const u=db.prepare('SELECT * FROM users WHERE id=? AND role IN (\'admin\',\'guru\')').get(req.params.id);if(!u)return res.status(404).json({error:'Akun tidak ditemukan'});if(u.id===req.session.user.id)return res.status(400).json({error:'Tidak dapat menghapus akun admin yang sedang login'});if(u.role==='admin'&&db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c<=1)return res.status(400).json({error:'Tidak dapat menghapus admin aktif terakhir'});db.prepare('DELETE FROM users WHERE id=?').run(u.id);res.json({ok:true});});
app.get('/api/gurus',admin,(req,res)=>res.json(db.prepare("SELECT id,username,name,active FROM users WHERE role='guru' ORDER BY name").all()));
app.get('/api/admins',admin,(req,res)=>res.json(db.prepare("SELECT id,username,name,active FROM users WHERE role='admin' ORDER BY name").all()));

// ===== User deletion compatibility =====
app.delete('/api/users/:id',staff,(req,res)=>{const id=Number(req.params.id);if(id===req.session.user.id)return res.status(400).json({error:'Tidak dapat menghapus akun sendiri'});const u=db.prepare('SELECT * FROM users WHERE id=?').get(id);if(!u)return res.status(404).json({error:'Akun tidak ditemukan'});if(u.role!=='siswa'&&req.session.user.role!=='admin')return res.status(403).json({error:'Guru tidak dapat menghapus akun staf'});db.prepare('DELETE FROM users WHERE id=?').run(id);res.json({ok:true});});

// ===== Mapel =====
app.get('/api/subjects',auth,(req,res)=>res.json(db.prepare('SELECT * FROM subjects WHERE active=1 ORDER BY name').all()));
app.post('/api/subjects',staff,(req,res)=>{const {code,name,duration_minutes}=req.body;if(!clean(code)||!clean(name))return res.status(400).json({error:'Kode dan nama wajib'});const id=db.prepare('INSERT INTO subjects(code,name,duration_minutes) VALUES(?,?,?)').run(clean(code),clean(name),Number(duration_minutes)||45).lastInsertRowid;res.json({id});});
app.put('/api/subjects/:id',staff,(req,res)=>{db.prepare('UPDATE subjects SET code=?,name=?,duration_minutes=? WHERE id=?').run(clean(req.body.code),clean(req.body.name),Number(req.body.duration_minutes)||45,req.params.id);res.json({ok:true});});
app.delete('/api/subjects/:id',staff,(req,res)=>{db.prepare('DELETE FROM subjects WHERE id=?').run(req.params.id);res.json({ok:true});});

// ===== Bank Soal =====
function normalizeQuestionType(v){
 const t=clean(v||'single').toLowerCase().replace(/[_-]+/g,' ');
 if(['single','single choice','single chois','pilihan tunggal','pilihan ganda tunggal'].includes(t))return 'single';
 if(['multi','multi select','multi choice','multi chois','multiple choice','pilihan ganda','pilihan ganda kompleks','multiple select'].includes(t))return 'multi';
 if(['truefalse','true false','benar salah','benar/salah','salah benar','true/false'].includes(t))return 'truefalse';
 if(['essay','esay','esai','uraian','essay/uraian','uraian/essay'].includes(t))return 'essay';
 return null;
}
function parseCorrect(v,type='single'){
 const raw=String(v??'').trim().toUpperCase();
 if(type==='truefalse'){
   if(['A','BENAR','TRUE','1','YA'].includes(raw))return [0];
   if(['B','SALAH','FALSE','0','TIDAK'].includes(raw))return [1];
   return [];
 }
 return raw.split(/[,;|\s]+/).map(x=>x.trim()).filter(Boolean).map(x=>x.length===1?x.charCodeAt(0)-65:NaN).filter(x=>Number.isInteger(x)&&x>=0&&x<5).filter((x,i,a)=>a.indexOf(x)===i);
}
function questionOptionCount(type){return type==='truefalse'?2:type==='essay'?0:5;}

// Validasi khusus baris Excel sebelum data diproses/import.
// Fungsi ini sebelumnya dipanggil oleh endpoint import tetapi belum didefinisikan,
// sehingga import selalu berhenti dengan error "validateQuestion is not defined".
function validateQuestion(r){
 const type=normalizeQuestionType(r.type||'single');
 if(!type)return 'type harus single, multi, truefalse, atau essay';
 if(!clean(r.subject_code||r.kode_mapel))return 'subject_code/kode_mapel wajib diisi';
 if(!clean(r.text||r.soal))return 'Teks soal wajib diisi';
 const points=Number(r.points);
 if(r.points!==''&&r.points!=null&&(!Number.isFinite(points)||points<=0))return 'points harus berupa angka lebih dari 0';
 const difficulty=clean(r.difficulty).toLowerCase();
 if(difficulty&&!['easy','medium','hard','mudah','sedang','sulit'].includes(difficulty))return 'difficulty harus easy/medium/hard (Mudah/Sedang/Sulit)';
 const status=clean(r.status).toLowerCase();
 if(status&&!['ready','draft','siap','draf'].includes(status))return 'status harus ready atau draft';
 if(type==='essay'){
   if(clean(r.correct??r.kunci))return 'Soal Esai tidak menggunakan kolom correct/kunci; isi pedoman pada explanation';
   return null;
 }
 const keys=type==='truefalse'?['option_a','option_b']:['option_a','option_b','option_c','option_d','option_e'];
 const options=keys.map(k=>clean(r[k]));
 if(options.some(x=>!x))return type==='truefalse'?'Opsi Benar dan Salah wajib diisi':'Pilihan A-E wajib lengkap';
 const raw=String(r.correct??r.kunci??'').trim().toUpperCase();
 const correct=parseCorrect(raw,type);
 if(!correct.length)return 'Kunci jawaban tidak valid atau belum diisi';
 const tokens=raw.split(/[,;|\s]+/).filter(Boolean);
 const allowed=type==='truefalse'?['A','B','BENAR','SALAH','TRUE','FALSE','1','0','YA','TIDAK']:['A','B','C','D','E'];
 if(tokens.some(t=>!allowed.includes(t)))return 'Kunci jawaban harus menggunakan huruf A-E yang sesuai dengan pilihan';
 if((type==='single'||type==='truefalse')&&correct.length!==1)return type==='single'?'Single Choice hanya boleh memiliki satu kunci':'Benar/Salah hanya boleh memiliki satu kunci';
 if(type==='multi'&&correct.length<1)return 'Multi Choice minimal memiliki satu kunci';
 return null;
}
function validateQuestionPayload({subject_id,type,text,options,correct,points,difficulty}){
 const t=normalizeQuestionType(type); if(!subject_id)return 'Mata pelajaran wajib dipilih'; if(!t)return 'Tipe soal tidak valid'; if(!clean(text))return 'Teks soal wajib diisi';
 if(t==='essay'){
   if(!Array.isArray(options)||options.length!==0)return 'Soal Esai tidak menggunakan pilihan jawaban';
   if(Array.isArray(correct)&&correct.length)return 'Soal Esai tidak menggunakan kunci jawaban pilihan';
 }else{
   if(!Array.isArray(options)||options.length!==questionOptionCount(t)||options.some(x=>!clean(x)))return t==='truefalse'?'Soal benar/salah harus memiliki opsi Benar dan Salah':'Pilihan A-E wajib lengkap';
   if(!Array.isArray(correct)||!correct.length||correct.some(x=>!Number.isInteger(Number(x))||Number(x)<0||Number(x)>=options.length))return 'Kunci jawaban tidak valid';
   if(t==='single'&&correct.length!==1)return 'Single Choice hanya boleh memiliki satu kunci';
   if(t==='truefalse'&&correct.length!==1)return 'Benar/Salah hanya boleh memiliki satu kunci';
   if(t==='multi'&&correct.length<1)return 'Multi Select minimal memiliki satu kunci';
 }
 if(difficulty&&!['easy','medium','hard'].includes(difficulty))return 'Tingkat kesulitan tidak valid';
 return null;
}
function normalizeStoredOptions(raw){
 try{const a=JSON.parse(raw||'[]');return Array.isArray(a)?a.map(x=>typeof x==='string'?{text:x,image_path:null}:{text:clean(x?.text),image_path:clean(x?.image_path)||null}):[];}catch{return []}
}
function serializeQuestion(q){return {...q,options:normalizeStoredOptions(q.options_json),correct:JSON.parse(q.correct_json||'[]').map(Number)};}
app.get('/api/questions',staff,(req,res)=>{
 const {subject_id,type,difficulty,status,q}=req.query;let sql='SELECT q.*,s.code subject_code,s.name subject_name FROM questions q JOIN subjects s ON s.id=q.subject_id WHERE 1=1',params=[];
 if(subject_id){sql+=' AND q.subject_id=?';params.push(subject_id)} if(type){sql+=' AND q.type=?';params.push(type)} if(difficulty){sql+=' AND q.difficulty=?';params.push(difficulty)} if(status){sql+=' AND q.status=?';params.push(status)} if(clean(q)){sql+=' AND (q.text LIKE ? OR q.tags LIKE ? OR s.name LIKE ? OR s.code LIKE ?)';const x='%'+clean(q)+'%';params.push(x,x,x,x)}
 sql+=' ORDER BY q.id DESC';res.json(db.prepare(sql).all(...params).map(serializeQuestion));
});
app.post('/api/questions',staff,(req,res)=>{
 const body=req.body;const type=normalizeQuestionType(body.type);let options=Array.isArray(body.options)?body.options.map(x=>typeof x==='string'?{text:clean(x),image_path:null}:{text:clean(x?.text),image_path:clean(x?.image_path)||null}):[];if(type==='truefalse')options=[{text:'Benar',image_path:options[0]?.image_path||null},{text:'Salah',image_path:options[1]?.image_path||null}];let correct=Array.isArray(body.correct)?body.correct.map(Number):[];
 const err=validateQuestionPayload({...body,type,options:options.map(x=>x.text),correct});if(err)return res.status(400).json({error:err});
 const id=db.prepare('INSERT INTO questions(subject_id,type,text,options_json,correct_json,points,image_path,explanation,difficulty,tags,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(Number(body.subject_id),type,clean(body.text),JSON.stringify(options),JSON.stringify(correct),Number(body.points)>0?Number(body.points):1,clean(body.image_path)||null,clean(body.explanation)||null,['easy','hard'].includes(body.difficulty)?body.difficulty:'medium',clean(body.tags)||null,['draft','ready'].includes(body.status)?body.status:'ready',now()).lastInsertRowid;res.json({id});
});
app.put('/api/questions/:id',staff,(req,res)=>{
 const old=db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.id);if(!old)return res.status(404).json({error:'Soal tidak ditemukan'});
 const body=req.body,type=normalizeQuestionType(body.type);let options=Array.isArray(body.options)?body.options.map(x=>typeof x==='string'?{text:clean(x),image_path:null}:{text:clean(x?.text),image_path:clean(x?.image_path)||null}):[];if(type==='truefalse')options=[{text:'Benar',image_path:options[0]?.image_path||null},{text:'Salah',image_path:options[1]?.image_path||null}];let correct=Array.isArray(body.correct)?body.correct.map(Number):[];const err=validateQuestionPayload({...body,type,options:options.map(x=>x.text),correct});if(err)return res.status(400).json({error:err});
 db.prepare('UPDATE questions SET subject_id=?,type=?,text=?,options_json=?,correct_json=?,points=?,image_path=?,explanation=?,difficulty=?,tags=?,status=?,updated_at=? WHERE id=?').run(Number(body.subject_id),type,clean(body.text),JSON.stringify(options),JSON.stringify(correct),Number(body.points)>0?Number(body.points):1,clean(body.image_path)||null,clean(body.explanation)||null,['easy','hard'].includes(body.difficulty)?body.difficulty:'medium',clean(body.tags)||null,['draft','ready'].includes(body.status)?body.status:'ready',now(),req.params.id);res.json({ok:true});
});
app.post('/api/questions/:id/duplicate',staff,(req,res)=>{const q=db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.id);if(!q)return res.status(404).json({error:'Soal tidak ditemukan'});const id=db.prepare('INSERT INTO questions(subject_id,type,text,options_json,correct_json,points,image_path,explanation,difficulty,tags,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(q.subject_id,q.type,q.text,q.options_json,q.correct_json,q.points,q.image_path,q.explanation,q.difficulty,q.tags,'draft',now()).lastInsertRowid;res.json({id});});
app.delete('/api/questions/:id',staff,(req,res)=>{const q=db.prepare('SELECT image_path FROM questions WHERE id=?').get(req.params.id);db.prepare('DELETE FROM questions WHERE id=?').run(req.params.id);if(q?.image_path&&q.image_path.startsWith('/uploads/questions/')){const f=path.join(questionUploadDir,path.basename(q.image_path));try{if(fs.existsSync(f))fs.unlinkSync(f)}catch{}}res.json({ok:true});});
app.post('/api/questions/bulk-delete',staff,(req,res)=>{const ids=Array.isArray(req.body.ids)?req.body.ids.map(Number).filter(Number.isInteger):[];if(!ids.length)return res.status(400).json({error:'Tidak ada soal dipilih'});const qs=db.prepare(`SELECT id,image_path FROM questions WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids);const tx=db.transaction(()=>{for(const q of qs)db.prepare('DELETE FROM questions WHERE id=?').run(q.id)});tx();for(const q of qs){if(q.image_path&&q.image_path.startsWith('/uploads/questions/')){const f=path.join(questionUploadDir,path.basename(q.image_path));try{if(fs.existsSync(f))fs.unlinkSync(f)}catch{}}}res.json({deleted:qs.length});});
const questionImageUpload=multer({storage:multer.diskStorage({destination:(req,file,cb)=>cb(null,questionUploadDir),filename:(req,file,cb)=>{const ext=path.extname(file.originalname||'').toLowerCase();cb(null,`${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`)}}),limits:{fileSize:200*1024},fileFilter:(req,file,cb)=>cb(null,/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))});
app.post('/api/questions/image',staff,questionImageUpload.single('image'),(req,res)=>{if(!req.file)return res.status(400).json({error:'File gambar tidak valid. Gunakan JPG, PNG, WEBP, atau GIF maksimal 200 KB.'});res.json({url:`/uploads/questions/${req.file.filename}`,name:req.file.originalname,size:req.file.size});});
app.get('/api/questions/stats',staff,(req,res)=>{const total=db.prepare('SELECT COUNT(*) c FROM questions').get().c;const byType=db.prepare('SELECT type,COUNT(*) c FROM questions GROUP BY type').all();const byDifficulty=db.prepare('SELECT difficulty,COUNT(*) c FROM questions GROUP BY difficulty').all();const draft=db.prepare("SELECT COUNT(*) c FROM questions WHERE status='draft'").get().c;res.json({total,byType,byDifficulty,draft});});

// ===== Jadwal & Ujian lama tetap =====
app.get('/api/schedules',staff,(req,res)=>res.json(db.prepare(`SELECT z.*,s.code,s.name subject_name,(SELECT COUNT(*) FROM schedule_questions sq WHERE sq.schedule_id=z.id) selected_question_count FROM schedules z JOIN subjects s ON s.id=z.subject_id ORDER BY z.start_at DESC`).all()));
app.post('/api/schedules',staff,(req,res)=>{
 let {subject_id,name,start_at,end_at,shuffle_questions,shuffle_options,selected_question_ids}=req.body;
 subject_id=Number(subject_id);
 if(!subject_id||!clean(name)||!start_at||!end_at)return res.status(400).json({error:'Jadwal belum lengkap'});
 let a=new Date(start_at).getTime(),b=new Date(end_at).getTime();if(!Number.isFinite(a)||!Number.isFinite(b)||!(b>a))return res.status(400).json({error:'Waktu selesai harus setelah mulai'});
 if(!Array.isArray(selected_question_ids))return res.status(400).json({error:'Pilih soal yang akan diujikan terlebih dahulu'});
 const ids=[...new Set(selected_question_ids.map(Number).filter(Number.isInteger))];
 if(!ids.length)return res.status(400).json({error:'Minimal pilih satu soal untuk jadwal ujian'});
 const valid=db.prepare(`SELECT id FROM questions WHERE subject_id=? AND status='ready' AND id IN (${ids.map(()=>'?').join(',')})`).all(subject_id,...ids).map(q=>q.id);
 if(valid.length!==ids.length)return res.status(400).json({error:'Ada soal yang tidak sesuai mata pelajaran atau belum berstatus siap'});
 const tx=db.transaction(()=>{const id=db.prepare('INSERT INTO schedules(subject_id,name,start_at,end_at,shuffle_questions,shuffle_options,question_selection_mode) VALUES(?,?,?,?,?,?,1)').run(subject_id,clean(name),a,b,shuffle_questions?1:0,shuffle_options?1:0).lastInsertRowid;const ins=db.prepare('INSERT INTO schedule_questions(schedule_id,question_id) VALUES(?,?)');for(const qid of ids)ins.run(id,qid);return id;});
 res.json({id:tx(),selected_question_count:ids.length});
});
app.post('/api/schedules/:id/reactivate',staff,(req,res)=>{
 const id=Number(req.params.id);const sch=db.prepare('SELECT id FROM schedules WHERE id=?').get(id);if(!sch)return res.status(404).json({error:'Jadwal tidak ditemukan'});
 const a=new Date(req.body.start_at).getTime(),b=new Date(req.body.end_at).getTime();if(!Number.isFinite(a)||!Number.isFinite(b)||!(b>a))return res.status(400).json({error:'Waktu selesai harus setelah waktu mulai'});
 db.prepare('UPDATE schedules SET start_at=?,end_at=?,active=1,allow_repeat=1 WHERE id=?').run(a,b,id);res.json({ok:true});
});
app.put('/api/schedules/:id',staff,(req,res)=>{const a=new Date(req.body.start_at).getTime(),b=new Date(req.body.end_at).getTime();if(!(b>a))return res.status(400).json({error:'Waktu selesai harus setelah mulai'});db.prepare('UPDATE schedules SET subject_id=?,name=?,start_at=?,end_at=?,shuffle_questions=?,shuffle_options=?,active=? WHERE id=?').run(req.body.subject_id,clean(req.body.name),a,b,req.body.shuffle_questions?1:0,req.body.shuffle_options?1:0,req.body.active?1:0,req.params.id);res.json({ok:true});});
app.delete('/api/schedules/:id',staff,(req,res)=>{
 try{
  const id=Number(req.params.id);
  const sch=db.prepare('SELECT id,name FROM schedules WHERE id=?').get(id);
  if(!sch)return res.status(404).json({error:'Jadwal tidak ditemukan'});

  // Nilai/percobaan yang SUDAH selesai tetap dilindungi agar tidak terhapus
  // tanpa sengaja. Percobaan yang belum selesai (mis. stopped/active) tidak
  // tampil di Rekap Nilai dan aman dibersihkan bersama jadwal.
  const finished=db.prepare(
   'SELECT COUNT(*) c FROM attempts WHERE schedule_id=? AND finished_at IS NOT NULL'
  ).get(id).c;

  if(finished>0){
   return res.status(409).json({
    error:`Jadwal "${sch.name}" sudah memiliki ${finished} data nilai yang sudah selesai. Hapus nilai pada menu Rekap Nilai terlebih dahulu, kemudian hapus jadwal.`
   });
  }

  const tx=db.transaction(()=>{
   // Bersihkan percobaan yang belum selesai agar tidak menjadi data yatim
   // dan tidak menghalangi penghapusan jadwal.
   db.prepare('DELETE FROM attempts WHERE schedule_id=? AND finished_at IS NULL').run(id);
   db.prepare('DELETE FROM schedules WHERE id=?').run(id);
  });
  tx();
  res.json({ok:true});
 }catch(e){
  console.error('[CBTVEN] /api/schedules/:id DELETE:',e);
  res.status(500).json({error:'Gagal menghapus jadwal.',details:e.message});
 }
});
app.get('/api/student/exams',auth,(req,res)=>{if(req.session.user.role!=='siswa')return res.status(403).json({error:'Khusus siswa'});const rows=db.prepare(`SELECT z.*,s.code,s.name subject_name,(SELECT id FROM attempts a WHERE a.user_id=? AND a.schedule_id=z.id ORDER BY a.id DESC LIMIT 1) attempt_id,(SELECT finished_at FROM attempts a WHERE a.user_id=? AND a.schedule_id=z.id ORDER BY a.id DESC LIMIT 1) finished_at,(SELECT status FROM attempts a WHERE a.user_id=? AND a.schedule_id=z.id ORDER BY a.id DESC LIMIT 1) attempt_status FROM schedules z JOIN subjects s ON s.id=z.subject_id WHERE z.active=1 ORDER BY z.start_at`).all(req.session.user.id,req.session.user.id,req.session.user.id);res.json(rows);});
function cleanQuestions(subjectId,sch){const chosen=db.prepare('SELECT question_id FROM schedule_questions WHERE schedule_id=?').all(sch.id).map(x=>x.question_id);let base="SELECT id,type,text,options_json,correct_json,points,image_path,explanation FROM questions WHERE subject_id=? AND status='ready'";let params=[subjectId];if(Number(sch.question_selection_mode)){if(chosen.length){base+=` AND id IN (${chosen.map(()=>'?').join(',')})`;params.push(...chosen)}else base+=' AND 1=0'}base+=' ORDER BY id';let qs=db.prepare(base).all(...params).map(q=>{let key=[];try{key=JSON.parse(q.correct_json||'[]')}catch{};key=[...new Set((Array.isArray(key)?key:[]).map(Number).filter(Number.isInteger))];return {id:q.id,type:q.type,text:q.text,options:normalizeStoredOptions(q.options_json),points:q.points,image_path:q.image_path||null,explanation:q.explanation||null,correct_count:q.type==='multi'?key.length:(q.type==='essay'?0:1)}});if(sch.shuffle_questions)qs.sort(()=>Math.random()-.5);qs=qs.map(q=>{q.options=q.options.map((v,i)=>({text:typeof v==='string'?v:(v?.text||''),image_path:typeof v==='object'?(v?.image_path||null):null,original:i}));if(sch.shuffle_options)q.options.sort(()=>Math.random()-.5);return q;});return qs;}
app.post('/api/exams/start',auth,(req,res)=>{
 try{
  if(req.session.user.role!=='siswa')return res.status(403).json({error:'Khusus siswa'});
  const u=db.prepare("SELECT * FROM users WHERE id=? AND role='siswa'").get(req.session.user.id);
  if(!u||!u.active)return res.status(403).json({error:'Akun siswa tidak aktif'});
  if(Number(u.cbt_locked))return res.status(423).json({error:'Akun siswa sedang dikunci. Hubungi admin untuk mengaktifkan kembali.'});
  const sch=db.prepare('SELECT z.*,s.code,s.name subject_name,s.duration_minutes FROM schedules z JOIN subjects s ON s.id=z.subject_id WHERE z.id=? AND z.active=1').get(Number(req.body.schedule_id));
  if(!sch)return res.status(404).json({error:'Jadwal tidak ditemukan'});
  const t=now();
  if(t<sch.start_at||t>sch.end_at)return res.status(400).json({error:'Ujian belum dimulai atau sudah ditutup'});
  const old=db.prepare('SELECT * FROM attempts WHERE user_id=? AND schedule_id=? ORDER BY id DESC LIMIT 1').get(req.session.user.id,sch.id);
  const qs=cleanQuestions(sch.subject_id,sch);
  if(!qs.length)return res.status(400).json({error:'Belum ada soal pada mapel ini'});
  if(old){
   if(old.finished_at&&!sch.allow_repeat)return res.status(409).json({error:'Anda sudah menyelesaikan ujian ini'});
   if(old.finished_at&&sch.allow_repeat){ /* Jadwal remedial: buat percobaan baru, riwayat lama tetap disimpan. */ } else {
   if(['violation','stopped'].includes(old.status))return res.status(423).json({error:'Percobaan ujian dikunci oleh admin. Silakan menunggu pengaktifan kembali.'});
   const deadline=Math.min(sch.end_at,old.started_at+sch.duration_minutes*60000);
   let saved={};try{saved=JSON.parse(old.answers_json||'{}');if(!saved||typeof saved!=='object'||Array.isArray(saved))saved={}}catch(e){saved={}}
   return res.json({attempt_id:old.id,exam:{id:sch.id,name:sch.name,subject_name:sch.subject_name,duration_minutes:sch.duration_minutes,start_at:sch.start_at,end_at:sch.end_at},started_at:old.started_at,expires_at:deadline,questions:qs,answers:saved,resume:true});
   }
  }
  const started=t,deadline=Math.min(sch.end_at,started+sch.duration_minutes*60000);
  const id=db.prepare('INSERT INTO attempts(user_id,subject_id,schedule_id,started_at,status) VALUES(?,?,?,?,?)').run(req.session.user.id,sch.subject_id,sch.id,started,'active').lastInsertRowid;
  res.json({attempt_id:id,exam:{id:sch.id,name:sch.name,subject_name:sch.subject_name,duration_minutes:sch.duration_minutes,start_at:sch.start_at,end_at:sch.end_at},started_at:started,expires_at:deadline,questions:qs,answers:{}});
 }catch(e){
  console.error('[CBTVEN] /api/exams/start:',e);
  res.status(500).json({error:'Gagal membuka ujian. Periksa database CBT dan restart server.',details:e.message});
 }
});
app.post('/api/exams/:id/save',auth,(req,res)=>{const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);const a=db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(req.params.id,req.session.user.id);if(u?.cbt_locked||a?.status==='violation'||a?.status==='stopped')return res.status(423).json({error:'Sesi ujian dikunci karena pelanggaran. Silakan hubungi admin.'});if(!a||a.finished_at)return res.status(409).json({error:'Percobaan tidak aktif'});db.prepare('UPDATE attempts SET answers_json=? WHERE id=?').run(JSON.stringify(req.body.answers||{}),a.id);res.json({ok:true});});
app.post('/api/exams/:id/submit',auth,(req,res)=>{
 const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);
 const a=db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(req.params.id,req.session.user.id);
 if(u?.cbt_locked||a?.status==='violation'||a?.status==='stopped')return res.status(423).json({error:'Sesi ujian dikunci karena pelanggaran.'});
 if(!a)return res.status(404).json({error:'Percobaan tidak ditemukan'});
 if(a.finished_at)return res.status(409).json({error:'Ujian sudah selesai'});
 const answers=req.body.answers||{};
 const chosen=a.schedule_id?db.prepare('SELECT question_id FROM schedule_questions WHERE schedule_id=?').all(a.schedule_id).map(x=>x.question_id):[];let qsql="SELECT * FROM questions WHERE subject_id=? AND status='ready'",qparams=[a.subject_id];const selectionMode=a.schedule_id?Number(db.prepare('SELECT question_selection_mode FROM schedules WHERE id=?').get(a.schedule_id)?.question_selection_mode||0):0;if(selectionMode){if(chosen.length){qsql+=` AND id IN (${chosen.map(()=>'?').join(',')})`;qparams.push(...chosen)}else qsql+=' AND 1=0'}const qs=db.prepare(qsql).all(...qparams);
 let autoTotal=0,autoPts=0,correct=0,essayTotal=0,essayCount=0;
 for(const q of qs){
  if(q.type==='essay'){essayTotal+=Number(q.points)||1;essayCount++;continue;}
  const keyRaw=JSON.parse(q.correct_json||'[]');
  const key=[...new Set((Array.isArray(keyRaw)?keyRaw:[]).map(Number).filter(Number.isInteger))];
  const point=Number(q.points)||1; autoTotal+=point;
  const ans=answers[String(q.id)];
  if(q.type==='multi'){
   const x=[...new Set((Array.isArray(ans)?ans:[]).map(Number).filter(Number.isInteger))].sort((a,b)=>a-b);const y=key.slice().sort((a,b)=>a-b);let ratio=0;
   if(x.length<=y.length&&y.length>0){const correctSelected=x.filter(v=>y.includes(v)).length;const wrongSelected=x.filter(v=>!y.includes(v)).length;ratio=Math.max(0,(correctSelected-wrongSelected)/y.length);}
   autoPts+=point*ratio;if(x.length===y.length&&JSON.stringify(x)===JSON.stringify(y))correct++;
  }else if(Number(ans)===Number(key[0])){autoPts+=point;correct++;}
 }
 const wrong=qs.filter(q=>q.type!=='essay').length-correct;
 const hasEssay=essayCount>0;
 const score=hasEssay?null:(autoTotal?Math.round(autoPts/autoTotal*100):0);
 db.prepare('UPDATE attempts SET finished_at=?,score=?,correct_count=?,wrong_count=?,answers_json=?,essay_score=?,essay_graded=? WHERE id=?').run(now(),score,correct,wrong,JSON.stringify(answers),0,0,a.id);
 res.json({score,correct_count:correct,wrong_count:wrong,essay_count:essayCount,essay_pending:hasEssay});
});

app.get('/api/results/:id/essay',staff,(req,res)=>{
 const a=db.prepare('SELECT * FROM attempts WHERE id=? AND finished_at IS NOT NULL').get(req.params.id);if(!a)return res.status(404).json({error:'Hasil ujian tidak ditemukan'});
 let answers={};try{answers=JSON.parse(a.answers_json||'{}')}catch{}
 let gradeMap={};try{gradeMap=JSON.parse(a.essay_grades_json||'{}')}catch{};const chosen=a.schedule_id?db.prepare('SELECT question_id FROM schedule_questions WHERE schedule_id=?').all(a.schedule_id).map(x=>x.question_id):[];let qsql="SELECT id,text,points FROM questions WHERE subject_id=? AND type='essay' AND status='ready'",qparams=[a.subject_id];const selectionMode=a.schedule_id?Number(db.prepare('SELECT question_selection_mode FROM schedules WHERE id=?').get(a.schedule_id)?.question_selection_mode||0):0;if(selectionMode){if(chosen.length){qsql+=` AND id IN (${chosen.map(()=>'?').join(',')})`;qparams.push(...chosen)}else qsql+=' AND 1=0'}qsql+=' ORDER BY id';const qs=db.prepare(qsql).all(...qparams).map(q=>({id:q.id,text:q.text,points:Number(q.points)||1,answer:String(answers[String(q.id)]||''),grade:gradeMap[String(q.id)]??''}));
 res.json({attempt_id:a.id,student_name:db.prepare('SELECT name FROM users WHERE id=?').get(a.user_id)?.name||'',essay_score:Number(a.essay_score)||0,essay_graded:Number(a.essay_graded)||0,questions:qs});
});

app.get('/api/results/:id',staff,(req,res)=>{const r=db.prepare(`SELECT a.*,u.name student_name,u.nis,u.nisn,u.class_name,s.name subject_name,z.name schedule_name FROM attempts a JOIN users u ON u.id=a.user_id JOIN subjects s ON s.id=a.subject_id LEFT JOIN schedules z ON z.id=a.schedule_id WHERE a.id=?`).get(req.params.id);if(!r)return res.status(404).json({error:'Tidak ditemukan'});res.json(r);});

app.post('/api/results/:id/essay',staff,(req,res)=>{
 const a=db.prepare('SELECT * FROM attempts WHERE id=? AND finished_at IS NOT NULL').get(req.params.id);if(!a)return res.status(404).json({error:'Hasil ujian tidak ditemukan'});
 let answers={};try{answers=JSON.parse(a.answers_json||'{}')}catch{}
 const chosen=a.schedule_id?db.prepare('SELECT question_id FROM schedule_questions WHERE schedule_id=?').all(a.schedule_id).map(x=>x.question_id):[];let qsql="SELECT id,points FROM questions WHERE subject_id=? AND type='essay' AND status='ready'",qparams=[a.subject_id];const selectionMode=a.schedule_id?Number(db.prepare('SELECT question_selection_mode FROM schedules WHERE id=?').get(a.schedule_id)?.question_selection_mode||0):0;if(selectionMode){if(chosen.length){qsql+=` AND id IN (${chosen.map(()=>'?').join(',')})`;qparams.push(...chosen)}else qsql+=' AND 1=0'}const qs=db.prepare(qsql).all(...qparams);
 let existingGrades={};try{existingGrades=JSON.parse(a.essay_grades_json||'{}')}catch{};const grades=req.body.grades&&typeof req.body.grades==='object'?req.body.grades:{};Object.assign(existingGrades,grades);
 let essayScore=0,graded=0,essayTotal=0;
 for(const q of qs){const max=Number(q.points)||1;essayTotal+=max;const raw=existingGrades[String(q.id)];if(raw===undefined||raw===null||raw==='')continue;const s=Number(raw);if(!Number.isFinite(s)||s<0||s>max)return res.status(400).json({error:`Nilai esai soal ${q.id} harus antara 0 dan ${max}`});essayScore+=s;graded++;}
 const all=db.prepare("SELECT id,type,points,correct_json FROM questions WHERE subject_id=? AND status='ready'").all(a.subject_id);let autoTotal=0,autoPts=0;
 for(const q of all){if(q.type==='essay')continue;const point=Number(q.points)||1;autoTotal+=point;const key=[...new Set((JSON.parse(q.correct_json||'[]')||[]).map(Number))];const ans=answers[String(q.id)];if(q.type==='multi'){const x=[...new Set((Array.isArray(ans)?ans:[]).map(Number))].sort((a,b)=>a-b),y=key.slice().sort((a,b)=>a-b);let ratio=0;if(x.length<=y.length&&y.length){const c=x.filter(v=>y.includes(v)).length,w=x.filter(v=>!y.includes(v)).length;ratio=Math.max(0,(c-w)/y.length)}autoPts+=point*ratio;}else if(Number(ans)===Number(key[0]))autoPts+=point;}
 const score=essayTotal>0&&graded===qs.length?Math.round((autoPts+essayScore)/(autoTotal+essayTotal)*100):null;
 db.prepare('UPDATE attempts SET score=?,essay_score=?,essay_graded=?,essay_grades_json=? WHERE id=?').run(score,essayScore,graded,JSON.stringify(existingGrades),a.id);
 res.json({ok:true,score,essay_graded:graded,essay_count:qs.length});
});

// ===== Reset / Kendali Siswa CBT =====
app.get('/api/admin/cbt-locks',admin,(req,res)=>{const rows=db.prepare(`SELECT u.id user_id,u.name,u.username,u.nis,u.nisn,u.class_name,u.cbt_locked,u.cbt_lock_reason,a.id attempt_id,a.status attempt_status,a.violation_reason,a.violation_at,a.started_at,a.finished_at,z.name schedule_name,s.name subject_name FROM users u LEFT JOIN attempts a ON a.id=(SELECT aa.id FROM attempts aa WHERE aa.user_id=u.id AND aa.finished_at IS NULL ORDER BY aa.id DESC LIMIT 1) LEFT JOIN schedules z ON z.id=a.schedule_id LEFT JOIN subjects s ON s.id=a.subject_id WHERE u.role='siswa' AND (u.cbt_locked=1 OR a.id IS NOT NULL) ORDER BY COALESCE(a.violation_at,0) DESC,u.name`).all();res.json(rows);});
app.post('/api/admin/cbt-unlock/:userId',admin,(req,res)=>{
 try{const uid=Number(req.params.userId);const u=db.prepare("SELECT id FROM users WHERE id=? AND role='siswa'").get(uid);if(!u)return res.status(404).json({error:'Siswa tidak ditemukan'});
  const tx=db.transaction(()=>{db.prepare('UPDATE users SET cbt_locked=0,cbt_lock_reason=NULL WHERE id=?').run(uid);db.prepare("UPDATE attempts SET status='active',violation_reason=NULL,violation_at=NULL WHERE user_id=? AND finished_at IS NULL AND status IN ('violation','stopped')").run(uid)});tx();res.json({ok:true});
 }catch(e){console.error('[CBTVEN] cbt-unlock:',e);res.status(500).json({error:'Gagal mengaktifkan kembali siswa.',details:e.message})}
});
app.post('/api/admin/cbt-stop/:userId',admin,(req,res)=>{
 try{const uid=Number(req.params.userId);const reason=clean(req.body.reason)||'Dihentikan admin';const u=db.prepare("SELECT id FROM users WHERE id=? AND role='siswa'").get(uid);if(!u)return res.status(404).json({error:'Siswa tidak ditemukan'});
  const tx=db.transaction(()=>{db.prepare('UPDATE users SET cbt_locked=1,cbt_lock_reason=? WHERE id=?').run(reason,uid);db.prepare("UPDATE attempts SET status='stopped',violation_reason=?,violation_at=? WHERE user_id=? AND finished_at IS NULL").run(reason,now(),uid)});tx();res.json({ok:true});
 }catch(e){console.error('[CBTVEN] cbt-stop:',e);res.status(500).json({error:'Gagal menghentikan siswa.',details:e.message})}
});
app.post('/api/exams/:id/violation',auth,(req,res)=>{if(req.session.user.role!=='siswa')return res.status(403).json({error:'Khusus siswa'});const reason=clean(req.body.reason)||'Terdeteksi keluar dari mode ujian';const a=db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(req.params.id,req.session.user.id);if(!a||a.finished_at)return res.status(409).json({error:'Percobaan tidak aktif'});db.prepare("UPDATE users SET cbt_locked=1,cbt_lock_reason=? WHERE id=?").run(reason,req.session.user.id);db.prepare("UPDATE attempts SET status='violation',violation_reason=?,violation_at=? WHERE id=?").run(reason,now(),a.id);req.session.destroy(()=>{});res.json({ok:true,locked:true});});

app.get('/api/results',staff,(req,res)=>{let sql=`SELECT a.*,u.name student_name,u.nis,u.nisn,u.class_name,s.code subject_code,s.name subject_name,z.name schedule_name,(SELECT COUNT(*) FROM questions qe WHERE qe.subject_id=a.subject_id AND qe.type='essay' AND qe.status='ready' AND (z.id IS NULL OR NOT EXISTS(SELECT 1 FROM schedule_questions sq0 WHERE sq0.schedule_id=z.id) OR EXISTS(SELECT 1 FROM schedule_questions sq1 WHERE sq1.schedule_id=z.id AND sq1.question_id=qe.id))) essay_count FROM attempts a JOIN users u ON u.id=a.user_id JOIN subjects s ON s.id=a.subject_id LEFT JOIN schedules z ON z.id=a.schedule_id WHERE a.finished_at IS NOT NULL`;let params=[];if(req.query.subject_id){sql+=' AND a.subject_id=?';params.push(Number(req.query.subject_id));}if(req.query.schedule_id){sql+=' AND a.schedule_id=?';params.push(Number(req.query.schedule_id));}if(req.query.class_name){sql+=" AND trim(COALESCE(u.class_name,''))=trim(?)";params.push(clean(req.query.class_name));}sql+=' ORDER BY u.class_name,u.name,a.finished_at DESC';res.json(db.prepare(sql).all(...params));});

app.delete('/api/results/:id',staff,(req,res)=>{const r=db.prepare('SELECT id FROM attempts WHERE id=? AND finished_at IS NOT NULL').get(req.params.id);if(!r)return res.status(404).json({error:'Nilai tidak ditemukan'});db.prepare('DELETE FROM attempts WHERE id=?').run(r.id);res.json({ok:true});});
app.post('/api/results/bulk-delete',staff,(req,res)=>{const ids=Array.isArray(req.body.ids)?req.body.ids.map(Number).filter(Number.isInteger):[];if(!ids.length)return res.status(400).json({error:'Tidak ada nilai yang dipilih'});const rows=db.prepare(`SELECT id FROM attempts WHERE id IN (${ids.map(()=>'?').join(',')}) AND finished_at IS NOT NULL`).all(...ids);const tx=db.transaction(()=>{for(const r of rows)db.prepare('DELETE FROM attempts WHERE id=?').run(r.id)});tx();res.json({deleted:rows.length});});
app.get('/api/export/results.csv',staff,(req,res)=>{let sql=`SELECT u.nis,u.nisn,u.name student_name,u.class_name,z.name schedule_name,a.score,a.correct_count,a.wrong_count FROM attempts a JOIN users u ON u.id=a.user_id JOIN subjects s ON s.id=a.subject_id LEFT JOIN schedules z ON z.id=a.schedule_id WHERE a.finished_at IS NOT NULL`;const params=[];if(req.query.subject_id){sql+=' AND a.subject_id=?';params.push(Number(req.query.subject_id));}if(req.query.schedule_id){sql+=' AND a.schedule_id=?';params.push(Number(req.query.schedule_id));}if(req.query.class_name){sql+=" AND trim(COALESCE(u.class_name,''))=trim(?)";params.push(clean(req.query.class_name));}sql+=' ORDER BY u.class_name,u.name,a.finished_at DESC';const rows=db.prepare(sql).all(...params);const esc=v=>'"'+String(v??'').replaceAll('"','""')+'"';const csv=['Siswa;NISN;Kelas;Jadwal;Benar;Salah;Nilai',...rows.map(x=>[x.student_name,x.nisn,x.class_name,x.schedule_name,x.correct_count,x.wrong_count,x.score].map(esc).join(';'))].join('\r\n');res.setHeader('Content-Type','text/csv;charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="rekap-nilai.csv"');res.send('\ufeff'+csv);});
app.post('/api/settings',admin,(req,res)=>{const keys=['school_name','app_name','logo_text','card_exam_type','card_exam_date','card_header1','card_header2','card_header3','card_address','card_login_url','card_head_name','card_head_nip','card_sign_place_date','card_logo','card_signature','card_stamp'];for(const k of keys)if(req.body[k]!=null)setS(k,req.body[k]);res.json({ok:true});});
const cardImageUpload=multer({storage:multer.diskStorage({destination:(req,file,cb)=>cb(null,cardUploadDir),filename:(req,file,cb)=>{const ext=path.extname(file.originalname||'').toLowerCase();cb(null,`${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`)}}),limits:{fileSize:200*1024},fileFilter:(req,file,cb)=>cb(null,/^image\/(jpeg|png|webp)$/.test(file.mimetype))});
app.get('/api/cards/qr',staff,(req,res)=>{try{const text=String(req.query.text||'').trim();if(!text)return res.status(400).send('');const qr=new QRCode(-1,QRErrorCorrectLevel.M);qr.addData(text);qr.make();const n=qr.getModuleCount(),pad=4;let svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n+pad*2} ${n+pad*2}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/>`;for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(qr.isDark(r,c))svg+=`<rect x="${c+pad}" y="${r+pad}" width="1" height="1" fill="black"/>`;svg+='</svg>';res.type('svg').send(svg);}catch(e){console.error('[CBTVEN] QR:',e);res.status(500).send('');}});
app.post('/api/cards/image',admin,cardImageUpload.single('image'),(req,res)=>{if(!req.file)return res.status(400).json({error:'File gambar tidak valid. JPG, PNG, atau WEBP maksimal 200 KB.'});res.json({url:`/uploads/cards/${req.file.filename}`});});
app.get('/api/cards/students',staff,(req,res)=>{let sql="SELECT id,username,name,nis,nipd,nisn,class_name,active,card_password_enc FROM users WHERE role='siswa'";const p=[];if(req.query.class_name){sql+=" AND trim(COALESCE(class_name,''))=trim(?)";p.push(clean(req.query.class_name));}sql+=' ORDER BY class_name,name';const rows=db.prepare(sql).all(...p).map(x=>({...x,password:decryptCardPassword(x.card_password_enc)}));res.json(rows);});
app.post('/api/cards/generate-passwords',staff,(req,res)=>{const ids=Array.isArray(req.body.ids)?req.body.ids.map(Number).filter(Number.isInteger):[];if(!ids.length)return res.status(400).json({error:'Tidak ada siswa dipilih'});const rows=db.prepare(`SELECT id FROM users WHERE role='siswa' AND id IN (${ids.map(()=>'?').join(',')})`).all(...ids);const out=[];const tx=db.transaction(()=>{for(const r of rows){const pw=makeCardPassword();db.prepare('UPDATE users SET password_hash=?,card_password_enc=? WHERE id=?').run(bcrypt.hashSync(pw,10),encryptCardPassword(pw),r.id);out.push({id:r.id,password:pw});}});tx();res.json({students:out});});


// ===== Template & Import =====
const upload=multer({dest:path.join(__dirname,'data'),limits:{fileSize:10*1024*1024}});
function sendTemplate(res,filename,headers,row){const ws=XLSX.utils.aoa_to_sheet([headers,row]);const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Template');const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);res.send(buf);}
app.get('/api/templates/students',staff,(req,res)=>sendTemplate(res,'template-data-siswa.xlsx',['username','password','name','nis','nipd','nisn','class_name','active'],['siswa001','password123','Nama Siswa','12345','00779','0012345678','XII-IPA-1',1]));
app.get('/api/templates/teachers',admin,(req,res)=>sendTemplate(res,'template-data-guru.xlsx',['username','password','name','active'],['guru001','password123','Nama Guru',1]));
app.get('/api/templates/questions',staff,(req,res)=>{
 const subjects=db.prepare('SELECT code,name FROM subjects WHERE active=1 ORDER BY name').all();
 const defaultCode=subjects[0]?.code||'KODE-MAPEL';
 const headers=['subject_code','type','text','option_a','option_b','option_c','option_d','option_e','correct','points','difficulty','tags','explanation','status','image_path','option_a_image','option_b_image','option_c_image','option_d_image','option_e_image'];
 const rows=[
  [defaultCode,'single','CONTOH - ubah teks ini menjadi soal Anda','Pilihan A','Pilihan B','Pilihan C','Pilihan D','Pilihan E','C',1,'medium','contoh','Pembahasan opsional','draft',''],
  [defaultCode,'multi','CONTOH - tipe multi dapat memiliki beberapa jawaban benar','Pilihan A','Pilihan B','Pilihan C','Pilihan D','Pilihan E','A,C',1,'medium','contoh','Pembahasan opsional','draft',''],
  [defaultCode,'truefalse','CONTOH - tentukan benar atau salah','Benar','Salah','','','','A',1,'medium','contoh','Pembahasan opsional','draft',''],
  [defaultCode,'essay','CONTOH - tulis pertanyaan uraian di sini','','','','','','',2,'medium','contoh','Pedoman koreksi opsional','draft','']
 ];
 const wb=XLSX.utils.book_new();
 const ws=XLSX.utils.aoa_to_sheet([headers,...rows]);
 XLSX.utils.book_append_sheet(wb,ws,'Template Soal');
 const info=[
  ['PETUNJUK PENGISIAN TEMPLATE BANK SOAL',''],
  ['subject_code',`Gunakan kode mapel yang sudah ada di menu Mapel. Contoh kode dari data aplikasi saat ini: ${subjects.map(x=>`${x.code} (${x.name})`).join('; ')||'belum ada mapel aktif'}. Kode pada contoh template mengikuti mapel aktif pertama; ubah jika diperlukan.`],
  ['type','Gunakan: single = pilihan satu jawaban; multi = pilihan beberapa jawaban; truefalse = Benar/Salah; essay = Esai/Uraian.'],
  ['correct','Single: satu kunci, contoh C. Multi: beberapa kunci dipisahkan koma, contoh A,C,E. Benar/Salah: A atau Benar untuk benar, B atau Salah untuk salah. Esai: kosongkan.'],
  ['option_a s/d option_e','Single/Multi wajib mengisi A-E. Benar/Salah wajib mengisi A=Benar dan B=Salah. Esai tidak memakai pilihan jawaban.'],
  ['points','Bobot harus berupa angka lebih dari 0; contoh 1 atau 2. Jika kosong, sistem menggunakan 1.'],
  ['difficulty','easy = Mudah, medium = Sedang, hard = Sulit.'],
  ['tags','Kata kunci/tag soal, opsional.'],
  ['explanation','Pembahasan atau pedoman koreksi, opsional.'],
  ['status','draft = contoh/belum siap diujikan; ready = siap digunakan. Baris contoh sengaja diset draft agar tidak langsung masuk ujian.'],
  ['image_path','Opsional. Path relatif/URL gambar soal yang sudah tersedia di server. Import Excel tidak mengunggah file gambar yang tertanam di sel.'],
  ['option_a_image s/d option_e_image','Opsional. Path relatif/URL gambar opsi yang sudah tersedia di server. Kolom ini sekarang disertakan pada template.'],
  ['PENTING','Hapus baris CONTOH sebelum mengimpor atau ubah menjadi soal sungguhan. Semua baris divalidasi lebih dahulu; jika ada kesalahan, tidak ada baris yang akan diimpor.'],
 ];
 const wi=XLSX.utils.aoa_to_sheet(info);XLSX.utils.book_append_sheet(wb,wi,'Petunjuk');
 const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="template-bank-soal-lengkap.xlsx"');res.send(buf);
});
function normalizeImportRows(rows){
 const aliases={kode_mapel:'subject_code',mapel:'subject_code',mata_pelajaran:'subject_code',soal:'text',pertanyaan:'text',kunci:'correct',kunci_jawaban:'correct',bobot:'points',pembahasan:'explanation',tingkat_kesulitan:'difficulty',status_soal:'status',gambar_soal:'image_path',nama:'name',nama_siswa:'name',nama_guru:'name',nisn_siswa:'nisn',kelas:'class_name',kelas_siswa:'class_name',nipd_siswa:'nipd',nis_siswa:'nis',aktif:'active',kata_sandi:'password',sandi:'password'};
 return rows.map(row=>{const out={};for(const [key,value] of Object.entries(row)){let k=String(key).replace(/^\uFEFF/,'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[\s-]+/g,'_');out[aliases[k]||k]=value;}return out;});
}
function readRows(file){
 const wb=XLSX.readFile(file.path,{cellDates:false,raw:false});
 if(!wb.SheetNames.length)throw Error('File tidak memiliki sheet');
 const ws=wb.Sheets[wb.SheetNames[0]];if(!ws||!ws['!ref'])throw Error('Sheet pertama kosong atau tidak memiliki header');
 const rows=XLSX.utils.sheet_to_json(ws,{defval:'',raw:false,blankrows:false});
 const cleaned=normalizeImportRows(rows).filter(r=>Object.values(r).some(v=>String(v??'').trim()!==''));
 if(!cleaned.length)throw Error('Tidak ada baris data. Pastikan baris pertama berisi nama kolom/header.');
 return cleaned;
}
function requireImportHeaders(rows,required,label){const keys=new Set(Object.keys(rows[0]||{}));const missing=required.filter(k=>!keys.has(k));if(missing.length)throw Error(`Header template ${label} tidak sesuai. Kolom wajib yang belum ada: ${missing.join(', ')}. Unduh template resmi dari menu aplikasi.`);}
function finishUpload(file){try{if(file&&fs.existsSync(file.path))fs.unlinkSync(file.path);}catch{}}
app.post('/api/import/students',staff,upload.single('file'),(req,res)=>{if(!req.file)return res.status(400).json({error:'File belum dipilih'});try{const rows=readRows(req.file);if(!rows.length)return res.status(400).json({error:'File kosong'});requireImportHeaders(rows,['username','password','name','nis'],'Data Siswa');const errors=[],seenUser=new Set(),seenNis=new Set(),seenNisn=new Set();for(let i=0;i<rows.length;i++){const r=rows[i],line=i+2,username=clean(r.username),nis=clean(r.nis),nipd=clean(r.nipd),nisn=clean(r.nisn);if(!username||!clean(r.name)||!nis||!String(r.password??'').trim()){errors.push(`Baris ${line}: username, password, name dan NIS wajib`);continue;}const activeVal=String(r.active??'1').trim().toLowerCase();if(activeVal&&!['1','0','true','false','aktif','nonaktif','ya','tidak'].includes(activeVal))errors.push(`Baris ${line}: active harus 1/0, true/false, aktif/nonaktif`);const ku=username.toLowerCase(),kn=nis.toLowerCase(),knn=nisn.toLowerCase();if(seenUser.has(ku)||db.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?)').get(username))errors.push(`Baris ${line}: username sudah ada/duplikat`);if(seenNis.has(kn)||db.prepare('SELECT 1 FROM users WHERE lower(nis)=lower(?)').get(nis))errors.push(`Baris ${line}: NIS sudah ada/duplikat`);if(nisn&&(seenNisn.has(knn)||db.prepare('SELECT 1 FROM users WHERE lower(nisn)=lower(?)').get(nisn)))errors.push(`Baris ${line}: NISN sudah ada/duplikat`);seenUser.add(ku);seenNis.add(kn);if(nisn)seenNisn.add(knn);}if(errors.length)return res.status(400).json({error:'Validasi gagal. Tidak ada data yang diimpor.',details:errors});const ins=db.transaction(()=>{const q=db.prepare('INSERT INTO users(username,password_hash,name,role,nis,nipd,nisn,class_name,active) VALUES(?,?,?,?,?,?,?,?,?)');for(const r of rows)q.run(clean(r.username),bcrypt.hashSync(String(r.password),10),clean(r.name),'siswa',clean(r.nis),clean(r.nipd),clean(r.nisn)||null,clean(r.class_name),(!['0','false','nonaktif','tidak'].includes(String(r.active??'1').trim().toLowerCase())?1:0));});ins();res.json({imported:rows.length});}catch(e){res.status(400).json({error:e.message});}finally{finishUpload(req.file);}});
app.post('/api/import/staff',admin,upload.single('file'),(req,res)=>{if(!req.file)return res.status(400).json({error:'File belum dipilih'});try{const rows=readRows(req.file);if(!rows.length)return res.status(400).json({error:'File kosong'});requireImportHeaders(rows,['username','password','name'],'Data Guru');const errors=[],seen=new Set();for(let i=0;i<rows.length;i++){const r=rows[i],line=i+2,username=clean(r.username),role='guru';if(!username||!String(r.password??'').trim()||!clean(r.name)){errors.push(`Baris ${line}: username, password dan name wajib`);continue;}const activeVal=String(r.active??'1').trim().toLowerCase();if(activeVal&&!['1','0','true','false','aktif','nonaktif','ya','tidak'].includes(activeVal))errors.push(`Baris ${line}: active harus 1/0, true/false, aktif/nonaktif`);if(seen.has(username.toLowerCase())||db.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?)').get(username))errors.push(`Baris ${line}: username sudah ada/duplikat`);seen.add(username.toLowerCase());}if(errors.length)return res.status(400).json({error:'Validasi gagal. Tidak ada data yang diimpor.',details:errors});const ins=db.transaction(()=>{const q=db.prepare('INSERT INTO users(username,password_hash,name,role,active) VALUES(?,?,?,?,?)');for(const r of rows)q.run(clean(r.username),bcrypt.hashSync(String(r.password),10),clean(r.name),'guru',(!['0','false','nonaktif','tidak'].includes(String(r.active??'1').trim().toLowerCase())?1:0));});ins();res.json({imported:rows.length});}catch(e){res.status(400).json({error:e.message});}finally{finishUpload(req.file);}});
app.post('/api/import/questions',staff,upload.single('file'),(req,res)=>{if(!req.file)return res.status(400).json({error:'File belum dipilih'});try{const rows=readRows(req.file);if(!rows.length)return res.status(400).json({error:'File kosong'});requireImportHeaders(rows,['subject_code','type','text'],'Bank Soal');const errors=[],prepared=[];for(let i=0;i<rows.length;i++){const r=rows[i],line=i+2,err=validateQuestion(r);if(err){errors.push(`Baris ${line}: ${err}`);continue;}const s=db.prepare('SELECT id FROM subjects WHERE lower(trim(code))=lower(trim(?)) AND active=1').get(clean(r.subject_code||r.kode_mapel));if(!s){errors.push(`Baris ${line}: kode mapel tidak ditemukan`);continue;}const type=normalizeQuestionType(r.type||'single');if(!type){errors.push(`Baris ${line}: type harus Single Choice, Multi Choice, Benar/Salah, atau Esai`);continue;}const keys=type==='essay'?[]:(type==='truefalse'?['option_a','option_b']:['option_a','option_b','option_c','option_d','option_e']);const options=keys.map((k,i)=>({text:clean(r[k]),image_path:clean(r[k+'_image']||r['option_'+String.fromCharCode(97+i)+'_image'])||null}));prepared.push({subject_id:s.id,type,text:clean(r.text||r.soal),options,correct:parseCorrect(r.correct??r.kunci,type),points:Number(r.points)>0?Number(r.points):1,difficulty:({'easy':'easy','mudah':'easy','medium':'medium','sedang':'medium','hard':'hard','sulit':'hard'})[clean(r.difficulty).toLowerCase()]||'medium',tags:clean(r.tags)||null,explanation:clean(r.explanation||r.answer_guide)||null,status:['draft','draf'].includes(clean(r.status).toLowerCase())?'draft':'ready',image_path:clean(r.image_path||r.image_url)||null});}if(errors.length)return res.status(400).json({error:'Validasi gagal. Tidak ada soal yang diimpor.',details:errors});const ins=db.transaction(()=>{const q=db.prepare('INSERT INTO questions(subject_id,type,text,options_json,correct_json,points,image_path,explanation,difficulty,tags,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');for(const x of prepared)q.run(x.subject_id,x.type,x.text,JSON.stringify(x.options),JSON.stringify(x.correct),x.points,x.image_path,x.explanation,x.difficulty,x.tags,x.status,now());});ins();res.json({imported:prepared.length});}catch(e){res.status(400).json({error:e.message});}finally{finishUpload(req.file);}});

app.listen(PORT,HOST,()=>console.log(`CBT server: http://localhost:${PORT}`));
