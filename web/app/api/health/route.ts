import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Runtime health proxy. Rewrites are resolved at build time by Next, which
 * incorrectly bakes NEXT_PUBLIC_API_BASE_URL=localhost into the Docker image.
 * Reading API_BASE_URL here preserves the compose-network target (http://owc:8000).
 */
export async function GET(): Promise<NextResponse> {
  const backend = (process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");
  if (!backend) {
    return NextResponse.json({ status: "unconfigured" }, { status: 503 });
  }

  try {
    const response = await fetch(`${backend}/health`, { cache: "no-store" });
    const body = await response.text();
    return new NextResponse(body, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("content-type") || "application/json" },
    });
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 503 });
  }
}
