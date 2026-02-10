import type { Attachment } from '../../types';

interface AttachmentPreviewProps {
  attachment: Attachment;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentPreview({ attachment }: AttachmentPreviewProps) {
  const isImage = attachment.contentType.startsWith('image/');
  const isVideo = attachment.contentType.startsWith('video/');

  if (isImage) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 block max-w-md"
      >
        <img
          src={attachment.url}
          alt={attachment.filename}
          className="max-h-80 rounded-md object-contain"
          loading="lazy"
        />
      </a>
    );
  }

  if (isVideo) {
    return (
      <video
        src={attachment.url}
        controls
        className="mt-1 max-h-80 max-w-md rounded-md"
      />
    );
  }

  // Generic file download card
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 flex w-fit items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3 transition-colors hover:bg-[var(--bg-input)]"
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-[var(--accent)]"
      >
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-[var(--accent)]">
          {attachment.filename}
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          {formatFileSize(attachment.size)}
        </p>
      </div>
    </a>
  );
}
