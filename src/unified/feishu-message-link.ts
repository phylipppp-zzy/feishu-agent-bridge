/** Build Feishu app links from verified API metadata, never from a root-as-thread guess. */
export interface MessageLinkFields { chat_id?:unknown; thread_id?:unknown; message_position?:unknown; thread_message_position?:unknown; message_app_link?:unknown }
function numericPosition(value:unknown):string|null {
  if(typeof value==='string') {const input=value.trim();if(!input || input.length>128 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(input))return null;value=input;}
  if(typeof value!=='number' && typeof value!=='string') return null;const n=Number(value);if(!Number.isFinite(n))return null;
  const text=String(n);if(!/[eE]/.test(text))return text;
  const m=/^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(text);if(!m)return null;const sign=m[1]!,digits=m[2]!+(m[3]??''),point=m[2]!.length+Number(m[4]);return sign+(point<=0 ? `0.${'0'.repeat(-point)}${digits}` : point>=digits.length ? digits+'0'.repeat(point-digits.length) : `${digits.slice(0,point)}.${digits.slice(point)}`);
}
export function verifiedMessageAppLink(m:MessageLinkFields):string|null {
  if(typeof m.message_app_link==='string' && m.message_app_link.trim()) {try {const u=new URL(m.message_app_link.trim());if(u.protocol==='https:' && ['applink.feishu.cn','applink.larksuite.com'].includes(u.hostname) && !u.username && !u.password && !u.port && ['/client/chat/open','/client/thread/open'].includes(u.pathname)) return u.toString();} catch { /* construct from verified fields */ }}
  if(typeof m.chat_id!=='string' || !m.chat_id.trim())return null;const threadPos=numericPosition(m.thread_message_position),msgPos=numericPosition(m.message_position);
  if(typeof m.thread_id==='string' && m.thread_id.trim() && threadPos!==null) {const q=new URLSearchParams({openthreadid:m.thread_id,openchatid:m.chat_id,open_thread_id:m.thread_id,open_chat_id:m.chat_id,thread_position:threadPos});return `https://applink.feishu.cn/client/thread/open?${q}`;}
  if(msgPos!==null) {const q=new URLSearchParams({openChatId:m.chat_id,position:msgPos});return `https://applink.feishu.cn/client/chat/open?${q}`;}return null;
}
