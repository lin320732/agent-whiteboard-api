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

  // Capability R2 file reads preserve immutable caching for 200/206/304 while keeping 404/416/json no-store
  const fileUrl = "https://board.example.test/api/files/f_1234567890abcdef12345678/chart.png";
  for (const [status, extraHeaders, query, expectedCache] of [
    [200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable", "Accept-Ranges": "bytes" }, "", "public, max-age=31536000, immutable"],
    [206, { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=31536000, immutable", "Content-Range": "bytes 0-15/64", "Accept-Ranges": "bytes" }, "", "public, max-age=31536000, immutable"],
    [304, { "Cache-Control": "public, max-age=31536000, immutable", "ETag": '"etag-1"' }, "", "public, max-age=31536000, immutable"],
    [404, { "Content-Type": "application/json", "Cache-Control": "public, max-age=31536000, immutable" }, "", "no-store"],
    [416, { "Content-Range": "bytes */64", "Cache-Control": "public, max-age=31536000, immutable" }, "", "no-store"],
    [200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=31536000, immutable" }, "?format=json", "no-store"],
  ]) {
    const fileEnv = {
      API: { async fetch() { return new Response(status === 304 ? null : "<img>", { status, headers: extraHeaders }); } },
      ASSETS: { async fetch() { throw Error("API must not reach static assets"); } },
    };
    const fileRes = await board.fetch(new Request(`${fileUrl}${query}`), fileEnv);
    assert.equal(fileRes.status, status, `${status}${query}`);
    assert.equal(fileRes.headers.get("Cache-Control"), expectedCache, `${status}${query}`);
    if (status === 206) {
      assert.equal(fileRes.headers.get("Content-Range"), "bytes 0-15/64");
      assert.equal(await fileRes.text(), "<img>");
    }
    if (status === 304) assert.equal(await fileRes.text(), "");
  }

  // Board proxy forwards HTML report sandbox CSP and HEAD method intact
  let seenMethod = null;
  const htmlEnv = {
    API: {
      async fetch(req) {
        seenMethod = req.method;
        return new Response(req.method === "HEAD" ? null : "<h1>report</h1>", {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Security-Policy": "default-src 'none'; sandbox allow-scripts;",
          },
        });
      },
    },
    ASSETS: { async fetch() { throw Error("API must not reach static assets"); } },
  };
  const htmlRes = await board.fetch(new Request("https://board.example.test/api/files/f_1234567890abcdef12345678/report.html"), htmlEnv);
  assert.equal(htmlRes.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox allow-scripts;");
  assert.equal(await htmlRes.text(), "<h1>report</h1>");
  const headRes = await board.fetch(new Request("https://board.example.test/api/files/f_1234567890abcdef12345678/report.html", { method: "HEAD" }), htmlEnv);
  assert.equal(seenMethod, "HEAD");
  assert.equal(headRes.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(await headRes.text(), "");
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

test("fingerprinted bundles are immutable while HTML, errors and stable URLs stay fresh", async () => {
  for (const [pathname, status, contentType, expected] of [
    ['/assets/app-ABCDEFG2.js', 200, 'text/javascript', 'public, max-age=31536000, immutable'],
    ['/assets/chunks/reading-ABCDEFG2.js', 200, 'application/javascript', 'public, max-age=31536000, immutable'],
    ['/assets/style-ABCDEFG2.css', 200, 'text/css', 'public, max-age=31536000, immutable'],
    ['/assets/app-ABCDEFG2.js', 304, '', 'public, max-age=31536000, immutable'],
    ['/assets/app-ABCDEFG2.js', 404, 'text/javascript', 'no-store'],
    ['/assets/app-ABCDEFG2.js', 200, 'text/html', 'no-store'],
    ['/app.js', 200, 'text/javascript', 'public, max-age=0, must-revalidate'],
    ['/assets/app.js', 200, 'text/javascript', 'public, max-age=0, must-revalidate'],
  ]) {
    const env = { ASSETS: { fetch: async () => new Response(status === 304 ? null : 'asset', {
      status, headers: { 'Content-Type': contentType, 'ETag': '"version"', 'Cache-Control': 'public, max-age=0, must-revalidate' },
    }) } };
    const res = await board.fetch(new Request(`https://board.example.test${pathname}`), env);
    assert.equal(res.headers.get('Cache-Control'), expected, `${pathname} (${status})`);
    assert.equal(res.headers.get('ETag'), '"version"');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  }
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
