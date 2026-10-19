import type { AttachmentView } from '../../../src/shared/api';
import { Icon } from './Icon';

/** The iPhone app's bridge: there only when the web app runs inside BJJ Notes for iPhone. */
interface NativeBridge {
  postMessage(message: unknown): void;
}
const bridge = (): NativeBridge | undefined =>
  (window as unknown as { webkit?: { messageHandlers?: { bjjNative?: NativeBridge } } }).webkit?.messageHandlers?.bjjNative;

/** "0:42", "12:05" */
function duration(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A note's photos and videos. The originals live in Apple Photos: in the iPhone app a tap plays one from
 * there; elsewhere (a desktop browser) the server's still image shows what it is.
 */
export function Clips({ attachments }: { attachments: AttachmentView[] }) {
  if (!attachments.length) return null;
  const native = bridge();
  return (
    <div className="note-foot">
      <div className="clips">
        {attachments.map(a => {
          const label = a.kind === 'video' ? `video${a.durationS ? `, ${duration(a.durationS)}` : ''}` : 'photo';
          const ratio = a.width && a.height ? `${a.width} / ${a.height}` : a.kind === 'video' ? '16 / 9' : '4 / 3';
          const inner = (
            <>
              <img src={`/api/v1/attachments/${a.id}/thumb`} alt="" loading="lazy" />
              {a.kind === 'video' && (
                <span className="clip-badge">
                  <Icon name="play" size={12} />
                  {a.durationS ? duration(a.durationS) : 'Video'}
                </span>
              )}
            </>
          );
          return native ? (
            <button
              key={a.id}
              type="button"
              className="clip"
              style={{ aspectRatio: ratio }}
              aria-label={`Open ${label} from Photos`}
              onClick={() =>
                native.postMessage({ action: 'open', attachmentId: a.id, kind: a.kind, photosLocalId: a.photosLocalId, photosCloudId: a.photosCloudId })
              }
            >
              {inner}
            </button>
          ) : (
            <span key={a.id} className="clip" style={{ aspectRatio: ratio }} role="img" aria-label={`A ${label} in Photos`}>
              {inner}
            </span>
          );
        })}
      </div>
      {!native && <p className="muted small clip-note">{attachments.length === 1 ? 'Plays' : 'They play'} from Photos in the iPhone app.</p>}
    </div>
  );
}
