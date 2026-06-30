const socket = io();
socket.emit('joinTicket', window.TICKET_ID);
const chat = document.getElementById('chat');
const form = document.getElementById('chatForm');
const input = document.getElementById('message');
const autoButtons = document.querySelectorAll('[data-auto-reply]');

function addMsg(m){
  const d=document.createElement('div');
  d.className='msg';
  const image = m.image_url ? `<a href="${m.image_url}" target="_blank"><img class="ticket-img" src="${m.image_url}"></a>` : '';
  d.innerHTML=`<img src="${m.avatar||'/img/logo.png'}"><div><b>${escapeHtml(m.username||'Utilisateur')} <span>${escapeHtml(m.role||'')}</span></b><p></p>${image}<small>${escapeHtml(m.created_at||'')}</small></div>`;
  d.querySelector('p').textContent=m.message || '';
  chat.appendChild(d); chat.scrollTop=chat.scrollHeight;
}
function escapeHtml(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function sendMessage(msg){
  msg=(msg||'').trim();
  if(!msg)return;
  socket.emit('ticketMessage',{ticketId:window.TICKET_ID,userId:window.USER_ID,message:msg});
}
form.addEventListener('submit',e=>{e.preventDefault(); sendMessage(input.value); input.value='';});
autoButtons.forEach(btn=>btn.addEventListener('click',()=>sendMessage(btn.dataset.autoReply)));

async function uploadImage(file){
  if(!file || !file.type.startsWith('image/')) return;
  const fd = new FormData();
  fd.append('image', file);
  input.placeholder='Upload de l’image...';
  try { await fetch(`/tickets/${window.TICKET_ID}/upload`, {method:'POST', body:fd}); }
  finally { input.placeholder='Écrire un message ou CTRL+V une image...'; }
}
window.addEventListener('paste', e=>{
  const items = e.clipboardData && e.clipboardData.items;
  if(!items) return;
  for(const item of items){
    if(item.type && item.type.startsWith('image/')){
      e.preventDefault(); uploadImage(item.getAsFile()); break;
    }
  }
});
socket.on('ticketMessage', addMsg);
chat.scrollTop=chat.scrollHeight;
