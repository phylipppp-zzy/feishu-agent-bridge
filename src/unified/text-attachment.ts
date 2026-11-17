/** Text is a bounded value, never a filesystem path. */
export const MAX_TEXT_ATTACHMENT_BYTES=1024*1024;
export function attachmentDisplayName(value:string):string {const name=[...value.normalize('NFC').replace(/[\/\\\x00-\x1f\x7f]/g,'_')].slice(0,120).join('').trim();return name||'attachment.txt';}
export function decodeTextAttachment(bytes:Uint8Array,limit=MAX_TEXT_ATTACHMENT_BYTES):string {if(!(bytes instanceof Uint8Array)||bytes.length===0||bytes.length>limit)throw Error('invalid text attachment size');let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw Error('invalid UTF-8 attachment')}if(text.includes('\0'))throw Error('NUL in text attachment');return text;}
export function textAttachmentBlock(name:string,bytes:Uint8Array,limit=MAX_TEXT_ATTACHMENT_BYTES):string{return `File content (${JSON.stringify(attachmentDisplayName(name))}):\n${decodeTextAttachment(bytes,limit)}`;}
