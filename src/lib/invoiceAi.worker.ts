import {
  AutoProcessor,
  Florence2ForConditionalGeneration,
  RawImage,
  env,
} from '@huggingface/transformers';

type LocalAdapter = { features?: { has: (name: string) => boolean } }
type LocalGpu = { requestAdapter: (options?: unknown) => Promise<LocalAdapter | null> }
declare const self: {
  postMessage: (message: WorkerResponse) => void
  addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void
  navigator: Navigator & { gpu?: LocalGpu }
}

const MODEL_ID = 'onnx-community/Florence-2-base-ft';
const OCR_TASK = '<OCR_WITH_REGION>';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.cacheKey = 'reselling-manager-florence2-v1';
env.useWasmCache = true;

type WorkerRequest = { type: 'recognize'; id: number; image: Blob; maxEdge?: number };
type WorkerResponse =
  | { type: 'progress'; id: number; fraction: number; stage: string }
  | { type: 'result'; id: number; text: string; labels: string[]; boxes: number[][]; width: number; height: number; backend: string }
  | { type: 'error'; id: number; message: string };

type FlorenceProcessor = {
  (image: RawImage, task: string): Promise<Record<string, unknown>>;
  batch_decode: (sequences: unknown, options: { skip_special_tokens: boolean }) => string[];
  post_process_generation: (text: string, task: string, size: [number, number]) => Record<string, unknown>;
};

type OcrModel = {
  generate: (inputs: Record<string, unknown> & Record<string, unknown>) => Promise<unknown>;
};

let processor: FlorenceProcessor | null = null;
let model: OcrModel | null = null;
let loadPromise: Promise<void> | null = null;
let backend = '';

function send(message: WorkerResponse): void {
  self.postMessage(message);
}

function progress(id: number, fraction: number, stage: string): void {
  send({ type: 'progress', id, fraction: Math.max(0, Math.min(1, fraction)), stage });
}

async function chooseBackend(): Promise<{ device: 'webgpu' | 'wasm'; dtype: Record<string, string> }> {
  const gpu = self.navigator.gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        const f16 = adapter.features?.has('shader-f16') === true;
        return {
          device: 'webgpu',
          dtype: f16
            ? { embed_tokens: 'fp16', vision_encoder: 'fp16', encoder_model: 'q4', decoder_model_merged: 'q4' }
            : { embed_tokens: 'fp32', vision_encoder: 'q4', encoder_model: 'q4', decoder_model_merged: 'q4' },
        };
      }
    } catch {
      // A WebGPU adapter can exist but fail when model sessions are created.
    }
  }
  return {
    device: 'wasm',
    dtype: { embed_tokens: 'q8', vision_encoder: 'q8', encoder_model: 'q8', decoder_model_merged: 'q8' },
  };
}

async function loadModel(id: number): Promise<void> {
  if (processor && model) return;
  loadPromise ??= (async () => {
    progress(id, 0.01, 'Lokales KI-Modell wird geladen');
    const chosen = await chooseBackend();
    const callback = (event: { status?: string; progress?: number; file?: string }) => {
      if (event.status === 'progress' && typeof event.progress === 'number') {
        progress(id, Math.min(0.88, 0.04 + (event.progress / 100) * 0.82), 'KI-Modell wird heruntergeladen');
      }
    };

    const processorPromise = AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: callback });
    let loadedModel: OcrModel;
    let usedDevice = chosen.device;
    try {
      loadedModel = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
        device: chosen.device,
        dtype: chosen.dtype,
        progress_callback: callback,
      }) as unknown as OcrModel;
    } catch (primaryError) {
      if (chosen.device !== 'webgpu') throw primaryError;
      // Safari/iOS and some integrated GPUs expose WebGPU but cannot allocate the model.
      progress(id, 0.45, 'Grafikspeicher reicht nicht aus – wechsle auf CPU');
      loadedModel = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
        device: 'wasm',
        dtype: { embed_tokens: 'q8', vision_encoder: 'q8', encoder_model: 'q8', decoder_model_merged: 'q8' },
        progress_callback: callback,
      }) as unknown as OcrModel;
      usedDevice = 'wasm';
    }
    const loadedProcessor = await processorPromise as unknown as FlorenceProcessor;
    model = loadedModel;
    processor = loadedProcessor;
    backend = usedDevice === 'webgpu' ? 'WebGPU' : 'CPU/WASM';
    progress(id, 0.95, 'KI-Modell ist bereit');
  })().catch(error => {
    processor = null;
    model = null;
    loadPromise = null;
    throw error;
  });
  await loadPromise;
}

async function decodeImage(blob: Blob, maxEdge: number): Promise<RawImage> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Bildverarbeitung ist in diesem Browser nicht verfügbar.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    return new RawImage(new Uint8ClampedArray(data), width, height, 4).rgb();
  } finally {
    bitmap.close();
  }
}

async function recognize(request: WorkerRequest): Promise<void> {
  const { id, image } = request;
  try {
    await loadModel(id);
    progress(id, 0.97, 'KI liest Text und Tabellenpositionen');
    const raw = await decodeImage(image, request.maxEdge || 1800);
    if (!processor || !model) throw new Error('Das lokale KI-Modell ist nicht verfügbar.');
    const inputs = await processor(raw, OCR_TASK);
    const output = await model.generate({
      ...inputs,
      max_new_tokens: 1000,
      do_sample: false,
    });
    const [decoded] = processor.batch_decode(output, { skip_special_tokens: false });
    const result = processor.post_process_generation(decoded || '', OCR_TASK, [raw.width, raw.height]);
    const extracted = result[OCR_TASK] as { labels?: unknown[]; quad_boxes?: unknown[] } | undefined;
    const labels = (extracted?.labels || []).map(value => String(value));
    const boxes = (extracted?.quad_boxes || []).map(value =>
      Array.isArray(value) ? value.map(Number) : [],
    ).filter(box => box.length >= 8 && box.every(Number.isFinite));
    send({
      type: 'result',
      id,
      text: labels.join('\n'),
      labels,
      boxes,
      width: raw.width,
      height: raw.height,
      backend,
    });
  } catch (error) {
    send({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
}

self.addEventListener('message', event => {
  const message = event.data as WorkerRequest;
  if (!message || message.type !== 'recognize') return;
  void recognize(message);
});
