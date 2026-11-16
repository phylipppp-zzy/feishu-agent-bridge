import {StringDecoder} from 'node:string_decoder';
import type {Readable} from 'node:stream';
/** Preserve UTF-8 code points across arbitrary stream chunk boundaries. */
export async function* readNativeTestLines(input:Readable,maxBytes=1024*1024):AsyncGenerator<string> {
  const decoder=new StringDecoder('utf8');let buffer='';
  for await(const chunk of input){buffer+=typeof chunk==='string'?chunk:decoder.write(chunk as Buffer);if(Buffer.byteLength(buffer)>maxBytes)throw Error('native test frame too large');for(;;){const at=buffer.indexOf('\n');if(at<0)break;yield buffer.slice(0,at);buffer=buffer.slice(at+1);}}
  buffer+=decoder.end();if(buffer)throw Error('incomplete native test frame');
}
/** HTTP model fixture body reader; the limit is counted before UTF-8 decoding. */
export async function readNativeTestBody(input:Readable,maxBytes=4*1024*1024):Promise<string> {
  const decoder=new StringDecoder('utf8');let body='',bytes=0;
  for await(const chunk of input){const data=typeof chunk==='string'?Buffer.from(chunk,'utf8'):chunk as Buffer;bytes+=data.length;if(bytes>maxBytes)throw Error('native test body too large');body+=decoder.write(data);}
  return body+decoder.end();
}
