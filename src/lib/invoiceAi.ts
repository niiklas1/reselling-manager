export type FlorenceOcrResult = {
  text: string
  labels: string[]
  boxes: number[][]
  width: number
  height: number
  backend: string
}

type WorkerResponse =
  | { type: 'progress'; id: number; fraction: number; stage: string }
  | ({ type: 'result'; id: number } & FlorenceOcrResult)
  | { type: 'error'; id: number; message: string }

type Pending = {
  resolve: (result: FlorenceOcrResult) => void
  reject: (error: Error) => void
  onProgress: (fraction: number, stage: string) => void
}

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, Pending>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./invoiceAi.worker.ts', import.meta.url), { type: 'module', name: 'reselling-invoice-ai' })
  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const message = event.data
    const job = pending.get(message.id)
    if (!job) return
    if (message.type === 'progress') {
      job.onProgress(message.fraction, message.stage)
      return
    }
    pending.delete(message.id)
    if (message.type === 'error') job.reject(new Error(message.message))
    else job.resolve({
      text: message.text,
      labels: message.labels,
      boxes: message.boxes,
      width: message.width,
      height: message.height,
      backend: message.backend,
    })
  })
  worker.addEventListener('error', event => {
    const error = new Error(event.message || 'Die lokale KI konnte nicht gestartet werden.')
    for (const job of pending.values()) job.reject(error)
    pending.clear()
    worker?.terminate()
    worker = null
  })
  return worker
}

export function recognizeInvoiceWithAI(
  image: Blob,
  onProgress: (fraction: number, stage: string) => void,
): Promise<FlorenceOcrResult> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress })
    try {
      getWorker().postMessage({ type: 'recognize', id, image, maxEdge: 1800 })
    } catch (error) {
      pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
