import test from 'node:test'
import assert from 'node:assert/strict'
import { qwenVectors } from '../src/worker.ts'

test('parses Qwen3 embedding vectors in the expected row order', () => {
  const result = qwenVectors({
    shape: [2, 3],
    data: [
      [0.1, 0.2, 0.3],
      [-0.1, 0, 0.5],
    ],
  }, 2)
  assert.deepEqual(result, [[0.1, 0.2, 0.3], [-0.1, 0, 0.5]])
})

test('rejects incomplete, malformed or non-finite Qwen3 embedding output', () => {
  assert.deepEqual(qwenVectors({ data: [[0.1, 0.2]] }, 2), [])
  assert.deepEqual(qwenVectors({ data: [[0.1, Number.NaN]] }, 1), [])
  assert.deepEqual(qwenVectors({ data: 'not-an-array' }, 1), [])
})
