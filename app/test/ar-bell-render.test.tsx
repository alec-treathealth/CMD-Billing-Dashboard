/**
 * AR notifications bell — the pure `BellMenuItems` leaf under string render. Pins the entry copy
 * (verb per event type), the "Mark all read" affordance appearing only with unread items, the
 * claim TAIL (never a patient), and the empty state.
 *
 * ⚠️ Must be .tsx — app/package.json collects `test/*.test.tsx` only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BellMenuItems, describeEvent } from '../components/ar-notifications-bell-leaves';
import type { ArNotificationRow } from '../lib/ar/contract';

const base = { business_entity_id: 'af504ab6-3dcd-4aa4-a93c-27bc58de4088', facility_code: 'CAMH', created_at: '2026-09-09T10:00:00Z', unread: true } as const;
const items: ArNotificationRow[] = [
  { ...base, id: 1, event_type: 'note', actor_email: 'jt@example.test', from_value: null, to_value: null, cmd_claim_id: '900000001' },
  { ...base, id: 2, event_type: 'status', actor_email: 'cb@example.test', from_value: 'open', to_value: 'waiting_payer', cmd_claim_id: '900000002', unread: false },
  { ...base, id: 3, event_type: 'assign', actor_email: 'cb@example.test', from_value: null, to_value: 'tula@example.test', cmd_claim_id: '900000003' },
  { ...base, id: 4, event_type: 'due', actor_email: 'cb@example.test', from_value: null, to_value: '2026-10-01', cmd_claim_id: '900000004' },
];

test('describeEvent: one verb per event type', () => {
  assert.equal(describeEvent(items[0]!), 'added a note');
  assert.equal(describeEvent(items[1]!), 'moved open → waiting_payer');
  assert.equal(describeEvent(items[2]!), 'assigned to tula');
  assert.equal(describeEvent(items[3]!), 'set follow-up Oct 1, 2026');
});

test('BellMenuItems: unread count, mark-all affordance, claim tail, actor local-part', () => {
  const html = renderToStaticMarkup(<BellMenuItems items={items} unread={3} nowMs={Date.parse('2026-09-09T12:00:00Z')} />);
  assert.ok(html.includes('3 unread'));
  assert.ok(html.includes('Mark all read'));
  assert.ok(html.includes('added a note'));
  assert.ok(html.includes('claim …0001'));
  assert.equal(html.includes('900000001'), false, 'only the tail of a claim id is rendered');
  assert.ok(html.includes('<span class="font-semibold">jt</span>'));
  assert.equal(html.includes('jt@example.test'), false, 'actor email renders as the local part');
  assert.ok(html.includes('2h ago'));
  assert.ok(html.includes('role="menu"'));
});

test('BellMenuItems: caught-up state has no mark-all button; empty list has its own copy', () => {
  const html = renderToStaticMarkup(<BellMenuItems items={[]} unread={0} nowMs={null} />);
  assert.ok(html.includes('All caught up'));
  assert.equal(html.includes('Mark all read'), false);
  assert.ok(html.includes('No changes yet.'));
});
