import { type RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import {
  createCheckpointsSql,
  createWritesSql,
  SelectCheckpointsResult,
  selectCheckpointsSql,
  SelectPendingSendsResult,
  SelectPendingWritesResult,
  selectPendingSendsSql,
  selectPendingWritesSql,
  insertWritesSql,
  insertCheckpointSql,
} from "./const";
import { DurableObject } from "cloudflare:workers";
import { getStub, iife } from "./utils";

type ListTuplesOptions = CheckpointListOptions & {
  thread_id?: string;
  checkpoint_ns?: string;
  before_checkpoint_id?: string;
};

const checkpointMetadataKeys = ["source", "step", "writes", "parents"] as const;

type CheckKeys<T, K extends readonly (keyof T)[]> = [K[number]] extends [
  keyof T
]
  ? [keyof T] extends [K[number]]
    ? K
    : never
  : never;

function validateKeys<T, K extends readonly (keyof T)[]>(
  keys: CheckKeys<T, K>
): K {
  return keys;
}

const validCheckpointMetadataKeys = validateKeys<
  CheckpointMetadata,
  typeof checkpointMetadataKeys
>(checkpointMetadataKeys);

/**
 * DurableThreadObject is the actual object that holds state.
 *
 * Note that the DurableThreadObject doesn't have parity with the BaseCheckpointSaver. Because of the way that serialization/RPC works,
 * the workers runtime is very selective about what can be passed between compute contexts. We'll handle all the serialization/conformance
 * in the target that interacts with the thread object. Many of the methods are the same naming wise for simplicity's sake.
 */
export class DurableThreadObject<Env = unknown> extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // this will block any requests from coming in until the database is ready
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(createCheckpointsSql());
      this.sql.exec(createWritesSql());
    });
  }

  getThreadId(): string {
    return this.ctx.id.toString();
  }

  protected async getCheckpointsWithPendingActions(
    after?: string[],
    args: (string | undefined)[] = []
  ) {
    const checkpointsCursor = this.sql.exec<SelectCheckpointsResult>(
      selectCheckpointsSql(after),
      ...args
    );

    const fqCheckpoints = [];

    for (const row of checkpointsCursor) {
      const pendingWritesCursor =
        await this.sql.exec<SelectPendingWritesResult>(
          selectPendingWritesSql(),
          ...[row.checkpoint_ns, row.checkpoint_id]
        );
      const pendingSendsCursor = await this.sql.exec<SelectPendingSendsResult>(
        selectPendingSendsSql(),
        ...[row.checkpoint_ns, row.checkpoint_id]
      );
      fqCheckpoints.push({
        row,
        pendingWrites: pendingWritesCursor.toArray(),
        pendingSends: pendingSendsCursor.toArray(),
      });
    }
    return fqCheckpoints;
  }

  async getTuple(checkpoint_id?: string, checkpoint_ns?: string) {
    const args = checkpoint_id
      ? [checkpoint_ns, checkpoint_id]
      : [checkpoint_ns];
    const checkpoints = await this.getCheckpointsWithPendingActions(
      [
        `WHERE checkpoint_ns = ?`,
        Boolean(checkpoint_id)
          ? `  AND checkpoint_id = ?`
          : `  ORDER BY checkpoint_id DESC LIMIT 1`,
      ],
      args
    );
    if (checkpoints.length === 0) {
      return undefined;
    }
    return checkpoints[0];
  }

  async listTuples(options: ListTuplesOptions) {
    const sanitizedFilter = Object.fromEntries(
      Object.entries(options.filter ?? {}).filter(
        ([key, value]) =>
          value !== undefined &&
          validCheckpointMetadataKeys.includes(key as keyof CheckpointMetadata)
      )
    );

    const whereConditions = [
      options.thread_id ? `thread_id = ?` : "",
      options.checkpoint_ns !== null && options.checkpoint_ns !== undefined
        ? `checkpoint_ns = ?`
        : "",
      options.before_checkpoint_id ? `checkpoint_id < ?` : "",
      ...Object.keys(sanitizedFilter).map(
        (key) => `jsonb(CAST(metadata AS TEXT))->'$.${key}' = ?`
      ),
    ].filter(Boolean);

    const checkpoints = await this.getCheckpointsWithPendingActions(
      [
        whereConditions.length > 0
          ? `WHERE\n  ${whereConditions.join(" AND\n  ")}`
          : null,
        "ORDER BY checkpoint_id DESC",
        options.limit ? `LIMIT ${options.limit}` : null,
      ].filter(Boolean) as string[],
      [
        options.thread_id,
        options.checkpoint_ns,
        options.before_checkpoint_id,
        ...Object.values(sanitizedFilter).map((value) => JSON.stringify(value)),
      ].filter((value) => value !== undefined && value !== null)
    );

    return checkpoints;
  }

  async putTuple(
    checkpoint: Checkpoint,
    encodingType: string,
    serializedCheckpoint: any,
    serializedMetadata: any,
    parent_checkpoint_id: string = "",
    checkpoint_ns: string = ""
  ) {
    this.sql.exec(
      insertCheckpointSql(),
      ...[
        checkpoint_ns,
        checkpoint.id,
        parent_checkpoint_id,
        encodingType,
        serializedCheckpoint,
        serializedMetadata,
      ]
    );

    return {
      checkpoint_ns,
      checkpoint_id: checkpoint.id,
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: [string, [string, unknown]][],
    taskId: string
  ): Promise<void> {
    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }
    if (!config.configurable.thread_id) {
      throw new Error("Missing thread_id field in config.configurable.");
    }
    if (!config.configurable.checkpoint_id) {
      throw new Error("Missing checkpoint_id field in config.configurable.");
    }

    for (const [idx, write] of writes.entries()) {
      const [channel, [type, value]] = write;
      this.sql.exec(
        insertWritesSql(),
        ...[
          config.configurable?.checkpoint_ns,
          config.configurable?.checkpoint_id,
          taskId,
          idx,
          channel,
          type,
          value,
        ]
      );
    }
  }
}

export class DurableGraphObject<Env = unknown> extends DurableObject<Env> {
  threads: string[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const results = await ctx.storage.list({ prefix: "thread:" });
      this.threads = Array.from(results.keys());
    });
  }

  async ensureThread(thread_id: string) {
    if (!this.threads.includes(thread_id)) {
      await this.ctx.storage.put(`thread:${thread_id}`, "");
      this.threads.push(thread_id);
    }
  }

  async getThreads() {
    return this.threads;
  }
}

export class DurableObjectSaver<Env = unknown> extends BaseCheckpointSaver {
  constructor(
    protected threadNamespace: DurableObjectNamespace<DurableThreadObject<Env>>,
    protected getGraphStub: () => DurableObjectStub<DurableGraphObject<Env>>
  ) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};

    const stub = getStub(this.threadNamespace, thread_id);
    const result = await stub.getTuple(checkpoint_id, checkpoint_ns);
    if (!result) {
      return undefined;
    }

    const outputConfig = checkpoint_id
      ? config
      : {
          configurable: {
            thread_id,
            checkpoint_ns,
            checkpoint_id: result.row.checkpoint_id,
          },
        };
    if (outputConfig.configurable?.thread_id === undefined) {
      throw new Error("Missing thread_id field in config.configurable.");
    }
    if (outputConfig.configurable?.checkpoint_id === undefined) {
      throw new Error("Missing checkpoint_id field in config.configurable.");
    }

    const serializedPendingWrites = await Promise.all(
      result.pendingWrites.map(async (write) => {
        return [
          write.task_id,
          write.channel,
          await this.serde.loadsTyped(write.type ?? "json", write.value),
        ] as [string, string, unknown];
      })
    );
    const serializedPendingSends = await Promise.all(
      result.pendingSends.map(async (send) => {
        return await this.serde.loadsTyped(
          send.type ?? "json",
          send.value ?? ""
        );
      })
    );
    const serializedCheckpoint: Checkpoint = {
      ...(await this.serde.loadsTyped(
        result.row.type ?? "json",
        // @ts-ignore
        result.row.checkpoint as any
      )),
      pending_sends: serializedPendingSends,
    };
    const serializedMetadata: CheckpointMetadata = await this.serde.loadsTyped(
      result.row.metadata.type ?? "json",
      result.row.metadata
    );

    return {
      checkpoint: serializedCheckpoint,
      config: outputConfig,
      metadata: serializedMetadata,
      parentConfig: result.row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id,
              checkpoint_ns,
              checkpoint_id: result.row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites: serializedPendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;

    const threads = await iife(async () => {
      if (thread_id) {
        return [thread_id];
      } else {
        const stub = await this.getGraphStub();
        return await stub.getThreads();
      }
    });

    for (const thread of threads) {
      const stub = getStub(this.threadNamespace, thread);
      const result = await stub.listTuples({
        thread_id,
        checkpoint_ns,
        before_checkpoint_id: options.before?.configurable?.checkpoint_id,
        ...options,
      });

      for (const tuple of result) {
        const serializedPendingWrites = await Promise.all(
          tuple.pendingWrites.map(async (write) => {
            return [
              write.task_id,
              write.channel,
              await this.serde.loadsTyped(write.type ?? "json", write.value),
            ] as [string, string, unknown];
          })
        );
        const serializedPendingSends = await Promise.all(
          tuple.pendingSends.map(async (send) => {
            return await this.serde.loadsTyped(
              send.type ?? "json",
              send.value ?? ""
            );
          })
        );
        const serializedCheckpoint: Checkpoint = {
          ...(await this.serde.loadsTyped(
            tuple.row.type ?? "json",
            tuple.row.checkpoint as any
          )),
          pending_sends: serializedPendingSends,
        };
        const serializedMetadata: CheckpointMetadata =
          await this.serde.loadsTyped(
            tuple.row.metadata.type ?? "json",
            tuple.row.metadata.checkpoint
          );
        yield {
          config: {
            configurable: {
              thread_id,
              checkpoint_ns: tuple.row.checkpoint_ns,
              checkpoint_id: tuple.row.checkpoint_id,
            },
          },
          checkpoint: serializedCheckpoint,
          metadata: serializedMetadata,
          parentConfig: tuple.row.parent_checkpoint_id
            ? {
                configurable: {
                  thread_id,
                  checkpoint_ns: tuple.row.checkpoint_ns,
                  checkpoint_id: tuple.row.parent_checkpoint_id,
                },
              }
            : undefined,
          pendingWrites: serializedPendingWrites,
        };
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }

    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    const parent_checkpoint_id = config.configurable?.checkpoint_id;

    if (!thread_id) {
      throw new Error(
        `Missing "thread_id" field in passed "config.configurable".`
      );
    }

    const [type1, serializedCheckpoint] = await this.serde.dumpsTyped(
      checkpoint
    );
    const [type2, serializedMetadata] = await this.serde.dumpsTyped(metadata);
    if (type1 !== type2) {
      throw new Error(
        "Failed to serialized checkpoint and metadata to the same type."
      );
    }

    const stub = getStub(this.threadNamespace, thread_id);
    await stub.putTuple(
      checkpoint,
      type1,
      serializedCheckpoint,
      serializedMetadata,
      parent_checkpoint_id,
      checkpoint_ns
    );

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }
    if (!config.configurable.thread_id) {
      throw new Error("Missing thread_id field in config.configurable.");
    }
    if (!config.configurable.checkpoint_id) {
      throw new Error("Missing checkpoint_id field in config.configurable.");
    }

    const stub = getStub(this.threadNamespace, config.configurable?.thread_id);
    const serializedWrites = await Promise.all(
      writes.map(async (write) => {
        const [type, serializedWrite] = await this.serde.dumpsTyped(write[1]);
        return [write[0], [type, serializedWrite]];
      })
    );

    // tmp
    delete config.signal;

    await stub.putWrites(config, serializedWrites, taskId);
  }
}

export * from "./utils";
