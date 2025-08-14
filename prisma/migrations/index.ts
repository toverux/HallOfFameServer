import type { ClientSession, Db } from 'mongodb';

/** @public */
export interface Migration {
  readonly run: (db: Db, session: ClientSession) => Promise<void>;
}
