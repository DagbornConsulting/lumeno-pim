export default function Toast({ message, type = 'info' }) {
  const bg = type === 'error'
    ? 'var(--status-new)'
    : type === 'success'
    ? 'var(--status-synced)'
    : 'var(--fg)';
  return (
    <div className="toast" style={{ background: bg }}>
      {message}
    </div>
  );
}
