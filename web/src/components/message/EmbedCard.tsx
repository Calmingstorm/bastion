import type { Embed } from '../../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { safeHttpUrl } from '../../utils/url';

interface EmbedCardProps {
  embed: Embed;
}

function intToHex(color: number): string {
  return '#' + color.toString(16).padStart(6, '0');
}

export function EmbedCard({ embed }: EmbedCardProps) {
  const borderColor = embed.color ? intToHex(embed.color) : 'var(--border)';
  // Only render http(s) URLs in href/src; a javascript:/data: value (even if it
  // slipped past server validation) must not become a clickable link or source.
  const titleHref = safeHttpUrl(embed.url);
  const imageSrc = safeHttpUrl(embed.image?.url);
  const thumbnailSrc = safeHttpUrl(embed.thumbnail?.url);

  return (
    <div
      className="mt-1 max-w-[520px] rounded bg-[var(--bg-secondary)] overflow-hidden"
      style={{ borderLeft: `4px solid ${borderColor}` }}
    >
      <div className="p-3 flex gap-3">
        {/* Main content area */}
        <div className="min-w-0 flex-1">
          {embed.title && (
            <div className="font-semibold text-sm text-[var(--text-primary)]">
              {titleHref ? (
                <a
                  href={titleHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline text-[var(--accent)]"
                >
                  {embed.title}
                </a>
              ) : (
                embed.title
              )}
            </div>
          )}

          {embed.description && (
            <div className="mt-1 text-sm text-[var(--text-secondary)]">
              <MarkdownRenderer content={embed.description} />
            </div>
          )}

          {/* Fields */}
          {embed.fields && embed.fields.length > 0 && (
            <div className="mt-2 grid gap-y-1" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {embed.fields.map((field, i) => (
                <div
                  key={i}
                  className={field.inline ? '' : 'col-span-3'}
                >
                  <div className="text-xs font-semibold text-[var(--text-muted)]">
                    {field.name}
                  </div>
                  <div className="text-sm text-[var(--text-secondary)]">
                    <MarkdownRenderer content={field.value} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Image */}
          {imageSrc && (
            <div className="mt-2">
              <img
                src={imageSrc}
                alt=""
                className="max-w-full max-h-[300px] rounded object-contain"
              />
            </div>
          )}

          {/* Footer */}
          {embed.footer && (
            <div className="mt-2 text-xs text-[var(--text-muted)]">
              {embed.footer.text}
            </div>
          )}
        </div>

        {/* Thumbnail */}
        {thumbnailSrc && (
          <div className="shrink-0">
            <img
              src={thumbnailSrc}
              alt=""
              className="w-20 h-20 rounded object-cover"
            />
          </div>
        )}
      </div>
    </div>
  );
}
