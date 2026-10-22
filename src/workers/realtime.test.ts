/* realtime.js: one shared socket, channel routing, presence, broadcast, rejoin after a drop.
   (Delivery itself is Supabase's; this checks our side of the Phoenix protocol with a fake socket.) */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Msg = { topic: string; event: string; payload: Record<string, unknown>; ref: string; join_ref?: string };
class FakeWS {
  static all: FakeWS[] = [];
  sent: Msg[] = []; closed = false;
  onopen?: () => void; onmessage?: (m: { data: string }) => void; onclose?: () => void;
  url: string;
  constructor(url: string) { this.url = url; FakeWS.all.push(this); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; }
  push(x: object) { this.onmessage!({ data: JSON.stringify(x) }); }
  joinOf(topic: string) { return this.sent.filter(m => m.event === "phx_join" && m.topic === topic).at(-1)!; }
  ok(topic: string) { this.push({ topic, event: "phx_reply", ref: this.joinOf(topic).ref, payload: { status: "ok", response: {} } }); }
}
const tick = () => new Promise(r => setTimeout(r, 0));
const load = () => {
  FakeWS.all = [];
  const ctx: Record<string, unknown> = { WebSocket: FakeWS, setInterval: () => 0, clearInterval: () => {}, setTimeout: (f: () => void) => { (ctx.pending as (() => void)[]).push(f); return 0; }, clearTimeout: () => {}, pending: [] };
  vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../realtime.js"), "utf8"), ctx);
  return ctx as { B5Realtime: { subscribe(o: object): { close(): void; joined(): boolean; track(m: object): void; send(e: string, p: object): void } }; pending: (() => void)[] };
};
const cfg = { url: "https://ref.supabase.co", publishableKey: "sb_publishable_x" };

test("every channel on a page shares one socket; each joins with its own config and the user's token", async () => {
  const R = load();
  const got: [string, unknown][] = [];
  R.B5Realtime.subscribe({ cfg, topic: "realtime:b5-board-u1", changes: [{ table: "board_posts" }], getToken: () => "jwt", onChange: (r: unknown, t: string) => got.push([t, r]) });
  R.B5Realtime.subscribe({ cfg, topic: "realtime:b5-chat", private: true, presenceKey: "u1", changes: [{ table: "chat_messages" }], getToken: () => "jwt", onChange: (r: unknown, t: string) => got.push(["chat:" + t, r]) });
  await tick(); await tick();
  assert.equal(FakeWS.all.length, 1, "one connection");
  const ws = FakeWS.all[0]!;
  assert.match(ws.url, /^wss:\/\/ref\.supabase\.co\/realtime\/v1\/websocket\?apikey=sb_publishable_x&vsn=1\.0\.0$/);
  ws.onopen!();
  const chat = ws.joinOf("realtime:b5-chat");
  assert.deepEqual(chat.payload, { config: { broadcast: { self: false }, presence: { key: "u1" }, postgres_changes: [{ event: "*", schema: "public", table: "chat_messages" }], private: true }, access_token: "jwt" });
  assert.equal(ws.joinOf("realtime:b5-board-u1").payload.access_token, "jwt");
  ws.push({ topic: "realtime:b5-chat", event: "postgres_changes", payload: { data: { table: "chat_messages", type: "INSERT", record: { id: 7, body: "hi" } } } });
  ws.push({ topic: "realtime:b5-board-u1", event: "postgres_changes", payload: { data: { table: "board_posts", type: "DELETE", old_record: { id: 3 } } } });
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [["chat:chat_messages", { id: 7, body: "hi" }], ["board_posts", { id: 3 }]], "each change reaches its own channel");
});

test("presence: full state, joins and leaves; tracking happens after the join and again after a reconnect", async () => {
  const R = load();
  let online: { key: string; metas: { name: string }[] }[] = [];
  const sub = R.B5Realtime.subscribe({ cfg, topic: "realtime:b5-chat", private: true, presenceKey: "u1", getToken: () => "jwt", onPresence: (l: typeof online) => { online = l; } });
  sub.track({ name: "Adam", team: "0011" });
  await tick(); await tick();
  const ws = FakeWS.all[0]!; ws.onopen!();
  assert.equal(ws.sent.filter(m => m.event === "presence").length, 0, "not before the join is accepted");
  ws.ok("realtime:b5-chat");
  assert.equal(sub.joined(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(ws.sent.filter(m => m.event === "presence").map(m => m.payload))), [{ type: "presence", event: "track", payload: { name: "Adam", team: "0011" } }]);
  ws.push({ topic: "realtime:b5-chat", event: "presence_state", payload: { u1: { metas: [{ phx_ref: "a", name: "Adam" }] }, u2: { metas: [{ phx_ref: "b", name: "Mike" }] } } });
  assert.deepEqual([...online.map(p => p.key)], ["u1", "u2"]);
  ws.push({ topic: "realtime:b5-chat", event: "presence_diff", payload: { joins: { u3: { metas: [{ phx_ref: "c", name: "Bob" }] } }, leaves: { u2: { metas: [{ phx_ref: "b" }] } } } });
  assert.deepEqual([...online.map(p => p.key)], ["u1", "u3"]);
  // Connection drops: reconnect, rejoin, re-track.
  ws.onclose!();
  assert.equal(sub.joined(), false);
  R.pending.shift()!(); await tick(); await tick();
  const ws2 = FakeWS.all[1]!; ws2.onopen!(); ws2.ok("realtime:b5-chat");
  assert.equal(ws2.sent.filter(m => m.event === "presence").length, 1, "presence re-tracked after the rejoin");
});

test("broadcast (typing): sent to the channel, others' arrive; closing the last channel closes the socket", async () => {
  const R = load();
  const heard: unknown[] = [];
  const sub = R.B5Realtime.subscribe({ cfg, topic: "realtime:b5-chat", private: true, getToken: () => "jwt", onBroadcast: (e: string, p: unknown) => heard.push([e, p]) });
  await tick(); await tick();
  const ws = FakeWS.all[0]!; ws.onopen!();
  sub.send("typing", { room: "league" });
  assert.equal(ws.sent.filter(m => m.event === "broadcast").length, 0, "nothing before the join");
  ws.ok("realtime:b5-chat");
  sub.send("typing", { room: "league", name: "Adam" });
  assert.deepEqual(ws.sent.filter(m => m.event === "broadcast").map(m => m.payload), [{ type: "broadcast", event: "typing", payload: { room: "league", name: "Adam" } }]);
  ws.push({ topic: "realtime:b5-chat", event: "broadcast", payload: { type: "broadcast", event: "typing", payload: { name: "Mike" } } });
  assert.deepEqual(JSON.parse(JSON.stringify(heard)), [["typing", { name: "Mike" }]]);
  sub.close();
  assert.equal(ws.sent.at(-1)!.event, "phx_leave");
  assert.equal(ws.closed, true);
});
