import { useState } from 'react';
import { hostLabel, isInstagram, youTubeId, videoStart } from '../lib/format';
import { Icon } from './Icon';

/** YouTube loads only when tapped (no third-party requests until then); other links open in the browser. */
export function SourceLink({ url, timestamp, title }: { url: string; timestamp: string | null; title: string | null }) {
  const [playing, setPlaying] = useState(false);
  const id = youTubeId(url);
  const start = videoStart(url, timestamp);

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
