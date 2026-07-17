export async function GET() {
  const backendUrl = process.env.KMD_BACKEND_URL ?? "http://127.0.0.1:8021";

  try {
    const response = await fetch(`${backendUrl}/v1/vehicle/stages`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json().catch(() => null);
    if (response.ok) {
      return Response.json(body, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    return Response.json(
      { detail: body?.detail ?? `kRPC staging inference failed (${response.status})` },
      { status: response.status, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        detail: error instanceof Error
          ? `Python kRPC backend unavailable: ${error.message}`
          : "Python kRPC backend unavailable",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
