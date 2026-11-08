import type { JSX } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

/** Eager boundary also handles failures to import a child's lazy module. */
export function RouteErrorBoundary(): JSX.Element {
  const error = useRouteError();
  const missing = isRouteErrorResponse(error) && error.status === 404;

  return (
    <section className="list-empty" role="alert">
      <h1>{missing ? 'Страница не найдена' : 'Не удалось открыть страницу'}</h1>
      <p>Перейдите в раздел ещё раз. Если ошибка сохраняется, обновите приложение.</p>
      <Link className="primary" to="/calls">
        К звонкам
      </Link>
    </section>
  );
}
