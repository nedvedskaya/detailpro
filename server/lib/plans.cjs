'use strict';
/**
 * Тарифные планы — единственный источник правды.
 *
 * Используется:
 *   - server/routes/admin.cjs    — лимит на создание сотрудников
 *   - server/routes/profile.cjs  — отдача GET /api/profile.limits и planLabel/planPriceRub
 *   - server/routes/webhooks.cjs — может смотреть на priceRub при сверке платежей
 *
 * Лимит включает собственника. solo=1 → ТОЛЬКО собственник, никаких сотрудников.
 * studio=3 → собственник + 2 сотрудника. trial=3 — даём пощупать команду на пробном.
 *
 * Цены — в рублях, без НДС (Оля — самозанятая, чеки идут через Продамус).
 */

const PLANS = Object.freeze({
  trial:     { maxUsers: 3, priceRub: 0,    label: 'Пробный',  upgradeable: true  },
  solo:      { maxUsers: 1, priceRub: 4900, label: 'Соло',     upgradeable: true  },
  studio:    { maxUsers: 3, priceRub: 8900, label: 'Студия',   upgradeable: false },
  cancelled: { maxUsers: 0, priceRub: 0,    label: 'Отменён',  upgradeable: true  },
});

function planMeta(plan) {
  return PLANS[plan] || PLANS.cancelled;
}

function maxUsersForPlan(plan) {
  return planMeta(plan).maxUsers;
}

function isUpgradeable(plan) {
  return planMeta(plan).upgradeable;
}

module.exports = { PLANS, planMeta, maxUsersForPlan, isUpgradeable };
