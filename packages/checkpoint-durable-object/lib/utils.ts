import { DurableObject } from "cloudflare:workers";

export const iife = <T>(fn: () => T): T => fn();

export function getStub<T extends DurableObject>(
  namespace: DurableObjectNamespace<T>,
  id?: DurableObjectId | string
): DurableObjectStub<T> {
  const stubId = iife(() => {
    if (!id) return namespace.newUniqueId();
    if (typeof id === "string") {
      // Check if the provided id is a string representation of the
      // 256-bit Durable Object ID
      if (id.match(/^[0-9a-f]{64}$/)) return namespace.idFromString(id);
      else return namespace.idFromName(id);
    }
    return id;
  });
  const stub = namespace.get(stubId);
  return stub;
}
