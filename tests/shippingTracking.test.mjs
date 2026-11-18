import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  normalizeShippingStatus,
  verify17TrackWebhookSignature,
} from '../src/worker.ts'

test('normalizes 17TRACK main and sub statuses for the shipping dashboard', () => {
  assert.equal(normalizeShippingStatus('Delivered'), 'delivered')
  assert.equal(normalizeShippingStatus('InTransit', 'InTransit_PickedUp', 2), 'in_transit')
  assert.equal(normalizeShippingStatus('InTransit', 'InTransit_Other', 6), 'stale')
  assert.equal(normalizeShippingStatus('OutForDelivery'), 'out_for_delivery')
  assert.equal(normalizeShippingStatus('AvailableForPickup'), 'available_for_pickup')
  assert.equal(normalizeShippingStatus('InfoReceived'), 'label_created')
  assert.equal(normalizeShippingStatus('DeliveryFailure', 'DeliveryFailure_NoBody'), 'attention')
  assert.equal(normalizeShippingStatus('Exception', 'Exception_Delayed'), 'attention')
  assert.equal(normalizeShippingStatus('Exception', 'Exception_Returning'), 'returned')
  assert.equal(normalizeShippingStatus('NotFound'), 'not_found')
  assert.equal(normalizeShippingStatus('Expired'), 'stale')
})

test('accepts an authentic 17TRACK webhook signature and rejects tampering', async () => {
  const body = '{"event":"TRACKING_UPDATED","data":{"accepted":[{"number":"RR123456789CN","tag":"rm:example"}]}}'
  const secret = 'test-webhook-secret'
  const signature = createHash('sha256').update(body + '/' + secret, 'utf8').digest('hex')

  assert.equal(await verify17TrackWebhookSignature(body, signature, secret), true)
  assert.equal(await verify17TrackWebhookSignature(body, 'sha256=' + signature, secret), true)
  assert.equal(await verify17TrackWebhookSignature(body + ' ', signature, secret), false)
  assert.equal(await verify17TrackWebhookSignature(body, signature, 'wrong-secret'), false)
  assert.equal(await verify17TrackWebhookSignature(body, '', secret), false)
})
