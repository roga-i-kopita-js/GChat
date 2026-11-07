import type { StickerContentDto } from '@gchat/backend-api';
import bear from '@gchat/dialog-assets/images/animal-pals-v1-bear.png';
import bunny from '@gchat/dialog-assets/images/animal-pals-v1-bunny.png';
import cat from '@gchat/dialog-assets/images/animal-pals-v1-cat.png';
import dog from '@gchat/dialog-assets/images/animal-pals-v1-dog.png';
import fox from '@gchat/dialog-assets/images/animal-pals-v1-fox.png';

export const stickers: Record<StickerContentDto['sticker_id'], { url: string; label: string }> = {
  'animal-pals-v1-cat': { url: cat, label: 'Кот' },
  'animal-pals-v1-dog': { url: dog, label: 'Щенок' },
  'animal-pals-v1-fox': { url: fox, label: 'Лиса' },
  'animal-pals-v1-bear': { url: bear, label: 'Медведь' },
  'animal-pals-v1-bunny': { url: bunny, label: 'Кролик' },
};
