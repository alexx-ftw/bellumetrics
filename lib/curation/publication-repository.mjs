function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function requireId(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function rpcUrl(supabaseUrl, functionName) {
  return new URL(
    `/rest/v1/rpc/${functionName}`,
    `${supabaseUrl.replace(/\/$/, "")}/`,
  );
}

function redact(value, credentials) {
  let redacted = String(value)
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]");
  for (const credential of credentials) {
    redacted = redacted.replaceAll(credential, "[REDACTED]");
  }
  return redacted;
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

function createRpcClient({ supabaseUrl, apiKey, bearerToken, fetchImpl }) {
  requireText(supabaseUrl, "supabaseUrl");
  requireText(apiKey, "apiKey");
  requireText(bearerToken, "bearerToken");
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  return async function request(functionName, payload) {
    let response;
    try {
      response = await fetchImpl(rpcUrl(supabaseUrl, functionName), {
        method: "POST",
        headers: {
          apikey: apiKey,
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const detail = redact(error instanceof Error ? error.message : error, [apiKey, bearerToken]);
      throw new Error(`RPC ${functionName} request failed: ${detail}`);
    }

    let body;
    try {
      body = await responseBody(response);
    } catch (error) {
      const detail = redact(error instanceof Error ? error.message : error, [apiKey, bearerToken]);
      throw new Error(`RPC ${functionName} response failed: ${detail}`);
    }
    if (!response.ok) {
      const detail = redact(
        typeof body === "string" ? body : JSON.stringify(body),
        [apiKey, bearerToken],
      );
      throw new Error(`RPC ${functionName} failed (${response.status}): ${detail.slice(0, 1000)}`);
    }
    const result = Array.isArray(body) ? body[0] ?? null : body;
    if (!result || !Number.isSafeInteger(result.event_id)
      || !Number.isSafeInteger(result.ranking_job_id)) {
      throw new Error(`RPC ${functionName} returned an invalid publication result`);
    }
    return result;
  };
}

export function createPublicationRepository({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}) {
  const request = createRpcClient({
    supabaseUrl,
    apiKey: serviceRoleKey,
    bearerToken: serviceRoleKey,
    fetchImpl,
  });
  return {
    publish({ caseId, workerId, proposerReviewId, reviewerReviewId, model }) {
      return request("publish_curation_decision", {
        case_id: requireId(caseId, "caseId"),
        worker_id: requireText(workerId, "workerId"),
        proposer_review_id: requireId(proposerReviewId, "proposerReviewId"),
        reviewer_review_id: requireId(reviewerReviewId, "reviewerReviewId"),
        configured_model: requireText(model, "model"),
      });
    },
  };
}

export function createOwnerPublicationRepository({
  supabaseUrl,
  publishableKey,
  accessToken,
  fetchImpl = fetch,
}) {
  if (publishableKey === accessToken) {
    throw new TypeError("publishableKey and accessToken must be distinct");
  }
  const request = createRpcClient({
    supabaseUrl,
    apiKey: publishableKey,
    bearerToken: accessToken,
    fetchImpl,
  });
  return {
    revert({ eventId, curatorUserId, reason }) {
      return request("revert_editorial_event", {
        event_id: requireId(eventId, "eventId"),
        curator_user_id: requireText(curatorUserId, "curatorUserId"),
        reason: requireText(reason, "reason"),
      });
    },
  };
}
