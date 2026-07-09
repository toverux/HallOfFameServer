import type { ClientSession, Db } from 'mongodb';

export interface Migration {
  readonly run: (db: Db, session: ClientSession) => Promise<void>;
}
