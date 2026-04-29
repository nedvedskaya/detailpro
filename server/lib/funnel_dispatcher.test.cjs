'use strict';
/**
 * Unit-тесты на чистые функции диспетчера воронки.
 *
 * Запуск:
 *   node --test server/lib/funnel_dispatcher.test.cjs
 *
 * Покрытие:
 *   • pickEventKind — корректная мапа days_since_expiry → event_kind
 *     для двух сегментов
 *   • isInSendingWindow — окно 11:00 для разных таймзон
 *
 * Почему отдельный файл-test (а не jest/mocha): node:test нативный, не
 * тянет зависимостей и работает на всех машинах. Для bigint-DB-логики тесты
 * сложнее — здесь намеренно тестируем только pure-логику.
 */

const test = require('node:test');
const assert = require('node:assert');
const { pickEventKind, isInSendingWindow } = require('./funnel_dispatcher.cjs');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function makeStudio({ daysExpired, paid, hoursUntilExpiry, recurring }) {
  // hoursUntilExpiry > 0 — подписка ещё активна, истечёт через N часов
  // daysExpired >= 0 — подписка истекла N дней назад
  const offsetMs = hoursUntilExpiry != null
    ? -hoursUntilExpiry * 60 * 60 * 1000  // в будущем
    : daysExpired * ONE_DAY_MS;            // в прошлом
  return {
    access_until: new Date(Date.now() - offsetMs).toISOString(),
    first_paid_at: paid ? new Date('2026-01-01').toISOString() : null,
    prodamus_subscription_id: recurring ? 'sub_test_123' : null,
  };
}

test('pickEventKind: s1 (никогда не платил)', () => {
  // T+0 — окно ещё не открыто
  assert.equal(pickEventKind(makeStudio({ daysExpired: 0, paid: false })), null);
  // T+1 — день 1
  assert.equal(pickEventKind(makeStudio({ daysExpired: 1, paid: false })), 's1.day1');
  // T+2..T+4 — между точками, ничего не шлём
  assert.equal(pickEventKind(makeStudio({ daysExpired: 2, paid: false })), null);
  assert.equal(pickEventKind(makeStudio({ daysExpired: 4, paid: false })), null);
  // T+5
  assert.equal(pickEventKind(makeStudio({ daysExpired: 5, paid: false })), 's1.day5_pain');
  // T+14
  assert.equal(pickEventKind(makeStudio({ daysExpired: 14, paid: false })), 's1.day14_freedom');
  // T+24
  assert.equal(pickEventKind(makeStudio({ daysExpired: 24, paid: false })), 's1.day24_fomo');
  // T+29
  assert.equal(pickEventKind(makeStudio({ daysExpired: 29, paid: false })), 's1.day29_final');
  // T+30 и далее — поздно
  assert.equal(pickEventKind(makeStudio({ daysExpired: 30, paid: false })), null);
  assert.equal(pickEventKind(makeStudio({ daysExpired: 100, paid: false })), null);
});

test('pickEventKind: s1.trial_last_day (за 24ч до конца trial)', () => {
  // Через 12 часов истечёт, не платил → trial_last_day
  assert.equal(pickEventKind(makeStudio({ hoursUntilExpiry: 12, paid: false })), 's1.trial_last_day');
  // На границе 24 часа
  assert.equal(pickEventKind(makeStudio({ hoursUntilExpiry: 24, paid: false })), 's1.trial_last_day');
  // 25 часов — слишком рано
  assert.equal(pickEventKind(makeStudio({ hoursUntilExpiry: 25, paid: false })), null);
});

test('pickEventKind: s2 pre-expiry — учитываем recurring', () => {
  // Платил, recurring настроен → ничего не пишем, Prodamus спишет сам
  assert.equal(pickEventKind(makeStudio({ hoursUntilExpiry: 12, paid: true, recurring: true })), null);
  // Платил, recurring НЕТ → напоминаем «продли вручную»
  assert.equal(pickEventKind(makeStudio({ hoursUntilExpiry: 12, paid: true, recurring: false })), 's2.sub_last_day_no_recurrent');
  // Граница 24 часа
  assert.equal(pickEventKind(makeStudio({ hoursUntilExpiry: 24, paid: true, recurring: false })), 's2.sub_last_day_no_recurrent');
  // 25 часов — слишком рано
  assert.equal(pickEventKind(makeStudio({ hoursUntilExpiry: 25, paid: true, recurring: false })), null);
});

test('pickEventKind: s2 (платил, истёк)', () => {
  assert.equal(pickEventKind(makeStudio({ daysExpired: 1, paid: true })), 's2.day1_care');
  assert.equal(pickEventKind(makeStudio({ daysExpired: 5, paid: true })), 's2.day5_habit');
  assert.equal(pickEventKind(makeStudio({ daysExpired: 14, paid: true })), 's2.day14_referral');
  assert.equal(pickEventKind(makeStudio({ daysExpired: 24, paid: true })), 's2.day24_fomo');
  assert.equal(pickEventKind(makeStudio({ daysExpired: 29, paid: true })), 's2.day29_final');
  // Между точками
  assert.equal(pickEventKind(makeStudio({ daysExpired: 7, paid: true })), null);
});

test('isInSendingWindow: только в 11:00 локалки', () => {
  // 28 апреля 2026 11:30 МСК (UTC+3) = 08:30 UTC
  const at1130MSK = new Date('2026-04-28T08:30:00.000Z');
  assert.equal(isInSendingWindow(at1130MSK, 'Europe/Moscow'), true);

  // То же время — но Камчатка (UTC+12) → у них 20:30, не в окне
  assert.equal(isInSendingWindow(at1130MSK, 'Asia/Kamchatka'), false);

  // 10:00 МСК — окно не открыто
  const at1000MSK = new Date('2026-04-28T07:00:00.000Z');
  assert.equal(isInSendingWindow(at1000MSK, 'Europe/Moscow'), false);

  // 11:59 МСК — последняя минута окна
  const at1159MSK = new Date('2026-04-28T08:59:00.000Z');
  assert.equal(isInSendingWindow(at1159MSK, 'Europe/Moscow'), true);

  // 12:00 МСК — окно закрыто
  const at1200MSK = new Date('2026-04-28T09:00:00.000Z');
  assert.equal(isInSendingWindow(at1200MSK, 'Europe/Moscow'), false);

  // Кривая таймзона — фолбэк на МСК (не падаем).
  assert.doesNotThrow(() => isInSendingWindow(at1130MSK, 'Garbage/Timezone'));
});
