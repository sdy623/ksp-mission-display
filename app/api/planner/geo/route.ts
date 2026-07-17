export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const backendUrl = process.env.KMD_BACKEND_URL ?? "http://127.0.0.1:8021";
  const query = new URLSearchParams();
  for (const key of ["target_longitude_deg", "tolerance_deg", "node_filter", "max_nodes"]) {
    const value = requestUrl.searchParams.get(key);
    if (value != null) query.set(key, value);
  }

  try {
    const response = await fetch(`${backendUrl}/v1/planner/geo?${query.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    return Response.json(body, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      {
        detail: error instanceof Error ? error.message : "Mission planner backend unavailable",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
