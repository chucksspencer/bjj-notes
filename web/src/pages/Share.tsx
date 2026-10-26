import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSaveShared } from '../api';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { linkKind, readShare } from '../lib/share';

/**
 * Where a reel or video shared from another app lands (Android, with the web app installed: it's the
 * app's share target). A link goes on the To try list, with a takeaway if there is one; text without a
 * link is saved as a note. Afterwards the page is replaced, so Back returns to the app it came from.
 */
export function Share() {
  const navigate = useNavigate();
  const toast = useToast();
  const save = useSaveShared();
  const [shared] = useState(() => readShare(window.location.search));
  const [text, setText] = useState(shared.url ? '' : shared.text);
  // The same id on a retry, so a save that timed out isn't saved twice.
  const [clientId] = useState(() => crypto.randomUUID());

  if (!shared.url && !shared.text) {
    return (
      <div className="page">
        <header className="page-head">
          <h1 className="display page-title">Nothing to save</h1>
        </header>
        <p className="muted">
          Nothing came through from the other app. Copy the link instead, then tap + and paste it into “Add a video or post link”.
        </p>
        <Link className="btn" to="/try" replace>
          Go to To try
        </Link>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="display page-title">{shared.url ? 'Save to try' : 'Save a note'}</h1>
      </header>
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!shared.url && !text.trim()) return;
          save.mutate(
            { text: text.trim(), url: shared.url, clientId },
            {
              onSuccess: r => {
                toast.show(r.speech);
                navigate(r.to_try ? '/try' : r.inbox ? '/inbox' : '/', { replace: true });
              },
              onError: err => toast.error(err),
            },
          );
        }}
      >
        {shared.url && (
          <div className="panel share-link">
            <div className="row row-split">
              <Icon name="link" />
              <div className="grow">
                <span className="row-title">{linkKind(shared.url)}</span>
                <span className="row-meta share-url">{shared.url}</span>
              </div>
            </div>
          </div>
        )}
        <label className="field">
          <span className="label">{shared.url ? "What's the takeaway? (optional)" : 'Note'}</span>
          <textarea className="textarea" value={text} onChange={e => setText(e.target.value)} />
        </label>
        {shared.url && <p className="muted small share-hint">It waits on your To try list until you've tried it.</p>}
        <button className="btn block" type="submit" disabled={save.isPending || (!shared.url && !text.trim())}>
          {shared.url ? 'Save to To try' : 'Save note'}
        </button>
      </form>
    </div>
  );
}
