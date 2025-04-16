# LangGraph Durable Object Checkpointer {WIP}

This is a checkpointer for LangGraph that uses Cloudflare Durable Objects to store checkpoint data. It provides a durable, distributed storage solution for LangGraph state management.

## Overview

Durable objects are a Cloudflare Workers feature that allows you to store durable state in short-lived compute nodes. If you're familiar with the actor model, durable objects are Cloudflare's equivalent.

The checkpointer works by treating every thread as a durable object. When a checkpoint is made, the checkpointer creates a durable object if it doesn't already exist and uses the object's SQLite-like storage to save checkpoint data.

### Key Components

The package exports three main classes:

1. **DurableThreadObject**
   - Stores checkpoint data for a single thread
   - Manages SQLite storage for checkpoints and writes
   - Handles thread-specific operations

2. **DurableGraphObject**
   - Coordinates between threads
   - Maintains a registry of all active threads
   - Enables thread discovery and management

3. **DurableObjectSaver**
   - Extends `BaseCheckpointSaver` for LangGraph integration
   - Handles serialization/deserialization of checkpoint data
   - Coordinates with DurableThreadObject and DurableGraphObject

### Source links

- [Checkpointer source](packages/checkpoint-durable-object/lib/index.ts)
- [Example worker](examples/basic-worker/src/index.ts)

### Related

- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Agents SDK][https://www.npmjs.com/package/agents]
