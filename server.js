require("dotenv").config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db', 'db.json');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'public', 'uploads'), { recursive: true });

const defaultDb = { users: [], login_history: [], products: [], orders: [], tickets: [], ticket_messages: [], invoices: [], licenses: [], twofa_codes: [] };
function loadDb(){
  if(!fs.existsSync(DB_FILE)) return structuredClone(defaultDb);
  try { return {...structuredClone(defaultDb), ...JSON.parse(fs.readFileSync(DB_FILE,'utf8'))}; } catch(e){ return structuredClone(defaultDb); }
}
let db = loadDb();
function saveDb(){ fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }
function nextId(table){ return (db[table].reduce((m,x)=>Math.max(m, x.id||0),0)+1); }
function now(){ return new Date().toISOString().replace('T',' ').slice(0,19); }
function moneyValue(total){
  const nums = String(total||'').match(/\d+(?:[.,]\d+)?/g);
  if(!nums || nums.length===0) return 0;
  return Math.max(...nums.map(n=>Number(n.replace(',', '.'))||0));
}
function formatEuro(n){ return (Math.round(n*100)/100).toLocaleString('fr-FR') + ' €'; }
function isRevenueStatus(status){ return ['Payée','En développement','Livrée','Terminée'].includes(status); }
function recomputeStats(){
  const revenue = db.orders.filter(o=>isRevenueStatus(o.status)).reduce((sum,o)=>sum+moneyValue(o.total),0);
  return {users:db.users.length,tickets:db.tickets.length,openTickets:db.tickets.filter(t=>t.status==='Ouvert').length,orders:db.orders.length,finishedOrders:db.orders.filter(o=>o.status==='Terminée').length,revenue:formatEuro(revenue)};
}
function publicUser(u){ return u ? {id:u.id,email:u.email,role:u.role,username:u.username,avatar:u.avatar,discord_id:u.discord_id||null} : null; }

function clean2faCodes(){
  const t = Date.now();
  db.twofa_codes = (db.twofa_codes || []).filter(c => new Date(c.expires_at).getTime() > t && (c.attempts || 0) < 5);
}
function make2faCode(){ return String(crypto.randomInt(100000, 1000000)); }
function gmailConfigured(){ return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD); }
function mailTransporter(){
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    family: 4,
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 30000,
    auth: {
      user: process.env.GMAIL_USER,
      pass: String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '')
    }
  });
}

async function send2faEmail(user, code){
  if(!gmailConfigured()) throw new Error('Variables Gmail manquantes sur Railway');
  await mailTransporter().sendMail({
    from: `"HighDevelopment Sécurité" <${process.env.GMAIL_USER}>`,
    to: user.email,
    subject: 'Code de connexion HighDevelopment',
    html: `
      <div style="font-family:Arial;background:#060b18;color:#eef4ff;padding:24px;border-radius:16px">
        <h2 style="color:#7dd3fc">HighDevelopment</h2>
        <p>Voici votre code de vérification :</p>
        <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#101a33;padding:16px;border-radius:12px;display:inline-block">${code}</div>
        <p>Ce code expire dans <b>5 minutes</b>.</p>
        <p style="color:#93a4c7">Si vous n'avez pas demandé cette connexion, ignorez cet e-mail.</p>
      </div>`
  });
}
async function sendEmailChangeCodeEmail(to, code){
  if(!gmailConfigured()) throw new Error('Variables Gmail manquantes');
  await mailTransporter().sendMail({
    from: `"HighDevelopment Sécurité" <${process.env.GMAIL_USER}>`,
    to,
    subject: 'Code de changement d’adresse e-mail HighDevelopment',
    html: `
      <div style="font-family:Arial;background:#060b18;color:#eef4ff;padding:24px;border-radius:16px">
        <h2 style="color:#7dd3fc">HighDevelopment</h2>
        <p>Voici le code pour confirmer votre nouvelle adresse e-mail :</p>
        <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#101a33;padding:16px;border-radius:12px;display:inline-block">${code}</div>
        <p>Ce code expire dans <b>5 minutes</b>.</p>
        <p style="color:#93a4c7">Si vous n’avez pas demandé cette modification, ignorez cet e-mail.</p>
      </div>`
  });
}
async function sendEmailChangedNotice(to, newEmail){
  if(!gmailConfigured()) return;
  try{
    await mailTransporter().sendMail({
      from: `"HighDevelopment Sécurité" <${process.env.GMAIL_USER}>`,
      to,
      subject: 'Adresse e-mail HighDevelopment modifiée',
      html: `
        <div style="font-family:Arial;background:#060b18;color:#eef4ff;padding:24px;border-radius:16px">
          <h2 style="color:#7dd3fc">HighDevelopment</h2>
          <p>Votre adresse e-mail vient d’être modifiée.</p>
          <p>Nouvelle adresse : <b>${newEmail}</b></p>
          <p style="color:#93a4c7">Si ce n’est pas vous, contactez immédiatement le support.</p>
        </div>`
    });
  }catch(e){ console.error('Email change notice error:', e.message); }
}
async function createAndSend2fa(req, user){
  clean2faCodes();
  const recent = (db.twofa_codes || []).filter(c => c.user_id === user.id && new Date(c.created_at).getTime() > Date.now() - 60_000);
  if(recent.length >= 2) throw new Error('Trop de codes envoyés. Réessayez dans 1 minute.');
  const code = make2faCode();
  db.twofa_codes = (db.twofa_codes || []).filter(c => c.user_id !== user.id);
  db.twofa_codes.push({
    id: nextId('twofa_codes'),
    user_id: user.id,
    code_hash: bcrypt.hashSync(code, 10),
    attempts: 0,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    ip: req.ip
  });
  saveDb();
  await send2faEmail(user, code);
}
function startPending2fa(req, user){
  req.session.pending2fa = { userId:user.id, email:user.email, createdAt:Date.now() };
}


function discordConfigured(){
  return Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_CALLBACK_URL);
}

const DISCORD_ROLE_IDS = {
  allPerm: ['1521513403779121152', '1519768720581333232'],
  modo: ['1519768721856659517'],
  support: ['1520104798060412948'],
  member: ['1519768729100091484']
};

function hasAnyRole(memberRoles, ids){
  return ids.some(id => memberRoles.includes(id));
}

function syncedSiteRole(member){
  const roles = (member && member.roles) ? member.roles.map(String) : [];
  if(hasAnyRole(roles, DISCORD_ROLE_IDS.allPerm)) return 'Owner';
  if(hasAnyRole(roles, DISCORD_ROLE_IDS.modo)) return 'Modo';
  if(hasAnyRole(roles, DISCORD_ROLE_IDS.support)) return 'Support';
  return 'Membre';
}

function discordAvatarUrl(discordUser){
  if(!discordUser.avatar) return '/img/logo.png';
  return `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=256`;
}

function discordOauthUrl(){
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_CALLBACK_URL,
    response_type: 'code',
    scope: 'identify email guilds.members.read',
    prompt: 'none'
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeDiscordCode(code){
  const body = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.DISCORD_CALLBACK_URL
  });

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const tokenData = await tokenRes.json();
  if(!tokenRes.ok){
    throw new Error(tokenData.error_description || tokenData.error || 'Erreur OAuth Discord');
  }

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });

  const discordUser = await userRes.json();
  if(!userRes.ok){
    throw new Error(discordUser.message || 'Impossible de récupérer le profil Discord');
  }

  if(!process.env.DISCORD_GUILD_ID){
    throw new Error('DISCORD_GUILD_ID manquant dans Railway. Ajoute l’ID du serveur HighDevelopment.');
  }

  const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${process.env.DISCORD_GUILD_ID}/member`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  const member = await memberRes.json();
  if(!memberRes.ok){
    throw new Error('Tu dois être sur le Discord HighDevelopment pour te connecter.');
  }

  return { discordUser, member };
}

function findOrCreateDiscordUser(discordUser, member){
  const discordId = String(discordUser.id);
  let user = db.users.find(u => String(u.discord_id || '') === discordId);

  if(!user && discordUser.email){
    user = db.users.find(u => String(u.email || '').toLowerCase() === String(discordUser.email).toLowerCase());
  }

  const discordUsername = discordUser.global_name || discordUser.username || 'Utilisateur Discord';
  const discordEmail = discordUser.email || `${discordId}@discord.local`;

  if(user){
    user.discord_id = discordId;
    user.email = user.email || discordEmail;
    user.username = discordUsername;
    user.avatar = discordAvatarUrl(discordUser);
    user.role = syncedSiteRole(member);
    user.discord_roles = member.roles || [];
    user.last_login = now();
    db.login_history.push({id:nextId('login_history'),user_id:user.id,ip:'Discord OAuth',date:now()});
    saveDb();
    return user;
  }

  const role = syncedSiteRole(member);

  user = {
    id: nextId('users'),
    email: discordEmail,
    password: bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10),
    role,
    username: discordUsername,
    avatar: discordAvatarUrl(discordUser),
    discord_id: discordId,
    discord_roles: member.roles || [],
    created_at: now(),
    last_login: now()
  };

  db.users.push(user);
  db.login_history.push({id:nextId('login_history'),user_id:user.id,ip:'Discord OAuth',date:now()});
  saveDb();
  return user;
}

function initDb(){
  if(!db.users.find(u=>u.email==='highdevelopment@tbhwf.com')){
    db.users.push({id:nextId('users'),email:'highdevelopment@tbhwf.com',password:bcrypt.hashSync('7J4UIco8j4pG!1',10),role:'Owner',username:'Owner HighDevelopment',avatar:'/img/logo.png',created_at:now(),last_login:null});
  }
  if(db.products.length===0){
    const add=(name,description,price,image,type)=>db.products.push({id:nextId('products'),name,description,price,image,type});
    add('Bot Discord Modérations','Bot Discord complet pour gérer modération, logs, sanctions et commandes staff.','10 €','/img/hd-bot.png','bot');
    add('Bot Discord Custom','Bot Discord personnalisé selon la demande client avec fonctionnalités sur mesure.','20 €','/img/hd-bot.png','bot');
    add('Script FiveM Custom','Script FiveM personnalisé, optimisé et sécurisé selon ton serveur.','25 €','/img/script-fivem.png','fivem');
    add('Base FiveM High Development','Base FiveM complète : 35 €/mois, 120 €/an ou Lifetime 200 €.','35 €/mois • 120 €/an • 200 € Lifetime','/img/base-fivem.png','fivem');
    add('Logo','Logo personnalisé pour serveur Discord, FiveM ou projet web.','5 € / unité','/img/logo.png','design');
  }
  saveDb();
}
initDb();

app.set('view engine','ejs');
app.set('views', path.join(__dirname,'views'));
app.use(express.urlencoded({extended:true}));
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));
app.use(session({secret:process.env.SESSION_SECRET || 'HighDevelopment_LOCAL_SECRET_CHANGE_ME',resave:false,saveUninitialized:false,cookie:{maxAge:1000*60*60*24*7, httpOnly:true, sameSite:'lax'}}));
app.use((req,res,next)=>{res.locals.user=req.session.user||null; next();});

const uploadDir = path.join(__dirname,'public','uploads');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(16).slice(2) + path.extname(file.originalname || '.png'))
});
const upload = multer({ storage, limits:{ fileSize: 8 * 1024 * 1024 }, fileFilter:(req,file,cb)=>{
  if(!String(file.mimetype || '').startsWith('image/')) return cb(new Error('Image uniquement'));
  cb(null,true);
}});
const TRANSCRIPT_WEBHOOK = 'https://canary.discord.com/api/webhooks/1521542727261622282/fsP2v8ABHM8baMGxfbMJbX6ovoZ-CtJJ5fcqk0MZrMBIA-y3JFSYmqtjSkgLneJMY2UM';


function requireAuth(req,res,next){ if(!req.session.user) return res.redirect('/login'); next(); }
function hasStaffPanel(role){ return ['Owner','Admin','Modo'].includes(role); }
function hasTicketPerm(role){ return ['Owner','Admin','Modo','Support'].includes(role); }
function staff(req,res,next){ if(!req.session.user || !hasStaffPanel(req.session.user.role)) return res.status(403).render('error',{msg:'Accès refusé'}); next(); }
function ticketStaff(req,res,next){ if(!req.session.user || !hasTicketPerm(req.session.user.role)) return res.status(403).render('error',{msg:'Accès refusé'}); next(); }
function admin(req,res,next){ if(!req.session.user || !['Owner','Admin'].includes(req.session.user.role)) return res.status(403).render('error',{msg:'Permission Owner/Admin requise'}); next(); }
function canBan(role){ return ['Owner','Admin','Modo'].includes(role); }
function refreshUser(req){ if(req.session.user){ const u=db.users.find(x=>x.id===req.session.user.id); if(u) req.session.user=publicUser(u); }}

app.get('/',(req,res)=>{ const stats={members:db.users.length, projects:db.orders.length, reviews:27}; res.render('home',{stats}); });
app.get('/boutique',(req,res)=>res.render('boutique',{products:db.products}));
app.get('/login',(req,res)=>res.redirect('/auth/discord'));

app.get('/auth/discord',(req,res)=>{
  if(!discordConfigured()) return res.status(500).render('error',{msg:'Connexion Discord non configurée. Ajoute DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET et DISCORD_CALLBACK_URL dans Railway.'});
  res.redirect(discordOauthUrl());
});

app.get('/auth/discord/callback', async (req,res)=>{
  try{
    if(!discordConfigured()) return res.status(500).render('error',{msg:'Connexion Discord non configurée.'});
    if(!req.query.code) return res.redirect('/');
    const { discordUser, member } = await exchangeDiscordCode(String(req.query.code));
    const user = findOrCreateDiscordUser(discordUser, member);
    if(user.role === 'Banni') return res.status(403).render('error',{msg:'Compte banni.'});
    req.session.user = publicUser(user);
    res.redirect('/dashboard');
  }catch(e){
    console.error('Discord OAuth error:', e.message);
    res.status(500).render('error',{msg:'Erreur connexion Discord : ' + e.message});
  }
});

app.post('/login',(req,res)=>res.redirect('/auth/discord'));
app.get('/verify',(req,res)=>{
  if(!req.session.pending2fa) return res.redirect('/login');
  res.render('auth/verify',{error:null,email:req.session.pending2fa.email,success:null});
});
app.post('/verify',(req,res)=>{
  if(!req.session.pending2fa) return res.redirect('/login');
  clean2faCodes();
  const userId = req.session.pending2fa.userId;
  const u=db.users.find(x=>x.id===userId);
  const record=(db.twofa_codes||[]).find(c=>c.user_id===userId);
  const code=String(req.body.code||'').replace(/\D/g,'').slice(0,6);
  if(!u || !record) return res.render('auth/verify',{error:'Code expiré. Demande un nouveau code.',email:req.session.pending2fa.email,success:null});
  if((record.attempts||0) >= 5) return res.render('auth/verify',{error:'Trop de tentatives. Demande un nouveau code.',email:req.session.pending2fa.email,success:null});
  if(!bcrypt.compareSync(code, record.code_hash)){
    record.attempts=(record.attempts||0)+1; saveDb();
    return res.render('auth/verify',{error:'Code incorrect.',email:req.session.pending2fa.email,success:null});
  }
  db.twofa_codes=(db.twofa_codes||[]).filter(c=>c.user_id!==userId);
  u.last_login=now();
  db.login_history.push({id:nextId('login_history'),user_id:u.id,ip:req.ip,date:now()});
  saveDb();
  req.session.pending2fa=null;
  req.session.user=publicUser(u);
  res.redirect('/dashboard');
});
app.post('/verify/resend', async (req,res)=>{
  if(!req.session.pending2fa) return res.redirect('/login');
  const u=db.users.find(x=>x.id===req.session.pending2fa.userId);
  if(!u) return res.redirect('/login');
  try{
    await createAndSend2fa(req,u);
    res.render('auth/verify',{error:null,email:u.email,success:'Nouveau code envoyé.'});
  }catch(e){
    res.render('auth/verify',{error:e.message || 'Impossible de renvoyer le code.',email:u.email,success:null});
  }
});

app.get('/register',(req,res)=>res.redirect('/auth/discord'));
app.post('/register',(req,res)=>res.redirect('/auth/discord'));

app.get('/logout',(req,res)=>req.session.destroy(()=>res.redirect('/')));

app.get('/dashboard',requireAuth,(req,res)=>{ refreshUser(req); const history=db.login_history.filter(h=>h.user_id===req.session.user.id).sort((a,b)=>b.id-a.id).slice(0,10); res.render('dashboard',{history}); });
app.post('/profile',requireAuth,upload.single('avatar'),(req,res)=>{ const u=db.users.find(x=>x.id===req.session.user.id); if(u){ u.username=req.body.username; if(req.file) u.avatar='/uploads/'+req.file.filename; saveDb(); } refreshUser(req); res.redirect('/dashboard'); });
app.post('/password',requireAuth,(req,res)=>{ const u=db.users.find(x=>x.id===req.session.user.id); if(u&&req.body.new_password){ u.password=bcrypt.hashSync(req.body.new_password,10); saveDb(); } res.redirect('/dashboard'); });

app.post('/order/:id',requireAuth,(req,res)=>{
  const p=db.products.find(x=>x.id===Number(req.params.id));
  if(!p) return res.redirect('/boutique');
  const order={id:nextId('orders'),user_id:req.session.user.id,product_id:p.id,status:'En attente',total:p.price,created_at:now()};
  db.orders.push(order);
  db.invoices.push({id:nextId('invoices'),user_id:req.session.user.id,order_id:order.id,total:p.price,status:'Non payée',created_at:now()});
  const t={id:nextId('tickets'),user_id:req.session.user.id,subject:'Commande #' + order.id + ' - ' + p.name,status:'Ouvert',created_at:now(),updated_at:now(),order_id:order.id};
  db.tickets.push(t);
  db.ticket_messages.push({id:nextId('ticket_messages'),ticket_id:t.id,user_id:req.session.user.id,message:'Bonjour, je viens de commander : '+p.name+' ('+p.price+').',created_at:now(),type:'text'});
  saveDb();
  res.redirect('/tickets/'+t.id);
});
app.get('/client',requireAuth,(req,res)=>{
  refreshUser(req);
  const orders=db.orders.filter(o=>o.user_id===req.session.user.id).map(o=>({...o,name:(db.products.find(p=>p.id===o.product_id)||{}).name})).sort((a,b)=>b.id-a.id);
  const invoices=db.invoices.filter(i=>i.user_id===req.session.user.id).sort((a,b)=>b.id-a.id);
  const licenses=db.licenses.filter(l=>l.user_id===req.session.user.id).sort((a,b)=>b.id-a.id);
  const tickets=db.tickets.filter(t=>t.user_id===req.session.user.id).sort((a,b)=>b.id-a.id);
  res.render('client/index',{orders,invoices,licenses,tickets});
});



app.get('/tickets',requireAuth,(req,res)=>{ const isStaff=hasTicketPerm(req.session.user.role); const tickets=(isStaff?db.tickets:db.tickets.filter(t=>t.user_id===req.session.user.id)).map(t=>({...t,email:(db.users.find(u=>u.id===t.user_id)||{}).email})).sort((a,b)=>b.id-a.id); res.render('tickets/list',{tickets}); });
app.post('/tickets',requireAuth,(req,res)=>{ const t={id:nextId('tickets'),user_id:req.session.user.id,subject:req.body.subject||'Ticket support',status:'Ouvert',created_at:now(),updated_at:now()}; db.tickets.push(t); saveDb(); res.redirect('/tickets/'+t.id); });
app.get('/tickets/:id',requireAuth,(req,res)=>{ const t=db.tickets.find(x=>x.id===Number(req.params.id)); if(!t) return res.status(404).render('error',{msg:'Ticket introuvable'}); if(t.user_id!==req.session.user.id && !hasTicketPerm(req.session.user.role)) return res.status(403).render('error',{msg:'Accès refusé'}); const owner=db.users.find(u=>u.id===t.user_id); const ticket={...t,email:owner?.email}; const messages=db.ticket_messages.filter(m=>m.ticket_id===t.id).map(m=>{const u=db.users.find(x=>x.id===m.user_id)||{}; return {...m,username:u.username,role:u.role,avatar:u.avatar};}); res.render('tickets/show',{ticket,messages}); });

async function sendTranscript(ticket){
  try{
    const owner=db.users.find(u=>u.id===ticket.user_id)||{};
    const messages=db.ticket_messages.filter(m=>m.ticket_id===ticket.id).map(m=>{
      const u=db.users.find(x=>x.id===m.user_id)||{};
      return `[${m.created_at}] ${u.username||'Utilisateur'} (${u.role||'?'}) : ${m.message || ''}${m.image_url ? ' [IMAGE: '+m.image_url+']' : ''}`;
    }).join('\n');
    const transcript = `Transcript HighDevelopment\nTicket #${ticket.id} - ${ticket.subject}\nClient: ${owner.email||'inconnu'}\nStatus: ${ticket.status}\n\n${messages}`.slice(0,180000);
    const form = new FormData();
    form.append('payload_json', JSON.stringify({content:`📄 Transcript du ticket #${ticket.id} fermé`, username:'HighDevelopment Tickets'}));
    form.append('file', new Blob([transcript], {type:'text/plain'}), `transcript-ticket-${ticket.id}.txt`);
    await fetch(TRANSCRIPT_WEBHOOK,{method:'POST',body:form});
  }catch(e){ console.error('Erreur webhook transcript:', e.message); }
}
app.post('/tickets/:id/close',ticketStaff,async (req,res)=>{
  const ticketId = Number(req.params.id);
  const t=db.tickets.find(x=>x.id===ticketId);
  if(t){
    t.status='Fermé';
    t.closed_at=now();
    saveDb();

    // 1) Envoie le transcript complet sur Discord
    await sendTranscript(t);

    // 2) Supprime complètement le ticket du panel staff / client
    db.ticket_messages = db.ticket_messages.filter(m=>m.ticket_id!==ticketId);
    db.tickets = db.tickets.filter(x=>x.id!==ticketId);
    saveDb();
  }
  res.redirect('/tickets');
});
app.post('/tickets/:id/upload',requireAuth,upload.single('image'),(req,res)=>{
  const t=db.tickets.find(x=>x.id===Number(req.params.id));
  if(!t || !req.file) return res.status(400).json({error:'Upload impossible'});
  if(t.user_id!==req.session.user.id && !hasTicketPerm(req.session.user.role)) return res.status(403).json({error:'Accès refusé'});
  const u=db.users.find(x=>x.id===req.session.user.id);
  const imageUrl='/uploads/'+req.file.filename;
  const msg={id:nextId('ticket_messages'),ticket_id:t.id,user_id:u.id,message:'Image envoyée',image_url:imageUrl,type:'image',created_at:now()};
  db.ticket_messages.push(msg); t.updated_at=now(); saveDb();
  io.to('ticket_'+t.id).emit('ticketMessage',{username:u.username,role:u.role,avatar:u.avatar,message:msg.message,image_url:imageUrl,created_at:new Date().toLocaleString('fr-FR')});
  res.json({ok:true,image_url:imageUrl});
});

app.get('/staff',staff,(req,res)=>{ const stats=recomputeStats(); res.render('staff/index',{stats}); });
app.get('/staff/users',staff,(req,res)=>{res.render('staff/users',{users:[...db.users].sort((a,b)=>b.id-a.id), canManage:['Owner','Admin'].includes(req.session.user.role), canBan:canBan(req.session.user.role)});});
app.post('/staff/users/:id/role',admin,(req,res)=>{ const u=db.users.find(x=>x.id===Number(req.params.id)); const roles=['Admin','Modo','Support','Membre']; if(req.session.user.role==='Owner') roles.push('Owner'); if(u&&roles.includes(req.body.role)){ u.role=req.body.role; saveDb(); } res.redirect('/staff/users'); });
app.post('/staff/users/:id/ban',staff,(req,res)=>{ const u=db.users.find(x=>x.id===Number(req.params.id)); if(u&&canBan(req.session.user.role)){ u.role='Banni'; saveDb();} res.redirect('/staff/users'); });
app.get('/staff/orders',staff,(req,res)=>{ const orders=db.orders.map(o=>({...o,email:(db.users.find(u=>u.id===o.user_id)||{}).email,name:(db.products.find(p=>p.id===o.product_id)||{}).name})).sort((a,b)=>b.id-a.id); res.render('staff/orders',{orders}); });
app.post('/staff/orders/:id/status',staff,(req,res)=>{
  const o=db.orders.find(x=>x.id===Number(req.params.id));
  if(o){
    o.status=req.body.status;
    o.updated_at=now();
    const invoice=db.invoices.find(i=>i.order_id===o.id);
    if(invoice){
      invoice.status = isRevenueStatus(o.status) ? 'Payée' : (o.status==='Annulée' ? 'Annulée' : 'Non payée');
      invoice.total = o.total;
    }
    if(o.status==='Terminée' && !db.licenses.find(l=>l.order_id===o.id)){
      const key='HD-' + Math.random().toString(36).slice(2,8).toUpperCase() + '-' + Math.random().toString(36).slice(2,8).toUpperCase();
      db.licenses.push({id:nextId('licenses'),user_id:o.user_id,order_id:o.id,key,status:'Active',created_at:now()});
    }
    saveDb();
  }
  res.redirect('/staff/orders');
});

io.on('connection',(socket)=>{
  socket.on('joinTicket', id => socket.join('ticket_'+id));
  socket.on('ticketMessage', data=>{
    const userId=Number(data.userId), ticketId=Number(data.ticketId); const u=db.users.find(x=>x.id===userId); const t=db.tickets.find(x=>x.id===ticketId); if(!u||!t) return;
    const msg={id:nextId('ticket_messages'),ticket_id:ticketId,user_id:userId,message:String(data.message).slice(0,2000),created_at:now(),type:'text'};
    db.ticket_messages.push(msg); t.updated_at=now(); saveDb();
    io.to('ticket_'+ticketId).emit('ticketMessage',{username:u.username,role:u.role,avatar:u.avatar,message:msg.message,created_at:new Date().toLocaleString('fr-FR')});
  });
});

app.use((req,res)=>res.status(404).render('error',{msg:'Page introuvable'}));
server.listen(PORT, '0.0.0.0', () => {
  console.log('HighDevelopment lancé sur le port ' + PORT);
});
