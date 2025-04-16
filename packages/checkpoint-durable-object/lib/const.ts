// the object SQL api doesn't have any rendition of a "prepared statement," so for readability I put the big SQL strings here

import { TASKS } from "@langchain/langgraph-checkpoint";

/** Table Statements */

export function createThreadsSql() {
  return [
    `CREATE TABLE IF NOT EXISTS threads (`,
    `  thread_id TEXT NOT NULL,`,
    `  PRIMARY KEY (thread_id)`,
    `);`,
  ].join("\n");
}

export type CheckpointRow = {
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string;
  checkpoint: any;
  metadata: any;
};
export function createCheckpointsSql() {
  return [
    `CREATE TABLE IF NOT EXISTS checkpoints (`,
    `  checkpoint_ns TEXT NOT NULL DEFAULT '',`,
    `  checkpoint_id TEXT NOT NULL,`,
    `  parent_checkpoint_id TEXT,`,
    `  type TEXT,`,
    `  checkpoint BLOB,`,
    `  metadata BLOB,`,
    `  PRIMARY KEY (checkpoint_ns, checkpoint_id)`,
    `);`,
  ].join("\n");
}

export type WriteRow = {
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string;
  value: any;
};
export function createWritesSql() {
  return [
    `CREATE TABLE IF NOT EXISTS writes (`,
    `  checkpoint_ns TEXT NOT NULL DEFAULT '',`,
    `  checkpoint_id TEXT NOT NULL,`,
    `  task_id TEXT NOT NULL,`,
    `  idx INTEGER NOT NULL,`,
    `  channel TEXT NOT NULL,`,
    `  type TEXT,`,
    `  value BLOB,`,
    `  PRIMARY KEY (checkpoint_ns, checkpoint_id, task_id, idx)`,
    `);`,
  ].join("\n");
}

/** Insert Statements */

export function insertCheckpointSql() {
  return [
    `INSERT OR REPLACE INTO checkpoints`,
    `(checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)`,
    `VALUES (?, ?, ?, ?, ?, ?)`,
  ].join("\n");
}

export type InsertWritesSqlParams = {
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string;
  value: string;
};
export function insertWritesSql() {
  return `INSERT OR REPLACE INTO writes (checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) VALUES (?, ?, ?, ?, ?, ?, ?)`;
}

/** Select Statements */

export type SelectCheckpointsResult = Pick<
  CheckpointRow,
  | "checkpoint_ns"
  | "checkpoint_id"
  | "parent_checkpoint_id"
  | "type"
  | "checkpoint"
  | "metadata"
>;
export function selectCheckpointsSql(after?: string[]) {
  return [
    `SELECT`,
    `  checkpoint_ns,`,
    `  checkpoint_id,`,
    `  parent_checkpoint_id,`,
    `  type,`,
    `  checkpoint,`,
    `  metadata`,
    `FROM checkpoints`,
    ...(after ?? []),
  ].join("\n");
}

export type SelectPendingWritesResult = Pick<
  WriteRow,
  "task_id" | "channel" | "type"
> & {
  value: string;
};
export function selectPendingWritesSql() {
  return [
    `SELECT`,
    `  task_id,`,
    `  channel,`,
    `  type,`,
    `  'value', CAST(value AS TEXT)`,
    `FROM writes`,
    `WHERE checkpoint_ns = ?`,
    `  AND checkpoint_id = ?`,
    `ORDER BY idx`,
  ].join("\n");
}

export type SelectPendingSendsResult = Pick<WriteRow, "type"> & {
  value: string;
};
export function selectPendingSendsSql() {
  return [
    `SELECT`,
    `  type,`,
    `  'value', CAST(value AS TEXT)`,
    `FROM writes`,
    `WHERE checkpoint_ns = ?`,
    `  AND checkpoint_id = ?`,
    `  AND channel = '${TASKS}'`,
    `ORDER BY idx`,
  ].join("\n");
}
