import { type ReactElement, useEffect } from 'react';

const launchUrl = 'gchat-launch-spike://open';

export function NativeLaunchSpike(): ReactElement {
  useEffect((): void => {
    window.location.assign(launchUrl);
  }, []);

  return (
    <main style={{ maxWidth: 440, margin: '48px auto', padding: 24 }}>
      <h1>Открыть GChat</h1>
      <p>Пробуем открыть приложение. Если переход не произошёл, нажмите кнопку ниже.</p>
      <p>
        <a style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }} href={launchUrl}>
          Открыть GChat
        </a>
      </p>
      <p>
        <a
          style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}
          href={window.location.pathname}
        >
          Остаться в Web
        </a>
      </p>
      <p>Для перехода приложение GChat должно быть установлено на iPhone.</p>
    </main>
  );
}
