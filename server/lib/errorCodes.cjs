// Словарь error-кодов API.
//
// Все коды ошибок, которые возвращаются на фронт через `res.json({ error })`,
// собраны здесь. На фронте есть translateApiError(), который переводит код в
// русский текст ошибки. Если код не в этом словаре — это новый код, добавь его
// сюда и в translateApiError одновременно.
//
// Зачем: ловим опечатки на этапе компиляции (require падает, если кода нет),
// и не приходится мучительно искать «куда же я в третий раз написал
// 'user_not_found' inline».

const ERR = Object.freeze({
  // Пользователь
  USER_NOT_FOUND:                'user_not_found',
  EMAIL_ALREADY_USED:            'email_already_used',
  EMAIL_PASSWORD_REQUIRED:       'email_password_required',
  EMAIL_INVALID:                 'email_invalid',
  INVALID_CREDENTIALS:           'invalid_credentials',
  USER_DISABLED:                 'user_disabled',

  // Студия
  STUDIO_NOT_FOUND:              'studio_not_found',
  STUDIO_DISABLED:               'studio_disabled',

  // Права (owner-only действия)
  ONLY_OWNER_CAN_EDIT_STUDIO:    'only_owner_can_edit_studio',
  ONLY_OWNER_CAN_CANCEL:         'only_owner_can_cancel',
  ONLY_OWNER_CAN_RESUME:         'only_owner_can_resume',
  ONLY_OWNER_CAN_DELETE_ACCOUNT: 'only_owner_can_delete_account',
  ONLY_OWNER_CAN_SEED_DEMO:      'only_owner_can_seed_demo',
  ONLY_OWNER_CAN_CLEAR_DEMO:     'only_owner_can_clear_demo',

  // Защита от самоповреждения
  LAST_OWNER_PROTECTED:          'last_owner_protected',
  CANNOT_DEMOTE_SELF:            'cannot_demote_self',
  CANNOT_DISABLE_SELF:           'cannot_disable_self',
  CANNOT_DELETE_SELF:            'cannot_delete_self',
  CANNOT_PROMOTE_TO_OWNER:       'cannot_promote_to_owner',

  // Запрос
  INVALID_ID:                    'invalid_id',
  NO_FIELDS_TO_UPDATE:           'no_fields_to_update',
  NAME_REQUIRED:                 'name_required',
  NO_ACTIVE_SUBSCRIPTION:        'no_active_subscription',
  TOO_MANY_ATTEMPTS:             'too_many_attempts',

  // Telegram
  TG_ALREADY_LINKED:             'tg_already_linked',
  ALREADY_LINKED:                'already_linked',
});

module.exports = { ERR };
