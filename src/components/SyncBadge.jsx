const LABELS = {
  synced: 'Synkad',
  modified: 'Ej pushad',
  new: 'Bara i PIM',
  error: 'Fel',
};

export default function SyncBadge({ status }) {
  const key = status || 'new';
  return (
    <span className={`status-badge ${key}`}>
      {LABELS[key] || key}
    </span>
  );
}
