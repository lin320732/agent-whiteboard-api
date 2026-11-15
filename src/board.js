// The dashboard uses a same-origin API proxy; the API Worker enforces every role.
const SECURITY = {
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
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
      const res = await env.API.fetch(new Request(target, request));
      const headers = new Headers(res.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(res.body, { status: res.status, headers });
    }
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [name, value] of Object.entries(SECURITY)) headers.set(name, value);
    if (headers.get("Content-Type")?.includes("text/html")) headers.set("Cache-Control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  },
};
