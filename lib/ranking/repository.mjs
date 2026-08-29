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

export function createRankingRepository({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}) {
  requireText(supabaseUrl, "supabaseUrl");
  requireText(serviceRoleKey, "serviceRoleKey");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

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
      throw new Error(
        `RPC ${functionName} request failed: ${redact(error instanceof Error ? error.message : error, serviceRoleKey)}`,
      );
    }

    let body;
    try {
      body = await responseBody(response);
    } catch (error) {
      throw new Error(
        `RPC ${functionName} response failed: ${redact(error instanceof Error ? error.message : error, serviceRoleKey)}`,
      );
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
      const result = await request("lease_ranking_job", {
        worker_id: requireText(workerId, "workerId"),
        lease_seconds: leaseSeconds,
      });
      return Array.isArray(result) ? result[0] ?? null : result;
    },

    heartbeat({ jobId, workerId, leaseSeconds }) {
      return request("heartbeat_ranking_job", {
        job_id: requireId(jobId, "jobId"),
        worker_id: requireText(workerId, "workerId"),
        lease_seconds: leaseSeconds,
      });
    },

    async readInput({ jobId, workerId }) {
      const result = await request("read_ranking_input", {
        job_id: requireId(jobId, "jobId"),
        worker_id: requireText(workerId, "workerId"),
      });
      if (!result || !Array.isArray(result.commanders)
        || !Array.isArray(result.engagements) || !Array.isArray(result.participations)) {
        throw new Error("read_ranking_input returned an invalid ranking input");
      }
      return result;
    },

    async complete({ jobId, workerId, inputDigest, results }) {
      if (!/^sha256:[a-f0-9]{64}$/.test(inputDigest)) {
        throw new TypeError("inputDigest must be a sha256 digest");
      }
      if (!results || typeof results !== "object" || Array.isArray(results)) {
        throw new TypeError("results must be an object");
      }
      const snapshotId = await request("complete_ranking_job", {
        job_id: requireId(jobId, "jobId"),
        worker_id: requireText(workerId, "workerId"),
        input_digest: inputDigest,
        results,
      });
      if (!Number.isSafeInteger(snapshotId) || snapshotId <= 0) {
        throw new Error("complete_ranking_job returned an invalid snapshot id");
      }
      return snapshotId;
    },

    release({ jobId, workerId, errorText }) {
      return request("release_ranking_job", {
        job_id: requireId(jobId, "jobId"),
        worker_id: requireText(workerId, "workerId"),
        error_text: redact(errorText, serviceRoleKey),
      });
    },
  };
}
