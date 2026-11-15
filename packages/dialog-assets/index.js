export const stickerIds = Object.freeze([
  'animal-pals-v1-cat',
  'animal-pals-v1-dog',
  'animal-pals-v1-fox',
  'animal-pals-v1-bear',
  'animal-pals-v1-bunny',
]);

export const reactionCatalog = Object.freeze([
  Object.freeze({ emoji: '👍', label: 'Нравится' }),
  Object.freeze({ emoji: '👎', label: 'Не нравится' }),
  Object.freeze({ emoji: '❤', label: 'Сердце' }),
  Object.freeze({ emoji: '🔥', label: 'Огонь' }),
  Object.freeze({ emoji: '🥰', label: 'Любовь' }),
  Object.freeze({ emoji: '👏', label: 'Аплодисменты' }),
  Object.freeze({ emoji: '😁', label: 'Улыбка' }),
  Object.freeze({ emoji: '🤔', label: 'Размышление' }),
  Object.freeze({ emoji: '🤯', label: 'Взрыв мозга' }),
  Object.freeze({ emoji: '😱', label: 'Ужас' }),
  Object.freeze({ emoji: '🤬', label: 'Злость' }),
  Object.freeze({ emoji: '😢', label: 'Грусть' }),
  Object.freeze({ emoji: '🎉', label: 'Праздник' }),
  Object.freeze({ emoji: '🤩', label: 'Восторг' }),
  Object.freeze({ emoji: '🤮', label: 'Тошнота' }),
  Object.freeze({ emoji: '💩', label: 'Какашка' }),
  Object.freeze({ emoji: '🙏', label: 'Спасибо' }),
  Object.freeze({ emoji: '👌', label: 'Отлично' }),
  Object.freeze({ emoji: '🕊', label: 'Голубь' }),
  Object.freeze({ emoji: '🤡', label: 'Клоун' }),
  Object.freeze({ emoji: '🥱', label: 'Зевота' }),
  Object.freeze({ emoji: '🥴', label: 'Озадаченность' }),
  Object.freeze({ emoji: '😍', label: 'Влюблённость' }),
  Object.freeze({ emoji: '🐳', label: 'Кит' }),
  Object.freeze({ emoji: '❤\u200d🔥', label: 'Пылающее сердце' }),
  Object.freeze({ emoji: '🌚', label: 'Луна' }),
  Object.freeze({ emoji: '🌭', label: 'Хот-дог' }),
  Object.freeze({ emoji: '💯', label: 'Сто процентов' }),
  Object.freeze({ emoji: '🤣', label: 'Смех' }),
  Object.freeze({ emoji: '⚡', label: 'Молния' }),
  Object.freeze({ emoji: '🍌', label: 'Банан' }),
  Object.freeze({ emoji: '🏆', label: 'Кубок' }),
  Object.freeze({ emoji: '💔', label: 'Разбитое сердце' }),
  Object.freeze({ emoji: '🤨', label: 'Недоверие' }),
  Object.freeze({ emoji: '😐', label: 'Безразличие' }),
  Object.freeze({ emoji: '🍓', label: 'Клубника' }),
  Object.freeze({ emoji: '🍾', label: 'Шампанское' }),
  Object.freeze({ emoji: '💋', label: 'Поцелуй' }),
  Object.freeze({ emoji: '🖕', label: 'Средний палец' }),
  Object.freeze({ emoji: '😈', label: 'Чертёнок' }),
  Object.freeze({ emoji: '😴', label: 'Сон' }),
  Object.freeze({ emoji: '😭', label: 'Плач' }),
  Object.freeze({ emoji: '🤓', label: 'Умник' }),
  Object.freeze({ emoji: '👻', label: 'Привидение' }),
  Object.freeze({ emoji: '👨\u200d💻', label: 'Программист' }),
  Object.freeze({ emoji: '👀', label: 'Глаза' }),
  Object.freeze({ emoji: '🎃', label: 'Тыква' }),
  Object.freeze({ emoji: '🙈', label: 'Не вижу' }),
  Object.freeze({ emoji: '😇', label: 'Ангел' }),
  Object.freeze({ emoji: '😨', label: 'Страх' }),
  Object.freeze({ emoji: '🤝', label: 'Рукопожатие' }),
  Object.freeze({ emoji: '✍', label: 'Письмо' }),
  Object.freeze({ emoji: '🤗', label: 'Объятия' }),
  Object.freeze({ emoji: '🫡', label: 'Честь' }),
  Object.freeze({ emoji: '🎅', label: 'Дед Мороз' }),
  Object.freeze({ emoji: '🎄', label: 'Ёлка' }),
  Object.freeze({ emoji: '☃', label: 'Снеговик' }),
  Object.freeze({ emoji: '💅', label: 'Маникюр' }),
  Object.freeze({ emoji: '🤪', label: 'Безумие' }),
  Object.freeze({ emoji: '🗿', label: 'Моаи' }),
  Object.freeze({ emoji: '🆒', label: 'Круто' }),
  Object.freeze({ emoji: '💘', label: 'Стрела любви' }),
  Object.freeze({ emoji: '🙉', label: 'Не слышу' }),
  Object.freeze({ emoji: '🦄', label: 'Единорог' }),
  Object.freeze({ emoji: '😘', label: 'Воздушный поцелуй' }),
  Object.freeze({ emoji: '💊', label: 'Таблетка' }),
  Object.freeze({ emoji: '🙊', label: 'Не говорю' }),
  Object.freeze({ emoji: '😎', label: 'Очки' }),
  Object.freeze({ emoji: '👾', label: 'Пришелец' }),
  Object.freeze({ emoji: '🤷\u200d♂', label: 'Мужчина пожимает плечами' }),
  Object.freeze({ emoji: '🤷', label: 'Пожимает плечами' }),
  Object.freeze({ emoji: '🤷\u200d♀', label: 'Женщина пожимает плечами' }),
  Object.freeze({ emoji: '😡', label: 'Недовольство' }),
]);

export const reactionEmojis = Object.freeze(reactionCatalog.map(({ emoji }) => emoji));

export function normalizeReaction(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const key = value.replaceAll('\uFE0F', '');

  return reactionEmojis.includes(key) ? key : null;
}

export function reactionGlyph(emoji) {
  if (['❤', '🕊', '⚡', '✍', '☃'].includes(emoji) || emoji.endsWith('♂') || emoji.endsWith('♀')) {
    return emoji + '\uFE0F';
  }

  if (emoji === '❤‍🔥') {
    return '❤️‍🔥';
  }

  return emoji;
}
