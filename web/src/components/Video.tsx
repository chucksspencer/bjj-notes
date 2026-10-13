import { useEffect, useRef, useState } from 'react';
import { instagramPost, type InstagramPost } from '../../../src/shared/links';
import { hostLabel, isInstagram, youTubeId, videoStart } from '../lib/format';
import { Icon } from './Icon';

/**
 * A note's video or post. YouTube and Instagram load only when tapped (no third-party requests until
 * then); other links open in the browser.
 */
export function SourceLink({
  url,
  timestamp,
  title,
  author,
}: {
  url: string;
  timestamp: string | null;
  title: string | null;
  author?: string | null;
}) {
  const [playing, setPlaying] = useState(false);
  const id = youTubeId(url);
  const start = videoStart(url, timestamp);
  const ig = instagramPost(url);

  if (ig) return <InstagramPostPlayer post={ig} author={author ?? null} />;
  if (id) {
    const src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1${start ? `&start=${start}` : ''}`;
    return playing ? (
      <div className="video">
        <iframe src={src} title={title ?? 'Video'} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
      </div>
    ) : (
      <button type="button" className="video" onClick={() => setPlaying(true)} aria-label={`Play video${timestamp ? ` from ${timestamp}` : ''}`}>
        <img
          src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}
          alt=""
          loading="lazy"
          onError={e => {
            e.currentTarget.style.visibility = 'hidden';
          }}
        />
        <span className="play">
          <Icon name="play" size={18} />
          {timestamp ? `Play from ${timestamp}` : 'Play'}
        </span>
      </button>
    );
  }
  if (!/^https?:\/\//i.test(url)) return null;
  return (
    <a className="btn quiet small" href={url} target="_blank" rel="noreferrer noopener" style={{ marginTop: 10 }}>
      <Icon name="link" size={18} />
      {isInstagram(url) ? 'Open on Instagram' : title || hostLabel(url)}
      {timestamp ? ` at ${timestamp}` : ''}
    </a>
  );
}

/**
 * An Instagram reel or post: Instagram's own player, loaded when tapped, sized to fit as it reports its
 * height. "Open in Instagram" is always there too, for reels the player won't show and for full screen.
 */
function InstagramPostPlayer({ post, author }: { post: InstagramPost; author: string | null }) {
  const [playing, setPlaying] = useState(false);
  const [height, setHeight] = useState(720);
  const frame = useRef<HTMLIFrameElement>(null);
  const what = post.kind === 'reel' ? 'reel' : 'post';

  useEffect(() => {
    if (!playing) return;
    // Instagram's player posts {"type":"MEASURE","details":{"height":…}} to its parent once laid out.
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== 'https://www.instagram.com' || e.source !== frame.current?.contentWindow) return;
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        const h = Number(data?.details?.height);
        if (data?.type === 'MEASURE' && h > 100) setHeight(Math.ceil(h));
      } catch {
        // some other message from the frame
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [playing]);

  return (
    <div className="reel">
      {playing && (
        <iframe
          ref={frame}
          className="reel-frame"
          src={`https://www.instagram.com/p/${post.code}/embed/captioned/`}
          title={`Instagram ${what}`}
          style={{ height }}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      )}
      <div className="reel-actions">
        {!playing && (
          <button type="button" className="btn quiet small" onClick={() => setPlaying(true)}>
            <Icon name="play" size={18} />
            Play {what}
          </button>
        )}
        <a className="btn ghost small" href={`https://www.instagram.com/${post.kind}/${post.code}/`} target="_blank" rel="noreferrer noopener">
          <Icon name="link" size={18} />
          Open in Instagram
        </a>
        {author && <span className="muted small">{author}</span>}
      </div>
    </div>
  );
}
