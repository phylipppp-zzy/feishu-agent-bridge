import {createHash} from 'node:crypto';
import type {TurnResidual} from './contracts.js';
const validId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512;
const unknown=():TurnResidual=>({status:'unknown',count:null,observedAt:null,complete:false,reason:'尚无完整的本进程任务观察或可信轮次关联'});
type Task={toolId:string|null;turnId:string|null;linkedAt:number|null;startedAtVersion:number|null};
/** One owned SDK process only. The level is never inferred from edge ordering. */
export class ClaudeResidualObservation {
  private readonly issued=new Set<string>();private readonly messages=new Map<string,string>();private readonly tools=new Map<string,string>();private readonly tasks=new Map<string,Task>();private readonly toolTasks=new Map<string,string>();private readonly levelIds=new Map<string,string>();
  private level:Set<string>|null=null;private observedAt:string|null=null;private version=0;private incomplete=false;
  constructor(private readonly nativeSessionId:string){}
  beginTurn(turnId:string):void {if(!turnId||this.issued.size>=1024){this.incomplete=true;return;}this.issued.add(turnId);}
  private remember(map:Map<string,string>,id:string,turn:string):void {if(!validId(id)||!validId(turn)||map.size>=10000){this.incomplete=true;return;}const old=map.get(id);if(old&&old!==turn){this.incomplete=true;return;}map.set(id,turn);}
  private bind():void {for(const task of this.tasks.values()){if(!task.toolId)continue;const turn=this.tools.get(task.toolId);if(!turn)continue;if(task.turnId&&task.turnId!==turn){this.incomplete=true;continue;}if(!task.turnId){task.turnId=turn;task.linkedAt=this.version;}}}
  observe(raw:unknown):void {
    if(!raw||typeof raw!=='object')return;const m=raw as Record<string,any>;if(m.session_id!==this.nativeSessionId)return;
    if((m.type==='assistant'||m.type==='stream_event')&&m.parent_tool_use_id==null&&m.parent_agent_id==null){
      const messageId=m.type==='assistant'?m.message?.id:m.event?.type==='message_start'?m.event.message?.id:undefined;
      const anchor=typeof m.user_message_uuid==='string'&&this.issued.has(m.user_message_uuid)?m.user_message_uuid:null;
      const batch=Array.isArray(m.user_message_uuids)?m.user_message_uuids:undefined;const unambiguous=!batch||batch.length===1&&batch[0]===anchor;
      if(typeof messageId==='string'&&anchor&&unambiguous)this.remember(this.messages,messageId,anchor);
      if(m.type==='assistant'&&typeof m.message?.id==='string'&&Array.isArray(m.message.content)){const turn=this.messages.get(m.message.id);if(turn)for(const b of m.message.content)if(b?.type==='tool_use'&&typeof b.id==='string')this.remember(this.tools,b.id,turn);this.bind();}
    }
    if(m.type!=='system')return;
    if(['task_started','task_notification','task_updated'].includes(m.subtype)&&!validId(m.task_id)){this.incomplete=true;return;}
    if(m.subtype==='background_tasks_changed') {if(!validId(m.uuid)||!Array.isArray(m.tasks)||m.tasks.length>10000){this.level=null;this.observedAt=null;this.incomplete=true;return;}const ids=new Set<string>();for(const task of m.tasks){if(!task||!validId(task.task_id)||ids.has(task.task_id)){this.level=null;this.observedAt=null;this.incomplete=true;return;}ids.add(task.task_id);}const digest=createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex'),prior=this.levelIds.get(m.uuid);if(prior){if(prior!==digest){this.level=null;this.observedAt=null;this.incomplete=true;}return;}if(this.levelIds.size>=10000){this.level=null;this.observedAt=null;this.incomplete=true;return;}this.levelIds.set(m.uuid,digest);this.version++;this.level=ids;this.observedAt=new Date().toISOString();return;}
    if(m.subtype==='task_updated'&&validId(m.task_id)&&m.patch&&typeof m.patch==='object'&&(m.patch.is_backgrounded===true||m.patch.status==='running'||m.patch.status==='pending')){if(this.tasks.size>=10000&&!this.tasks.has(m.task_id)){this.incomplete=true;return;}let item=this.tasks.get(m.task_id);if(!item){item={toolId:null,turnId:null,linkedAt:null,startedAtVersion:null};this.tasks.set(m.task_id,item);}item.startedAtVersion=this.version;return;}
    if((m.subtype==='task_started'||m.subtype==='task_notification')&&validId(m.task_id)){if(this.tasks.size>=10000&&!this.tasks.has(m.task_id)){this.incomplete=true;return;}const tool=validId(m.tool_use_id)?m.tool_use_id:null;let item=this.tasks.get(m.task_id);if(!item){item={toolId:tool,turnId:null,linkedAt:null,startedAtVersion:null};this.tasks.set(m.task_id,item);}else if(tool&&item.toolId&&item.toolId!==tool){this.incomplete=true;return;}else if(tool&&!item.toolId)item.toolId=tool;if(m.subtype==='task_started')item.startedAtVersion=this.version;if(item.toolId){const old=this.toolTasks.get(item.toolId);if(old&&old!==m.task_id){this.incomplete=true;return;}this.toolTasks.set(item.toolId,m.task_id);}this.bind();}
  }
  inspect(turnId:string):TurnResidual {
    if(!this.issued.has(turnId)||!this.level||!this.observedAt)return unknown();const target=[...this.tasks.entries()].filter(([,task])=>task.turnId===turnId);const running=target.filter(([id])=>this.level!.has(id)).length;const unresolved=[...this.level].some(id=>!this.tasks.get(id)?.turnId);const pendingStart=[...this.tasks.entries()].some(([id,task])=>task.startedAtVersion!==null&&task.startedAtVersion>=this.version&&!this.level!.has(id));const unsafe=this.incomplete||unresolved||pendingStart;
    if(running>0)return {status:'running',count:running,observedAt:this.observedAt,complete:!unsafe,reason:'目标轮次已登记任务的最近观察'};
    if(unsafe||!target.length||target.some(([,task])=>task.linkedAt===null||task.linkedAt>=this.version))return unknown();
    return {status:'none',count:0,observedAt:this.observedAt,complete:true,reason:'最近观察未见目标轮次已登记任务'};
  }
}
