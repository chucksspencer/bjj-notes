import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { AccountView, InviteView, PersonView } from '../../../src/shared/api';
import {
  useAccount,
  useChangePassword,
  useCreateInvite,
  useCreateToken,
  useRemovePerson,
  useResetLink,
  useRevokeInvite,
  useRevokeToken,
  useSignOut,
  useUpdateProfile,
} from '../api';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { agoText } from '../lib/format';

/** Your name, email and password, tokens for Siri Shortcuts, and (for the owner) who else can sign in. */
export function Account() {
  const account = useAccount();
  const signOut = useSignOut();
  const a = account.data;

  return (
    <div className="page">
      <Link className="back" to="/">
        <Icon name="back" size={20} />
        Focus
      </Link>
      <header className="page-head">
        <h1 className="display page-title">Account</h1>
      </header>
      {account.isError && <div className="panel empty">Couldn't load your account. {account.error.message}</div>}
      {a && (
        <>
          <Profile a={a} />
          <Password a={a} />
          <Tokens a={a} />
          {a.me.isOwner && <People a={a} />}
        </>
      )}
      <div className="account-signout">
        <button type="button" className="btn quiet block" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
          Sign out
        </button>
      </div>
    </div>
  );
}

function Profile({ a }: { a: AccountView }) {
  const update = useUpdateProfile();
  const toast = useToast();
  const [name, setName] = useState(a.me.name ?? '');
  const [email, setEmail] = useState(a.me.email ?? '');
  const changed = name.trim() !== (a.me.name ?? '') || email.trim().toLowerCase() !== (a.me.email ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    update.mutate(
      { name: name.trim() || null, email: email.trim() || undefined },
      { onSuccess: () => toast.show('Saved.'), onError: err => toast.error(err) },
    );
  };
  return (
    <section>
      <h2 className="section-title">You</h2>
      <form className="panel account-form" onSubmit={submit}>
        {a.me.isOwner && !a.me.email && (
          <p className="account-note">Add your email: you'll sign in with it and your password from now on.</p>
        )}
        <label className="field">
          <span className="label">Name (Claude calls you this)</span>
          <input className="input" autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Email (you sign in with it)</span>
          <input
            className="input"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
        </label>
        <button className="btn" type="submit" disabled={!changed || (!email.trim() && !!a.me.email) || update.isPending}>
          Save
        </button>
      </form>
    </section>
  );
}

function Password({ a }: { a: AccountView }) {
  const change = useChangePassword();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  if (a.me.isOwner) {
    return (
      <section>
        <h2 className="section-title">Password</h2>
        <div className="panel">
          <p className="account-note">
            Your password is the <code>OWNER_PASSWORD</code> secret in GitHub. To change it, update the secret and run the deploy.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section>
      <h2 className="section-title">Password</h2>
      <form
        className="panel account-form"
        onSubmit={e => {
          e.preventDefault();
          change.mutate(
            { current, password },
            {
              onSuccess: () => {
                setCurrent('');
                setPassword('');
                toast.show('Password changed.');
              },
              onError: err => toast.error(err),
            },
          );
        }}
      >
        {a.me.email && <input type="email" autoComplete="username" value={a.me.email} readOnly hidden />}
        <label className="field">
          <span className="label">Current password</span>
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">New password (at least 10 characters)</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
        </label>
        <button className="btn" type="submit" disabled={!current || password.length < 10 || change.isPending}>
          Change password
        </button>
      </form>
    </section>
  );
}

function Tokens({ a }: { a: AccountView }) {
  const create = useCreateToken();
  const revoke = useRevokeToken();
  const toast = useToast();
  const [made, setMade] = useState<string | null>(null);
  const captureUrl = `${window.location.origin}/api/capture`;
  return (
    <section>
      <h2 className="section-title">Siri Shortcuts</h2>
      <div className="panel">
        <p className="account-note">
          Shortcuts send notes to <code>{captureUrl}</code> with a token in the <code>Authorization</code> header (
          <code>Bearer</code> then the token). Make one token per phone or shortcut, so you can remove it on its own.
          {a.ownerApiToken && ' The API_TOKEN secret works too.'}
        </p>
        {a.tokens.map(t => (
          <div className="row row-split" key={t.id}>
            <div className="grow">
              <span className="row-title">{t.label ?? 'Token'}</span>
              <span className="row-meta">
                Made {agoText(t.createdAt)} · {t.lastUsedAt ? `last used ${agoText(t.lastUsedAt)}` : 'not used yet'}
              </span>
            </div>
            <button
              type="button"
              className="btn danger small"
              disabled={revoke.isPending}
              onClick={() => {
                if (window.confirm(`Remove ${t.label ?? 'this token'}? Shortcuts using it will stop working.`)) {
                  revoke.mutate(t.id, { onSuccess: r => toast.show(r.message), onError: err => toast.error(err) });
                }
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <form
          className="row account-inline"
          onSubmit={e => {
            e.preventDefault();
            const label = new FormData(e.currentTarget).get('label')?.toString().trim();
            const form = e.currentTarget;
            create.mutate(
              { label: label || undefined },
              {
                onSuccess: r => {
                  setMade(r.token);
                  form.reset();
                },
                onError: err => toast.error(err),
              },
            );
          }}
        >
          <input className="input" name="label" placeholder="What it's for, e.g. iPhone" aria-label="What the token is for" maxLength={80} />
          <button className="btn small" type="submit" disabled={create.isPending}>
            Make a token
          </button>
        </form>
      </div>
      {made && (
        <Sheet title="Your new token" onClose={() => setMade(null)}>
          <p className="muted">Copy it into your shortcut now. It won't be shown again.</p>
          <CopyField value={made} label="Token" />
          <button type="button" className="btn block" onClick={() => setMade(null)}>
            Done
          </button>
        </Sheet>
      )}
    </section>
  );
}

function People({ a }: { a: AccountView }) {
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ url: string; title: string; note: string } | null>(null);
  const [person, setPerson] = useState<PersonView | null>(null);
  const revoke = useRevokeInvite();
  const toast = useToast();
  const people = a.people ?? [];
  const invites = a.invites ?? [];
  const nameOf = (id: number | null) => {
    const p = people.find(x => x.id === id);
    return p?.name ?? p?.email ?? 'someone';
  };
  return (
    <section>
      <div className="section-head">
        <h2 className="section-title">People</h2>
        <button type="button" className="btn small" onClick={() => setInviting(true)}>
          <Icon name="plus" size={18} />
          Invite
        </button>
      </div>
      <div className="panel">
        {people.map(p => (
          <div className="row row-split" key={p.id}>
            <div className="grow">
              <span className="row-title">
                {p.name ?? p.email ?? 'No name yet'}
                {p.isOwner && <span className="account-tag">owner</span>}
              </span>
              <span className="row-meta">
                {[p.name ? p.email : null, p.lastActiveAt ? `active ${agoText(p.lastActiveAt)}` : `joined ${agoText(p.createdAt)}`]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            {!p.isOwner && (
              <button type="button" className="btn ghost" aria-label={`Options for ${p.name ?? p.email}`} onClick={() => setPerson(p)}>
                <Icon name="more" />
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="section-hint">Everyone has their own notebook. Nobody, you included, sees anyone else's notes.</p>

      {invites.length > 0 && (
        <>
          <h3 className="account-subhead">Links waiting to be used</h3>
          <div className="panel">
            {invites.map((i: InviteView) => (
              <div className="row row-split" key={i.id}>
                <div className="grow">
                  <span className="row-title">
                    {i.purpose === 'reset' ? `New password for ${nameOf(i.userId)}` : `Invite${i.name || i.email ? ` for ${i.name ?? i.email}` : ''}`}
                  </span>
                  <span className="row-meta">Made {agoText(i.createdAt)} · expires {new Date(i.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                </div>
                <button
                  type="button"
                  className="btn danger small"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(i.id, { onSuccess: r => toast.show(r.message), onError: err => toast.error(err) })}
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {inviting && (
        <InviteSheet
          onClose={() => setInviting(false)}
          onMade={(url, who) => {
            setInviting(false);
            setLink({
              url,
              title: 'Invite link',
              note: `Send this to ${who ?? 'them'}. It works once, for 7 days, and lets them make an account with their own password.`,
            });
          }}
        />
      )}
      {person && (
        <PersonSheet
          person={person}
          onClose={() => setPerson(null)}
          onReset={url => {
            setPerson(null);
            setLink({
              url,
              title: 'Password reset link',
              note: `Send this to ${person.name ?? person.email}. It works once, for 7 days. Their old password stops working when they use it.`,
            });
          }}
        />
      )}
      {link && (
        <Sheet title={link.title} onClose={() => setLink(null)}>
          <p className="muted">{link.note}</p>
          <CopyField value={link.url} label="Link" share />
          <button type="button" className="btn block" onClick={() => setLink(null)}>
            Done
          </button>
        </Sheet>
      )}
    </section>
  );
}

function InviteSheet({ onClose, onMade }: { onClose: () => void; onMade: (url: string, who: string | null) => void }) {
  const create = useCreateInvite();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  return (
    <Sheet title="Invite someone" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          create.mutate(
            { name: name.trim() || undefined, email: email.trim() || undefined },
            { onSuccess: r => onMade(r.url, name.trim() || email.trim() || null) },
          );
        }}
      >
        <p className="muted">You'll get a link to send them. Both details are optional; they can change them when they join.</p>
        <label className="field">
          <span className="label">Their name</span>
          <input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span className="label">Their email</span>
          <input
            className="input"
            type="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
        </label>
        {create.error && (
          <p className="error-text" role="alert">
            {create.error.message}
          </p>
        )}
        <button className="btn block" type="submit" disabled={create.isPending}>
          Make invite link
        </button>
      </form>
    </Sheet>
  );
}

function PersonSheet({ person, onClose, onReset }: { person: PersonView; onClose: () => void; onReset: (url: string) => void }) {
  const reset = useResetLink();
  const remove = useRemovePerson();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const who = person.name ?? person.email ?? 'this person';
  return (
    <Sheet title={who} onClose={onClose}>
      {!confirming ? (
        <div className="sheet-actions">
          <button
            type="button"
            className="btn quiet block"
            disabled={reset.isPending}
            onClick={() => reset.mutate(person.id, { onSuccess: r => onReset(r.url), onError: err => toast.error(err) })}
          >
            Make a password reset link
          </button>
          <button type="button" className="btn danger block" onClick={() => setConfirming(true)}>
            Remove {who}…
          </button>
        </div>
      ) : (
        <>
          <p>
            This deletes {who}'s account and their whole notebook: techniques, notes, focus list and sign-ins. It can't be undone.
          </p>
          <div className="sheet-actions">
            <button
              type="button"
              className="btn destroy block"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(person.id, {
                  onSuccess: r => {
                    toast.show(r.message);
                    onClose();
                  },
                  onError: err => toast.error(err),
                })
              }
            >
              Remove {who} and their notebook
            </button>
            <button type="button" className="btn quiet block" onClick={() => setConfirming(false)}>
              Keep {who}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/** A value to hand over: shown in full, with Copy (and Share where the phone offers it). */
function CopyField({ value, label, share }: { value: string; label: string; share?: boolean }) {
  const [copied, setCopied] = useState(false);
  const canShare = share && typeof navigator.share === 'function';
  return (
    <div className="copy-field">
      <input className="input" readOnly value={value} aria-label={label} onFocus={e => e.currentTarget.select()} />
      <div className="copy-actions">
        <button
          type="button"
          className="btn quiet small"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
            } catch {
              // Clipboard not allowed here: the field is selected for a manual copy instead.
              document.querySelector<HTMLInputElement>('.copy-field input')?.select();
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        {canShare && (
          <button type="button" className="btn quiet small" onClick={() => void navigator.share({ url: value }).catch(() => {})}>
            Share
          </button>
        )}
      </div>
    </div>
  );
}
