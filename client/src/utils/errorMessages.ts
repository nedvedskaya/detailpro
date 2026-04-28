/**
 * errorMessages.ts — единый словарь машинных error-кодов бэкенда → читаемые
 * русские сообщения для пользователя.
 *
 * Зачем: бэкенд отдаёт коды вроде 'schema_name_taken' / 'email_already_used'
 * прямо в поле `error` JSON-а. Раньше они показывались как есть — пользователь
 * видел «schema_name_taken» и не понимал, что не так. Теперь все сообщения
 * проходят через translateApiError() и возвращаются в читаемом виде.
 *
 * Контракт: при добавлении нового кода ошибки на бэке — добавьте перевод сюда.
 * Если код не найден в словаре — возвращаем оригинальное сообщение (бэк часто
 * шлёт уже русский текст в `message`), либо общий fallback.
 */

import { ApiError } from './api';

// Известные коды → читаемый русский. Ключи синхронизированы с бэком
// (см. server/routes/auth.cjs, tenant.cjs, profile.cjs, admin.cjs).
const ERROR_TRANSLATIONS: Record<string, string> = {
  // Авторизация / signup
  email_invalid:           'Введите корректный email',
  email_already_used:      'Этот email уже зарегистрирован — попробуйте войти',
  password_too_short:      'Пароль должен быть не менее 8 символов',
  password_too_common:     'Этот пароль слишком распространённый — придумайте надёжнее',
  invalid_credentials:     'Неверный email или пароль',
  consent_required:        'Подтвердите согласие с условиями',
  display_name_required:   'Введите название студии',

  // Имя схемы (генерируется автоматически из displayName)
  schema_name_required:    'Не указано название студии',
  schema_name_invalid:     'В названии студии должны быть буквы или цифры',
  schema_name_reserved:    'Это название зарезервировано системой — выберите другое',
  schema_name_taken:       'Это название уже занято — добавьте уточнение или цифру',

  // Профиль / реквизиты
  inn_invalid:             'ИНН должен содержать 10 или 12 цифр',
  ogrn_invalid:            'ОГРН должен содержать 13 или 15 цифр',
  contact_email_invalid:   'Введите корректный контактный email',
  no_fields_to_update:     'Нет данных для сохранения',
  user_not_found:          'Пользователь не найден',
  studio_not_found:        'Студия не найдена',

  // Подписка
  only_owner_can_cancel:   'Отменить подписку может только собственник',
  only_owner_can_resume:   'Восстановить подписку может только собственник',
  only_owner_can_edit_studio: 'Реквизиты может править только собственник',
  only_owner:              'Действие доступно только собственнику студии',
  no_active_subscription:  'Активной подписки нет — отменять нечего',
  subscription_expired:    'Подписка истекла — оформите тариф',
  session_expired:         'Сессия истекла — войдите заново',

  // Файлы
  file_too_large:          'Файл слишком большой',
  not_an_image:            'Это не изображение',
  avatar_required:         'Файл аватара не выбран',

  // Документы (акт приёмки / заказ-наряд)
  signature_too_large:     'Подпись слишком тяжёлая — попробуйте перерисовать',
  signature_invalid:       'Подпись в неверном формате',
  zones_invalid:           'Ошибка в данных по зонам',
  items_invalid:           'Ошибка в данных по услугам',

  // Rate-limit / общие
  too_many_attempts:       'Слишком много попыток — попробуйте через 15 минут',
  too_many_requests:       'Слишком много запросов — попробуйте через 15 минут',
  too_many_signups:        'Слишком много регистраций с этого адреса — попробуйте через час',
  rate_limited:            'Слишком много запросов — подождите немного',

  // Доступ / роли
  finance_forbidden:       'Раздел «Финансы» недоступен для вашей роли',
  forbidden_role:          'Это действие доступно только владельцу студии',
  master_cannot_edit:      'Мастер не может изменять данные',
  unauthenticated:         'Войдите в систему — сессия не активна',
  session_invalid_or_expired: 'Сессия истекла — войдите заново',
  studio_disabled:         'Студия отключена — обратитесь в поддержку',
  forbidden:               'Действие запрещено для вашей роли',

  // Транзакции / записи
  type_invalid:            'Неверный тип операции',
  amount_required:         'Укажите сумму',
  invalid_id:              'Некорректный идентификатор',
  transaction_not_found:   'Операция не найдена',
  not_found:               'Запись не найдена',
  name_required:           'Укажите название',

  // Аналитика / тариф
  plan_required:                       'Раздел доступен на тарифе «Студия»',
  daily_summary_requires_studio_plan:  'Утренняя сводка приходит на тарифе «Студия». Оформите тариф в разделе «Подписка»',

  // Демо-данные
  only_owner_can_seed_demo:   'Заполнить демо-данные может только собственник',
  only_owner_can_clear_demo:  'Очистить демо-данные может только собственник',

  // Общая 500 от бэка. До этого фронт показывал «internal_error» как есть —
  // юзер видел английский код и не понимал, что делать. Теперь читаемый
  // текст с подсказкой попробовать ещё раз / написать в поддержку.
  internal_error:             'Что-то пошло не так на сервере. Попробуйте ещё раз через минуту, если повторится — напишите в поддержку',
};

/**
 * Возвращает читаемое сообщение об ошибке для отображения пользователю.
 * Принимает что угодно из catch — ApiError, обычную Error, строку.
 *
 * Логика:
 *   1. Если объект — ApiError со знакомым `code` или `message` (равным коду) —
 *      возвращаем перевод из словаря.
 *   2. Если message уже на русском (содержит кириллицу) — возвращаем его как есть.
 *   3. Иначе возвращаем fallback.
 */
// Человеческие имена полей для сообщений field_invalid.
// Ключи синхронизированы с тем, что бэк передаёт в `err.field`.
const FIELD_LABELS: Record<string, string> = {
  name: 'имя',
  firstName: 'имя',
  lastName: 'фамилия',
  phone: 'телефон',
  email: 'email',
  city: 'город',
  source: 'источник',
  notes: 'заметки',
  tags: 'теги',
  signature_data: 'подпись',
  limit: 'количество',
  offset: 'смещение',
  period: 'период',
  // Поля внутри items / zones / snapshot — раскрываются ниже через explainPath
  items: 'строки документа',
  zones: 'зоны осмотра',
  zone_name: 'название зоны',
  quantity: 'количество',
  price: 'стоимость',
  condition: 'состояние',
};

/**
 * Раскрывает путь вида `items[2].quantity` в человечески читаемое
 * «строка 3, количество». Если путь простой (например `notes`) —
 * возвращает label из FIELD_LABELS или сам путь.
 */
function explainPath(path: string): string {
  // items[N].field → «строка N+1, <field>»
  const itemMatch = path.match(/^items\[(\d+)\]\.(.+)$/);
  if (itemMatch) {
    const rowNum = Number(itemMatch[1]) + 1;
    const sub = FIELD_LABELS[itemMatch[2]] || itemMatch[2];
    return `строка ${rowNum} — ${sub}`;
  }
  // items[N] (без поля) — сам объект
  const itemRowMatch = path.match(/^items\[(\d+)\]$/);
  if (itemRowMatch) return `строка ${Number(itemRowMatch[1]) + 1}`;
  // zones[N].field
  const zoneMatch = path.match(/^zones\[(\d+)\]\.(.+)$/);
  if (zoneMatch) {
    const zoneNum = Number(zoneMatch[1]) + 1;
    const sub = FIELD_LABELS[zoneMatch[2]] || zoneMatch[2];
    return `зона ${zoneNum} — ${sub}`;
  }
  const zoneRowMatch = path.match(/^zones\[(\d+)\]$/);
  if (zoneRowMatch) return `зона ${Number(zoneRowMatch[1]) + 1}`;
  // snapshot.field — пропускаем префикс
  const snapMatch = path.match(/^(client_snapshot|vehicle_snapshot)\.(.+)$/);
  if (snapMatch) return FIELD_LABELS[snapMatch[2]] || snapMatch[2];
  // Простое поле
  return FIELD_LABELS[path] || path;
}

// Reason → читаемое объяснение. Reason приходит вида `max_5000`, `must_be_string`,
// `item_2_must_be_string` (для массивов с индексом).
function explainReason(reason: string): string {
  if (reason === 'must_be_string') return 'должно быть строкой';
  if (reason === 'must_be_array') return 'должно быть списком';
  if (reason === 'must_be_non_negative_int') return 'должно быть положительным числом';
  if (reason === 'empty') return 'не может быть пустым';
  if (reason === 'invalid_base64') return 'неверный формат файла';
  if (reason === 'not_png') return 'должно быть PNG-изображением';
  if (reason === 'too_short') return 'слишком короткое значение';
  // max_NNNN или max_NNNN_bytes
  const maxMatch = reason.match(/^max_(\d+)(_bytes)?$/);
  if (maxMatch) {
    return maxMatch[2] ? `превышен лимит ${maxMatch[1]} байт` : `превышен лимит ${maxMatch[1]} символов`;
  }
  // max_items_NN
  const maxItemsMatch = reason.match(/^max_items_(\d+)$/);
  if (maxItemsMatch) return `не более ${maxItemsMatch[1]} элементов`;
  // item_N_max_NNN
  const itemMaxMatch = reason.match(/^item_(\d+)_max_(\d+)$/);
  if (itemMaxMatch) return `элемент ${Number(itemMaxMatch[1]) + 1}: превышен лимит ${itemMaxMatch[2]} символов`;
  // item_N_must_be_string
  const itemTypeMatch = reason.match(/^item_(\d+)_must_be_string$/);
  if (itemTypeMatch) return `элемент ${Number(itemTypeMatch[1]) + 1}: должен быть строкой`;
  // must_be_one_of_a|b|c
  if (reason.startsWith('must_be_one_of_')) {
    return `допустимые значения: ${reason.slice('must_be_one_of_'.length).replace(/\|/g, ', ')}`;
  }
  return reason;
}

export function translateApiError(err: unknown, fallback = 'Ошибка соединения с сервером'): string {
  // field_invalid: ApiError с .field и .reason. Строим осмысленное «Поле X — Y».
  if (err instanceof ApiError && (err.code === 'field_invalid' || err.message === 'field_invalid')) {
    if (err.field && err.reason) {
      const label = explainPath(err.field);
      return `Поле «${label}»: ${explainReason(err.reason)}`;
    }
  }

  // Сетевые ошибки fetch — `TypeError: Failed to fetch` / `Network request failed`.
  // Это не сообщение для пользователя: показываем fallback.
  const isNetworkNoise = (s: string) =>
    s.startsWith('Failed to fetch') ||
    s.startsWith('Network request failed') ||
    s === 'Load failed' ||
    s.startsWith('NetworkError');

  if (err instanceof ApiError) {
    // Бэк может вернуть код в `code` ИЛИ в `message` (часто в нашем коде
    // body.error становится message при отсутствии code).
    const candidate = (err.code || err.message || '').trim();
    if (candidate && ERROR_TRANSLATIONS[candidate]) return ERROR_TRANSLATIONS[candidate];
    // message — уже русский текст? (содержит кириллицу — значит, локализован).
    if (candidate && /[а-яёА-ЯЁ]/.test(candidate)) return candidate;
    if (candidate && !isNetworkNoise(candidate)) return candidate;
  } else if (typeof err === 'string') {
    if (ERROR_TRANSLATIONS[err]) return ERROR_TRANSLATIONS[err];
    if (!isNetworkNoise(err)) return err;
  } else if (err instanceof Error) {
    const m = err.message || '';
    if (ERROR_TRANSLATIONS[m]) return ERROR_TRANSLATIONS[m];
    if (m && /[а-яёА-ЯЁ]/.test(m)) return m;
  }
  return fallback;
}
