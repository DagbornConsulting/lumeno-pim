import { Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';

export default function TabImages({ draft, setDraft }) {
  const images = draft.images || [];

  function set(i, key, value) {
    setDraft(d => ({ ...d, images: d.images.map((img, idx) => idx === i ? { ...img, [key]: value } : img) }));
  }
  function add() {
    setDraft(d => ({ ...d, images: [...(d.images || []), { src: '', alt: '', position: (d.images?.length || 0) + 1 }] }));
  }
  function remove(i) {
    setDraft(d => ({ ...d, images: d.images.filter((_, idx) => idx !== i).map((x, idx) => ({ ...x, position: idx + 1 })) }));
  }
  function move(i, dir) {
    setDraft(d => {
      const imgs = [...d.images];
      const j = i + dir;
      if (j < 0 || j >= imgs.length) return d;
      [imgs[i], imgs[j]] = [imgs[j], imgs[i]];
      return { ...d, images: imgs.map((x, idx) => ({ ...x, position: idx + 1 })) };
    });
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button onClick={add}><Plus size={14} /> Lägg till bild (URL)</button>
      </div>
      {images.length === 0 ? (
        <div className="empty">Inga bilder.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
          {images.map((img, i) => (
            <div key={img.id || i} className="card" style={{ padding: 12 }}>
              <div style={{
                width: '100%', height: 160,
                background: 'var(--bg-sunken)',
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: 10,
              }}>
                {img.src
                  ? <img src={img.src} alt={img.alt || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Ingen bild</span>
                }
              </div>
              <label>Bild-URL</label>
              <input value={img.src || ''} onChange={e => set(i, 'src', e.target.value)} />
              <div style={{ marginTop: 8 }}>
                <label>Alt-text</label>
                <input value={img.alt || ''} onChange={e => set(i, 'alt', e.target.value)} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="sm ghost" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp size={12} /></button>
                  <button className="sm ghost" onClick={() => move(i, 1)} disabled={i === images.length - 1}><ArrowDown size={12} /></button>
                </div>
                <button className="sm ghost" onClick={() => remove(i)}><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
