// Thin client for a locally-running Ollama server (https://ollama.com).
// Uses Node's native fetch (Node 18+). No API key, no cloud call - this
// talks to http://localhost:11434 on the same machine running the backend.
//
// Setup (one-time, on the machine running this backend):
//   1. Install Ollama: https://ollama.com/download
//   2. Pull a model:   ollama pull llama3.2
//   3. Ollama runs its own local server automatically after install
//      (or start it manually with `ollama serve`).
//
// If Ollama isn't running or times out, callers should catch and fall back
// to rules-based logic - see agents/fraud.js for the pattern.

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";

async function callOllama(prompt, { timeoutMs = 20000, model = OLLAMA_MODEL } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, format: "json" }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Ollama responded with HTTP ${resp.status}`);
    const data = await resp.json();
    return JSON.parse(data.response);
  } finally {
    clearTimeout(timeout);
  }
}

// Real (not simulated) reachability check - actually pings the Ollama server.
async function isOllamaReachable() {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return resp.ok;
  } catch {
    return false;
  }
}

module.exports = { callOllama, isOllamaReachable, OLLAMA_MODEL, OLLAMA_URL };