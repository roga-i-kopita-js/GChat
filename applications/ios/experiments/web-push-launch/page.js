const status = document.getElementById('status');

void (async () => {
  try {
    return await request('/spike/trace', { event: 'page-ready' });
  } catch (cause) {}
})();
let readingIntent = false;

async function consumeClickIntent() {
  if (readingIntent || document.visibilityState !== 'visible') {
    return;
  }

  readingIntent = true;

  try {
    const cache = await caches.open('gchat-launch-spike-intents');
    const key = new URL('/__gchat_launch_spike_intent', window.location.origin).href;
    const { match: cacheMatch } = cache;
    const response = await cacheMatch.bind(cache)(key);

    if (!response) {
      return;
    }

    const { delete: cacheDelete } = cache;

    await cacheDelete.bind(cache)(key);
    const { json: responseJson } = response;
    const { createdAt } = await responseJson.bind(response)();
    const age = Date.now() - createdAt;

    if (typeof createdAt === 'number' && age >= 0 && age <= 30000) {
      void (async () => {
        try {
          return await request('/spike/trace', { event: 'intent-found' });
        } catch (cause) {}
      })();
      window.location.assign('/apps/client/calls?native_launch_spike=1');
    }
  } catch {
    // Keep the test controls available when storage cannot be read.
  } finally {
    readingIntent = false;
  }
}

window.addEventListener('pageshow', () => void consumeClickIntent());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void (async () => {
      try {
        return await request('/spike/trace', { event: 'page-visible' });
      } catch (cause) {}
    })();
  }

  void consumeClickIntent();
});
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (
    event.source === navigator.serviceWorker.controller &&
    event.data?.type === 'gchat.launch-spike.clicked'
  ) {
    void consumeClickIntent();
  }
});
// Cover the cold-start race where the page is visible before notificationclick stores its intent.
let intentChecks = 0;
const intentTimer = setInterval(() => {
  void consumeClickIntent();

  if (++intentChecks >= 15) {
    clearInterval(intentTimer);
  }
}, 1000);

const stages = {
  worker: 'Запускаем обработчик уведомлений',
  key: 'Получаем тестовый ключ с Mac',
  subscription: 'Создаём push-подписку в iOS',
  binding: 'Передаём тестовую подписку на Mac',
  send: 'Планируем отправку',
};
let stage = 'worker';
const ready = (async () => {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) {
    throw new DOMException('secure context required', 'SecurityError');
  }

  let timer;

  try {
    return await Promise.race([
      (async () => {
        await navigator.serviceWorker.register('/apps/sw.js', { scope: '/apps/' });

        return navigator.serviceWorker.ready;
      })(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new DOMException('worker timeout', 'TimeoutError')), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
})();

function failure(cause) {
  const known = [
    'AbortError',
    'InvalidStateError',
    'NotAllowedError',
    'NotSupportedError',
    'SecurityError',
    'TimeoutError',
    'NetworkError',
  ];
  const name = known.includes(cause?.name) ? cause.name : 'Ошибка';

  return `${stages[stage] ?? 'Уведомления'}: ${name}.`;
}

(async () => {
  try {
    await ready;

    status.textContent = 'Обработчик готов. Разрешите уведомления и выберите тест.';
  } catch (cause) {
    status.textContent = failure(cause);
  }
})();

async function request(path, body) {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );

  const { ok: responseOk } = response ?? {};

  if (!responseOk) {
    throw new Error('request');
  }

  const { json: responseJson2 } = response;

  return responseJson2.bind(response)();
}

document.getElementById('permission').onclick = async () => {
  try {
    const result = await Notification.requestPermission();

    status.textContent =
      result === 'granted'
        ? 'Уведомления разрешены.'
        : 'Разрешение не получено. Проверьте настройки iPhone.';
  } catch {
    status.textContent = 'Откройте страницу с экрана «Домой» в поддерживаемой версии iOS.';
  }
};
document.getElementById('local').onclick = async () => {
  try {
    const registration = await ready;

    const { showNotification: registrationShowNotification } = registration;

    await registrationShowNotification.bind(registration)('Тест GChat', {
      body: 'Нажмите, чтобы проверить переход в нативное приложение.',
      tag: 'gchat-launch-test',
      data: {},
    });
    status.textContent = 'Уведомление запрошено. Нажмите на него. Это проверка без сетевого push.';
  } catch {
    status.textContent = 'Не удалось показать уведомление. Проверьте разрешение.';
  }
};
document.getElementById('push').onclick = async () => {
  try {
    stage = 'worker';
    status.textContent = stages[stage] + '…';
    const registration = await ready;

    if (Notification.permission !== 'granted') {
      status.textContent = 'Сначала нажмите «Разрешить уведомления» и подтвердите разрешение iOS.';

      return;
    }

    stage = 'key';
    status.textContent = stages[stage] + '…';
    const { publicKey } = await request('/spike/key');
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='), (c) =>
      c.charCodeAt(0),
    );
    const { pushManager: registrationPushManager } = registration;
    let subscription = await registrationPushManager.getSubscription();

    // This fixture generates fresh keys after every server restart.
    if (subscription) {
      await subscription.unsubscribe();
    }

    stage = 'subscription';
    status.textContent = stages[stage] + '…';
    const { pushManager: registrationPushManager2 } = registration;

    subscription = await registrationPushManager2.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    stage = 'binding';
    status.textContent = stages[stage] + '…';
    await request('/spike/subscribe', subscription.toJSON());
    stage = 'send';
    status.textContent = stages[stage] + '…';
    await request('/spike/send', {});
    status.textContent =
      'Отправка через 10 секунд. Можно свернуть PWA или заблокировать экран. После получения нажмите уведомление.';
  } catch (cause) {
    status.textContent = failure(cause);
  }
};
document.getElementById('check').onclick = async () => {
  try {
    const result = await request('/spike/status');
    const messages = {
      idle: 'Отправка ещё не запланирована.',
      scheduled: 'Ожидаем 10 секунд.',
      sending: 'Отправляем.',
      'provider-accepted': 'Провайдер принял Web Push. Это не подтверждение доставки на iPhone.',
      'provider-error': 'Провайдер не принял Web Push или сеть недоступна.',
    };

    const { state: resultState } = result;

    status.textContent = messages[resultState] ?? 'Неизвестное состояние.';
  } catch {
    status.textContent = 'Mac недоступен.';
  }
};

document.getElementById('update').onclick = async () => {
  status.textContent = 'Обновляем тест…';

  try {
    const registration = await navigator.serviceWorker.getRegistration('/apps/');

    if (!registration) {
      throw new Error('registration');
    }

    const { update: registrationUpdate } = registration;

    await registrationUpdate.bind(registration)();
    const { installing: registrationInstalling } = registration;
    const installing = registrationInstalling;

    if (installing) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 15000);
        const changed = () => {
          if (installing.state === 'installed' || installing.state === 'redundant') {
            clearTimeout(timer);
            installing.removeEventListener('statechange', changed);
            resolve();
          }
        };

        installing.addEventListener('statechange', changed);
        changed();
      });
    }

    const { waiting: registrationWaiting } = registration;

    if (registrationWaiting) {
      navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {
        once: true,
      });
      const { waiting: registrationWaiting2 } = registration;

      registrationWaiting2.postMessage({ type: 'GCHAT_ACTIVATE' });
    } else {
      status.textContent = 'Тест актуален. Можно повторить отправку.';
    }
  } catch {
    status.textContent = 'Обновление не удалось. Закройте тестовую PWA и откройте снова.';
  }
};
