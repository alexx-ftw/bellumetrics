function requireConfiguration(supabaseUrl, serviceRoleKey, fetchImpl) {
  if (!supabaseUrl) throw new Error("supabaseUrl is required");
  if (!serviceRoleKey) throw new Error("serviceRoleKey is required");
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl must be a function");
}

function rpcUrl(supabaseUrl, functionName) {
  return new URL(
    `/rest/v1/rpc/${functionName}`,
    `${supabaseUrl.replace(/\/$/, "")}/`,
  );
}

function redact(value, serviceRoleKey) {
  return String(value)
    .replaceAll(serviceRoleKey, "[REDACTED]")
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]");
}

async function responseBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createQueueRepository({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}) {
  requireConfiguration(supabaseUrl, serviceRoleKey, fetchImpl);

  async function request(functionName, payload) {
    let response;
    try {
      response = await fetchImpl(rpcUrl(supabaseUrl, functionName), {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const detail = redact(error instanceof Error ? error.message : error, serviceRoleKey);
      throw new Error(`RPC ${functionName} request failed: ${detail}`);
    }

    let body;
    try {
      body = await responseBody(response);
    } catch (error) {
      const detail = redact(error instanceof Error ? error.message : error, serviceRoleKey);
      throw new Error(`RPC ${functionName} response failed: ${detail}`);
    }
    if (!response.ok) {
      const detail = redact(
        typeof body === "string" ? body : JSON.stringify(body),
        serviceRoleKey,
      );
      throw new Error(`RPC ${functionName} failed (${response.status}): ${detail.slice(0, 1000)}`);
    }
    return body;
  }

  return {
    async lease({ workerId, leaseSeconds }) {
      const result = await request("lease_curation_case", {
        worker_id: workerId,
        lease_seconds: leaseSeconds,
      });
      return Array.isArray(result) ? result[0] ?? null : result;
    },

    heartbeat({ caseId, workerId, leaseSeconds }) {
      return request("heartbeat_curation_case", {
        case_id: caseId,
        worker_id: workerId,
        lease_seconds: leaseSeconds,
      });
    },

    recordReview({
      caseId,
      workerId,
      reviewRole,
      model,
      promptVersion,
      evidence,
      decision,
    }) {
      return request("record_ai_review", {
        case_id: caseId,
        worker_id: workerId,
        review_role: reviewRole,
        model,
        prompt_version: promptVersion,
        evidence,
        decision,
      });
    },

    readReviews({ caseId, workerId }) {
      return request("read_curation_reviews", {
        case_id: caseId,
        worker_id: workerId,
      });
    },

    release({ caseId, workerId, outcome, errorText = null }) {
      return request("release_curation_case", {
        case_id: caseId,
        worker_id: workerId,
        outcome,
        error_text: errorText === null ? null : redact(errorText, serviceRoleKey),
      });
    },
  };
}
