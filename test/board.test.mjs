import test from "node:test";
import assert from "node:assert/strict";
import board from "../src/board.js";

test("board proxies /api to the bound API and forwards cookies without cache", async () => {
  let received;
  const env = {
    API: { async fetch(req) { received = req; return new Response('{"ok":true}', { headers: { "Content-Type": "application/json", "Set-Cookie": "wb_session=x; HttpOnly" } }); } },
    ASSETS: { async fetch() { throw Error("API must not reach static assets"); } },
  };
  const res = await board.fetch(new Request("https://board.example.test/api/tasks?status=open", { headers: { Cookie: "wb_session=existing", Origin: "https://board.example.test" } }), env);
  assert.equal(new URL(received.url).pathname, "/api/tasks");
  assert.equal(new URL(received.url).search, "?status=open");
  assert.equal(received.headers.get("Cookie"), "wb_session=existing");
  assert.equal(received.headers.get("Origin"), "https://board.example.test");
  assert.equal(received.headers.get("X-Whiteboard-Require-Auth"), "1");
  assert.equal(res.headers.get("Set-Cookie"), "wb_session=x; HttpOnly");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("board static content is served with script protections", async () => {
  const env = {
    API: { async fetch() { throw Error("static page must not reach API"); } },
    ASSETS: { async fetch() { return new Response("<html>board</html>", { headers: { "Content-Type": "text/html" } }); } },
  };
  const res = await board.fetch(new Request("https://board.example.test/"), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Security-Policy"), /script-src 'self'/);
  assert.match(res.headers.get("Content-Security-Policy"), /img-src 'self' data: https:/);
  assert.match(res.headers.get("Content-Security-Policy"), /media-src 'self' https:/);
  assert.match(res.headers.get("Content-Security-Policy"), /frame-src 'self' https:\/\/www.youtube-nocookie.com https:\/\/player.bilibili.com https:\/\/www.bilibili.com(?:;|$)/);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});


test("Bilibili metadata page isolates provider scripts from the board", async () => {
  const env = {
    API: { async fetch() { throw Error("metadata page must not reach API"); } },
    ASSETS: { async fetch() { return new Response("<html>metadata</html>", {headers: {"Content-Type": "text/html"}}); } },
  };
  const res = await board.fetch(new Request("https://board.example.test/bilibili-metadata.html?bvid=BV1B7411m7LV"), env);
  const policy = res.headers.get("Content-Security-Policy");
  assert.match(policy, /sandbox allow-scripts;/);
  assert.doesNotMatch(policy, /allow-same-origin|unsafe-inline|unsafe-eval/);
  assert.match(policy, /script-src 'self' https:\/\/api.bilibili.com\/x\/web-interface\/wbi\/view$/);
  assert.match(policy, /frame-ancestors 'self'/);
  assert.equal(res.headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const boardRes = await board.fetch(new Request("https://board.example.test/"), env);
  assert.doesNotMatch(boardRes.headers.get("Content-Security-Policy"), /api.bilibili.com/);
  assert.equal(boardRes.headers.get("X-Frame-Options"), "DENY");
  const canonical = await board.fetch(new Request("https://board.example.test/bilibili-metadata?bvid=BV1B7411m7LV"), env);
  assert.equal(canonical.headers.get("Content-Security-Policy"), policy, "Cloudflare Assets redirects HTML files to an extensionless URL");
});
