import { useState } from 'react';
import { ApiError, useSignIn } from '../api';
import { BeltMark } from '../components/Belt';

export function Login() {
  const [password, setPassword] = useState('');
  const signIn = useSignIn();
  const error =
    signIn.error instanceof ApiError && signIn.error.status === 401
      ? 'Wrong password.'
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
          if (password) signIn.mutate(password);
        }}
      >
        <BeltMark />
        <h1 className="display">BJJ Notes</h1>
        <p className="muted" style={{ marginTop: 0, marginBottom: 24 }}>
          Your techniques, notes and focus list.
        </p>
        <label className="field">
          <span className="label">Password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus
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
      </form>
    </main>
  );
}
