import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, useAcceptInvite, useInviteCheck } from '../api';
import { BeltMark } from '../components/Belt';

/**
 * Where invite and password-reset links land (/join#token). The token stays in the fragment, so it
 * never reaches the server's request logs; it's sent once, in the body, to check and use the link.
 */
export function Join() {
  const navigate = useNavigate();
  const [token] = useState(() => decodeURIComponent(window.location.hash.slice(1)));
  const check = useInviteCheck(token);
  const accept = useAcceptInvite();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (!check.data) return;
    setName(n => n || check.data.name || '');
    setEmail(e => e || check.data.email || '');
  }, [check.data]);

  const reset = check.data?.purpose === 'reset';
  const tooShort = password.length > 0 && password.length < 10;

  if (!token || check.isError) {
    return (
      <main className="login">
        <div className="login-card">
          <BeltMark />
          <h1 className="display">BJJ Notes</h1>
          <p className="muted">
            {check.error instanceof ApiError && check.error.status === 429
              ? 'Too many tries. Wait a few minutes and open the link again.'
              : 'This link has expired or was already used. Ask for a new one.'}
          </p>
          <a className="btn block" href="/">
            Go to sign in
          </a>
        </div>
      </main>
    );
  }
  if (!check.data) return null;

  return (
    <main className="login">
      <form
        onSubmit={e => {
          e.preventDefault();
          if (password.length < 10) return;
          accept.mutate(
            reset ? { token, password } : { token, name: name.trim(), email: email.trim(), password },
            { onSuccess: () => navigate('/', { replace: true }) },
          );
        }}
      >
        <BeltMark />
        <h1 className="display">{reset ? 'New password' : 'Join BJJ Notes'}</h1>
        <p className="muted" style={{ marginTop: 0, marginBottom: 24 }}>
          {reset
            ? `Choose a new password for ${check.data.email ?? check.data.name ?? 'your account'}.`
            : 'Your own notebook: techniques, notes from class and video, and a focus list. Nobody else sees it.'}
        </p>
        {!reset && (
          <>
            <label className="field">
              <span className="label">Your name</span>
              <input className="input" autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
            </label>
            <label className="field">
              <span className="label">Email (you'll sign in with it)</span>
              <input
                className="input"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </label>
          </>
        )}
        {reset && check.data.email && (
          // Lets password managers save the new password under the right account.
          <input type="email" autoComplete="username" value={check.data.email} readOnly hidden />
        )}
        <label className="field">
          <span className="label">{reset ? 'New password' : 'Password'}</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            autoFocus={reset}
            required
            minLength={10}
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
        </label>
        <p className={`small ${tooShort ? 'error-text' : 'muted'}`} style={{ marginTop: -6, marginBottom: 16 }}>
          At least 10 characters.
        </p>
        <button className="btn block" type="submit" disabled={password.length < 10 || (!reset && !email.trim()) || accept.isPending}>
          {reset ? 'Save and sign in' : 'Create my account'}
        </button>
        {accept.error && (
          <p className="error-text" role="alert">
            {accept.error.message}
          </p>
        )}
      </form>
    </main>
  );
}
