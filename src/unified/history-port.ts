import type {Message, Session} from './contracts.js';
/** Trusted local reader, scoped by a persisted session's native identity. */
export interface HistoryReader { read(session:Session):Promise<Message[]> }
