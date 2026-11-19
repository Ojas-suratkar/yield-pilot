import type { NextRequest } from "next/server";

// Same-origin proxy to the FastAPI backend, so the browser never needs CORS.
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";
const HOP = ["host", "connection", "content-length", "transfer-encoding"];

// On Cloud Run the backend only accepts calls from this service: attach a Google-signed ID token.
let cached: { token: string; exp: number } | null = null;
async function serviceToken(): Promise<string | null> {
  if (!process.env.K_SERVICE) return null;
  if (cached && cached.exp > Date.now()) return cached.token;
  const res = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(BACKEND)}`,
    { headers: { "Metadata-Flavor": "Google" }, cache: "no-store" },
  );
  if (!res.ok) return null;
  cached = { token: await res.text(), exp: Date.now() + 50 * 60 * 1000 };
  return cached.token;
}

async function proxy(req: NextRequest, { params }: { params: { path: string[] } }) {
  const target = `${BACKEND}/api/${params.path.join("/")}${req.nextUrl.search}`;
  const headers = new Headers(req.headers);
  HOP.forEach((h) => headers.delete(h));
  const token = await serviceToken();
  if (token) headers.set("X-Serverless-Authorization", `Bearer ${token}`);
  const res = await fetch(target, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    // @ts-expect-error duplex is required for streaming request bodies
    duplex: "half",
    cache: "no-store",
    redirect: "manual",
  });
  // fetch already decompressed the body, so drop the encoding and length; copy each cookie separately so none are merged
  const out = new Headers();
  res.headers.forEach((v, k) => {
    if (!["content-encoding", "content-length", "set-cookie"].includes(k)) out.set(k, v);
  });
  res.headers.getSetCookie().forEach((c) => out.append("set-cookie", c));
  return new Response(res.body, { status: res.status, headers: out });
}

export const dynamic = "force-dynamic";
export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
