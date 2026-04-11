async function parseJson(res) {
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function apiRequest(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await parseJson(res);
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data || {};
}

export async function requestMagicLink(email, nextPath = "/") {
  return apiRequest("/api/auth/request-link", {
    method: "POST",
    body: JSON.stringify({ email, nextPath }),
  });
}

export async function verifyMagicToken(token) {
  return apiRequest("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function fetchSession() {
  return apiRequest("/api/auth/session", { method: "GET" });
}

export async function signOutSession() {
  return apiRequest("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
}

export async function listAccountResearches() {
  return apiRequest("/api/account/researches", { method: "GET" });
}

export async function upsertAccountResearches(researches = []) {
  return apiRequest("/api/account/researches", {
    method: "POST",
    body: JSON.stringify({ researches: Array.isArray(researches) ? researches : [researches] }),
  });
}

export async function deleteAccountResearch(id) {
  return apiRequest("/api/account/researches", {
    method: "DELETE",
    body: JSON.stringify({ id }),
  });
}
