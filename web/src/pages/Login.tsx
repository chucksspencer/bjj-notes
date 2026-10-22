import { useState } from 'react';
import { ApiError, useSignIn } from '../api';
import { BeltMark } from '../components/Belt';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const signIn = useSignIn();
  const error =
    signIn.error instanceof ApiError && signIn.error.status === 401
      ? 'Wrong email or password.'
      : signIn.error instanceof ApiError && signIn.error.status === 429
        ? 'Too many tries. Wait a few minutes and try again.'
        : signIn.error
          ? signIn.error.message
          : null;

  return (
    <main className="login">
      <form
        onSubmit={e => {
          e.preventDefault();
          if (password) signIn.mutate({ email: email.trim(), password });
        }}
      >
        <BeltMark />
        <h1 className="display">BJJ Notes</h1>
        <p className="muted" style={{ marginTop: 0, marginBottom: 24 }}>
          Your techniques, notes and focus list.
        </p>
        <label className="field">
          <span className="label">Email</span>
          <input
            className="input"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="label">Password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
        </label>
        <button className="btn block" type="submit" disabled={!password || signIn.isPending}>
          Sign in
        </button>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <p className="muted small" style={{ marginTop: 20 }}>
          New here? Ask for an invite link.
        </p>
      </form>
    </main>
  );
}
