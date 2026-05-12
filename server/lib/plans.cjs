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
  solo:      { maxUsers: 1, priceRub: 3900, label: 'Соло',     upgradeable: true  },
  studio:    { maxUsers: 3, priceRub: 5900, extraUserPriceRub: 1000, label: 'Студия',   upgradeable: false },
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

// Утренняя сводка в Telegram — доступна на «Студия» И на «Пробный».
// На trial даём попробовать максимум фич — это апсельный аргумент за
// Студия. Solo осознанно без сводки (для одиночек напоминания не так
// критичны, и это сохраняет дельту между Solo и Студия).
//
// Гейтинг применяется в:
//   • PATCH /api/profile/studio  — отказ менять время не-studio/trial-плану
//   • reminders.cjs              — фильтр в processStudio (cron-тик)
//   • telegram.cjs onboarding    — спрашивать время только нужным
//   • ProfilePage UI             — секция «Утренняя сводка» видна нужным
function planHasDailySummary(plan) {
  return plan === 'studio' || plan === 'trial';
}

module.exports = { PLANS, planMeta, maxUsersForPlan, isUpgradeable, planHasDailySummary };
