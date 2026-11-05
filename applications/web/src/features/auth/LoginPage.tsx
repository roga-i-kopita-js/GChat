import { ArrowRight, CircleHelp, Headphones, Phone, ShieldCheck } from 'lucide-react';
import type { FormEvent, JSX } from 'react';
import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router';

import { errorMessage } from '../../shared/api/client';
import { embedded } from '../../shared/native/bridge';
import { useCalls } from '../calls/CallsProvider';
import { useAuth } from './AuthProvider';
import { loginDestination } from './navigation';
import { login } from './session';

export function LoginPage(): JSX.Element {
  const { session } = useAuth();
  const { client } = useCalls();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);

    try {
      await login(String(form.get('login')), String(form.get('password')));
    } catch (cause) {
      setError(errorMessage(cause, 'Не удалось войти'));
    } finally {
      setBusy(false);
    }
  }

  if (session && !embedded) return <Navigate to={loginDestination(location.state)} replace />;

  return (
    <main className="login-page">
      <Link className="brand" to="/">
        <span className="brand-mark" aria-hidden="true">
          <img
            src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
            width="43"
            height="43"
            alt=""
          />
        </span>
        GChat<span className="brand-web">WEB</span>
      </Link>
      <div className="login-layout">
        <section className="login-copy">
          <div className="eyebrow">ВАШЕ ПРОСТРАНСТВО ДЛЯ РАЗГОВОРОВ</div>
          <h1>
            Ближе.
            <br />
            <span>Даже на расстоянии.</span>
          </h1>
          <p>
            Люди, с которыми хочется поговорить.
            <br />
            Голосовые звонки в вашем браузере.
          </p>
          <div className="login-art" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="call-symbol">
              <Phone size={48} />
            </div>
            <span className="art-badge">
              <ShieldCheck size={18} /> Только ваши контакты
            </span>
          </div>
        </section>
        <section className="login-card">
          <div className="mini-icon">
            <Headphones size={25} />
          </div>
          <h2>Вход в GChat</h2>
          <p>Рады вас видеть. Войдите в свой аккаунт.</p>
          <form
            onSubmit={(event): void => {
              void client.enableRingtone();
              void submit(event);
            }}
          >
            <label>
              Логин
              <input
                name="login"
                autoComplete="username"
                placeholder="Ваш логин"
                required
                autoFocus
                minLength={3}
              />
            </label>
            <label>
              Пароль
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="Ваш пароль"
                required
                minLength={15}
                maxLength={128}
              />
            </label>
            {error && (
              <div role="alert" className="form-error">
                {error}
              </div>
            )}
            <button className="primary" disabled={busy}>
              {busy ? 'Входим…' : 'Войти'}
              <ArrowRight size={18} />
            </button>
          </form>
          <div className="login-note">
            <CircleHelp size={18} />
            <span>
              Данные для входа выдаёт администратор.
              <br />
              Если не получается войти, обратитесь к нему.
            </span>
          </div>
        </section>
      </div>
      <footer>GChat · Голосовые звонки один на один</footer>
    </main>
  );
}
