/**
 * Y-app extension RPC bridge — postMessage wrapper around the parent
 * Y-app's ExtensionHost.
 *
 * Wire protocol (must match packages/frontend/src/components/ExtensionHost.tsx):
 *   iframe → parent   { id, type: "yapp-ext.rpc",       method, args }
 *   parent → iframe   { id, type: "yapp-ext.rpc.reply", ok: true,  result }
 *                   | { id, type: "yapp-ext.rpc.reply", ok: false, error }
 *
 * Allowed methods (DISPATCH map in ExtensionHost.tsx):
 *   fetchList(doctype, params)
 *   fetchDocument(doctype, name)
 *   updateDocument(doctype, name, patch)
 *   createDocument(doctype, doc)
 *   callMethod(method, params)
 *   getActiveInstanceId()
 *   getErpNextAppUrl()
 *   fetchPrivateFile(path)
 */

type RpcReply =
  | { id: string; type: "yapp-ext.rpc.reply"; ok: true; result: unknown }
  | { id: string; type: "yapp-ext.rpc.reply"; ok: false; error: string };

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let counter = 0;

window.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as RpcReply | null;
  if (!data || data.type !== "yapp-ext.rpc.reply") return;
  const p = pending.get(String(data.id));
  if (!p) return;
  pending.delete(String(data.id));
  if (data.ok) p.resolve(data.result);
  else p.reject(new Error(data.error));
});

function call<T>(method: string, args: unknown[] = []): Promise<T> {
  const id = `r${++counter}_${Date.now()}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.parent.postMessage({ id, type: "yapp-ext.rpc", method, args }, "*");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }
    }, 30_000);
  });
}

export interface ListParams {
  fields?: string[];
  filters?: unknown[][];
  limit_page_length?: number;
  limit_start?: number;
  order_by?: string;
}

export const yapp = {
  fetchList: <T = Record<string, unknown>>(doctype: string, params?: ListParams) =>
    call<T[]>("fetchList", [doctype, params]),
  fetchDocument: <T = Record<string, unknown>>(doctype: string, name: string) =>
    call<T>("fetchDocument", [doctype, name]),
  updateDocument: (doctype: string, name: string, patch: Record<string, unknown>) =>
    call<unknown>("updateDocument", [doctype, name, patch]),
  createDocument: (doctype: string, doc: Record<string, unknown>) =>
    call<unknown>("createDocument", [doctype, doc]),
  callMethod: (method: string, params?: Record<string, unknown>) =>
    call<unknown>("callMethod", [method, params]),
  getActiveInstanceId: () => call<string>("getActiveInstanceId"),
  getErpNextAppUrl: () => call<string>("getErpNextAppUrl"),
  fetchPrivateFile: (path: string) =>
    call<{ contentType: string; base64: string }>("fetchPrivateFile", [path]),
};
