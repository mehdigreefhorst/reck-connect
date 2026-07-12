// Embedded Whisper transcription worker. Runs off the UI thread; lazily
// imports transformers.js (so its ~large bundle + ONNX runtime only load
// when the local engine is first used) and fetches the model from the HF
// hub on first use. Prefers WebGPU, falls back to WASM.
//
// The model is loaded AND warmed up (a tiny silent inference) before the
// caller starts recording — the warm-up validates the compute device end to
// end, so a WebGPU incompatibility (e.g. an adapter that doesn't expose the
// subgroup limits transformers.js expects) is caught here and we fall back
// to WASM, instead of blowing up mid-transcription after the user has spoken.
//
// Protocol:
//   main → worker: { type: "prepare"|"transcribe", repo, generation, audio? }
//   worker → main: { type: "status", status: "loading"|"transcribing" }
//                  { type: "ready" }        (prepare succeeded, model warm)
//                  { type: "result", text } (transcribe succeeded)
//                  { type: "error", message }

import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";

// Always fetch from the Hugging Face hub (no local model files bundled).
env.allowLocalModels = false;

type InMessage =
  | { type: "prepare"; repo: string; generation: number }
  | { type: "transcribe"; repo: string; generation: number; audio: Float32Array };

// Ordered by preference: fast native GPU first, portable WASM second. Each
// is validated by a warm-up inference before being accepted.
const DEVICE_CONFIGS: ReadonlyArray<{ device: "webgpu" | "wasm"; dtype: string }> = [
  { device: "webgpu", dtype: "fp16" },
  { device: "wasm", dtype: "q8" },
];

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loadedRepo: string | null = null;

/** Load + warm up the model, falling back across devices. Cached per repo. */
async function ensureReady(
  repo: string,
  generation: number,
): Promise<AutomaticSpeechRecognitionPipeline> {
  if (asr && loadedRepo === repo) return asr;
  post({ type: "status", status: "loading", generation });
  let lastErr: unknown;
  for (const cfg of DEVICE_CONFIGS) {
    try {
      const p = (await pipeline("automatic-speech-recognition", repo, {
        device: cfg.device,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dtype: cfg.dtype as any,
      })) as AutomaticSpeechRecognitionPipeline;
      // Warm-up: one inference over 1s of silence. This is where a broken
      // WebGPU backend actually throws, so it belongs inside the try.
      await p(new Float32Array(16000), { chunk_length_s: 30 });
      asr = p;
      loadedRepo = repo;
      return p;
    } catch (err) {
      lastErr = err;
      asr = null;
      loadedRepo = null;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Failed to load speech model");
}

self.onmessage = async (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  if (!msg || (msg.type !== "prepare" && msg.type !== "transcribe")) return;
  const gen = msg.generation;
  try {
    const model = await ensureReady(msg.repo, gen);
    if (msg.type === "prepare") {
      post({ type: "ready", generation: gen });
      return;
    }
    post({ type: "status", status: "transcribing", generation: gen });
    const output = await model(msg.audio, { chunk_length_s: 30, stride_length_s: 5 });
    post({ type: "result", text: extractText(output).trim(), generation: gen });
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      generation: gen,
    });
  }
};

function extractText(output: unknown): string {
  if (Array.isArray(output)) return output.map((o) => extractText(o)).join(" ");
  if (output && typeof output === "object" && "text" in output) {
    const t = (output as { text: unknown }).text;
    return typeof t === "string" ? t : "";
  }
  return "";
}

type WorkerOut =
  | { type: "status"; status: "loading" | "transcribing"; generation: number }
  | { type: "ready"; generation: number }
  | { type: "result"; text: string; generation: number }
  | { type: "error"; message: string; generation: number };

function post(m: WorkerOut): void {
  (self as unknown as Worker).postMessage(m);
}
