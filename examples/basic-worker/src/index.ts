import { DurableObjectSaver } from "checkpoint-durable-object";
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { Hono } from "hono";

const StateAnnotation = Annotation.Root({
  messages: Annotation<string[]>({
    value: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

const node1 = async (state: typeof StateAnnotation.State) => {
  return {
    messages: ["Hello from node 1!"],
  };
};

const node2 = async (state: typeof StateAnnotation.State) => {
  return {
    messages: ["Hello from node 2!"],
  };
};

const app = new Hono<{ Bindings: Env }>();

app.get("*", async (c) => {
  const saver = new DurableObjectSaver(
    c.env.LANGCHAIN_THREADS,
    () =>
      c.env.LANGCHAIN_THREADS.get(
        c.env.LANGCHAIN_THREADS.idFromName("agent1")
      ) as any
  );
  const builder = new StateGraph(StateAnnotation)
    .addNode("node1", node1)
    .addNode("node2", node2)
    .addEdge(START, "node1")
    .addEdge("node1", "node2")
    .addEdge("node2", END);

  const graph = builder.compile({
    checkpointer: saver,
  });

  const threadId = c.req.path;

  const result = await graph.invoke(
    { messages: [] },
    { configurable: { thread_id: threadId } }
  );

  return new Response(JSON.stringify(result, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});

export default app;

export {
  DurableGraphObject,
  DurableThreadObject,
} from "checkpoint-durable-object";
