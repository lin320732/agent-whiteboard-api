// The dashboard uses a same-origin API proxy; the API Worker enforces every role.
import { parsePublicFilePath } from "./public-file-path.js";

const SECURITY = {
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https:; media-src 'self' https:; frame-src 'self' https://www.youtube-nocookie.com https://player.bilibili.com https://www.bilibili.com",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const target = new URL(request.url);
      target.hostname = "api.internal";
      target.protocol = "https:";
      const forwarded = new Request(target, request);
      forwarded.headers.set("X-Whiteboard-Require-Auth", "1");
      const res = await env.API.fetch(forwarded);
      const headers = new Headers(res.headers);
      const publicFile = parsePublicFilePath(url.pathname);
      const isImmutableFile = (request.method === "GET" || request.method === "HEAD")
        && !!publicFile && !publicFile.invalidEncoding
        && (res.status === 200 || res.status === 206 || res.status === 304)
        && url.searchParams.get("format") !== "json";
      if (!isImmutableFile) headers.set("Cache-Control", "no-store");
      return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers });
    }
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [name, value] of Object.entries(SECURITY)) headers.set(name, value);
    if (["/bilibili-metadata", "/bilibili-metadata.html"].includes(url.pathname)) {
      // JSONP runs in an opaque sandbox, isolated from board content/cookies.
      headers.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts; script-src 'self' https://api.bilibili.com/x/web-interface/wbi/view");
      headers.set("X-Frame-Options", "SAMEORIGIN");
    }
    const contentType = headers.get("Content-Type") || "";
    if (contentType.includes("text/html") || res.status >= 400) {
      headers.set("Cache-Control", "no-store");
    } else if ((res.status === 200 || res.status === 304)
      && /^\/assets\/(?:chunks\/)?[\w-]+-[A-Z0-9]{8}\.(?:js|css)$/.test(url.pathname)
      && (res.status === 304 || /(?:javascript|text\/css)/.test(contentType))) {
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }
    return new Response(res.body, { status: res.status, headers });
  },
};
